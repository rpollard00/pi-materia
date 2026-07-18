import { createHash } from "node:crypto";
import {
  type CatalogDriftInfo,
  readCatalogOriginProvenance,
  resolveCatalogDrift,
  type CatalogOriginProvenance,
} from "../domain/catalogProvenance.js";
import type { MateriaConfigLayerScope, MateriaConfig, MateriaPipelineConfig, PiMateriaConfig, ResolvedConfigCatalogDrift } from "../types.js";
import {
  centralCatalogSummaryKey,
  hasCentralCatalogSummaries,
  type CentralCatalogConfigSource,
  type CentralCatalogItemSummary,
} from "./centralCatalogSource.js";

/**
 * Catalog drift detection for config layering (docs/enterprise-control-plane.md §14).
 *
 * Resolves drift for local loadout/materia definitions that originated from a
 * central catalog item, by comparing each definition's recorded origin against
 * the current central version/content-hash from {@link CentralCatalogConfigSource.summaries}.
 *
 * Drift is **informational only**. This module never mutates local files: it only
 * reads the loaded (normalized) config and produces a drift snapshot for loaded
 * config and WebUI API responses. Resolving drift requires an explicit
 * copy/update/replace action (§12, §14.3).
 *
 * Content digests use the same deterministic key-stable serialization as the
 * central catalog repository and local control-plane adapter, so an unedited
 * local copy compares equal to its recorded origin hash. The local-only
 * `catalogOrigin` provenance field is stripped before hashing so provenance does
 * not itself change the digest.
 */

/** Writable local scopes that may carry catalog origin provenance. */
const WRITABLE_LOCAL_SCOPES: ReadonlySet<MateriaConfigLayerScope> = new Set(["user", "project", "explicit"]);

/**
 * Resolve catalog drift for a loaded config against the central source.
 *
 * Returns `undefined` when drift cannot be resolved — specifically when the
 * central source carries no catalog summaries (central unreachable or summary
 * data unavailable). In that case drift is left unset rather than fabricated
 * (§14.3). When summaries are available, every local (user/project/explicit)
 * definition carrying a valid `catalogOrigin` is resolved, including `orphaned`
 * when its origin item is no longer present centrally.
 */
export function resolveConfigCatalogDrift(input: {
  config: PiMateriaConfig;
  loadoutSources: Record<string, MateriaConfigLayerScope>;
  materiaSources: Record<string, MateriaConfigLayerScope>;
  centralSource: CentralCatalogConfigSource | undefined;
}): ResolvedConfigCatalogDrift | undefined {
  if (!hasCentralCatalogSummaries(input.centralSource)) return undefined;
  const summaries = input.centralSource!.summaries!;
  const staleSnapshot = input.centralSource!.snapshot?.status === "last-known"
    ? input.centralSource!.snapshot
    : undefined;

  const loadoutDrift = markSnapshotDriftStale(
    resolveLoadoutDrift(input.config.loadouts, input.loadoutSources, summaries),
    staleSnapshot?.fetchedAt,
  );
  const materiaDrift = markSnapshotDriftStale(
    resolveMateriaDrift(input.config.materia, input.materiaSources, summaries),
    staleSnapshot?.fetchedAt,
  );

  if (loadoutDrift === undefined && materiaDrift === undefined) return undefined;
  const result: ResolvedConfigCatalogDrift = {};
  if (loadoutDrift) result.loadouts = loadoutDrift;
  if (materiaDrift) result.materia = materiaDrift;
  return result;
}

function markSnapshotDriftStale(
  drift: Record<string, CatalogDriftInfo> | undefined,
  lastFetchedAt: string | undefined,
): Record<string, CatalogDriftInfo> | undefined {
  if (!drift || lastFetchedAt === undefined) return drift;
  return Object.fromEntries(Object.entries(drift).map(([key, value]) => [key, {
    ...value,
    stale: true,
    reason: `Central catalog is unavailable; compared with the last-known snapshot from ${lastFetchedAt}.`,
  }]));
}

function resolveLoadoutDrift(
  loadouts: PiMateriaConfig["loadouts"],
  sources: Record<string, MateriaConfigLayerScope>,
  summaries: Readonly<Record<string, CentralCatalogItemSummary>>,
): Record<string, CatalogDriftInfo> | undefined {
  if (!loadouts) return undefined;
  let result: Record<string, CatalogDriftInfo> | undefined;
  for (const [name, loadout] of Object.entries(loadouts)) {
    const drift = resolveDefinitionDrift("loadout", loadout as MateriaPipelineConfig, sources[name], summaries);
    if (drift) {
      result ??= {};
      result[name] = drift;
    }
  }
  return result;
}

function resolveMateriaDrift(
  materia: PiMateriaConfig["materia"],
  sources: Record<string, MateriaConfigLayerScope>,
  summaries: Readonly<Record<string, CentralCatalogItemSummary>>,
): Record<string, CatalogDriftInfo> | undefined {
  if (!materia) return undefined;
  let result: Record<string, CatalogDriftInfo> | undefined;
  for (const [id, definition] of Object.entries(materia)) {
    const drift = resolveDefinitionDrift("materia", definition as MateriaConfig, sources[id], summaries);
    if (drift) {
      result ??= {};
      result[id] = drift;
    }
  }
  return result;
}

function resolveDefinitionDrift(
  kind: "loadout" | "materia",
  definition: MateriaPipelineConfig | MateriaConfig,
  scope: MateriaConfigLayerScope | undefined,
  summaries: Readonly<Record<string, CentralCatalogItemSummary>>,
): CatalogDriftInfo | undefined {
  // Only writable local copies carry origin provenance; central/default/shipped
  // definitions never record a central catalog origin.
  if (scope !== undefined && !WRITABLE_LOCAL_SCOPES.has(scope)) return undefined;
  const origin = readCatalogOriginProvenance(definition);
  if (origin === undefined) return undefined;
  const centralKey = centralCatalogSummaryKey(kind, origin.catalogItemId);
  const central = summaries[centralKey];
  const localDigest = computeDefinitionDigest(definition as unknown as Readonly<Record<string, unknown>>);
  return resolveCatalogDrift(origin, localDigest, central);
}

/**
 * Deterministic content digest for a local definition, used for drift
 * comparison. Strips the local-only `catalogOrigin` provenance field and uses
 * the same key-stable serialization as the central catalog repository and local
 * control-plane adapter, so an unedited local copy compares equal to its
 * recorded central origin hash (§14).
 */
export function computeDefinitionDigest(definition: Readonly<Record<string, unknown>>): string {
  return `sha256:${createHash("sha256").update(stableStringify(stripCatalogOrigin(definition))).digest("hex")}`;
}

function stripCatalogOrigin(definition: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(definition, "catalogOrigin")) {
    return { ...(definition as Record<string, unknown>) };
  }
  const { catalogOrigin: _catalogOrigin, ...rest } = definition as Record<string, unknown>;
  return rest;
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

export type { CatalogOriginProvenance };
