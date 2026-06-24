/**
 * Catalog origin provenance and drift resolution (pure domain).
 *
 * Tracks when a local loadout/materia definition originated from a central
 * catalog item and resolves whether it has drifted from the current central
 * version/hash (docs/enterprise-control-plane.md §14).
 *
 * Pure domain layer: no HTTP, persistence, UI, or crypto/IO dependencies. Drift
 * is resolved from a recorded {@link CatalogOriginProvenance}, the current local
 * content digest, and an optional current central summary. The caller computes
 * digests (deterministic content hashes); this module only compares them.
 *
 * Drift is **informational only**: this module never mutates local files and
 * never performs IO. Resolving drift requires an explicit copy/update/replace
 * action (§12, §14.3).
 */

/** Writable local scope recorded on a definition that originated from central. */
export type CatalogOriginScope = "user" | "project" | "explicit";

/**
 * Persisted on a local loadout/materia definition that originated from a central
 * catalog item via an explicit copy/update/replace action (§14.1).
 *
 * `source` is never `central` for a writable local file; central definitions are
 * expressed through the read-only `central` config layer scope instead.
 */
export interface CatalogOriginProvenance {
  /** Stable central id of the origin catalog item. */
  catalogItemId: string;
  /** Central version recorded at copy/update/replace time. */
  catalogVersion: string;
  /** Central content hash recorded at copy/update/replace time. */
  catalogContentHash: string;
  /** Local scope the definition now lives in. */
  source: CatalogOriginScope;
}

/** Drift status enum for a local definition against its central origin (§14.2). */
export const CATALOG_DRIFT_STATUSES = ["current", "behind", "diverged", "orphaned"] as const;
export type CatalogDriftStatus = (typeof CATALOG_DRIFT_STATUSES)[number];

export function isCatalogDriftStatus(value: unknown): value is CatalogDriftStatus {
  return typeof value === "string" && (CATALOG_DRIFT_STATUSES as readonly string[]).includes(value);
}

/** Current central summary used for drift comparison (version + content hash). */
export interface CatalogDriftCentralSummary {
  version: string;
  contentHash: string;
}

/**
 * Resolved drift of a local definition against its central origin (§14.2).
 * Surfaced in loaded config and WebUI API responses; never auto-applied.
 */
export interface CatalogDriftInfo {
  status: CatalogDriftStatus;
  /** Current central version (resolved at load), when central was reachable. */
  centralVersion?: string;
  /** Current central content hash (resolved at load), when central was reachable. */
  centralContentHash?: string;
  /** True when central was reachable but the origin item could not be compared. */
  stale?: boolean;
  reason?: string;
}

/**
 * Resolve drift for a local definition with a recorded central origin.
 *
 * - `central === undefined` → the origin item no longer exists centrally
 *   (`orphaned`).
 * - origin content hash matches central → `current` (a version-only central
 *   republish with identical content is not content drift).
 * - central content hash changed and the local content still equals the recorded
 *   origin hash (not locally edited since copy) → `behind`.
 * - central content hash changed and the local content no longer equals the
 *   recorded origin hash (locally edited) → `diverged`.
 *
 * The content hash is the authoritative drift signal: it is stable across
 * central metadata-only updates (name/description) that bump version without
 * changing definition content. `centralVersion` is still reported for UIs.
 *
 * `currentLocalDigest` and `origin.catalogContentHash` must be in the same
 * deterministic content-hash space (see `computeDefinitionDigest` in the config
 * layer), so an unedited local copy compares equal to its recorded origin.
 */
export function resolveCatalogDrift(
  origin: CatalogOriginProvenance,
  currentLocalDigest: string,
  central: CatalogDriftCentralSummary | undefined,
): CatalogDriftInfo {
  if (central === undefined) {
    return { status: "orphaned" };
  }
  const centralChanged = central.contentHash !== origin.catalogContentHash;
  if (!centralChanged) {
    return { status: "current", centralVersion: central.version, centralContentHash: central.contentHash };
  }
  const locallyEdited = currentLocalDigest !== origin.catalogContentHash;
  if (locallyEdited) {
    return { status: "diverged", centralVersion: central.version, centralContentHash: central.contentHash };
  }
  return { status: "behind", centralVersion: central.version, centralContentHash: central.contentHash };
}

/** True when `value` is a valid persisted catalog origin provenance record. */
export function isValidCatalogOriginProvenance(value: unknown): value is CatalogOriginProvenance {
  if (!isPlainObject(value)) return false;
  return (
    isNonEmptyString(value.catalogItemId) &&
    isNonEmptyString(value.catalogVersion) &&
    isNonEmptyString(value.catalogContentHash) &&
    (value.source === "user" || value.source === "project" || value.source === "explicit")
  );
}

/**
 * Read the persisted catalog origin provenance from a definition record, or
 * `undefined` when absent or invalid. Provenance is informational metadata; an
 * invalid record is ignored rather than failing config load.
 */
export function readCatalogOriginProvenance(definition: unknown): CatalogOriginProvenance | undefined {
  if (!isPlainObject(definition)) return undefined;
  const origin = definition.catalogOrigin;
  return isValidCatalogOriginProvenance(origin) ? origin : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
