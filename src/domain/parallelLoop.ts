import type { DomainIssue } from "./result.js";

/** The only workspace mode supported by the experimental parallel loop MVP. */
export const PARALLEL_LOOP_WORKSPACE_MODE = "jj" as const;
/** The only lane failure policy supported by the experimental parallel loop MVP. */
export const PARALLEL_LOOP_FAILURE_POLICY = "all_terminal" as const;
/** The only fan-in ordering supported by the experimental parallel loop MVP. */
export const PARALLEL_LOOP_FAN_IN_BEHAVIOR = "ordered" as const;

/**
 * Validate the persisted shape without coupling callers to a particular
 * config adapter. `undefined` is valid because parallel execution is opt-in.
 */
export function validateMateriaLoopParallelConfig(value: unknown, path = "parallel"): DomainIssue[] {
  if (value === undefined) return [];
  if (!isPlainObject(value)) return [{ path, message: "parallel execution metadata must be an object when present" }];

  const issues: DomainIssue[] = [];
  if (!isNonEmptyString(value.planInput)) {
    issues.push({ path: `${path}.planInput`, message: "parallel execution planInput must be a non-empty normalized-plan input path" });
  }
  if (!Number.isSafeInteger(value.maxConcurrency) || (value.maxConcurrency as number) < 1) {
    issues.push({ path: `${path}.maxConcurrency`, message: "parallel execution maxConcurrency must be a positive safe integer" });
  }
  if (value.workspaceMode !== PARALLEL_LOOP_WORKSPACE_MODE) {
    issues.push({ path: `${path}.workspaceMode`, message: `unsupported parallel workspace mode ${JSON.stringify(value.workspaceMode)}; expected ${JSON.stringify(PARALLEL_LOOP_WORKSPACE_MODE)}` });
  }
  if (value.failurePolicy !== PARALLEL_LOOP_FAILURE_POLICY) {
    issues.push({ path: `${path}.failurePolicy`, message: `unsupported parallel failure policy ${JSON.stringify(value.failurePolicy)}; expected ${JSON.stringify(PARALLEL_LOOP_FAILURE_POLICY)}` });
  }
  if (value.fanIn !== PARALLEL_LOOP_FAN_IN_BEHAVIOR) {
    issues.push({ path: `${path}.fanIn`, message: `unsupported parallel fan-in behavior ${JSON.stringify(value.fanIn)}; expected ${JSON.stringify(PARALLEL_LOOP_FAN_IN_BEHAVIOR)}` });
  }
  return issues;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
