export class RkeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode = 2,
  ) {
    super(message);
    this.name = "RkeError";
  }
}

export class BlockingOutcome extends RkeError {
  constructor(code: string, message: string) {
    super(code, message, 3);
    this.name = "BlockingOutcome";
  }
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
