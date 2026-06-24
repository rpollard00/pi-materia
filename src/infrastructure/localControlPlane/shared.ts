import { createHash } from "node:crypto";
import { localOnlyModeMetadata, type ControlPlaneModeMetadata } from "../../application/controlPlane.js";
import type { EnrichedEvent } from "../../domain/eventing.js";
import type { LoadedConfig, MateriaConfigLayerScope } from "../../types.js";

/**
 * Local control-plane adapter shared contracts and helpers.
 *
 * The local adapter wraps existing local config/model/monitoring behavior behind
 * the application control-plane ports and always reports `local-only` mode
 * (docs/enterprise-control-plane.md §2, §4, §7). It does not introduce a central
 * dependency, does not change quest-board routes or semantics, and does not
 * replace local session/artifact monitoring (§15).
 */

export type MaybePromise<T> = T | Promise<T>;

/**
 * Reads the current local layered Materia config. Implementations typically wrap
 * `loadConfig` (src/config/config.ts). The adapter never mutates config through
 * this source: catalog writes go through the normal local config save path, never
 * the control-plane admin port (docs/enterprise-control-plane.md §3.3, §10).
 */
export interface LocalControlPlaneConfigSource {
  getLoadedConfig(): MaybePromise<LoadedConfig>;
}

/**
 * Reads existing local monitoring data (runtime events + runtime identity). The
 * local adapter exposes this read-only through control-plane telemetry/status
 * DTOs; it does not replace local session/artifact monitoring and does not become
 * a telemetry ingestion target (docs/enterprise-control-plane.md §15).
 */
export interface LocalControlPlaneMonitoringSource {
  /** Enriched runtime events from the active local run, in natural order. */
  getRuntimeEvents?(): MaybePromise<readonly EnrichedEvent[]>;
  /** Stable identity of the active local runtime/cast, when known. */
  getRuntimeId?(): MaybePromise<string | undefined>;
  /** Whether the local session/monitor is currently reachable/healthy. */
  isHealthy?(): MaybePromise<boolean>;
}

export interface LocalControlPlaneAdapterOptions {
  configSource?: LocalControlPlaneConfigSource;
  monitoringSource?: LocalControlPlaneMonitoringSource;
  /** Optional human-readable label surfaced through mode metadata and admin info. */
  label?: string;
  /** Optional RFC3339 server start time surfaced through admin metadata. */
  startedAt?: string;
}

/** Local-only mode metadata reported by every local control-plane port. */
export function localAdapterModeMetadata(options: Pick<LocalControlPlaneAdapterOptions, "label">): ControlPlaneModeMetadata {
  return localOnlyModeMetadata(options.label);
}

// Local catalog ids are synthesized and prefixed by kind so materia and loadout
// definitions cannot collide even when they share a name. The raw materia id /
// loadout name is carried on CatalogItemSummary.name.
export const LOCAL_MATERIA_ID_PREFIX = "local:materia:";
export const LOCAL_LOADOUT_ID_PREFIX = "local:loadout:";

export function localMateriaItemId(materiaId: string): string {
  return `${LOCAL_MATERIA_ID_PREFIX}${materiaId}`;
}

export function localLoadoutItemId(loadoutName: string): string {
  return `${LOCAL_LOADOUT_ID_PREFIX}${loadoutName}`;
}

/**
 * Local definitions are not centrally versioned or timestamped. These sentinels
 * make that explicit in the catalog DTO; `contentHash` is the meaningful change
 * indicator for local catalog items (docs/enterprise-control-plane.md §14).
 */
export const LOCAL_DEFINITION_VERSION = "local";
export const LOCAL_DEFINITION_UPDATED_AT = "1970-01-01T00:00:00.000Z";

/** Deterministic content hash for a local definition, independent of key order. */
export function hashLocalDefinition(definition: Readonly<Record<string, unknown>>): string {
  return `sha256:${createHash("sha256").update(stableStringify(definition)).digest("hex")}`;
}

/** Resolve the local layer scope owning a definition, defaulting to bundled default. */
export function resolveLocalScope(scope: MateriaConfigLayerScope | undefined): MateriaConfigLayerScope {
  return scope ?? "default";
}

/** Current RFC3339 timestamp. */
export function nowIso(): string {
  return new Date().toISOString();
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys(record[key]);
        return acc;
      }, {});
  }
  return value;
}
