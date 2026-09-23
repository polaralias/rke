import { Worker } from "node:worker_threads";

import { RkeError } from "./errors.js";

export class BoundedRegexSearch {
  private readonly worker: Worker;
  constructor(pattern: string) {
    if (pattern.length > 256) throw new RkeError("invalid_search_pattern", "Search pattern exceeds 256 characters.");
    try { new RegExp(pattern, "i"); } catch { throw new RkeError("invalid_search_pattern", "Invalid regular expression."); }
    this.worker = new Worker(new URL("./regex-worker.js", import.meta.url), { workerData: pattern });
  }
  matches(text: string, limit: number): Promise<{ line: number; text: string }[]> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: { line: number; text: string }[]): void => {
        clearTimeout(timer);
        this.worker.off("message", onMessage);
        this.worker.off("error", onError);
        this.worker.off("exit", onExit);
        if (error) reject(error); else resolve(value ?? []);
      };
      const onMessage = (value: { line: number; text: string }[]): void => finish(undefined, value);
      const onError = (error: Error): void => finish(error);
      const onExit = (): void => finish(new RkeError("search_worker_failed", "Search worker exited unexpectedly."));
      const timer = setTimeout(() => { void this.close(); finish(new RkeError("search_timeout", "Regular expression exceeded the five-second per-file limit.")); }, 5000);
      this.worker.once("message", onMessage);
      this.worker.once("error", onError);
      this.worker.once("exit", onExit);
      this.worker.postMessage({ text, limit });
    });
  }
  async close(): Promise<void> { await this.worker.terminate(); }
}
