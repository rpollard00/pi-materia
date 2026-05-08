import type { MateriaEdgeCondition } from "./types.js";

export const HANDOFF_SUMMARY_FIELD = "summary" as const;
export const HANDOFF_WORK_ITEMS_FIELD = "workItems" as const;
export const HANDOFF_GUIDANCE_FIELD = "guidance" as const;
export const HANDOFF_DECISIONS_FIELD = "decisions" as const;
export const HANDOFF_RISKS_FIELD = "risks" as const;
export const HANDOFF_SATISFIED_FIELD = "satisfied" as const;
export const HANDOFF_FEEDBACK_FIELD = "feedback" as const;
export const HANDOFF_MISSING_FIELD = "missing" as const;

export const HANDOFF_ENVELOPE_FIELDS = [
  HANDOFF_SUMMARY_FIELD,
  HANDOFF_WORK_ITEMS_FIELD,
  HANDOFF_GUIDANCE_FIELD,
  HANDOFF_DECISIONS_FIELD,
  HANDOFF_RISKS_FIELD,
  HANDOFF_SATISFIED_FIELD,
  HANDOFF_FEEDBACK_FIELD,
  HANDOFF_MISSING_FIELD,
] as const;

export const HANDOFF_RESERVED_CONTROL_FIELDS = [
  HANDOFF_SATISFIED_FIELD,
] as const;

export const HANDOFF_RESERVED_EVALUATOR_FIELDS = [
  HANDOFF_SATISFIED_FIELD,
  HANDOFF_FEEDBACK_FIELD,
  HANDOFF_MISSING_FIELD,
] as const;

export type HandoffEnvelopeField = typeof HANDOFF_ENVELOPE_FIELDS[number];
export type HandoffReservedControlField = typeof HANDOFF_RESERVED_CONTROL_FIELDS[number];
export type HandoffReservedEvaluatorField = typeof HANDOFF_RESERVED_EVALUATOR_FIELDS[number];

export const HANDOFF_WORK_ITEM_FIELDS = [
  "id",
  "title",
  "description",
  "acceptance",
  "context",
] as const;

export const HANDOFF_WORK_ITEM_CONTEXT_FIELDS = [
  "architecture",
  "constraints",
  "dependencies",
  "risks",
] as const;

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

export const HANDOFF_ALWAYS_EDGE_CONDITION = "always" as const;
export const HANDOFF_SATISFIED_EDGE_CONDITION = "satisfied" as const;
export const HANDOFF_NOT_SATISFIED_EDGE_CONDITION = "not_satisfied" as const;

export const HANDOFF_EDGE_CONDITIONS = [
  HANDOFF_ALWAYS_EDGE_CONDITION,
  HANDOFF_SATISFIED_EDGE_CONDITION,
  HANDOFF_NOT_SATISFIED_EDGE_CONDITION,
] as const satisfies readonly MateriaEdgeCondition[];

export const HANDOFF_LEGACY_NON_CANONICAL_ALIASES = [
  "passed",
] as const;

export const HANDOFF_ENVELOPE_EXAMPLE: HandoffEnvelope = {
  [HANDOFF_SUMMARY_FIELD]: "",
  [HANDOFF_WORK_ITEMS_FIELD]: [],
  [HANDOFF_GUIDANCE_FIELD]: {},
  [HANDOFF_DECISIONS_FIELD]: [],
  [HANDOFF_RISKS_FIELD]: [],
  [HANDOFF_SATISFIED_FIELD]: false,
  [HANDOFF_FEEDBACK_FIELD]: "",
  [HANDOFF_MISSING_FIELD]: [],
};

export const HANDOFF_WORK_ITEM_EXAMPLE: HandoffWorkItem = {
  id: "",
  title: "",
  description: "",
  acceptance: [],
  context: {
    architecture: "",
    constraints: [],
    dependencies: [],
    risks: [],
  },
};

export type HandoffEnvelopeInit = Partial<HandoffEnvelope>;
export type HandoffObject = Record<string, unknown>;
export type PartialHandoffEnvelope = Partial<Record<HandoffEnvelopeField, unknown>>;

export function createHandoffEnvelope(init: HandoffEnvelopeInit = {}): HandoffEnvelope {
  return {
    ...HANDOFF_ENVELOPE_EXAMPLE,
    ...init,
    [HANDOFF_WORK_ITEMS_FIELD]: init[HANDOFF_WORK_ITEMS_FIELD] ?? [],
    [HANDOFF_GUIDANCE_FIELD]: init[HANDOFF_GUIDANCE_FIELD] ?? {},
    [HANDOFF_DECISIONS_FIELD]: init[HANDOFF_DECISIONS_FIELD] ?? [],
    [HANDOFF_RISKS_FIELD]: init[HANDOFF_RISKS_FIELD] ?? [],
    [HANDOFF_MISSING_FIELD]: init[HANDOFF_MISSING_FIELD] ?? [],
  };
}

