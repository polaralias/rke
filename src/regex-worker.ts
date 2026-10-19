import { parentPort, workerData } from "node:worker_threads";

const matcher = new RegExp(String(workerData), "i");
parentPort?.on("message", ({ text, limit }: { text: string; limit: number }) => {
  const matches: { line: number; text: string }[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (matcher.test(line)) matches.push({ line: index + 1, text: line.slice(0, 1000) });
    if (matches.length >= limit) break;
  }
  parentPort?.postMessage(matches);
});
