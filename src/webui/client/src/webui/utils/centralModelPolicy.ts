import type {
  CentralModelCatalog,
  CentralModelCatalogEntry,
  CentralModelCatalogResponse,
  CentralModelPolicyDocument,
  CentralModelPolicyModelRef,
  CentralModelPolicyResponse,
  CentralModelPolicyThinkingConstraint,
} from '../types.js';

/**
 * Pure normalization for central model-policy / model-catalog responses
 * (docs/enterprise-control-plane.md §11).
 *
 * Central policy state is read and rendered **independently** from local Pi
 * model availability. These helpers defensively coerce the central HTTP payloads
 * into the stable frontend types so partial/malformed envelopes degrade to an
 * "empty" state instead of throwing — mirroring the local model-catalog
 * normalization in `./modelCatalog.ts`. No IO: safe for both the hook and tests.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function toBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeModelRef(value: unknown): CentralModelPolicyModelRef | undefined {
  if (!isRecord(value)) return undefined;
  const refValue = stringField(value.value);
  if (!refValue) return undefined;
  const label = stringField(value.label);
  return { value: refValue, ...(label ? { label } : {}) };
}

function normalizeRefList(value: unknown): CentralModelPolicyModelRef[] {
  if (!Array.isArray(value)) return [];
  const refs: CentralModelPolicyModelRef[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const ref = normalizeModelRef(entry);
    if (!ref || seen.has(ref.value)) continue;
    seen.add(ref.value);
    refs.push(ref);
  }
  return refs;
}

function normalizeThinkingConstraint(value: unknown): CentralModelPolicyThinkingConstraint | undefined {
  if (!isRecord(value)) return undefined;
  const constraint: CentralModelPolicyThinkingConstraint = {};
  if (Array.isArray(value.allow)) {
    const allow: string[] = [];
    const seen = new Set<string>();
    for (const level of value.allow) {
      const normalized = stringField(level);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      allow.push(normalized);
    }
    if (allow.length > 0) constraint.allow = allow;
  }
  const max = stringField(value.max);
  if (max) constraint.max = max;
  return constraint.allow !== undefined || constraint.max !== undefined ? constraint : undefined;
}

/**
 * Normalize a `GET /api/model-policy` envelope into the active policy document
 * (or `undefined` when none is configured). Pure; tolerates missing/malformed
 * payloads by returning an empty result.
 */
export function normalizeCentralModelPolicyResponse(value: unknown): { activePolicyId?: string; policy?: CentralModelPolicyDocument } {
  if (!isRecord(value)) return {};
  const activePolicyId = stringField(value.activePolicyId);
  const policy = normalizeCentralModelPolicyDocument(value.policy);
  const result: { activePolicyId?: string; policy?: CentralModelPolicyDocument } = {};
  if (activePolicyId) result.activePolicyId = activePolicyId;
  if (policy) result.policy = policy;
  return result;
}

/** Normalize a single central model-policy document, or `undefined` when invalid. */
export function normalizeCentralModelPolicyDocument(value: unknown): CentralModelPolicyDocument | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringField(value.id);
  if (!id) return undefined;
  const name = stringField(value.name);
  const description = stringField(value.description);
  const severityRaw = stringField(value.severity);
  const severity = severityRaw === 'advisory' || severityRaw === 'enforced' ? severityRaw : undefined;
  const version = stringField(value.version);
  const updatedAt = stringField(value.updatedAt);
  const allow = normalizeRefList(value.allow);
  const deny = normalizeRefList(value.deny);
  const prefer = normalizeRefList(value.prefer);
  const thinking = normalizeThinkingConstraint(value.thinking);
  const document: CentralModelPolicyDocument = { id };
  if (name) document.name = name;
  if (description) document.description = description;
  if (allow.length > 0) document.allow = allow;
  if (deny.length > 0) document.deny = deny;
  if (prefer.length > 0) document.prefer = prefer;
  if (thinking) document.thinking = thinking;
  if (severity) document.severity = severity;
  if (version) document.version = version;
  if (updatedAt) document.updatedAt = updatedAt;
  return document;
}

function normalizeCatalogEntry(value: unknown): CentralModelCatalogEntry | undefined {
  if (!isRecord(value)) return undefined;
  const entryValue = stringField(value.value);
  if (!entryValue) return undefined;
  const label = stringField(value.label);
  const vendor = stringField(value.vendor);
  const deprecated = toBool(value.deprecated);
  const notes = stringField(value.notes);
  const supportedThinkingLevels = Array.isArray(value.supportedThinkingLevels)
    ? value.supportedThinkingLevels.map(stringField).filter((level): level is string => Boolean(level))
    : undefined;
  const entry: CentralModelCatalogEntry = { value: entryValue };
  if (label) entry.label = label;
  if (vendor) entry.vendor = vendor;
  if (supportedThinkingLevels && supportedThinkingLevels.length > 0) entry.supportedThinkingLevels = supportedThinkingLevels;
  if (deprecated !== undefined) entry.deprecated = deprecated;
  if (notes) entry.notes = notes;
  return entry;
}

/**
 * Normalize a `GET /api/model-catalog` envelope into the central catalog (or
 * `undefined` when none is configured). Pure; tolerates missing/malformed
 * payloads.
 */
export function normalizeCentralModelCatalogResponse(value: unknown): CentralModelCatalog | undefined {
  if (!isRecord(value)) return undefined;
  const catalog = value.catalog;
  if (!isRecord(catalog)) return undefined;
  if (!Array.isArray(catalog.entries)) return undefined;
  const entries: CentralModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const raw of catalog.entries) {
    const entry = normalizeCatalogEntry(raw);
    if (!entry || seen.has(entry.value)) continue;
    seen.add(entry.value);
    entries.push(entry);
  }
  const updatedAt = stringField(catalog.updatedAt);
  return { entries, ...(updatedAt ? { updatedAt } : {}) };
}

/** Type-only re-exports so callers import response types from a single module. */
export type { CentralModelCatalogResponse, CentralModelPolicyResponse };
