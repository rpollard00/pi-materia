import { err, ok, type DomainIssue, type DomainResult } from "./result.js";

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

export const HANDOFF_RESERVED_CONTROL_FIELDS = [HANDOFF_SATISFIED_FIELD] as const;
export const HANDOFF_RESERVED_EVALUATOR_FIELDS = [HANDOFF_SATISFIED_FIELD, HANDOFF_FEEDBACK_FIELD, HANDOFF_MISSING_FIELD] as const;

export type HandoffEnvelopeField = typeof HANDOFF_ENVELOPE_FIELDS[number];
export type HandoffReservedControlField = typeof HANDOFF_RESERVED_CONTROL_FIELDS[number];
export type HandoffReservedEvaluatorField = typeof HANDOFF_RESERVED_EVALUATOR_FIELDS[number];

export const HANDOFF_WORK_ITEM_FIELDS = ["id", "title", "description", "acceptance", "context"] as const;
export const HANDOFF_WORK_ITEM_CONTEXT_FIELDS = ["architecture", "constraints", "dependencies", "risks"] as const;

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

export const HANDOFF_EDGE_CONDITIONS = [HANDOFF_ALWAYS_EDGE_CONDITION, HANDOFF_SATISFIED_EDGE_CONDITION, HANDOFF_NOT_SATISFIED_EDGE_CONDITION] as const;
export type HandoffEdgeCondition = typeof HANDOFF_EDGE_CONDITIONS[number];

export const HANDOFF_LEGACY_NON_CANONICAL_ALIASES = ["passed"] as const;

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
  if (!hasHandoffEnvelopeField(init)) return init;
  return { ...init, ...createPartialHandoffEnvelope(init) };
}

export function stringifyDeterministicHandoffOutput(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) return JSON.stringify(createDeterministicHandoffOutput(value as HandoffObject));
  return JSON.stringify(value);
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

export function parseHandoffWorkItem(value: unknown, path = "workItems[]"): DomainResult<HandoffWorkItem> {
  if (!isPlainObject(value)) return err(path, "work item must be an object");
  const issues: DomainIssue[] = [];
  const id = value.id;
  const title = value.title;
  const description = value.description;
  const acceptance = value.acceptance;
  const context = value.context;
  if (!isNonEmptyString(id)) issues.push({ path: `${path}.id`, message: "id is required" });
  if (!isNonEmptyString(title)) issues.push({ path: `${path}.title`, message: "title is required" });
  if (!isNonEmptyString(description)) issues.push({ path: `${path}.description`, message: "description is required" });
  if (!isStringArray(acceptance)) issues.push({ path: `${path}.acceptance`, message: "acceptance must be a string array" });
  if (!isPlainObject(context)) {
    issues.push({ path: `${path}.context`, message: "context is required" });
  } else {
    if (context.architecture !== undefined && typeof context.architecture !== "string") issues.push({ path: `${path}.context.architecture`, message: "architecture must be a string when present" });
    for (const field of ["constraints", "dependencies", "risks"] as const) {
      if (!isStringArray(context[field])) issues.push({ path: `${path}.context.${field}`, message: `${field} must be a string array` });
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return ok({
    id: id as string,
    title: title as string,
    description: description as string,
    acceptance: acceptance as string[],
    context: {
      ...((context as HandoffWorkItemContext).architecture === undefined ? {} : { architecture: (context as HandoffWorkItemContext).architecture }),
      constraints: (context as HandoffWorkItemContext).constraints,
      dependencies: (context as HandoffWorkItemContext).dependencies,
      risks: (context as HandoffWorkItemContext).risks,
    },
  });
}

export function validateReservedHandoffFields(value: Record<string, unknown>, path = "$", options: { requiresSatisfied?: boolean } = {}): DomainResult<void> {
  const issues: DomainIssue[] = [];
  if (Object.prototype.hasOwnProperty.call(value, HANDOFF_SATISFIED_FIELD) && typeof value[HANDOFF_SATISFIED_FIELD] !== "boolean") issues.push({ path: `${path}.${HANDOFF_SATISFIED_FIELD}`, message: "reserved control field must be a boolean when present" });
  if (Object.prototype.hasOwnProperty.call(value, HANDOFF_FEEDBACK_FIELD) && typeof value[HANDOFF_FEEDBACK_FIELD] !== "string") issues.push({ path: `${path}.${HANDOFF_FEEDBACK_FIELD}`, message: "reserved evaluator field must be a string when present" });
  if (Object.prototype.hasOwnProperty.call(value, HANDOFF_MISSING_FIELD) && !Array.isArray(value[HANDOFF_MISSING_FIELD])) issues.push({ path: `${path}.${HANDOFF_MISSING_FIELD}`, message: "reserved evaluator field must be an array when present" });
  if (options.requiresSatisfied && !Object.prototype.hasOwnProperty.call(value, HANDOFF_SATISFIED_FIELD)) issues.push({ path, message: `reserved boolean field ${JSON.stringify(HANDOFF_SATISFIED_FIELD)} is required for satisfied/not_satisfied routing` });
  return issues.length > 0 ? { ok: false, issues } : ok(undefined);
}

export function isHandoffEdgeCondition(value: unknown): value is HandoffEdgeCondition {
  return typeof value === "string" && (HANDOFF_EDGE_CONDITIONS as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
