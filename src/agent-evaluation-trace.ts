interface EventSummary {
  elapsedMs: number;
  event: string;
  itemType?: string;
  itemId?: string;
  exitCode?: number;
  operation?: string;
}

const MAX_LINE = 1_000_000;
const MAX_EVENTS = 32;

function commandOperation(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  const match = command.match(/\brke(?:\.cmd)?\s+(activate|resume|status|journey|gate|change|documentation|context|knowledge|task|close|closure|checkpoint|dissection|tracker)\b(?:\s+(enter|add|resolve|assess|explain|check|validate|preview|complete-small))?/i);
  if (match) return `rke:${match[1]!.toLowerCase()}${match[2] ? `:${match[2].toLowerCase()}` : ""}`;
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/i.test(command) || /\bnode\s+--test\b/i.test(command)) return "test";
  if (/\bgit\s+(?:status|diff|show|log)\b/i.test(command)) return "git:read";
  if (/\bgit\s+push\b/i.test(command)) return "git:push";
  if (/\b(?:Get-Content|rg|type)\b/i.test(command)) return "read";
  return "other";
}

export class AgentEvaluationTrace {
  private pending = "";
  private readonly startedAt = Date.now();
  private lastEventAt = this.startedAt;
  private count = 0;
  private readonly recent: EventSummary[] = [];
  private readonly observedOperations = new Set<string>();

  accept(chunk: string): void {
    this.pending += chunk;
    if (this.pending.length > MAX_LINE) {
      this.pending = "";
      return;
    }
    let newline = this.pending.indexOf("\n");
    while (newline >= 0) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      this.acceptLine(line);
      newline = this.pending.indexOf("\n");
    }
  }

  private acceptLine(line: string): void {
    let value: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      value = parsed as Record<string, unknown>;
    } catch { return; }
    if (typeof value.type !== "string") return;
    const item = value.item && typeof value.item === "object" && !Array.isArray(value.item)
      ? value.item as Record<string, unknown> : undefined;
    const operation = item?.type === "command_execution" ? commandOperation(item.command) : undefined;
    const entry: EventSummary = {
      elapsedMs: Date.now() - this.startedAt,
      event: value.type,
      ...(typeof item?.type === "string" ? { itemType: item.type } : {}),
      ...(typeof item?.id === "string" ? { itemId: item.id.slice(0, 80) } : {}),
      ...(typeof item?.exit_code === "number" ? { exitCode: item.exit_code } : {}),
      ...(operation ? { operation } : {})
    };
    this.count++;
    if (operation) this.observedOperations.add(operation);
    this.lastEventAt = Date.now();
    this.recent.push(entry);
    if (this.recent.length > MAX_EVENTS) this.recent.shift();
  }

  snapshot(): {eventCount: number; quietMs: number; observedOperations: string[]; recent: EventSummary[]} {
    return {eventCount: this.count, quietMs: Date.now() - this.lastEventAt, observedOperations: [...this.observedOperations].sort(), recent: [...this.recent]};
  }
}
