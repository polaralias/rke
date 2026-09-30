import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { grammarForPath } from "./parser.js";
import type { ParsedFile } from "./types.js";

export class ParserProcessClient {
  private child: ChildProcess | undefined;
  private language: string | undefined;
  processCount = 0;
  peakRss = 0;

  async parse(path: string, content: string): Promise<ParsedFile> {
    const language = grammarForPath(path);
    if (!language) throw new Error(`No parser grammar for ${path}`);
    if (this.language !== language || !this.child || this.child.exitCode !== null || this.child.signalCode !== null || !this.child.connected) {
      await this.close();
      this.child = fork(fileURLToPath(new URL("./parser-process.js", import.meta.url)), [], {
        execPath: process.execPath, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
      });
      this.language = language;
      this.processCount++;
    }
    const child = this.child!;
    return new Promise<ParsedFile>((resolve, reject) => {
      const onMessage = (message: { result?: ParsedFile; error?: string; peakRss?: number }): void => {
        cleanup();
        if (typeof message.peakRss === "number") this.peakRss = Math.max(this.peakRss, message.peakRss);
        if (message.error) reject(new Error(message.error));
        else if (message.result) resolve(message.result);
        else reject(new Error("Parser process returned no result"));
      };
      const onError = (error: Error): void => { cleanup(); reject(error); };
      const onExit = (code: number | null): void => { cleanup(); reject(new Error(`Parser process exited before returning a result: ${code}`)); };
      const cleanup = (): void => {
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      child.once("message", onMessage);
      child.once("error", onError);
      child.once("exit", onExit);
      child.send({ path, content }, error => { if (error) onError(error); });
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.language = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const finish = (): void => {
        clearTimeout(timer);
        child.off("exit", finish);
        child.off("error", finish);
        resolve();
      };
      child.once("exit", finish);
      child.once("error", finish);
      const timer = setTimeout(() => { child.kill("SIGKILL"); finish(); }, 5000);
      timer.unref();
      if (!child.kill()) finish();
    });
  }
}
