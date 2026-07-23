import {
  HANDOFF_CONTEXT_FIELD,
  HANDOFF_SATISFIED_FIELD,
} from "../handoff/handoffContract.js";

export interface UtilityInfrastructureFailure {
  namespace: string;
  message: string;
}

export class UtilityInfrastructureFailureError extends Error {
  constructor(public readonly namespace: string, message: string) {
    super(message);
    this.name = "UtilityInfrastructureFailureError";
  }
}

/**
 * Detect a utility's handled infrastructure-failure result. Utilities use this
 * shape when they can emit valid handoff JSON even though their underlying
 * infrastructure operation failed.
 */
export function detectUtilityInfrastructureFailure(
  output: unknown,
): UtilityInfrastructureFailure | undefined {
  if (!isPlainObject(output) || output[HANDOFF_SATISFIED_FIELD] !== false) return undefined;
  const state = output.state;
  if (!isPlainObject(state)) return undefined;

  for (const [namespace, value] of Object.entries(state)) {
    if (!isPlainObject(value) || value.ok !== false) continue;
    return {
      namespace,
      message: nonBlankString(value.error)
        ?? nonBlankString(output[HANDOFF_CONTEXT_FIELD])
        ?? nonBlankString(value.message)
        ?? `Utility infrastructure failure reported by state.${namespace}.ok === false.`,
    };
  }

  return undefined;
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
