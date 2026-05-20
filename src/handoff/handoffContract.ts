import {
  HANDOFF_DECISIONS_FIELD,
  HANDOFF_EDGE_CONDITIONS,
  HANDOFF_ENVELOPE_FIELDS,
  HANDOFF_FEEDBACK_FIELD,
  HANDOFF_GUIDANCE_FIELD,
  HANDOFF_LEGACY_NON_CANONICAL_ALIASES,
  HANDOFF_MISSING_FIELD,
  HANDOFF_RESERVED_EVALUATOR_FIELDS,
  HANDOFF_RISKS_FIELD,
  HANDOFF_SATISFIED_FIELD,
  HANDOFF_SUMMARY_FIELD,
  HANDOFF_WORK_ITEMS_FIELD,
  createHandoffEnvelope,
  createPartialHandoffEnvelope,
  formatHandoffWorkItemShape as formatDomainHandoffWorkItemShape,
  pickHandoffEnvelopeFields,
  type HandoffEnvelope,
  type HandoffObject,
  type PartialHandoffEnvelope,
} from "../domain/handoff.js";

export * from "../domain/handoff.js";

export { createHandoffEnvelope, createPartialHandoffEnvelope, pickHandoffEnvelopeFields };
export type { HandoffEnvelope, HandoffObject, PartialHandoffEnvelope };

export function formatHandoffEnvelopeShape(): string {
  return JSON.stringify({
    [HANDOFF_SUMMARY_FIELD]: "string",
    [HANDOFF_WORK_ITEMS_FIELD]: [],
    [HANDOFF_GUIDANCE_FIELD]: {},
    [HANDOFF_DECISIONS_FIELD]: [],
    [HANDOFF_RISKS_FIELD]: [],
    [HANDOFF_SATISFIED_FIELD]: "boolean",
    [HANDOFF_FEEDBACK_FIELD]: "string",
    [HANDOFF_MISSING_FIELD]: [],
  });
}

export function formatHandoffWorkItemShape(): string {
  return formatDomainHandoffWorkItemShape();
}

// Shared contract prose belongs in docs and synthetic cast context. Socket-local
// prompt suffixes should reference it and add only adapter-specific constraints
// such as JSON-only output or generator workItems placement.
export const HANDOFF_CONTRACT_PROMPT_TEXT = [
  "pi-materia canonical handoff JSON contract:",
  `- JSON-parsed agent materia should return the generic handoff envelope when applicable: ${formatHandoffEnvelopeShape()}.`,
  `- Generated units of work belong in workItems, never tasks. Each work item has: ${formatHandoffWorkItemShape()}.`,
  "- Preserve useful existing summary, workItems, guidance, decisions, risks, feedback, and missing context when planning, refining, or evaluating an existing envelope; augment fields instead of replacing them with placement-specific payloads.",
  "- If older prompts, examples, adapter metadata, or cast state mention tasks, treat that as legacy placement terminology and still emit generated work units as workItems in the generic envelope.",
  `- Reserved evaluator/route fields are owned by evaluator and graph-flow adapters: ${HANDOFF_RESERVED_EVALUATOR_FIELDS.map((field) => JSON.stringify(field)).join(", ")}. Do not repurpose them for general payload data.`,
  `- ${JSON.stringify(HANDOFF_SATISFIED_FIELD)} is the canonical boolean control field for satisfied/not_satisfied routing and advancement. Use it only when a socket participates in that control flow, and return a real boolean value when present.`,
  "- Socket-specific payload fields may be requested by a local prompt for assignments, artifacts, or diagnostics. Compose them with the generic envelope; payload fields must not redefine or alias reserved evaluator/route semantics.",
  "- Do not invent alternate routing booleans. Legacy names such as \"passed\" are not canonical handoff fields.",
  "- When a socket adapter asks for JSON output, return only the handoff JSON object with no markdown fences, prose, or extra commentary.",
].join("\n");

export function formatHandoffJsonFinalInstruction(): string {
  return "Final output format: Return only JSON for this socket adapter, with no markdown fences, prose, or extra commentary. Use the runtime-provided canonical handoff envelope and preserve useful existing envelope context from Generic cast data or Previous output when applicable.";
}

export const HANDOFF_CONTRACT_DOC_TEXT = [
  "A pi-materia handoff message is a generic JSON envelope produced by a JSON-parsed socket and consumed by socket adapters for assignment, routing, advancement, prompts, and artifacts.",
  "The canonical envelope fields are summary, workItems, guidance, decisions, risks, satisfied, feedback, and missing. Generated units of work use workItems, not tasks.",
  "Each workItem has id, title, description, acceptance, and context fields; context carries optional architecture guidance plus constraints, dependencies, and risks arrays.",
  `Reserved evaluator/route fields (${HANDOFF_RESERVED_EVALUATOR_FIELDS.map((field) => JSON.stringify(field)).join(", ")}) are owned by evaluator and graph-flow adapters and must not be repurposed by general payload logic.`,
  `The reserved control field ${JSON.stringify(HANDOFF_SATISFIED_FIELD)} is the only canonical satisfaction field. It is required by sockets whose graph control flow depends on satisfied/not_satisfied semantics and must be a boolean when present.`,
  `Legacy aliases (${HANDOFF_LEGACY_NON_CANONICAL_ALIASES.map((field) => JSON.stringify(field)).join(", ")}) are not canonical handoff fields. Any compatibility behavior for them must be explicitly documented as obsolete outside the canonical field list.`,
].join("\n\n");

void HANDOFF_EDGE_CONDITIONS;