export function pickHandoffEnvelopeFields(value: HandoffObject): PartialHandoffEnvelope {
  const envelope: PartialHandoffEnvelope = {};
  for (const field of HANDOFF_ENVELOPE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field)) envelope[field] = value[field];
  }
  return envelope;
}

export function hasHandoffEnvelopeField(value: HandoffObject): boolean {
  return HANDOFF_ENVELOPE_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(value, field));
}

export function createPartialHandoffEnvelope(init: PartialHandoffEnvelope = {}): PartialHandoffEnvelope {
  return pickHandoffEnvelopeFields(init);
}

export function createDeterministicHandoffOutput<T extends HandoffObject>(init: T): T {
  // Deterministic utilities may emit local extension fields such as diagnostics or
  // command-specific values. Preserve those fields, but normalize any canonical
  // handoff fields through the shared contract so utilities do not define a
  // separate envelope shape.
  if (!hasHandoffEnvelopeField(init)) return init;
  return { ...init, ...createPartialHandoffEnvelope(init) };
}

export function stringifyDeterministicHandoffOutput(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return JSON.stringify(createDeterministicHandoffOutput(value as HandoffObject));
  }
  return JSON.stringify(value);
}

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
  return JSON.stringify({
    id: "string",
    title: "string",
    description: "string",
    acceptance: "string[]",
    context: {
      architecture: "string",
      constraints: "string[]",
      dependencies: "string[]",
      risks: "string[]",
    },
  });
}

export const HANDOFF_CONTRACT_PROMPT_TEXT = [
  "pi-materia canonical handoff JSON contract:",
  `- JSON-parsed agent materia should return the generic handoff envelope when applicable: ${formatHandoffEnvelopeShape()}.`,
  `- Generated units of work belong in workItems, never tasks. Each work item has: ${formatHandoffWorkItemShape()}.`,
  "- Preserve useful existing summary, workItems, guidance, decisions, risks, feedback, and missing context when planning, refining, or evaluating an existing envelope; augment fields instead of replacing them with placement-specific payloads.",
  "- If older prompts, examples, adapter metadata, or cast state mention tasks, treat that as legacy placement terminology and still emit generated work units as workItems in the generic envelope.",
  `- Reserved evaluator/route fields are owned by evaluator and graph-flow adapters: ${HANDOFF_RESERVED_EVALUATOR_FIELDS.map((field) => JSON.stringify(field)).join(", ")}. Do not repurpose them for general payload data.`,
  `- ${JSON.stringify(HANDOFF_SATISFIED_FIELD)} is the canonical boolean control field for satisfied/not_satisfied routing and advancement. Use it only when a node participates in that control flow, and return a real boolean value when present.`,
  "- Node-specific payload fields may be requested by a local prompt for assignments, artifacts, or diagnostics. Compose them with the generic envelope; payload fields must not redefine or alias reserved evaluator/route semantics.",
  "- Do not invent alternate routing booleans. Legacy names such as \"passed\" are not canonical handoff fields.",
  "- When a node is asked for JSON output, return only the handoff JSON object with no markdown fences, prose, or extra commentary.",
].join("\n");

export function formatHandoffJsonFinalInstruction(): string {
  return [
    "Final output format: Return only JSON for this node, with no markdown fences, prose, or extra commentary. Follow the central handoff contract below; if local prompt wording or adapter metadata mentions legacy placement fields such as tasks, interpret that context and still emit generated work units as workItems. Preserve and augment useful existing envelope context from Generic cast data or Previous output when applicable.",
    HANDOFF_CONTRACT_PROMPT_TEXT,
  ].join("\n\n");
}

export const HANDOFF_CONTRACT_DOC_TEXT = [
  "A pi-materia handoff message is a generic JSON envelope produced by a JSON-parsed node and consumed by node/socket adapters for assignment, routing, advancement, prompts, and artifacts.",
  "The canonical envelope fields are summary, workItems, guidance, decisions, risks, satisfied, feedback, and missing. Generated units of work use workItems, not tasks.",
  "Each workItem has id, title, description, acceptance, and context fields; context carries optional architecture guidance plus constraints, dependencies, and risks arrays.",
  `Reserved evaluator/route fields (${HANDOFF_RESERVED_EVALUATOR_FIELDS.map((field) => JSON.stringify(field)).join(", ")}) are owned by evaluator and graph-flow adapters and must not be repurposed by general payload logic.`,
  `The reserved control field ${JSON.stringify(HANDOFF_SATISFIED_FIELD)} is the only canonical satisfaction field. It is required by nodes whose graph control flow depends on satisfied/not_satisfied semantics and must be a boolean when present.`,
  `Legacy aliases (${HANDOFF_LEGACY_NON_CANONICAL_ALIASES.map((field) => JSON.stringify(field)).join(", ")}) are not canonical handoff fields. Any compatibility behavior for them must be explicitly documented as migration-only outside the canonical field list.`,
].join("\n\n");
