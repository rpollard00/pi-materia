import type { MateriaEdgeCondition } from "./types.js";

export const HANDOFF_SATISFIED_FIELD = "satisfied" as const;

export const HANDOFF_RESERVED_CONTROL_FIELDS = [
  HANDOFF_SATISFIED_FIELD,
] as const;

export type HandoffReservedControlField = typeof HANDOFF_RESERVED_CONTROL_FIELDS[number];

export const HANDOFF_EDGE_CONDITIONS = [
  "always",
  "satisfied",
  "not_satisfied",
] as const satisfies readonly MateriaEdgeCondition[];

export const HANDOFF_LEGACY_NON_CANONICAL_ALIASES = [
  "passed",
] as const;

export const HANDOFF_CONTRACT_PROMPT_TEXT = [
  "pi-materia canonical handoff JSON contract:",
  "- JSON-parsed node output is a flat handoff message object.",
  `- Reserved control fields are owned by pi-materia runtime: ${HANDOFF_RESERVED_CONTROL_FIELDS.map((field) => JSON.stringify(field)).join(", ")}.`,
  `- ${JSON.stringify(HANDOFF_SATISFIED_FIELD)} is the canonical boolean control field for satisfied/not_satisfied routing and advancement. Use it only when a node participates in that control flow, and return a real boolean value when present.`,
  "- Materia may include arbitrary additional payload fields for downstream prompts, assignments, artifacts, or diagnostics. Payload fields must not redefine or alias reserved control semantics.",
  "- Do not invent alternate routing booleans. Legacy names such as \"passed\" are not canonical handoff fields.",
  "- When a node is asked for JSON output, return only the handoff JSON object with no markdown fences, prose, or extra commentary.",
].join("\n");

export const HANDOFF_CONTRACT_DOC_TEXT = [
  "A pi-materia handoff message is a flat JSON object produced by a JSON-parsed node and consumed by assignments, routing, advancement, prompts, and artifacts.",
  `The reserved control field ${JSON.stringify(HANDOFF_SATISFIED_FIELD)} is the only canonical satisfaction field. It is required by nodes whose graph control flow depends on satisfied/not_satisfied semantics and must be a boolean when present.`,
  "All other top-level fields are arbitrary materia payload fields unless pi-materia reserves them in this module in the future.",
  "Payload fields may carry task lists, feedback, diagnostics, checkpoint metadata, or any user-defined data, but they must not be treated as alternate routing/control fields.",
  `Legacy aliases (${HANDOFF_LEGACY_NON_CANONICAL_ALIASES.map((field) => JSON.stringify(field)).join(", ")}) are not canonical handoff fields. Any compatibility behavior for them must be explicitly documented as migration-only outside the canonical field list.`,
].join("\n\n");
