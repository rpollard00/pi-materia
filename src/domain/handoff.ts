import { err, ok, type DomainIssue, type DomainResult } from "./result.js";

export const HANDOFF_WORK_ITEMS_FIELD = "workItems" as const;
export const HANDOFF_SATISFIED_FIELD = "satisfied" as const;
export const HANDOFF_CONTEXT_FIELD = "context" as const;
/**
 * Canonical renderable text payload: the materia's primary user-facing prose
 * output (e.g. narration, notes, descriptions). The raw JSON value is
 * authoritative; TUI rendering is a one-way presentation layer. Downstream
 * materia may consume it via assignment (e.g. `$.text`) or state references.
 */
export const HANDOFF_TEXT_FIELD = "text" as const;

/** Top-level fields authored by agent JSON handoffs. */
export const HANDOFF_ENVELOPE_FIELDS = [
  HANDOFF_WORK_ITEMS_FIELD,
  HANDOFF_SATISFIED_FIELD,
  HANDOFF_CONTEXT_FIELD,
  HANDOFF_TEXT_FIELD,
] as const;

export const HANDOFF_RESERVED_CONTROL_FIELDS = [
  HANDOFF_SATISFIED_FIELD,
] as const;
export const HANDOFF_RESERVED_EVALUATOR_FIELDS = [
  HANDOFF_SATISFIED_FIELD,
] as const;

export type HandoffEnvelopeField = (typeof HANDOFF_ENVELOPE_FIELDS)[number];
export type HandoffReservedControlField =
  (typeof HANDOFF_RESERVED_CONTROL_FIELDS)[number];
export type HandoffReservedEvaluatorField =
  (typeof HANDOFF_RESERVED_EVALUATOR_FIELDS)[number];

export const HANDOFF_WORK_ITEM_FIELDS = ["title", "context"] as const;

export interface HandoffWorkItem {
  title: string;
  context: string;
}

export interface HandoffEnvelope {
  workItems: HandoffWorkItem[];
  satisfied: boolean;
  context: string;
  /** Canonical renderable text payload (authoritative prose output). */
  text: string;
}

export const HANDOFF_ALWAYS_EDGE_CONDITION = "always" as const;
export const HANDOFF_SATISFIED_EDGE_CONDITION = "satisfied" as const;
export const HANDOFF_NOT_SATISFIED_EDGE_CONDITION = "not_satisfied" as const;

export const HANDOFF_EDGE_CONDITIONS = [
  HANDOFF_ALWAYS_EDGE_CONDITION,
  HANDOFF_SATISFIED_EDGE_CONDITION,
  HANDOFF_NOT_SATISFIED_EDGE_CONDITION,
] as const;
export type HandoffEdgeCondition = (typeof HANDOFF_EDGE_CONDITIONS)[number];

export const HANDOFF_LEGACY_NON_CANONICAL_ALIASES = ["passed"] as const;

export const HANDOFF_ENVELOPE_EXAMPLE: HandoffEnvelope = {
  [HANDOFF_WORK_ITEMS_FIELD]: [],
  [HANDOFF_SATISFIED_FIELD]: false,
  [HANDOFF_CONTEXT_FIELD]: "",
  [HANDOFF_TEXT_FIELD]: "",
};

export const HANDOFF_WORK_ITEM_EXAMPLE: HandoffWorkItem = {
  title: "",
  context: "",
};

export type HandoffEnvelopeInit = Partial<HandoffEnvelope>;
export type HandoffObject = Record<string, unknown>;
export type PartialHandoffEnvelope = Partial<
  Record<HandoffEnvelopeField, unknown>
>;

export function createHandoffEnvelope(
  init: HandoffEnvelopeInit = {},
): HandoffEnvelope {
  return {
    ...HANDOFF_ENVELOPE_EXAMPLE,
    ...init,
    [HANDOFF_WORK_ITEMS_FIELD]: init[HANDOFF_WORK_ITEMS_FIELD] ?? [],
    [HANDOFF_CONTEXT_FIELD]: init[HANDOFF_CONTEXT_FIELD] ?? "",
    [HANDOFF_TEXT_FIELD]: init[HANDOFF_TEXT_FIELD] ?? "",
  };
}

export function pickHandoffEnvelopeFields(
  value: HandoffObject,
): PartialHandoffEnvelope {
  const envelope: PartialHandoffEnvelope = {};
  for (const field of HANDOFF_ENVELOPE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field))
      envelope[field] = value[field];
  }
  return envelope;
}

export function hasHandoffEnvelopeField(value: HandoffObject): boolean {
  return HANDOFF_ENVELOPE_FIELDS.some((field) =>
    Object.prototype.hasOwnProperty.call(value, field),
  );
}

export function createPartialHandoffEnvelope(
  init: PartialHandoffEnvelope = {},
): PartialHandoffEnvelope {
  return pickHandoffEnvelopeFields(init);
}

export function createDeterministicHandoffOutput<T extends HandoffObject>(
  init: T,
): T {
  if (!hasHandoffEnvelopeField(init)) return init;
  return { ...init, ...createPartialHandoffEnvelope(init) };
}

export function stringifyDeterministicHandoffOutput(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value))
    return JSON.stringify(
      createDeterministicHandoffOutput(value as HandoffObject),
    );
  return JSON.stringify(value);
}

export function formatHandoffWorkItemShape(): string {
  return JSON.stringify({
    title: "string",
    context: "string",
  });
}

export function parseHandoffWorkItem(
  value: unknown,
  path = "workItems[]",
): DomainResult<HandoffWorkItem> {
  if (!isPlainObject(value)) return err(path, "work item must be an object");
  const issues: DomainIssue[] = [];
  const allowedFields = new Set<string>([...HANDOFF_WORK_ITEM_FIELDS, "id"]);
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field))
      issues.push({ path: `${path}.${field}`, message: `unexpected work item field ${JSON.stringify(field)}` });
  }
  const title = value.title;
  const context = value.context;
  if (!isNonEmptyString(title))
    issues.push({ path: `${path}.title`, message: "title is required" });
  if (!isNonEmptyString(context))
    issues.push({ path: `${path}.context`, message: "context is required" });
  if (issues.length > 0) return { ok: false, issues };
  return ok({
    title: title as string,
    context: context as string,
  });
}

export function validateReservedHandoffFields(
  value: Record<string, unknown>,
  path = "$",
  options: { requiresSatisfied?: boolean } = {},
): DomainResult<void> {
  const issues: DomainIssue[] = [];
  if (
    Object.prototype.hasOwnProperty.call(value, HANDOFF_SATISFIED_FIELD) &&
    typeof value[HANDOFF_SATISFIED_FIELD] !== "boolean"
  )
    issues.push({
      path: `${path}.${HANDOFF_SATISFIED_FIELD}`,
      message: "reserved control field must be a boolean when present",
    });
  if (
    options.requiresSatisfied &&
    !Object.prototype.hasOwnProperty.call(value, HANDOFF_SATISFIED_FIELD)
  )
    issues.push({
      path,
      message: `reserved boolean field ${JSON.stringify(HANDOFF_SATISFIED_FIELD)} is required for satisfied/not_satisfied routing`,
    });
  return issues.length > 0 ? { ok: false, issues } : ok(undefined);
}

export function isHandoffEdgeCondition(
  value: unknown,
): value is HandoffEdgeCondition {
  return (
    typeof value === "string" &&
    (HANDOFF_EDGE_CONDITIONS as readonly string[]).includes(value)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
