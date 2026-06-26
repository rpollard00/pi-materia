/**
 * Explicit central-to-local catalog actions (docs/enterprise-control-plane.md §12).
 *
 * Pure domain layer: defines the copy/update/replace action contract, the
 * overwrite decision logic, and the central→local definition transformation
 * (strip local ownership metadata, stamp catalog origin provenance). No IO,
 * HTTP, persistence, or application/control-plane dependencies. The application
 * use case (`src/application/catalogActions.ts`) orchestrates central reads and
 * local writes around this pure decision; the infrastructure adapter
 * (`src/infrastructure/localControlPlane/catalogStore.ts`) wires it to the
 * existing local config save path.
 *
 * Overwrite is always explicit. `copy` targets a new local key; `update`
 * refreshes a local definition whose recorded origin matches the central item;
 * `replace` overwrites an existing local definition verbatim. Central updates
 * are never applied silently — a write that would change existing local content
 * requires `confirmOverwrite: true`, otherwise the decision is
 * `needs_confirmation` and the caller must not write.
 *
 * Provenance is re-exported from `./catalogProvenance.js` so this is the single
 * import surface for catalog-action provenance helpers.
 */
export {
  readCatalogOriginProvenance,
  isValidCatalogOriginProvenance,
  type CatalogOriginProvenance,
  type CatalogOriginScope,
} from "./catalogProvenance.js";

import type { CatalogOriginProvenance, CatalogOriginScope } from "./catalogProvenance.js";
import { readCatalogOriginProvenance } from "./catalogProvenance.js";

// ───────────────────────────────────────────────────────────────────────
// Kinds, actions, scopes
// ───────────────────────────────────────────────────────────────────────

/**
 * Definition kind. Structurally identical to the application `CatalogItemKind`
 * ("loadout" | "materia"). Defined here so the domain decision does not depend
 * on the application control-plane DTO module.
 */
export const CATALOG_DEFINITION_KINDS = ["loadout", "materia"] as const;
export type CatalogDefinitionKind = (typeof CATALOG_DEFINITION_KINDS)[number];

export function isCatalogDefinitionKind(value: unknown): value is CatalogDefinitionKind {
  return typeof value === "string" && (CATALOG_DEFINITION_KINDS as readonly string[]).includes(value);
}

/** The three explicit central-to-local actions (§12). */
export const CATALOG_LOCAL_ACTIONS = ["copy", "update", "replace"] as const;
export type CatalogLocalAction = (typeof CATALOG_LOCAL_ACTIONS)[number];

export function isCatalogLocalAction(value: unknown): value is CatalogLocalAction {
  return typeof value === "string" && (CATALOG_LOCAL_ACTIONS as readonly string[]).includes(value);
}

/** Writable local scope a central definition may be promoted into (never `central`). */
export type CatalogLocalTargetScope = CatalogOriginScope;
export const CATALOG_LOCAL_TARGET_SCOPES: readonly CatalogLocalTargetScope[] = ["user", "project", "explicit"];

export function isCatalogLocalTargetScope(value: unknown): value is CatalogLocalTargetScope {
  return typeof value === "string" && (CATALOG_LOCAL_TARGET_SCOPES as readonly string[]).includes(value);
}

// ───────────────────────────────────────────────────────────────────────
// Definition transformation
// ───────────────────────────────────────────────────────────────────────

/**
 * Local ownership metadata fields stripped when promoting a central definition
 * into a local scope. A promoted definition takes a normal local identity/source
 * (re-stamped by the local save path) plus a fresh catalog origin (§10, §12).
 * Semantic content (materia behavior, loadout graph/sockets/loops) is preserved.
 */
const LOADOUT_OWNERSHIP_METADATA_FIELDS: readonly string[] = ["id", "source", "lockState", "originDefaultId", "catalogOrigin"];
const MATERIA_OWNERSHIP_METADATA_FIELDS: readonly string[] = ["lockState", "catalogOrigin"];

function ownershipMetadataFields(kind: CatalogDefinitionKind): readonly string[] {
  return kind === "loadout" ? LOADOUT_OWNERSHIP_METADATA_FIELDS : MATERIA_OWNERSHIP_METADATA_FIELDS;
}

/**
 * Strip local ownership metadata from a definition so the local save path owns
 * identity/source/lock for the target scope. Pure: returns a shallow-cloned
 * record without the ownership fields; nested content is shared (callers must
 * not mutate).
 */
