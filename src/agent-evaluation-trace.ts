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
interface Usage { inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; reasoningOutputTokens: number | null }

function commandOperation(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  const match = command.match(/(?:\brke(?:\.cmd)?|\bnode(?:\.exe)?\s+(?:["']?[^\s"']*[\\/])?dist[\\/]src[\\/]cli\.js["']?)\s+(activate|resume|status|journey|gate|documentation|context|knowledge|task|close|closure|checkpoint|dissection|tracker|publication|coordination|handoff|structure|host)\b(?:\s+(enter|add|resolve|assess|check|verify|validate|apply|preview|scan|cleanup-check|cleanup|write|inspect|plan|trace|file-api|map|impact|search|find|build-indexes|recipe|install))?/i);
  if (match) return `rke:${match[1]!.toLowerCase()}${match[2] ? `:${match[2].toLowerCase()}` : ""}`;
  const okf = command.match(/\bokf-tasks(?:\.exe)?\s+(validate|stop-time|set-status|build-index|create|add-workstream)\b/i);
  if (okf) return `okf:${okf[1]!.toLowerCase()}`;
  if (/\bnode(?:\.exe)?\s+(?:\.\/)?src[\\/]cli\.mjs\b/i.test(command)) return "node:source-cli";
  if (/\bnode(?:\.exe)?\s+(?:\.\/)?dist[\\/]cli\.mjs\b/i.test(command)) return "node:package-cli";
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/i.test(command) || /\bnode\s+--test\b/i.test(command)) return "test";
  if (/\bgit\s+(?:status|diff|show|log)\b/i.test(command)) return "git:read";
  if (/\bgit\s+push\b/i.test(command)) return "git:push";
  if (/\b(?:Get-Content|rg|type)\b/i.test(command)) return "read";
  return "other";
}

export class AgentEvaluationTrace {
  private readonly knownReads: Set<string>;
  private readonly observedReadCommands = new Set<string>();
  private unclassifiedReadCommands = 0;
  private readsTruncated = false;
  private pending = "";
  private readonly startedAt = Date.now();
  private lastEventAt = this.startedAt;
  private count = 0;
  private readonly recent: EventSummary[] = [];
  private readonly observedOperations = new Set<string>();
  private readonly operationExitCodes = new Map<string, Set<number>>();
  private turnCompleted = false;
  private usage: Usage | undefined;
  private completedToolItems = 0;
  private observedToolOutputBytes = 0;
  private traceComplete = true;

  constructor(knownReads: readonly string[] = ["engineering-workflow/SKILL.md", "rke/SKILL.md"]) {
    this.knownReads = new Set(knownReads);
  }

  private observeRead(command: unknown): void {
    if (typeof command !== "string" || !/^\s*(?:Get-Content|cat|type)\s/i.test(command)) return;
    // Only a direct successful read command is recognised. Pipelines, scripts,
    // search hits and quoted mentions are deliberately left unclassified.
    const match = /^\s*(?:Get-Content|cat|type)\s+(?:(?:-LiteralPath|-Path|--)\s+)?(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))(?:\s+-Raw)?\s*$/i.exec(command);
    const path = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").replaceAll("\\", "/");
    const key = /(?:^|\/)skills\/(.+)$/.exec(path)?.[1];
    if (!key || /[;$`|&<>*?\r\n]/.test(path) || !this.knownReads.has(key)) { this.unclassifiedReadCommands++; return; }
    if (this.observedReadCommands.size >= 128 && !this.observedReadCommands.has(key)) { this.readsTruncated = true; return; }
    this.observedReadCommands.add(key);
  }

  accept(chunk: string): void {
    this.pending += chunk;
    if (this.pending.length > MAX_LINE) {
      this.pending = "";
      this.traceComplete = false;
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
    if (value.type === "turn.completed") {
      this.turnCompleted = true;
      if (value.usage && typeof value.usage === "object" && !Array.isArray(value.usage)) {
        const usage = value.usage as Record<string, unknown>;
        const number = (key: string): number | null => typeof usage[key] === "number" && Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0 ? Number(usage[key]) : null;
        const current: Usage = { inputTokens: number("input_tokens"), cachedInputTokens: number("cached_input_tokens"), outputTokens: number("output_tokens"), reasoningOutputTokens: number("reasoning_output_tokens") };
        if (this.usage) for (const key of Object.keys(current) as (keyof Usage)[]) {
          const previous = this.usage[key], value = current[key];
          current[key] = previous !== null && value !== null && Number.isSafeInteger(previous + value) ? previous + value : null;
        }
        this.usage = current;
      } else {
        this.usage = { inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningOutputTokens: null };
      }
    }
    const item = value.item && typeof value.item === "object" && !Array.isArray(value.item)
      ? value.item as Record<string, unknown> : undefined;
    if (value.type === "item.completed" && ["command_execution", "mcp_tool_call", "web_search"].includes(String(item?.type))) {
      this.completedToolItems++;
      if (typeof item?.aggregated_output === "string") this.observedToolOutputBytes += Buffer.byteLength(item.aggregated_output, "utf8");
    }
    if (value.type === "item.completed" && item?.type === "command_execution" && item.exit_code === 0) this.observeRead(item.command);
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
    if (operation && value.type === "item.completed" && typeof item?.exit_code === "number") {
      const exits = this.operationExitCodes.get(operation) ?? new Set<number>();
      exits.add(item.exit_code);
      this.operationExitCodes.set(operation, exits);
    }
    this.lastEventAt = Date.now();
    this.recent.push(entry);
    if (this.recent.length > MAX_EVENTS) this.recent.shift();
  }

  completedTurn(): boolean { return this.turnCompleted; }

  snapshot(): {eventCount: number; quietMs: number; turnCompleted: boolean; traceComplete: boolean; completedToolItems: number; observedToolOutputBytes: number; usage?: Usage; observedOperations: string[]; operationExitCodes: Record<string, number[]>; readEvidence: {scope: "partial-successful-direct-command-observation"; observed: string[]; unclassifiedCommands: number; truncated: boolean; unobserved: "unknown"}; recent: EventSummary[]} {
    return {eventCount: this.count, quietMs: Date.now() - this.lastEventAt, turnCompleted: this.turnCompleted, traceComplete: this.traceComplete, completedToolItems: this.completedToolItems, observedToolOutputBytes: this.observedToolOutputBytes, ...(this.usage ? { usage: this.usage } : {}), observedOperations: [...this.observedOperations].sort(), operationExitCodes: Object.fromEntries([...this.operationExitCodes].map(([operation, exits]) => [operation, [...exits].sort((left, right) => left - right)])), readEvidence: {scope: "partial-successful-direct-command-observation", observed: [...this.observedReadCommands].sort(), unclassifiedCommands: this.unclassifiedReadCommands, truncated: this.readsTruncated, unobserved: "unknown"}, recent: [...this.recent]};
  }
}
