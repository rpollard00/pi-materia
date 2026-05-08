import {
  HANDOFF_FEEDBACK_FIELD,
  HANDOFF_LEGACY_NON_CANONICAL_ALIASES,
  HANDOFF_MISSING_FIELD,
  HANDOFF_NOT_SATISFIED_EDGE_CONDITION,
  HANDOFF_SATISFIED_EDGE_CONDITION,
  HANDOFF_SATISFIED_FIELD,
} from "./handoffContract.js";
import type { MateriaPipelineNodeConfig } from "./types.js";

export interface HandoffValidationOptions {
  nodeId: string;
  node: MateriaPipelineNodeConfig;
}

export function validateHandoffJsonOutput(value: unknown, options: HandoffValidationOptions): Record<string, unknown> {
  if (!isPlainJsonObject(value)) {
    throw new Error(`Invalid handoff JSON output for node "${options.nodeId}": expected a JSON object at the top level.`);
  }

  const satisfied = value[HANDOFF_SATISFIED_FIELD];
  if (satisfied !== undefined && typeof satisfied !== "boolean") {
    throw new Error(`Invalid handoff JSON output for node "${options.nodeId}": reserved control field "${HANDOFF_SATISFIED_FIELD}" must be a boolean when present.`);
  }

  const feedback = value[HANDOFF_FEEDBACK_FIELD];
  if (feedback !== undefined && typeof feedback !== "string") {
    throw new Error(`Invalid handoff JSON output for node "${options.nodeId}": reserved evaluator field "${HANDOFF_FEEDBACK_FIELD}" must be a string when present.`);
  }

  const missing = value[HANDOFF_MISSING_FIELD];
  if (missing !== undefined && !Array.isArray(missing)) {
    throw new Error(`Invalid handoff JSON output for node "${options.nodeId}": reserved evaluator field "${HANDOFF_MISSING_FIELD}" must be an array when present.`);
  }

  if (requiresSatisfiedControl(options.node) && satisfied === undefined) {
    const legacyFields = HANDOFF_LEGACY_NON_CANONICAL_ALIASES.filter((field) => Object.prototype.hasOwnProperty.call(value, field));
    const legacyHint = legacyFields.length
      ? ` Legacy field ${legacyFields.map((field) => JSON.stringify(field)).join(", ")} is not canonical and is not used for routing.`
      : "";
    throw new Error(`Invalid handoff JSON output for node "${options.nodeId}": this node has satisfied/not_satisfied control flow and must include reserved boolean field "${HANDOFF_SATISFIED_FIELD}".${legacyHint}`);
  }

  return value;
}

export function requiresSatisfiedControl(node: MateriaPipelineNodeConfig): boolean {
  if (node.edges?.some((edge) => edge.when === HANDOFF_SATISFIED_EDGE_CONDITION || edge.when === HANDOFF_NOT_SATISFIED_EDGE_CONDITION)) return true;
  const advanceWhen = node.advance?.when?.trim();
  return advanceWhen === HANDOFF_SATISFIED_EDGE_CONDITION || advanceWhen === HANDOFF_NOT_SATISFIED_EDGE_CONDITION;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
