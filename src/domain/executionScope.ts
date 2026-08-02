/** Stable identity of a cast execution scope. */
export type ExecutionScopeId = string;

export const MAX_EXECUTION_SCOPE_EXPORTS = 64;
export const MAX_EXECUTION_SCOPE_EXPORT_BYTES = 64 * 1024;
export const MAX_EXECUTION_SCOPE_EXPORT_TOTAL_BYTES = 256 * 1024;

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

/** Reconstruct and validate all durable scope records for a cast. */
export function restoreExecutionScopes(input: {
  castId: string;
  cwd: string;
  version?: unknown;
  baseScope?: unknown;
  activeScope?: unknown;
  branchScopes?: unknown;
}): { baseScope: ExecutionScope; activeScope: ExecutionScope; branchScopes: Record<string, ExecutionScope> } {
  const castId = requireNonEmptyString(input.castId, "castId");
  const legacyCwd = requireNonEmptyString(input.cwd, "cast cwd");
  const hasBase = input.baseScope !== undefined;
  const hasActive = input.activeScope !== undefined;

  // Version-one cwd-only casts predate explicit scopes. Their project cwd
  // becomes both the immutable base and initial active scope. Do not apply this
  // migration to canonical or ambiguous records: doing so would hide scope
  // corruption and could silently discard persisted branch state.
  if (!hasBase && !hasActive) {
    if (input.version !== 1 || input.branchScopes !== undefined) {
      throw new Error("persisted canonical cast must contain baseScope, activeScope, and branchScopes.");
    }
    const baseScope = createBaseExecutionScope(castId, legacyCwd);
    return { baseScope, activeScope: cloneExecutionScope(baseScope), branchScopes: {} };
  }
  if (input.version !== 1 && input.version !== 2) throw new Error("persisted cast version must be 1 or 2.");
  if (!hasBase || !hasActive) throw new Error("persisted cast must contain both baseScope and activeScope.");

  const baseScope = restoreScopeRecord(input.baseScope, "baseScope");
  const expectedBaseId = baseExecutionScopeId(castId);
  if (baseScope.id !== expectedBaseId) throw new Error(`persisted baseScope id must be ${JSON.stringify(expectedBaseId)}.`);
  if (baseScope.cwd !== legacyCwd) throw new Error("persisted baseScope cwd must match the cast cwd.");
  const activeScope = restoreScopeRecord(input.activeScope, "activeScope");
  if (!isPlainRecord(input.branchScopes)) throw new Error("persisted branchScopes must be a plain object.");

  const branchEntries: Array<[string, ExecutionScope]> = [];
  for (const [scopeId, rawScope] of Object.entries(input.branchScopes)) {
    const scope = restoreScopeRecord(rawScope, `branchScopes.${scopeId}`);
    if (scope.id !== scopeId) throw new Error(`persisted branch scope key ${JSON.stringify(scopeId)} must match its scope id.`);
    if (scope.id === baseScope.id) throw new Error("persisted branch scope must not reuse the base scope id.");
    branchEntries.push([scopeId, scope]);
  }
  return { baseScope, activeScope, branchScopes: Object.fromEntries(branchEntries) };
}

function restoreScopeRecord(value: unknown, label: string): ExecutionScope {
  if (!isPlainRecord(value)) throw new Error(`persisted ${label} must be a plain object.`);
  try {
    if (!Object.hasOwn(value, "state") || !isPlainRecord(value.state)) {
      throw new Error("execution scope state must be a present, non-null plain object.");
    }
    if (!Object.hasOwn(value, "exports") || !isPlainRecord(value.exports)) {
      throw new Error("execution scope exports must be a present, non-null plain object.");
    }
    return createExecutionScope({
      id: value.id as string,
      cwd: value.cwd as string,
      state: value.state,
      exports: value.exports as Record<string, ExecutionScopeExport>,
    });
  } catch (error) {
    throw new Error(`persisted ${label} is malformed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function cloneRecord(value: Readonly<Record<string, unknown>>, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a plain object.`);
  assertJsonValue(value, label, new Set());
  return structuredClone(value) as Record<string, unknown>;
}

function cloneExports(value: Readonly<Record<string, ExecutionScopeExport>>): Record<string, ExecutionScopeExport> {
  if (!isPlainRecord(value)) throw new Error("execution scope exports must be a plain object.");
  const entries = Object.entries(value);
  if (entries.length > MAX_EXECUTION_SCOPE_EXPORTS) throw new Error(`execution scope exports may contain at most ${MAX_EXECUTION_SCOPE_EXPORTS} entries.`);
  const clonedEntries: Array<[string, ExecutionScopeExport]> = [];
  let totalBytes = 0;
  for (const [key, entry] of entries) {
    requireNonEmptyString(key, "execution scope export name");
    if (!isPlainRecord(entry)) throw new Error(`execution scope output named "${key}" must be an object.`);
    const producer = requireNonEmptyString(entry.producer, `execution scope output named "${key}" producer`);
    assertJsonValue(entry.value, `execution scope output named "${key}"`, new Set());
    const bytes = Buffer.byteLength(JSON.stringify({ key, producer, value: entry.value }), "utf8");
    if (bytes > MAX_EXECUTION_SCOPE_EXPORT_BYTES) throw new Error(`execution scope output named "${key}" exceeds ${MAX_EXECUTION_SCOPE_EXPORT_BYTES} bytes.`);
    totalBytes += bytes;
    if (totalBytes > MAX_EXECUTION_SCOPE_EXPORT_TOTAL_BYTES) throw new Error(`execution scope exports exceed ${MAX_EXECUTION_SCOPE_EXPORT_TOTAL_BYTES} bytes.`);
    clonedEntries.push([key, { producer, value: structuredClone(entry.value) }]);
  }
  // Object.fromEntries defines keys as data properties, so valid names such as
  // "__proto__" round-trip without invoking Object.prototype setters.
  return Object.fromEntries(clonedEntries);
}

function assertJsonValue(value: unknown, label: string, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain only finite JSON numbers.`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${label} must be structured-cloneable and JSON-serializable.`);
  if (seen.has(value)) throw new Error(`${label} must not contain cyclic values.`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) assertJsonValue(entry, label, seen);
  } else {
    if (!isPlainRecord(value)) throw new Error(`${label} must contain only plain JSON objects.`);
    for (const entry of Object.values(value)) assertJsonValue(entry, label, seen);
  }
  seen.delete(value);
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
