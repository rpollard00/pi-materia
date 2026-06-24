/**
 * Model policy contracts and pure selection evaluation
 * (docs/enterprise-control-plane.md §11).
 *
 * Pure domain layer: no HTTP, OAuth, persistence, WebUI, runtime-adapter, or
 * model-registry dependencies. The local Pi model registry is treated as the
 * **available-runtime** source of truth: callers read it and pass the available
 * model values into the evaluation. This module only decides how a policy
 * constrains selection given that runtime availability.
 *
 * Constraint semantics (§11):
 * - **deny** is hard. Denied models must not be selected.
 * - **allow** constrains the selectable set to listed models.
 * - **prefer** is advisory. Preferred models are suggested; the evaluation warns
 *   or falls back when a preferred central model is unavailable locally.
 * - **thinking** constrains thinking-level selection where required.
 *
 * Invariants encoded here:
 * - When no policy (or a constraint-free policy) is configured, evaluation is a
 *   no-op (`unconstrained: true`) so existing local selection is preserved.
 * - Model denial is the only hard block. Thinking violations always produce a
 *   clamp suggestion rather than blocking a cast; preferred-unavailable is a
 *   warning, never a hard failure.
 *
 * The application layer (`src/application/controlPlane.ts`) re-exports these
 * contracts as the stable control-plane DTO surface and adds the
 * `ModelPolicyPort` (application-level port). Enforcement integration with the
 * local model selection flow is a separate work item (§16.14).
 */
import {
  MATERIA_THINKING_LEVELS,
  isMateriaThinkingLevel,
  type MateriaThinkingLevel,
} from "./thinking.js";

// ───────────────────────────────────────────────────────────────────────
// Document shape
// ───────────────────────────────────────────────────────────────────────

/** A model reference by its local Pi model-registry value (e.g. "zai/glm-4.6"). */
export interface ModelPolicyModelRef {
  value: string;
  label?: string;
}

/** Thinking-level constraint applied to model selection. */
export interface ModelPolicyThinkingConstraint {
  /** Allowed thinking levels; when present, selection is constrained to these. */
  allow?: readonly MateriaThinkingLevel[];
  /** Maximum thinking level allowed, inclusive. */
  max?: MateriaThinkingLevel;
}

/** How a policy violation is treated when it cannot be satisfied exactly. */
export type ModelPolicySeverity = "advisory" | "enforced";

export const MODEL_POLICY_SEVERITIES = ["advisory", "enforced"] as const;

export function isModelPolicySeverity(value: unknown): value is ModelPolicySeverity {
  return typeof value === "string" && (MODEL_POLICY_SEVERITIES as readonly string[]).includes(value);
}

/**
 * A model-policy document. Constraints map to §11 behavior:
 * - `deny` is hard (denied models must not be selected);
 * - `allow` constrains the selectable set;
 * - `prefer` is advisory (warn/fallback when unavailable locally);
 * - `thinking` constrains thinking-level selection where required.
 *
 * The local Pi model registry remains the available-runtime source of truth.
 * When no policy is configured, existing local selection behavior is preserved.
 */
export interface ModelPolicyDocument {
  id: string;
  name?: string;
  description?: string;
  /** Allowed model values; when present, selection is constrained to these. */
  allow?: readonly ModelPolicyModelRef[];
  /** Denied model values; hard exclusion. */
  deny?: readonly ModelPolicyModelRef[];
  /** Preferred model values; advisory unless available and allowed. */
  prefer?: readonly ModelPolicyModelRef[];
  thinking?: ModelPolicyThinkingConstraint;
  /** Default severity for unsatisfiable constraints. Per-constraint behavior follows §11. */
  severity?: ModelPolicySeverity;
  /** Central version of the policy document (provenance/drift). */
  version?: string;
  /** RFC3339 timestamp the policy was last updated centrally. */
  updatedAt?: string;
}

/** True when the document carries at least one constraining rule. */
export function policyHasConstraints(policy: ModelPolicyDocument | undefined): boolean {
  if (policy === undefined) return false;
  return (
    (policy.deny !== undefined && policy.deny.length > 0) ||
    (policy.allow !== undefined && policy.allow.length > 0) ||
    (policy.prefer !== undefined && policy.prefer.length > 0) ||
    policy.thinking !== undefined
  );
}

/** Resolve the effective severity; `enforced` is the default when unspecified. */
export function policySeverity(policy: ModelPolicyDocument | undefined): ModelPolicySeverity {
  return policy?.severity === "advisory" ? "advisory" : "enforced";
}

