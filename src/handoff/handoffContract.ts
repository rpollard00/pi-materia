import {
  HANDOFF_CONTEXT_FIELD,
  HANDOFF_EDGE_CONDITIONS,
  HANDOFF_ENVELOPE_FIELDS,
  HANDOFF_LEGACY_NON_CANONICAL_ALIASES,
  HANDOFF_RESERVED_EVALUATOR_FIELDS,
  HANDOFF_SATISFIED_FIELD,
  HANDOFF_WORK_ITEMS_FIELD,
  createHandoffEnvelope,
  createPartialHandoffEnvelope,
  formatHandoffWorkItemShape as formatDomainHandoffWorkItemShape,
  pickHandoffEnvelopeFields,
  type HandoffEnvelope,
  type HandoffObject,
  type PartialHandoffEnvelope,
} from "../domain/handoff.js";
import type { SocketOutputRequirements } from "./socketOutputRequirements.js";

export * from "../domain/handoff.js";

export {
  createHandoffEnvelope,
  createPartialHandoffEnvelope,
  pickHandoffEnvelopeFields,
};
export type { HandoffEnvelope, HandoffObject, PartialHandoffEnvelope };

export function formatHandoffEnvelopeShape(): string {
  return JSON.stringify({
    [HANDOFF_WORK_ITEMS_FIELD]: [],
    [HANDOFF_SATISFIED_FIELD]: "boolean",
    [HANDOFF_CONTEXT_FIELD]: "string",
  });
}

export function formatHandoffWorkItemShape(): string {
  return formatDomainHandoffWorkItemShape();
}

export const HANDOFF_RESERVED_FIELD_TYPE_PROMPT_TEXT =
  `Reserved handoff field type: ${JSON.stringify(HANDOFF_SATISFIED_FIELD)} is a boolean when present.`;

// Shared contract prose belongs in docs and synthetic cast context. Socket-local
// prompt suffixes should render sparse, socket-specific output requirements.
export const HANDOFF_CONTRACT_PROMPT_TEXT = [
  "pi-materia agent handoff JSON contract:",
  `- Agent JSON handoffs have only these top-level fields: ${formatHandoffEnvelopeShape()}. Emit a field only when it is relevant to this socket's placement, routing, and assignments.`,
  `- Generated units of work belong in top-level ${JSON.stringify(HANDOFF_WORK_ITEMS_FIELD)}. Each generated work item has exactly this model-authored shape: ${formatHandoffWorkItemShape()}.`,
  `- Do not ask agents to invent work item ids, descriptions, acceptance arrays, or nested context objects. Put all item-specific guidance in the work item's ${JSON.stringify(HANDOFF_CONTEXT_FIELD)} string.`,
  `- ${JSON.stringify(HANDOFF_CONTEXT_FIELD)} is optional top-level explanatory text for downstream agents. Do not use it for arbitrary structured state.`,
  `- ${JSON.stringify(HANDOFF_SATISFIED_FIELD)} is the canonical boolean control field for satisfied/not_satisfied routing and advancement. Use it only when a socket participates in that control flow, and return a real boolean value when present.`,
  `- ${HANDOFF_RESERVED_FIELD_TYPE_PROMPT_TEXT}`,
  "- Utility/script materia may return deterministic structured data under a separate top-level state object when configured; that utility state is not part of the agent handoff contract.",
  "- When a socket adapter asks for JSON output, return only the requested JSON object with no markdown fences, prose, or extra commentary.",
].join("\n");

export function formatHandoffJsonFinalInstruction(
  requirements?: SocketOutputRequirements,
): string {
  if (!requirements) {
    return "Final output format: Return only JSON for this socket adapter, with no markdown fences, prose, or extra commentary. Agent handoff fields are limited to workItems, satisfied, and context; emit only fields relevant to this socket's configured placement, routing, and assignments.";
  }
  return formatSocketOutputFinalInstruction(requirements);
}

export function formatSocketOutputFinalInstruction(
  requirements: SocketOutputRequirements,
): string {
  if (!requirements.requiresJsonObject) return "";

  const lines = [
    "Final output format: Return only one top-level JSON object for this socket adapter. Do not include markdown fences, prose, commentary, or explanations.",
    "Agent handoff fields are limited to workItems, satisfied, and context. Emit only the fields relevant to this socket's configured placement, routing, and assignments.",
  ];

  const requiredFields = requirements.requiredFields.map(
    (requirement) =>
      `- ${JSON.stringify(requirement.field)} at ${requirement.path}: ${requirement.type}. ${requirement.reason}`,
  );
  if (requiredFields.length > 0)
    lines.push("Required payload fields:", ...requiredFields);

  if (
    requirements.requiredFields.some(
      (requirement) => requirement.field === HANDOFF_WORK_ITEMS_FIELD,
    )
  ) {
    lines.push(
      `For generated or planned work, emit required top-level ${JSON.stringify(HANDOFF_WORK_ITEMS_FIELD)} at $.${HANDOFF_WORK_ITEMS_FIELD} as an array of objects with ${JSON.stringify("title")} and ${JSON.stringify(HANDOFF_CONTEXT_FIELD)} strings; do not place generated units in tasks or other fields.`,
    );
  }

  const consumedPaths = requirements.consumedPayloadPaths.map(
    (path) => `- ${path.payloadPath} for assignment to ${path.targetPath}.`,
  );
  if (consumedPaths.length > 0)
    lines.push("Payload paths consumed by this socket:", ...consumedPaths);

  const reservedRequiredRules = requirements.reservedFieldTypeRules
    .filter((rule) => rule.required)
    .map(
      (rule) =>
        `- ${JSON.stringify(rule.field)} must be ${articleForType(rule.type)} ${rule.type}.`,
    );
  if (reservedRequiredRules.length > 0)
    lines.push("Required reserved field types:", ...reservedRequiredRules);

  return lines.join("\n");
}

function articleForType(type: string): string {
  return /^[aeiou]/i.test(type) ? "an" : "a";
}

export const HANDOFF_CONTRACT_DOC_TEXT = [
  "A pi-materia agent handoff is a small JSON object consumed by socket adapters for generated work, graph routing, downstream prompt context, and artifacts. Agent-authored JSON handoffs are limited to top-level workItems, satisfied, and context.",
  "workItems is the top-level array for generated or refined work units. Generated units use workItems, not tasks. Each agent-produced work item contains only title:string and context:string. Agents should not provide work item ids, descriptions, acceptance arrays, or nested context objects; runtime/UI code may derive internal keys separately.",
  `satisfied is the reserved boolean graph-control field for satisfied/not_satisfied routing and advancement. ${HANDOFF_RESERVED_FIELD_TYPE_PROMPT_TEXT} It should only appear when the socket participates in that control flow.`,
  "context is optional top-level explanatory text for downstream agents. It is plain text, not arbitrary structured state.",
  "Utility/script materia are separate producers. They may return deterministic structured data under a top-level state object when configured; utility state patches are not part of the agent handoff output contract and must not be mixed into agent-authored handoffs.",
  `Legacy aliases (${HANDOFF_LEGACY_NON_CANONICAL_ALIASES.map((field) => JSON.stringify(field)).join(", ")}) are not canonical handoff fields. Obsolete broad-envelope fields such as summary, guidance, decisions, risks, feedback, and missing are not agent handoff fields in the small contract.`,
].join("\n\n");

void HANDOFF_EDGE_CONDITIONS;
void HANDOFF_ENVELOPE_FIELDS;
void HANDOFF_RESERVED_EVALUATOR_FIELDS;
