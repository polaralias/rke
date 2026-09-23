import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { routeLegacy } from "../src/workflow.js";

interface Scenario {
  id: string;
  legacy: string;
  category: string;
  prompt: string;
  setup: string;
  expected: string[];
  forbidden: string[];
  grader: string[];
  status: string;
}

const RETAINED = ["EWO", "RDS", "QTK", "RKE", "DDD", "RTL", "WTC", "RCC", "RSA", "LHO", "LPK", "RPF"];
const GRADERS = new Set(["runtime-assertion", "tool-trace", "artifact-diff", "semantic-review", "trigger"]);

test("legacy parity scenarios cover every retained outcome and the two explicit routing decisions", async () => {
  const fixture = JSON.parse(await readFile(join(process.cwd(), "tests/fixtures/legacy-parity-scenarios.json"), "utf8")) as {schema: number; cases: Scenario[]};
  const matrix = await readFile(join(process.cwd(), "docs/legacy-skill-parity-matrix.md"), "utf8");
  assert.equal(fixture.schema, 1);
  assert.ok(Array.isArray(fixture.cases));
  assert.deepEqual([...new Set(fixture.cases.map(item => item.legacy))].sort(), [...RETAINED, "TPU", "TPW"].sort());
  assert.equal(new Set(fixture.cases.map(item => item.id)).size, fixture.cases.length);
  for (const item of fixture.cases) {
    assert.match(item.id, new RegExp(`^${item.legacy}-\\d{2}$`));
    assert.ok(item.category.trim() && item.prompt.trim() && item.setup.trim(), item.id);
    assert.ok(item.expected.length > 0 && item.expected.every(value => value.trim()), item.id);
    assert.ok(item.forbidden.length > 0 && item.forbidden.every(value => value.trim()), item.id);
    assert.ok(item.grader.length > 0 && item.grader.every(value => GRADERS.has(value)), item.id);
    assert.match(matrix, new RegExp(`\\b${item.id}\\b`));
  }
  assert.equal(fixture.cases.find(item => item.id === "TPU-01")?.status, "pending");
  assert.equal(fixture.cases.find(item => item.id === "TPW-01")?.status, "excluded-from-ewf");
  assert.equal(routeLegacy("TPU").payload.destination, "tracker-publication");
  assert.equal(routeLegacy("tracker-publisher").payload.destination, "tracker-publication");
  assert.equal(routeLegacy("TPW").exitCode, 2);
  assert.ok(fixture.cases.filter(item => item.category.includes("injection") || item.category.includes("authority") || item.category.includes("safety")).length >= 3);
});

test("priority matrix orders every contract once and retains an explicit exit test", async () => {
  const fixture = JSON.parse(await readFile(join(process.cwd(), "tests/fixtures/legacy-parity-scenarios.json"), "utf8")) as {cases: Scenario[]};
  const priority = await readFile(join(process.cwd(), "docs/legacy-skill-priority-matrix.md"), "utf8");
  const rows = priority.split("\n").filter(line => /^\| \d+ \| [A-Z]+-\d{2} \| P[0-2] \|/.test(line));
  const parsed = rows.map(line => {
    const cells = line.split("|").slice(1, -1).map(cell => cell.trim());
    return {order: Number(cells[0]), id: cells[1], priority: cells[2], owner: cells[3], evidence: cells[4], done: cells[5]};
  });
  assert.deepEqual(parsed.map(row => row.order), Array.from({length: fixture.cases.length}, (_, index) => index + 1));
  assert.deepEqual(parsed.map(row => row.id).sort(), fixture.cases.map(item => item.id).sort());
  assert.ok(parsed.every(row => row.owner?.startsWith("`") && row.evidence?.length && row.done?.length), "every row needs owner, evidence and exit test");
  assert.ok(parsed.every(row => ["P0", "P1", "P2"].includes(row.priority ?? "")));
  assert.equal(parsed.find(row => row.id === "TPU-01")?.priority, "P0");
  assert.equal(parsed.find(row => row.id === "TPW-01")?.priority, "P2");
  assert.match(priority, /OKF Tasks remains the execution authority and the default durable TPU path/);
});