// ───────────────────────────────────────────────────────────────────────
// Low-level reference helpers (pure)
// ───────────────────────────────────────────────────────────────────────

/** True when a model value matches a policy reference list (exact value match). */
export function modelPolicyAllowsValue(refs: readonly ModelPolicyModelRef[] | undefined, value: string | undefined): boolean {
  if (refs === undefined || refs.length === 0) return true;
  if (value === undefined) return false;
  return refs.some((ref) => ref.value === value);
}

/** True when a model value is explicitly denied by a policy reference list. */
export function modelPolicyDeniesValue(refs: readonly ModelPolicyModelRef[] | undefined, value: string | undefined): boolean {
  if (refs === undefined || value === undefined) return false;
  return refs.some((ref) => ref.value === value);
}

/** True when a thinking level satisfies a thinking constraint; undefined constraint = always allowed. */
export function modelPolicyAllowsThinking(constraint: ModelPolicyThinkingConstraint | undefined, level: MateriaThinkingLevel | undefined): boolean {
  if (constraint === undefined) return true;
  if (constraint.allow !== undefined) {
    if (level === undefined) return false;
    if (!constraint.allow.includes(level)) return false;
  }
  if (constraint.max !== undefined && level !== undefined) {
    if (thinkingRank(level) > thinkingRank(constraint.max)) return false;
  }
  return true;
}

const THINKING_RANK: Record<MateriaThinkingLevel, number> = Object.fromEntries(
  MATERIA_THINKING_LEVELS.map((level, index) => [level, index]),
) as Record<MateriaThinkingLevel, number>;

function thinkingRank(level: MateriaThinkingLevel): number {
  return THINKING_RANK[level];
}

/**
 * Resolve a thinking level that satisfies the constraint, closest to the
 * candidate's intent. Used as the clamp suggestion when a candidate thinking
 * level violates the constraint. Returns `undefined` when no satisfying level
 * can be derived from the constraint.
 *
 * - When `allow` is present: the highest allowed level that is also `<= max`
 *   (preserving the most capable permitted intent). If `max` excludes every
 *   allowed level, falls back to the lowest allowed level.
 * - When only `max` is present: `max` (the candidate exceeded it).
 */
export function suggestThinkingLevel(
  constraint: ModelPolicyThinkingConstraint | undefined,
): MateriaThinkingLevel | undefined {
  if (constraint === undefined) return undefined;
  if (constraint.allow !== undefined && constraint.allow.length > 0) {
    const allowed = [...constraint.allow].sort((a, b) => thinkingRank(a) - thinkingRank(b));
    if (constraint.max !== undefined) {
      const withinCeiling = allowed.filter((level) => thinkingRank(level) <= thinkingRank(constraint.max as MateriaThinkingLevel));
      // Highest allowed level that also respects the ceiling. When the ceiling
      // excludes every allowed level the constraint is contradictory and no
      // level satisfies it; return undefined so callers surface a warning.
      if (withinCeiling.length > 0) return withinCeiling[withinCeiling.length - 1];
      return undefined;
    }
    return allowed[allowed.length - 1];
  }
  if (constraint.max !== undefined) return constraint.max;
  return undefined;
}

// ───────────────────────────────────────────────────────────────────────
// Guards
// ───────────────────────────────────────────────────────────────────────

/** Guard for a model reference value. */
export function isModelPolicyModelRef(value: unknown): value is ModelPolicyModelRef {
  if (!isPlainObject(value)) return false;
  return typeof value.value === "string" && value.value.trim().length > 0;
}

/** Guard for thinking constraint shape (used by policy DTO construction/validation). */
export function isModelPolicyThinkingConstraint(value: unknown): value is ModelPolicyThinkingConstraint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.allow !== undefined) {
    if (!Array.isArray(record.allow) || !record.allow.every((entry) => isMateriaThinkingLevel(entry))) return false;
  }
  if (record.max !== undefined && !isMateriaThinkingLevel(record.max)) return false;
  return true;
}

/**
 * Structural guard for a model-policy document. Provenance fields (`version`,
 * `updatedAt`) and presentation fields (`name`, `description`) are optional.
 * Reference lists, when present, must be arrays of valid refs. An invalid
 * document is rejected rather than partially applied.
 */
