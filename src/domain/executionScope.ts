/** Stable identity of a cast execution scope. */
export type ExecutionScopeId = string;

/**
 * An opaque value published by a scope producer. Core execution transports the
 * value and its ownership metadata, but does not interpret its contents.
 */
export interface ExecutionScopeExport {
  readonly producer: string;
  readonly value: unknown;
}

/**
 * Workspace-neutral execution context for a cast or one of its branches.
 *
 * `state` belongs only to this scope. Callers creating branches must clone it
 * rather than sharing mutable records between scopes.
 */
export interface ExecutionScope {
  readonly id: ExecutionScopeId;
  readonly cwd: string;
  readonly state: Readonly<Record<string, unknown>>;
  readonly exports: Readonly<Record<string, ExecutionScopeExport>>;
}

export interface CreateExecutionScopeInput {
  id: ExecutionScopeId;
  cwd: string;
  state?: Readonly<Record<string, unknown>>;
  exports?: Readonly<Record<string, ExecutionScopeExport>>;
}

/** A deterministic base-scope identity that remains stable across restarts. */
export function baseExecutionScopeId(castId: string): ExecutionScopeId {
  const normalizedCastId = requireNonEmptyString(castId, "castId");
  return `cast:${encodeURIComponent(normalizedCastId)}:base`;
}

/** Create the initial scope rooted at the session project cwd. */
export function createBaseExecutionScope(castId: string, cwd: string): ExecutionScope {
  return createExecutionScope({ id: baseExecutionScopeId(castId), cwd });
}

/**
 * Create a detached, persistence-safe scope snapshot. Scope payloads remain
 * opaque to core execution and must be structured-cloneable.
 */
export function createExecutionScope(input: CreateExecutionScopeInput): ExecutionScope {
  const id = requireNonEmptyString(input.id, "execution scope id");
  const cwd = requireNonEmptyString(input.cwd, "execution scope cwd");
  const state = cloneRecord(input.state ?? {}, "execution scope state");
  const exports = cloneExports(input.exports ?? {});
  return { id, cwd, state, exports };
}

/** Clone a scope snapshot so base and active records never share mutable data. */
export function cloneExecutionScope(scope: ExecutionScope): ExecutionScope {
  return createExecutionScope(scope);
}

function cloneRecord(value: Readonly<Record<string, unknown>>, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a plain object.`);
  try {
    return structuredClone(value) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${label} must be structured-cloneable.`, { cause: error });
  }
}

function cloneExports(value: Readonly<Record<string, ExecutionScopeExport>>): Record<string, ExecutionScopeExport> {
  if (!isPlainRecord(value)) throw new Error("execution scope exports must be a plain object.");
  const result: Record<string, ExecutionScopeExport> = {};
  for (const [key, entry] of Object.entries(value)) {
    requireNonEmptyString(key, "execution scope export name");
    if (!isPlainRecord(entry)) throw new Error(`execution scope output named "${key}" must be an object.`);
    const producer = requireNonEmptyString(entry.producer, `execution scope output named "${key}" producer`);
    try {
      result[key] = { producer, value: structuredClone(entry.value) };
    } catch (error) {
      throw new Error(`execution scope output named "${key}" must be structured-cloneable.`, { cause: error });
    }
  }
  return result;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
