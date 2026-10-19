import assert from "node:assert/strict";
import test from "node:test";
import { planStudy, reportStudy, studyDigest, validateStudy, type Measurement, type Study } from "../src/evaluation-study.js";

const hash = "a".repeat(64), second = "b".repeat(64);
function fixture(): Study {
  return validateStudy({ schema: 1, seed: "fixed-seed", model: "explicit-model", settingsDigest: hash, dependencyDigest: hash, timeoutMs: 1000, trials: 3,
    arms: ["ordinary", "ewf", "runtime", "enriched"], conditions: ["cold", "warm"], artifacts: { runtimeDigest: hash, skillDigest: second }, accounting: null,
    snapshots: Array.from({ length: 6 }, (_, index) => ({ id: `repo-${index}`, language: ["typescript", "python", "jvm", "csharp"][index % 4], digest: hash })),
    tasks: Array.from({ length: 30 }, (_, index) => ({ id: `task-${index}`, snapshot: `repo-${index % 6}`, cohort: index < 15 ? "routine" : "ambiguous", inputDigest: hash, graderDigest: second })) });
}
function measurements(study: Study): Measurement[] {
  return planStudy(study).runs.map(run => ({ ...run, status: "completed", correct: true, safetyFailures: 0, mandatoryChecksPassed: true,
    durationMs: run.arm === "runtime" ? 650 : 1000, setupMs: run.condition === "cold" ? 100 : 0, enrichmentMs: 0, refreshMs: 0,
    toolCalls: 3, contextBytes: null, timeToEvidenceMs: 400, usage: null, accountedContextCost: null,
    graderDigest: second, snapshotDigest: hash, model: study.model, settingsDigest: hash, dependencyDigest: hash,
    runtimeDigest: run.arm === "runtime" || run.arm === "enriched" ? hash : null, skillDigest: run.arm === "ordinary" ? null : second }));
}
test("preregistration requires representative tasks, explicit controls and separate conditions", () => {
  const study = fixture();
  for (const changes of [{ tasks: study.tasks.slice(0, 29) }, { snapshots: study.snapshots.slice(0, 5) }, { conditions: ["warm"] }, { model: "" }, { trials: 2 }, { arms: ["runtime", "enriched"] }]) assert.throws(() => validateStudy({ ...study, ...changes }));
  assert.throws(() => validateStudy({ ...study, snapshots: study.snapshots.map(snapshot => ({ ...snapshot, language: "typescript" })) }));
});
test("paired schedule is reproducible, balanced and bound to canonical controls", () => {
  const study = fixture(), plan = planStudy(study);
  assert.equal(plan.runs.length, 720);
  assert.equal(new Set(plan.runs.map(run => JSON.stringify(run))).size, 720);
  assert.deepEqual(planStudy(study), plan);
  assert.notDeepEqual(planStudy({ ...study, seed: "other-seed" }).runs, plan.runs);
  assert.equal(studyDigest({ ...study }), studyDigest(study));
  assert.notEqual(studyDigest({ ...study, model: "changed" }), studyDigest(study));
  for (let offset = 0; offset < plan.runs.length; offset += 4) {
    assert.equal(new Set(plan.runs.slice(offset, offset + 4).map(run => `${run.task}:${run.trial}:${run.condition}`)).size, 1);
    assert.equal(new Set(plan.runs.slice(offset, offset + 4).map(run => run.arm)).size, 4);
  }
});
test("reports task-cluster intervals and no fabricated accounting for missing usage", () => {
  const study = fixture(), report = reportStudy(study, measurements(study), "runtime");
  assert.equal(report.qualified, true);
  assert.equal(report.missing.length, 0);
  const warm = report.comparisons.find(row => row.condition === "warm" && row.cohort === "ambiguous")!;
  assert.equal(warm.timeReduction?.tasks, 15); // Three trials are not counted as 45 independent tasks.
  assert.equal(warm.timeReduction?.lower, 0.35);
  assert.equal(warm.contextReduction, null);
  assert.equal(warm.correctnessDifference?.lower, 0);
});
test("missing runs, changed identities and duplicate trials cannot pass", () => {
  const study = fixture(), rows = measurements(study);
  assert.equal(reportStudy(study, rows.slice(1), "runtime").qualified, false);
  assert.throws(() => reportStudy(study, [...rows, rows[0]], "runtime"), /Duplicate/);
  for (const changes of [{ model: "other-model" }, { studyDigest: second }, { runtimeDigest: second }, { graderDigest: hash }]) {
    const candidate = rows.findIndex(row => row.arm === "runtime");
    assert.throws(() => reportStudy(study, rows.map((row, index) => index === candidate ? { ...row, ...changes } : row), "runtime"));
  }
});
test("retains failed and timed-out runs in costs and correctness", () => {
  const study = fixture(), rows = measurements(study).map(row => row.arm === "runtime" ? { ...row, status: "timeout" as const, correct: false, durationMs: 1000 } : row);
  const report = reportStudy(study, rows, "runtime");
  assert.equal(report.qualified, false);
  assert.equal(report.failures.length, 180);
  assert.equal(report.checks.correctness, false);
  assert.equal(report.comparisons[0]?.correctnessDifference?.estimate, -1);
  assert.throws(() => reportStudy(study, rows.map(row => ({ ...row, correct: true })), "runtime"), /cannot be correct/);
  assert.throws(() => reportStudy(study, rows.map(row => ({ ...row, durationMs: 1, timeToEvidenceMs: null })), "runtime"), /timeout cost/);
});
test("safety and mandatory regressions block a measured speed benefit", () => {
  const study = fixture(), rows = measurements(study);
  assert.equal(reportStudy(study, rows.map((row, index) => index === 0 ? { ...row, safetyFailures: 1 } : row), "runtime").qualified, false);
  assert.equal(reportStudy(study, rows.map((row, index) => index === 0 ? { ...row, mandatoryChecksPassed: false } : row), "runtime").qualified, false);
});
test("warm routine regressions and cold overhead remain visible", () => {
  const study = fixture(), rows = measurements(study).map(row => row.arm !== "runtime" ? row : { ...row, setupMs: row.condition === "cold" ? 5000 : 0, durationMs: Number(row.task.slice(5)) < 15 ? 1200 : 650 });
  const report = reportStudy(study, rows, "runtime");
  assert.equal(report.checks.routineCost, false);
  assert.equal(report.qualified, false);
  assert.ok(report.comparisons.find(row => row.condition === "cold" && row.cohort === "ambiguous")!.timeReduction!.estimate < 0);
});
test("context bytes cannot substitute for actual accounted cost benefit", () => {
  const study = fixture(), rows = measurements(study).map(row => ({ ...row, durationMs: 1000, contextBytes: row.arm === "runtime" ? 500 : 1000 }));
  const proxy = reportStudy(study, rows, "runtime");
  assert.equal(proxy.comparisons[0]?.contextReduction?.estimate, 0.5);
  assert.equal(proxy.qualified, false);
  const priced = { ...study, accounting: { currency: "USD", pricingDigest: second } }, identity = studyDigest(priced);
  const accounted = rows.map(row => ({ ...row, studyDigest: identity, accountedContextCost: { ...priced.accounting, microunits: row.arm === "runtime" ? 500 : 1000 } }));
  assert.equal(reportStudy(priced, accounted, "runtime").qualified, true);
  assert.throws(() => reportStudy(study, rows.map(row => ({ ...row, accountedContextCost: { currency: "USD", pricingDigest: second, microunits: 1 } })), "runtime"), /matching registered pricing/);
  const incomplete = accounted.map((row, index) => index === accounted.findIndex(item => item.arm === "runtime" && item.condition === "warm" && Number(item.task.slice(5)) >= 15) ? { ...row, accountedContextCost: null } : row);
  assert.equal(reportStudy(priced, incomplete, "runtime").qualified, false);
});
