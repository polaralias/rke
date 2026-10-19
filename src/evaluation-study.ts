import { createHash } from "node:crypto";

export const STUDY_ARMS = ["ordinary", "ewf", "runtime", "enriched"] as const;
type Arm = typeof STUDY_ARMS[number];
type Condition = "cold" | "warm";
interface Task { id: string; snapshot: string; cohort: "routine" | "ambiguous"; inputDigest: string; graderDigest: string }
export interface Study {
  schema: 1; seed: string; model: string; settingsDigest: string; dependencyDigest: string;
  timeoutMs: number; trials: number; arms: Arm[]; conditions: Condition[];
  snapshots: { id: string; language: string; digest: string }[]; tasks: Task[];
  artifacts: { runtimeDigest: string; skillDigest: string };
  accounting: { currency: string; pricingDigest: string } | null;
}
export interface Measurement {
  task: string; trial: number; arm: Arm; condition: Condition; studyDigest: string;
  status: "completed" | "failed" | "timeout"; correct: boolean; safetyFailures: number; mandatoryChecksPassed: boolean;
  durationMs: number; setupMs: number; refreshMs: number; enrichmentMs: number;
  toolCalls: number; contextBytes: number | null; timeToEvidenceMs: number | null;
  accountedContextCost: { currency: string; pricingDigest: string; microunits: number } | null;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null;
  graderDigest: string; snapshotDigest: string; model: string; settingsDigest: string;
  dependencyDigest: string; runtimeDigest: string | null; skillDigest: string | null;
}
const digestPattern = /^[a-f0-9]{64}$/;
function requireValue(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value); }
function digest(value: unknown): value is string { return typeof value === "string" && digestPattern.test(value); }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function unique(values: unknown[]): boolean { return new Set(values).size === values.length; }

