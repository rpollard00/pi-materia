import type { DomainIssue } from "./result.js";

/** Workspace-neutral concurrency configuration shared by all parallel generators. */
export interface ParallelismConfig {
  maxConcurrency: number;
}

/** A consuming loop may only override the app-level concurrency bound. */
export interface LoopParallelismConfig {
  maxConcurrency?: number;
}

export function validateParallelismConfig(value: unknown, path = "parallelism"): DomainIssue[] {
  if (!isPlainObject(value)) return [{ path, message: "parallelism configuration must be an object" }];
  return validateMaxConcurrency(value.maxConcurrency, `${path}.maxConcurrency`, false);
}

export function resolveParallelMaxConcurrency(app: ParallelismConfig, loop?: LoopParallelismConfig): number {
  return loop?.maxConcurrency ?? app.maxConcurrency;
}

/**
 * Validate the persisted shape without coupling callers to a particular
 * config adapter. `undefined` uses the app bound; generator capability, not
 * this loop-local override, determines whether execution is parallel.
 */
export function validateMateriaLoopParallelConfig(value: unknown, path = "parallel"): DomainIssue[] {
  if (value === undefined) return [];
  if (!isPlainObject(value)) return [{ path, message: "parallel execution metadata must be an object when present" }];

  return validateMaxConcurrency(value.maxConcurrency, `${path}.maxConcurrency`, true);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateMaxConcurrency(value: unknown, path: string, optional: boolean): DomainIssue[] {
  if (optional && value === undefined) return [];
  return Number.isSafeInteger(value) && (value as number) >= 1
    ? []
    : [{ path, message: "maxConcurrency must be a positive safe integer" }];
}