export function stripDefinitionOwnershipMetadata(
  definition: Readonly<Record<string, unknown>>,
  kind: CatalogDefinitionKind,
): Record<string, unknown> {
  const fields = ownershipMetadataFields(kind);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(definition)) {
    if (!fields.includes(key)) result[key] = value;
  }
  return result;
}

/** Build catalog origin provenance for a promotion (§14.1). Pure. */
export function buildCatalogOrigin(input: {
  catalogItemId: string;
  catalogVersion: string;
  catalogContentHash: string;
  source: CatalogLocalTargetScope;
}): CatalogOriginProvenance {
  return {
    catalogItemId: input.catalogItemId,
    catalogVersion: input.catalogVersion,
    catalogContentHash: input.catalogContentHash,
    source: input.source,
  };
}

/**
 * Stamp catalog origin provenance onto a definition. Pure: returns a shallow
 * clone with `catalogOrigin` set (overwriting any prior origin).
 */
export function stampCatalogOrigin(
  definition: Readonly<Record<string, unknown>>,
  origin: CatalogOriginProvenance,
): Record<string, unknown> {
  return { ...definition, catalogOrigin: origin };
}

/**
 * Build the local definition to persist for a promotion: the central definition
 * with local ownership metadata stripped and a fresh catalog origin stamped.
 * Pure. This is what the local save path receives.
 */
export function preparePromotedDefinition(input: {
  centralDefinition: Readonly<Record<string, unknown>>;
  kind: CatalogDefinitionKind;
  origin: CatalogOriginProvenance;
}): Record<string, unknown> {
  const stripped = stripDefinitionOwnershipMetadata(input.centralDefinition, input.kind);
  return stampCatalogOrigin(stripped, input.origin);
}

/**
 * Structural deep equality between two definitions. Key-order independent and
 * type-tolerant. Used for the conservative "would content change" comparison in
 * update/replace decisions.
 */
export function catalogDefinitionsEqual(
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
): boolean {
  return deepEqual(a, b);
}

/**
 * Compare two definitions by semantic content only: local ownership metadata is
 * stripped from both before deep comparison, so identity/source/lock/provenance
 * differences do not count as a content change (§12).
 */
export function catalogDefinitionsSemanticallyEqual(
  kind: CatalogDefinitionKind,
  existing: Readonly<Record<string, unknown>>,
  central: Readonly<Record<string, unknown>>,
): boolean {
  return catalogDefinitionsEqual(stripDefinitionOwnershipMetadata(existing, kind), stripDefinitionOwnershipMetadata(central, kind));
}

// ───────────────────────────────────────────────────────────────────────
// Action request + decision
// ───────────────────────────────────────────────────────────────────────

/** Request for an explicit central-to-local catalog action (§12). */
export interface CatalogLocalActionRequest {
  action: CatalogLocalAction;
  kind: CatalogDefinitionKind;
  /** Stable central id of the catalog item to promote. */
  catalogItemId: string;
  /**
   * Local key to write: a materia id (kind "materia") or a loadout display name
   * (kind "loadout").
   */
  localKey: string;
  /** Writable local scope to promote into (never `central`). */
  target: CatalogLocalTargetScope;
  /**
   * Explicit confirmation for writes that would overwrite existing local content.
   * Required for `replace` of an existing definition and for `update` when the
   * central content differs from the local copy. Without it, such writes return
   * `needs_confirmation` instead of mutating local files.
   */
  confirmOverwrite?: boolean;
}

/** Rejection reason codes for a central-to-local action decision. */
export type CatalogLocalActionRejectionCode =
  /** copy: the local key already has a (default or local) definition. */
  | "target_exists"
  /** update: no existing local definition to refresh. */
  | "missing_origin_target"
  /** update: existing definition did not originate from this central item. */
  | "origin_mismatch";

/**
 * The pure decision for a central-to-local action (no IO). The caller resolves
 * the central item and the existing local definition, then acts on the decision:
 * only `apply` authorizes a local write; `needs_confirmation`/`rejected` must
 * not write.
 */
export type CatalogLocalActionDecision =
  | {
      status: "apply";
      /** Definition to persist (central content + fresh catalog origin). */
      definition: Record<string, unknown>;
      /** Catalog origin recorded on the promoted definition. */
      origin: CatalogOriginProvenance;
      /** True when this write overwrites an existing local definition. */
      overwrite: boolean;
      /** True when the write changes existing local semantic content (conservative). */
      contentChanged: boolean;
    }
  | {
      status: "needs_confirmation";
      reason: string;
      /** The definition that would be written if the caller confirms. */
      definition: Record<string, unknown>;
      origin: CatalogOriginProvenance;
    }
  | {
      status: "rejected";
      reason: string;
      code: CatalogLocalActionRejectionCode;
    };

