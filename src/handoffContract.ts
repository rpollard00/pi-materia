import type { MateriaEdgeCondition } from "./types.js";

export const HANDOFF_SATISFIED_FIELD = "satisfied" as const;

export const HANDOFF_FEEDBACK_FIELD = "feedback" as const;
export const HANDOFF_MISSING_FIELD = "missing" as const;

export const HANDOFF_RESERVED_CONTROL_FIELDS = [
  HANDOFF_SATISFIED_FIELD,
] as const;

export const HANDOFF_RESERVED_EVALUATOR_FIELDS = [
  HANDOFF_SATISFIED_FIELD,
  HANDOFF_FEEDBACK_FIELD,
  HANDOFF_MISSING_FIELD,
] as const;

export type HandoffReservedControlField = typeof HANDOFF_RESERVED_CONTROL_FIELDS[number];
export type HandoffReservedEvaluatorField = typeof HANDOFF_RESERVED_EVALUATOR_FIELDS[number];

export interface HandoffWorkItemContext {
  architecture?: string;
  constraints: string[];
  dependencies: string[];
  risks: string[];
}

export interface HandoffWorkItem {
  id: string;
  title: string;
  description: string;
  acceptance: string[];
  context: HandoffWorkItemContext;
}

export interface HandoffEnvelope {
  summary: string;
  workItems: HandoffWorkItem[];
  guidance: Record<string, unknown>;
  decisions: unknown[];
  risks: unknown[];
  satisfied: boolean;
  feedback: string;
  missing: unknown[];
}

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
  "- JSON-parsed agent materia should return the generic handoff envelope when applicable: { \"summary\": string, \"workItems\": [], \"guidance\": {}, \"decisions\": [], \"risks\": [], \"satisfied\": boolean, \"feedback\": string, \"missing\": [] }.",
  "- Generated units of work belong in workItems, never tasks. Each work item has: { \"id\": string, \"title\": string, \"description\": string, \"acceptance\": string[], \"context\": { \"architecture\": string, \"constraints\": string[], \"dependencies\": string[], \"risks\": string[] } }.",
  "- Preserve useful existing summary, workItems, guidance, decisions, risks, feedback, and missing context when planning, refining, or evaluating an existing envelope; augment fields instead of replacing them with placement-specific payloads.",
  "- If older prompts, examples, adapter metadata, or cast state mention tasks, treat that as legacy placement terminology and still emit generated work units as workItems in the generic envelope.",
  `- Reserved evaluator/route fields are owned by evaluator and graph-flow adapters: ${HANDOFF_RESERVED_EVALUATOR_FIELDS.map((field) => JSON.stringify(field)).join(", ")}. Do not repurpose them for general payload data.`,
  `- ${JSON.stringify(HANDOFF_SATISFIED_FIELD)} is the canonical boolean control field for satisfied/not_satisfied routing and advancement. Use it only when a node participates in that control flow, and return a real boolean value when present.`,
  "- Materia may include additional payload inside the generic envelope fields for downstream prompts, assignments, artifacts, or diagnostics. Payload fields must not redefine or alias reserved evaluator/route semantics.",
  "- Do not invent alternate routing booleans. Legacy names such as \"passed\" are not canonical handoff fields.",
  "- When a node is asked for JSON output, return only the handoff JSON object with no markdown fences, prose, or extra commentary.",
].join("\n");

export const HANDOFF_CONTRACT_DOC_TEXT = [
  "A pi-materia handoff message is a generic JSON envelope produced by a JSON-parsed node and consumed by node/socket adapters for assignment, routing, advancement, prompts, and artifacts.",
  "The canonical envelope fields are summary, workItems, guidance, decisions, risks, satisfied, feedback, and missing. Generated units of work use workItems, not tasks.",
  "Each workItem has id, title, description, acceptance, and context fields; context carries optional architecture guidance plus constraints, dependencies, and risks arrays.",
  `Reserved evaluator/route fields (${HANDOFF_RESERVED_EVALUATOR_FIELDS.map((field) => JSON.stringify(field)).join(", ")}) are owned by evaluator and graph-flow adapters and must not be repurposed by general payload logic.`,
  `The reserved control field ${JSON.stringify(HANDOFF_SATISFIED_FIELD)} is the only canonical satisfaction field. It is required by nodes whose graph control flow depends on satisfied/not_satisfied semantics and must be a boolean when present.`,
  `Legacy aliases (${HANDOFF_LEGACY_NON_CANONICAL_ALIASES.map((field) => JSON.stringify(field)).join(", ")}) are not canonical handoff fields. Any compatibility behavior for them must be explicitly documented as migration-only outside the canonical field list.`,
].join("\n\n");
