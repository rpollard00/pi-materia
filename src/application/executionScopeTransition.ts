import {
  cloneExecutionScope,
  createExecutionScope,
  type CreateExecutionScopeInput,
  type ExecutionScope,
} from "../domain/executionScope.js";
import type { MateriaCastState } from "../types.js";

/** Reserved utility-output sidecar; it is never part of agent handoffs or utility state patches. */
export const UTILITY_SCOPE_TRANSITION_FIELD = "scopeTransition";

/** A utility-only request to replace the cast's active execution scope. */
export type UtilityExecutionScopeTransition =
  | { readonly kind: "replace"; readonly scope: CreateExecutionScopeInput }
  | { readonly kind: "base" };

export interface ExtractedUtilityScopeTransition {
  output: string;
  transition?: UtilityExecutionScopeTransition;
}

/**
 * Extract a typed transition from JSON utility output and remove its sidecar
 * before ordinary handoff validation, assignment, and state-patch handling.
 */
export function extractUtilityScopeTransition(output: string): ExtractedUtilityScopeTransition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { output };
  }
  if (!isPlainRecord(parsed) || !Object.hasOwn(parsed, UTILITY_SCOPE_TRANSITION_FIELD)) return { output };

  const transition = parseUtilityScopeTransition(parsed[UTILITY_SCOPE_TRANSITION_FIELD]);
  const ordinaryEntries = Object.entries(parsed).filter(([key]) => key !== UTILITY_SCOPE_TRANSITION_FIELD);
  return { output: JSON.stringify(Object.fromEntries(ordinaryEntries)), transition };
}

/** Validate and atomically activate a utility-produced replacement scope. */
export function activateUtilityScopeTransition(
  state: MateriaCastState,
  transition: UtilityExecutionScopeTransition,
): ExecutionScope {
  const replacement = transition.kind === "base"
    ? cloneExecutionScope(state.baseScope)
    : createExecutionScope(transition.scope);

  if (replacement.id === state.baseScope.id) {
    if (!scopeEquals(replacement, state.baseScope)) {
      throw new Error("a utility may return to the base execution scope but may not replace or mutate it.");
    }
  } else {
    state.branchScopes = Object.fromEntries([
      ...Object.entries(state.branchScopes).filter(([id]) => id !== replacement.id),
      [replacement.id, cloneExecutionScope(replacement)],
    ]);
  }
  state.activeScope = cloneExecutionScope(replacement);
  return state.activeScope;
}

function parseUtilityScopeTransition(value: unknown): UtilityExecutionScopeTransition {
  if (!isPlainRecord(value)) throw new Error(`utility ${UTILITY_SCOPE_TRANSITION_FIELD} must be an object.`);
  if (value.kind === "base") {
    assertOnlyKeys(value, ["kind"]);
    return { kind: "base" };
  }
  if (value.kind !== "replace") throw new Error(`utility ${UTILITY_SCOPE_TRANSITION_FIELD}.kind must be "replace" or "base".`);
  assertOnlyKeys(value, ["kind", "scope"]);
  if (!isPlainRecord(value.scope)) throw new Error(`utility ${UTILITY_SCOPE_TRANSITION_FIELD}.scope must be an object.`);
  const unexpectedScopeKey = Object.keys(value.scope).find((key) => !["id", "cwd", "state", "exports"].includes(key));
  if (unexpectedScopeKey) throw new Error(`utility ${UTILITY_SCOPE_TRANSITION_FIELD}.scope has unexpected field ${JSON.stringify(unexpectedScopeKey)}.`);
  // createExecutionScope performs bounded export and JSON-safe state validation.
  const scope = createExecutionScope(value.scope as unknown as CreateExecutionScopeInput);
  return { kind: "replace", scope };
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`utility ${UTILITY_SCOPE_TRANSITION_FIELD} has unexpected field ${JSON.stringify(unexpected[0])}.`);
}

function scopeEquals(left: ExecutionScope, right: ExecutionScope): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
