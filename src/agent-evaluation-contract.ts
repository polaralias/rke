import { validateWorkflowState } from "./workflow.js";

/** Current contracts can allow persistence; historical booleans retain exact meaning. */
export type WorkflowStatePolicy = "required" | "forbidden" | "optional";
export interface WorkflowStateExpectation {
  workflowState?: WorkflowStatePolicy;
  expectWorkflowState?: boolean;
}

export function workflowStatePolicy(expectation: WorkflowStateExpectation): WorkflowStatePolicy {
  const explicit = expectation.workflowState;
  if (explicit !== undefined && !["required", "forbidden", "optional"].includes(explicit)) throw new Error("Invalid workflow state policy");
  if (expectation.expectWorkflowState !== undefined && typeof expectation.expectWorkflowState !== "boolean") throw new Error("Invalid legacy workflow state expectation");
  const legacy = expectation.expectWorkflowState === undefined ? undefined : expectation.expectWorkflowState ? "required" : "forbidden";
  if (explicit && legacy && explicit !== legacy) throw new Error("Conflicting workflow state expectations");
  if (!explicit && !legacy) throw new Error("Missing workflow state expectation");
  return explicit ?? legacy!;
}

export function workflowStatePresenceMatches(expectation: WorkflowStateExpectation, exists: boolean): boolean {
  const policy = workflowStatePolicy(expectation);
  return policy === "optional" || exists === (policy === "required");
}

/** A file containing null/array/arbitrary JSON is not valid persisted workflow state. */
export function validObservedWorkflowState(value: unknown): value is Record<string, unknown> {
  return validateWorkflowState(value).length === 0;
}