export function isValidModelPolicyDocument(value: unknown): value is ModelPolicyDocument {
  if (!isPlainObject(value)) return false;
  if (typeof value.id !== "string" || value.id.trim().length === 0) return false;
  if (value.name !== undefined && typeof value.name !== "string") return false;
  if (value.description !== undefined && typeof value.description !== "string") return false;
  if (value.severity !== undefined && !isModelPolicySeverity(value.severity)) return false;
  if (value.version !== undefined && typeof value.version !== "string") return false;
  if (value.updatedAt !== undefined && typeof value.updatedAt !== "string") return false;
  if (!isValidRefList(value.allow)) return false;
  if (!isValidRefList(value.deny)) return false;
  if (!isValidRefList(value.prefer)) return false;
  if (value.thinking !== undefined && !isModelPolicyThinkingConstraint(value.thinking)) return false;
  return true;
}

function isValidRefList(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((entry) => isModelPolicyModelRef(entry));
}

// ───────────────────────────────────────────────────────────────────────
// Available-runtime source (local Pi model registry)
// ───────────────────────────────────────────────────────────────────────

/**
 * A model value available in the local runtime, sourced from the local Pi model
 * registry. The registry is the available-runtime source of truth; this module
 * never reads it directly. `supportedThinkingLevels` is optional forward
 * metadata for richer selection; core evaluation only needs `value`.
 */
export interface AvailableRuntimeModel {
  value: string;
  supportedThinkingLevels?: readonly MateriaThinkingLevel[];
}

/** Factory for an available-runtime model entry (keeps `supportedThinkingLevels` optional). */
export function availableRuntimeModel(value: string, supportedThinkingLevels?: readonly MateriaThinkingLevel[]): AvailableRuntimeModel {
  const entry: AvailableRuntimeModel = { value };
  if (supportedThinkingLevels !== undefined) entry.supportedThinkingLevels = supportedThinkingLevels;
  return entry;
}

/** The set of model values a candidate selection may resolve against. */
export type AvailableRuntimeModels = readonly AvailableRuntimeModel[];

/** Coerce a plain list of model values into available-runtime entries. */
export function toAvailableRuntimeModels(values: readonly string[]): AvailableRuntimeModels {
  return values.map((value) => availableRuntimeModel(value));
}

function availableValues(available: AvailableRuntimeModels): Set<string> {
  return new Set(available.map((model) => model.value));
}

// ───────────────────────────────────────────────────────────────────────
// Selection evaluation (pure)
// ───────────────────────────────────────────────────────────────────────

/** A selection the runtime intends to use, evaluated against a policy. */
export interface ModelPolicyCandidate {
  /** Model value being evaluated (e.g. the materia-configured or active model). */
  modelValue: string;
  /** Thinking level being evaluated, when known. */
  thinkingLevel?: MateriaThinkingLevel;
}

/** Reason codes for a hard model denial. Thinking violations never hard-deny. */
export type ModelPolicyDenialReason =
  /** Candidate model is on the policy deny list. */
  | "model_denied"
  /** Candidate model is outside the policy allow list under enforced severity. */
  | "model_not_allowed";

/** An advisory preferred model that is available locally and allowed. */
export interface ModelPolicyPreferredSuggestion {
  modelValue: string;
}

export type ModelPolicyDecisionStatus = "allowed" | "denied";

/**
 * Pure evaluation of a candidate selection against a model policy, given the
 * models currently available in the local runtime. Carries no IO and never
 * mutates inputs.
 *
 * Outcomes:
 * - `status: "denied"` — the candidate **model** must not be selected. Only
 *   model constraints hard-deny (deny list; allow list under enforced severity).
 * - `status: "allowed"` — the candidate is permitted. Advisory signals ride
 *   alongside: `preferredSuggestion`, `suggestedThinkingLevel`, and `warnings`.
 * - `unconstrained: true` — no policy / no rules; callers must preserve existing
 *   local selection behavior exactly.
 *
 * Thinking violations never hard-deny: they yield a `suggestedThinkingLevel`
 * clamp (the nearest permitted level) plus a warning, so a thinking rule never
 * blocks a cast. Preferred models unavailable locally produce warnings only.
 */
export interface ModelPolicyEvaluation {
  status: ModelPolicyDecisionStatus;
  /** True when no policy constraints applied (passthrough). */
  unconstrained: boolean;
  /** Reason code for a hard model denial. */
  denialReason?: ModelPolicyDenialReason;
  /** Human-readable denial reason. */
  denialMessage?: string;
  /** Advisory: a preferred model that is available locally and allowed. */
  preferredSuggestion?: ModelPolicyPreferredSuggestion;
  /** Clamp suggestion when the candidate thinking violates the constraint. */
  suggestedThinkingLevel?: MateriaThinkingLevel;
  /** Advisory warnings (preferred-unavailable, advisory allow/thinking notices). */
  warnings: string[];
}