/** A preregistration is evidence of intended controls, never proof of executed runs. */
export function validateStudy(value: unknown): Study {
  requireValue(object(value) && value.schema === 1, "Study must use schema 1.");
  requireValue(identifier(value.seed) && typeof value.model === "string" && value.model.length > 0 && value.model.length <= 120, "Study must pin its seed and model.");
  requireValue(digest(value.settingsDigest) && digest(value.dependencyDigest), "Study must pin settings and dependencies.");
  requireValue(integer(value.timeoutMs) && value.timeoutMs > 0 && value.timeoutMs <= 3_600_000 && integer(value.trials) && value.trials >= 3 && value.trials <= 20, "Study needs 3–20 trials and a bounded timeout.");
  requireValue(Array.isArray(value.arms) && unique(value.arms) && value.arms.length >= 2 && value.arms.every(arm => STUDY_ARMS.includes(arm as Arm)) && value.arms.includes("ordinary"), "Study needs ordinary tools and distinct supported arms.");
  requireValue(Array.isArray(value.conditions) && unique(value.conditions) && value.conditions.length === 2 && value.conditions.includes("cold") && value.conditions.includes("warm"), "Cold and warm conditions must be separate.");
  requireValue(object(value.artifacts) && digest(value.artifacts.runtimeDigest) && digest(value.artifacts.skillDigest), "Study must pin runtime and skill bytes.");
  requireValue(value.accounting === null || (object(value.accounting) && typeof value.accounting.currency === "string" && /^[A-Z]{3}$/.test(value.accounting.currency) && digest(value.accounting.pricingDigest)), "Accounting must be unavailable or pin a currency and actual pricing inputs.");
  requireValue(Array.isArray(value.snapshots) && value.snapshots.length >= 6 && value.snapshots.length <= 100, "Study needs 6–100 snapshots.");
  requireValue(value.snapshots.every(snapshot => object(snapshot) && identifier(snapshot.id) && identifier(snapshot.language) && digest(snapshot.digest)), "Snapshot identities are invalid.");
  const snapshots = value.snapshots as Study["snapshots"];
  requireValue(unique(snapshots.map(snapshot => snapshot.id)) && new Set(snapshots.map(snapshot => snapshot.language)).size >= 4, "Snapshot ids must be unique across at least four language families.");
  requireValue(Array.isArray(value.tasks) && value.tasks.length >= 30 && value.tasks.length <= 500, "Study needs 30–500 distinct tasks.");
  const ids = new Set(snapshots.map(snapshot => snapshot.id));
  requireValue(value.tasks.every(task => object(task) && identifier(task.id) && ids.has(String(task.snapshot)) && ["routine", "ambiguous"].includes(String(task.cohort)) && digest(task.inputDigest) && digest(task.graderDigest)), "Task inputs, cohorts and independent graders must be pinned.");
  const tasks = value.tasks as Task[];
  requireValue(unique(tasks.map(task => task.id)) && ids.size === new Set(tasks.map(task => task.snapshot)).size && ["routine", "ambiguous"].every(cohort => tasks.some(task => task.cohort === cohort)), "Tasks must cover every snapshot and both cohorts without duplicate ids.");
  return value as unknown as Study;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function studyDigest(study: Study): string { return createHash("sha256").update(canonical(study)).digest("hex"); }
function random(seed: string): () => number {
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0) || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4_294_967_296; };
}
function shuffled<T>(values: T[], next: () => number): T[] {
  const output = [...values];
  for (let index = output.length - 1; index > 0; index--) { const swap = Math.floor(next() * (index + 1)); [output[index], output[swap]] = [output[swap]!, output[index]!]; }
  return output;
}
export function planStudy(study: Study) {
  const identity = studyDigest(study), next = random(study.seed);
  const blocks = study.tasks.flatMap(task => study.conditions.flatMap(condition => Array.from({ length: study.trials }, (_, trial) => ({ task: task.id, condition, trial: trial + 1 }))));
  return { schema: 1, studyDigest: identity, execution: "not-executed", workspacePolicy: "fresh isolated workspace per arm; warm preparation is arm-local and separately metered", runs: shuffled(blocks, next).flatMap(block => shuffled(study.arms, next).map(arm => ({ ...block, arm, studyDigest: identity }))) };
}
function key(row: {task: string; trial: number; arm: Arm; condition: Condition}): string { return `${row.task}:${row.trial}:${row.arm}:${row.condition}`; }
function validateMeasurement(value: unknown, study: Study, identity: string): Measurement {
  requireValue(object(value), "Measurement must be an object.");
  const task = study.tasks.find(task => task.id === value.task), snapshot = study.snapshots.find(snapshot => snapshot.id === task?.snapshot);
  requireValue(task && snapshot && integer(value.trial) && value.trial >= 1 && value.trial <= study.trials && study.arms.includes(value.arm as Arm) && study.conditions.includes(value.condition as Condition), "Measurement does not belong to a registered trial.");
  requireValue(value.studyDigest === identity && value.graderDigest === task.graderDigest && value.snapshotDigest === snapshot.digest && value.model === study.model && value.settingsDigest === study.settingsDigest && value.dependencyDigest === study.dependencyDigest, "Measurement controls differ from preregistration.");
  const needsSkill = value.arm !== "ordinary", needsRuntime = value.arm === "runtime" || value.arm === "enriched";
  requireValue(value.skillDigest === (needsSkill ? study.artifacts.skillDigest : null) && value.runtimeDigest === (needsRuntime ? study.artifacts.runtimeDigest : null), "Measured arm has the wrong artifact identities.");
  requireValue(["completed", "failed", "timeout"].includes(String(value.status)) && typeof value.correct === "boolean" && typeof value.mandatoryChecksPassed === "boolean" && integer(value.safetyFailures), "Measurement needs an outcome, mandatory-check and safety grade.");
  requireValue(value.status === "completed" || value.correct === false, "Failed and timed-out trials cannot be correct.");
  for (const field of ["durationMs", "setupMs", "refreshMs", "enrichmentMs", "toolCalls"]) requireValue(integer(value[field]), "Measured costs must be nonnegative integers.");
  requireValue((value.contextBytes === null || integer(value.contextBytes)) && (value.timeToEvidenceMs === null || integer(value.timeToEvidenceMs)), "Unavailable evidence/context measurements must be null.");
  requireValue(value.timeToEvidenceMs === null || (value.timeToEvidenceMs as number) <= (value.durationMs as number), "Evidence cannot arrive after the recorded run.");
  requireValue(value.status !== "timeout" || (value.durationMs as number) >= study.timeoutMs, "Timeout measurements must retain the timeout cost.");
  requireValue(value.accountedContextCost === null || (study.accounting !== null && object(value.accountedContextCost) && value.accountedContextCost.currency === study.accounting.currency && value.accountedContextCost.pricingDigest === study.accounting.pricingDigest && integer(value.accountedContextCost.microunits)), "Context cost needs measured accounting matching registered pricing inputs.");
  if (value.usage !== null) {
    requireValue(object(value.usage) && ["inputTokens", "cachedInputTokens", "outputTokens"].every(field => integer((value.usage as Record<string, unknown>)[field])), "Usage must be measured or null.");
    requireValue((value.usage.cachedInputTokens as number) <= (value.usage.inputTokens as number), "Cached input cannot exceed total input.");
  }
  return value as unknown as Measurement;
}
function median(values: number[]): number { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2; }
function mean(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function interval(values: number[], statistic: (values: number[]) => number, seed: string) {
  if (!values.length) return null;
  const next = random(seed), samples: number[] = [];
  for (let iteration = 0; iteration < 2_000; iteration++) samples.push(statistic(values.map(() => values[Math.floor(next() * values.length)]!)));
  samples.sort((a, b) => a - b);
  return { estimate: statistic(values), lower: samples[49]!, upper: samples[1949]!, confidence: 0.95, method: "paired-task-cluster-percentile-bootstrap", resamples: 2_000, tasks: values.length };
}

/** Missing trials prevent qualification. Failures remain in correctness and time costs. */
export function reportStudy(study: Study, values: unknown[], candidate: Arm) {
  requireValue(candidate !== "ordinary" && study.arms.includes(candidate), "Choose a registered treatment arm.");
  requireValue(values.length <= 80_000, "Measurement budget exceeded.");
  const identity = studyDigest(study), rows = values.map(value => validateMeasurement(value, study, identity));
  requireValue(unique(rows.map(key)), "Duplicate trials cannot be pooled.");
  const byKey = new Map(rows.map(row => [key(row), row])), missing = planStudy(study).runs.filter(run => !byKey.has(key(run))).map(key);
  const comparisons = study.conditions.flatMap(condition => (["routine", "ambiguous"] as const).map(cohort => {
    const times: number[] = [], contexts: number[] = [], costs: number[] = [], correctness: number[] = [];
    for (const task of study.tasks.filter(task => task.cohort === cohort)) {
      const taskTime: number[] = [], taskContext: number[] = [], taskCost: number[] = [], taskCorrect: number[] = [];
      for (let trial = 1; trial <= study.trials; trial++) {
        const ordinary = byKey.get(key({ task: task.id, trial, condition, arm: "ordinary" })), treatment = byKey.get(key({ task: task.id, trial, condition, arm: candidate }));
        if (!ordinary || !treatment) continue;
        const cost = (row: Measurement): number => row.durationMs + row.setupMs + row.refreshMs + row.enrichmentMs;
        if (cost(ordinary) > 0) taskTime.push(1 - cost(treatment) / cost(ordinary));
        if (ordinary.contextBytes !== null && ordinary.contextBytes > 0 && treatment.contextBytes !== null) taskContext.push(1 - treatment.contextBytes / ordinary.contextBytes);
        if (ordinary.accountedContextCost !== null && ordinary.accountedContextCost.microunits > 0 && treatment.accountedContextCost !== null) taskCost.push(1 - treatment.accountedContextCost.microunits / ordinary.accountedContextCost.microunits);
        taskCorrect.push(Number(treatment.correct) - Number(ordinary.correct));
      }
      if (taskTime.length === study.trials) times.push(median(taskTime));
      if (taskContext.length === study.trials) contexts.push(median(taskContext));
      if (taskCost.length === study.trials) costs.push(median(taskCost));
      if (taskCorrect.length === study.trials) correctness.push(mean(taskCorrect));
    }
    return { condition, cohort, timeReduction: interval(times, median, `${identity}:${condition}:${cohort}:time`), contextReduction: interval(contexts, median, `${identity}:${condition}:${cohort}:context`), accountedContextCostReduction: interval(costs, median, `${identity}:${condition}:${cohort}:cost`), correctnessDifference: interval(correctness, mean, `${identity}:${condition}:${cohort}:correctness`) };
  }));
  const safetyFailures = rows.reduce((sum, row) => sum + row.safetyFailures, 0);
  // Warm is the predeclared reusable-task benefit; cold costs are reported independently.
  const routine = comparisons.find(row => row.condition === "warm" && row.cohort === "routine")!, ambiguous = comparisons.find(row => row.condition === "warm" && row.cohort === "ambiguous")!;
  const qualifies = (metric: typeof ambiguous.timeReduction): boolean => Boolean(metric && metric.estimate >= 0.2 && metric.lower > 0);
  const costComplete = ambiguous.accountedContextCostReduction?.tasks === study.tasks.filter(task => task.cohort === "ambiguous").length;
  const checks = { complete: missing.length === 0, safety: safetyFailures === 0, mandatoryRegressions: rows.every(row => row.mandatoryChecksPassed),
    correctness: comparisons.every(row => row.correctnessDifference !== null && row.correctnessDifference.lower >= -0.05),
    routineCost: Boolean(routine.timeReduction && routine.timeReduction.estimate >= -0.1),
    benefit: qualifies(ambiguous.timeReduction) || (costComplete && qualifies(ambiguous.accountedContextCostReduction)) };
  return { schema: 1, studyDigest: identity, candidate, qualified: Object.values(checks).every(Boolean), checks, safetyFailures, missing,
    observed: rows.length, failures: rows.filter(row => row.status !== "completed").map(row => ({ trial: key(row), status: row.status })), comparisons,
    thresholds: { ambiguousMedianReduction: 0.2, routineMedianRegressionLimit: 0.1, correctnessLowerBound: -0.05, confidence: 0.95, benefitCondition: "warm" },
    limitations: ["Independent grader review and snapshot provenance must be supplied by the study owner.", "No pricing or token-to-cost conversion is inferred.", "Cold and warm costs must not overlap; preparation is not amortised without a declared repeated-task count.", "Small task clusters may give unstable intervals; this report does not establish broad generalisation."] };
}
