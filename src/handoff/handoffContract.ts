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
import type { SocketOutputRequirements } from "./socketOutputRequirements.js";

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

export const HANDOFF_RESERVED_FIELD_TYPE_PROMPT_TEXT = [
  `Reserved handoff field types: ${JSON.stringify(HANDOFF_SATISFIED_FIELD)} is a boolean when present; ${JSON.stringify(HANDOFF_FEEDBACK_FIELD)} is a string when present; ${JSON.stringify(HANDOFF_MISSING_FIELD)} is an array when present.`,
  `Do not format ${JSON.stringify(HANDOFF_FEEDBACK_FIELD)} as a list or array; summarize feedback as one concise string.`,
].join(" ");

// Shared contract prose belongs in docs and synthetic cast context. Socket-local
// prompt suffixes should render sparse, socket-specific output requirements.
export const HANDOFF_CONTRACT_PROMPT_TEXT = [
  "pi-materia canonical handoff runtime state:",
  `- The runtime carries a canonical state shape for handoff context: ${formatHandoffEnvelopeShape()}. JSON sockets should emit only the fields relevant to their configured placement, routing, and assignments.`,
  `- Generated units of work belong in workItems, never tasks. Each work item has: ${formatHandoffWorkItemShape()}.`,
  "- Preserve useful existing summary, workItems, guidance, decisions, risks, feedback, and missing context when a socket is explicitly asked to refine those fields; do not emit unrelated canonical fields just to fill an envelope.",
  "- If older prompts, examples, adapter metadata, or cast state mention tasks, treat that as legacy placement terminology and still emit generated work units as workItems.",
  `- Reserved evaluator/route fields are owned by evaluator and graph-flow adapters: ${HANDOFF_RESERVED_EVALUATOR_FIELDS.map((field) => JSON.stringify(field)).join(", ")}. Do not repurpose them for general payload data.`,
  `- ${JSON.stringify(HANDOFF_SATISFIED_FIELD)} is the canonical boolean control field for satisfied/not_satisfied routing and advancement. Use it only when a socket participates in that control flow, and return a real boolean value when present.`,
  `- ${HANDOFF_RESERVED_FIELD_TYPE_PROMPT_TEXT}`,
  "- Socket-specific payload fields may be requested by a local prompt for assignments, artifacts, or diagnostics. Payload fields must not redefine or alias reserved evaluator/route semantics.",
  "- Do not invent alternate routing booleans. Legacy names such as \"passed\" are not canonical handoff fields.",
  "- When a socket adapter asks for JSON output, return only the requested JSON object with no markdown fences, prose, or extra commentary.",
].join("\n");

export function formatHandoffJsonFinalInstruction(requirements?: SocketOutputRequirements): string {
  if (!requirements) {
    return "Final output format: Return only JSON for this socket adapter, with no markdown fences, prose, or extra commentary. Emit only fields relevant to this socket's configured placement, routing, and assignments; do not emit the full canonical handoff envelope unless the local prompt explicitly asks for it.";
  }
  return formatSocketOutputFinalInstruction(requirements);
}