/** Evaluate a candidate selection against a policy (pure). */
export function evaluateModelPolicy(input: {
  policy: ModelPolicyDocument | undefined;
  candidate: ModelPolicyCandidate;
  /** Models available in the local runtime (from the Pi model registry). */
  available: AvailableRuntimeModels;
}): ModelPolicyEvaluation {
  const { policy, candidate } = input;
  const available = availableValues(input.available);

  if (!policyHasConstraints(policy)) {
    return { status: "allowed", unconstrained: true, warnings: [] };
  }

  const enforced = policySeverity(policy) === "enforced";
  const warnings: string[] = [];

  // DENY — hard, always, regardless of severity (§11).
  if (modelPolicyDeniesValue(policy!.deny, candidate.modelValue)) {
    return denied("model_denied", `Model "${candidate.modelValue}" is denied by policy "${policy!.id}".`);
  }

  // ALLOW — constrains the selectable set (§11).
  if (policy!.allow !== undefined && policy!.allow.length > 0 && !modelPolicyAllowsValue(policy!.allow, candidate.modelValue)) {
    if (enforced) {
      return denied("model_not_allowed", `Model "${candidate.modelValue}" is not in the allowed set for policy "${policy!.id}".`);
    }
    warnings.push(`Model "${candidate.modelValue}" is not in the policy allowed set (advisory).`);
  }

  // THINKING — constrains selection; never hard-denies, always clampable.
  let suggestedThinkingLevel: MateriaThinkingLevel | undefined;
  if (policy!.thinking !== undefined && !modelPolicyAllowsThinking(policy!.thinking, candidate.thinkingLevel)) {
    suggestedThinkingLevel = suggestThinkingLevel(policy!.thinking);
    const currentLabel = candidate.thinkingLevel ?? "none";
    if (suggestedThinkingLevel !== undefined) {
      warnings.push(`Thinking level "${currentLabel}" is not permitted by policy "${policy!.id}"; suggested clamp is "${suggestedThinkingLevel}".`);
    } else {
      warnings.push(`Thinking level "${currentLabel}" is not permitted by policy "${policy!.id}" and no satisfying level could be derived.`);
    }
  }

  // PREFER — advisory. Suggest an available+allowed preferred model; warn when
  // a preferred central model is unavailable locally (§11).
  const preferredSuggestion = selectPolicyPreferredModel(policy!, input.available);
  for (const value of unavailablePreferredModels(policy!, input.available)) {
    warnings.push(`Preferred model "${value}" from policy "${policy!.id}" is not available locally.`);
  }

  return {
    status: "allowed",
    unconstrained: false,
    ...(preferredSuggestion !== undefined ? { preferredSuggestion } : {}),
    ...(suggestedThinkingLevel !== undefined ? { suggestedThinkingLevel } : {}),
    warnings,
  };
}

function denied(reason: ModelPolicyDenialReason, message: string): ModelPolicyEvaluation {
  return { status: "denied", unconstrained: false, denialReason: reason, denialMessage: message, warnings: [] };
}

/**
 * Pick the best preferred model that is available locally and allowed (not
 * denied, and within the allow list when one is present). Document order is
 * priority order: the first qualifying preferred value wins. Returns
 * `undefined` when no preferred model is available locally.
 *
 * Pure; used for advisory "prefer" selection and by {@link evaluateModelPolicy}.
 */
export function selectPolicyPreferredModel(policy: ModelPolicyDocument, available: AvailableRuntimeModels): ModelPolicyPreferredSuggestion | undefined {
  if (policy.prefer === undefined || policy.prefer.length === 0) return undefined;
  const availableSet = availableValues(available);
  for (const ref of policy.prefer) {
    if (!availableSet.has(ref.value)) continue;
    if (modelPolicyDeniesValue(policy.deny, ref.value)) continue;
    if (policy.allow !== undefined && policy.allow.length > 0 && !modelPolicyAllowsValue(policy.allow, ref.value)) continue;
    return { modelValue: ref.value };
  }
  return undefined;
}

/**
 * Preferred model values that are not available in the local runtime, in
 * document order. Used to surface "preferred central model unavailable locally"
 * warnings (§11). Pure.
 */
export function unavailablePreferredModels(policy: ModelPolicyDocument, available: AvailableRuntimeModels): string[] {
  if (policy.prefer === undefined || policy.prefer.length === 0) return [];
  const availableSet = availableValues(available);
  return policy.prefer.filter((ref) => !availableSet.has(ref.value)).map((ref) => ref.value);
}

// ───────────────────────────────────────────────────────────────────────
// Internal helpers
// ───────────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