/**
 * Evaluate a central-to-local action against the current local state and the
 * central item. Pure: performs no IO and never mutates inputs.
 *
 * Semantics (§12):
 * - **copy**: write the central definition as a NEW local definition. Rejects
 *   (`target_exists`) if any definition already exists at the local key — use
 *   `replace` or a different local key.
 * - **update**: refresh an EXISTING local definition whose recorded catalog
 *   origin matches this central item to the latest central version. Rejects
 *   (`missing_origin_target`) when no local definition exists (use copy) or
 *   (`origin_mismatch`) when its origin does not match (use replace). Requires
 *   confirmation when the central content differs from the local copy.
 * - **replace**: overwrite an existing local definition with the central
 *   definition verbatim. Requires confirmation when a definition already exists.
 *
 * The "would content change" comparison strips local ownership metadata from
 * both sides and compares structurally. It is intentionally conservative: a
 * normalization-only difference may surface as `needs_confirmation`, which is
 * always safe (never a silent overwrite).
 */
export function evaluateCatalogLocalAction(input: {
  request: CatalogLocalActionRequest;
  /** Existing local definition at the local key (merged config), or undefined. */
  existingDefinition: Readonly<Record<string, unknown>> | undefined;
  /** Current central item version. */
  centralVersion: string;
  /** Current central item content hash. */
  centralContentHash: string;
  /** Central definition content to promote. */
  centralDefinition: Readonly<Record<string, unknown>>;
}): CatalogLocalActionDecision {
  const { request } = input;
  const existing = input.existingDefinition;
  const origin = buildCatalogOrigin({
    catalogItemId: request.catalogItemId,
    catalogVersion: input.centralVersion,
    catalogContentHash: input.centralContentHash,
    source: request.target,
  });
  const definition = preparePromotedDefinition({
    centralDefinition: input.centralDefinition,
    kind: request.kind,
    origin,
  });

  switch (request.action) {
    case "copy": {
      if (existing !== undefined) {
        return rejected(
          "target_exists",
          `A ${request.kind} named "${request.localKey}" already exists. Use "replace" to overwrite it, or choose a different local key.`,
        );
      }
      return apply(definition, origin, false, false);
    }
    case "update": {
      if (existing === undefined) {
        return rejected(
          "missing_origin_target",
          `No local ${request.kind} "${request.localKey}" exists to update. Use "copy" to create it from the central catalog.`,
        );
      }
      const existingOrigin = readCatalogOriginProvenance(existing);
      if (existingOrigin === undefined || existingOrigin.catalogItemId !== request.catalogItemId) {
        return rejected(
          "origin_mismatch",
          `Local ${request.kind} "${request.localKey}" did not originate from central item "${request.catalogItemId}". Use "replace" to overwrite it.`,
        );
      }
      const contentChanged = !catalogDefinitionsSemanticallyEqual(request.kind, existing, input.centralDefinition);
      if (contentChanged && !request.confirmOverwrite) {
        return {
          status: "needs_confirmation",
          reason: `Updating ${request.kind} "${request.localKey}" to central version ${input.centralVersion} changes its local content. Confirm the overwrite to proceed.`,
          definition,
          origin,
        };
      }
      return apply(definition, origin, true, contentChanged);
    }
    case "replace": {
      if (existing !== undefined && !request.confirmOverwrite) {
        return {
          status: "needs_confirmation",
          reason: `Replacing ${request.kind} "${request.localKey}" overwrites the existing local definition. Confirm the overwrite to proceed.`,
          definition,
          origin,
        };
      }
      const contentChanged =
        existing !== undefined ? !catalogDefinitionsSemanticallyEqual(request.kind, existing, input.centralDefinition) : false;
      return apply(definition, origin, existing !== undefined, contentChanged);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────
// Internal decision helpers
// ───────────────────────────────────────────────────────────────────────

function apply(
  definition: Record<string, unknown>,
  origin: CatalogOriginProvenance,
  overwrite: boolean,
  contentChanged: boolean,
): CatalogLocalActionDecision {
  return { status: "apply", definition, origin, overwrite, contentChanged };
}

function rejected(code: CatalogLocalActionRejectionCode, reason: string): CatalogLocalActionDecision {
  return { status: "rejected", reason, code };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => deepEqual(aRecord[key], bRecord[key]));
}