export function formatSocketOutputFinalInstruction(requirements: SocketOutputRequirements): string {
  if (!requirements.requiresJsonObject) return "";

  const lines = [
    "Final output format: Return only one top-level JSON object for this socket adapter. Do not include markdown fences, prose, commentary, or explanations.",
    "Emit only the fields relevant to this socket's configured placement, routing, and assignments. Do not emit the full canonical handoff envelope unless the local prompt explicitly asks for it.",
  ];

  const requiredFields = requirements.requiredFields.map((requirement) => `- ${JSON.stringify(requirement.field)} at ${requirement.path}: ${requirement.type}. ${requirement.reason}`);
  if (requiredFields.length > 0) lines.push("Required payload fields:", ...requiredFields);

  if (requirements.requiredFields.some((requirement) => requirement.field === HANDOFF_WORK_ITEMS_FIELD)) {
    lines.push(`For generated or planned work, emit required top-level ${JSON.stringify(HANDOFF_WORK_ITEMS_FIELD)} at $.${HANDOFF_WORK_ITEMS_FIELD} as an array of work-item objects; do not place generated units in tasks or other fields.`);
    lines.push("Put item-specific architecture direction in each workItem.context.architecture; do not invent sibling architecture fields for it.");
    lines.push(`Include ${JSON.stringify(HANDOFF_SUMMARY_FIELD)} only when a concise summary is useful downstream or explicitly requested by the local prompt.`);
    lines.push(`Include top-level ${JSON.stringify(HANDOFF_GUIDANCE_FIELD)}, ${JSON.stringify(HANDOFF_DECISIONS_FIELD)}, or ${JSON.stringify(HANDOFF_RISKS_FIELD)} only for cross-cutting information when the local prompt explicitly requests them or this socket lists those payload paths as consumed.`);
  }

  const consumedPaths = requirements.consumedPayloadPaths.map((path) => `- ${path.payloadPath} for assignment to ${path.targetPath}.`);
  if (consumedPaths.length > 0) lines.push("Payload paths consumed by this socket:", ...consumedPaths);

  const reservedRequiredRules = requirements.reservedFieldTypeRules
    .filter((rule) => rule.required)
    .map((rule) => `- ${JSON.stringify(rule.field)} must be ${articleForType(rule.type)} ${rule.type}.`);
  if (reservedRequiredRules.length > 0) lines.push("Required reserved field types:", ...reservedRequiredRules);

  return lines.join("\n");
}

function articleForType(type: string): string {
  return /^[aeiou]/i.test(type) ? "an" : "a";
}

export const HANDOFF_CONTRACT_DOC_TEXT = [
  "A pi-materia handoff is runtime-carried JSON state consumed by socket adapters for assignment, routing, advancement, prompts, and artifacts. JSON-parsed sockets emit sparse JSON payloads containing only fields relevant to their configured role and socket placement; runtime merges those payloads into canonical state.",
  "The canonical runtime state fields are summary, workItems, guidance, decisions, risks, satisfied, feedback, and missing. Exact scopes: summary is an optional concise cross-cutting summary; workItems is the optional top-level array for generated or refined work units; guidance is optional cross-cutting guidance only when socket-relevant or explicitly requested; decisions is optional cross-cutting decision records only when socket-relevant or explicitly requested; risks is optional cross-cutting risks only when socket-relevant or explicitly requested; satisfied is a reserved evaluator/route-owned boolean for graph control; feedback is a reserved evaluator-owned string for route/evaluation feedback, not a general guidance channel; missing is a reserved evaluator-owned array of missing items, not a general guidance channel.",
  "Generated units of work use workItems, not tasks. Generated units belong only in top-level workItems, not task, work, architectureGuidance, top-level architecture, or other aliases. Do not emit architectureGuidance or top-level architecture as canonical handoff fields.",
  "Each workItem has id, title, description, acceptance, and context fields. Item-specific architecture direction belongs in workItems[].context.architecture; item constraints, dependencies, and risks belong in workItems[].context.constraints, workItems[].context.dependencies, and workItems[].context.risks respectively. Top-level guidance, decisions, and risks are only for cross-cutting information when socket-relevant or explicitly requested.",
  `Reserved evaluator/route fields (${HANDOFF_RESERVED_EVALUATOR_FIELDS.map((field) => JSON.stringify(field)).join(", ")}) are owned by evaluator and graph-flow adapters and must not be repurposed by general payload logic or used as general guidance channels.`,
  `The reserved control field ${JSON.stringify(HANDOFF_SATISFIED_FIELD)} is the only canonical satisfaction field. It is required by sockets whose graph control flow depends on satisfied/not_satisfied semantics and must be a boolean when present.`,
  HANDOFF_RESERVED_FIELD_TYPE_PROMPT_TEXT,
  `Legacy aliases (${HANDOFF_LEGACY_NON_CANONICAL_ALIASES.map((field) => JSON.stringify(field)).join(", ")}) are not canonical handoff fields. Any compatibility behavior for them must be explicitly documented as obsolete outside the canonical field list.`,
].join("\n\n");

void HANDOFF_EDGE_CONDITIONS;
