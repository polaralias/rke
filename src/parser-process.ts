import { SourceParser } from "./parser.js";

const parser = await SourceParser.create();
let peakRss = process.memoryUsage().rss;
process.on("message", async (request: { path: string; content: string }) => {
  try {
    const result = await parser.parse(request.path, request.content);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    process.send?.({ result, peakRss });
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : String(error) });
  }
});
process.on("disconnect", () => { parser.close(); });
