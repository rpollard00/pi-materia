import type {
  CentralCatalogSnapshotMetadata,
  ConnectedCatalogItemMetadata,
  MateriaConfig,
  MateriaPipelineConfig,
  PiMateriaConfig,
} from "../types.js";

/**
 * Central-catalog definitions fed into config layering as the read-only
 * `central` layer (docs/enterprise-control-plane.md §5, §10).
 *
 * The central control-plane adapter populates this from `CatalogAccessPort`;
 * config loading surfaces these definitions between bundled defaults and the
 * user layer and never writes through them. Persisting central content into a
 * local scope requires an explicit copy/update/replace action (§12), so this
 * source is read-only provenance, not a save target.
 *
 * Definitions use the same persisted application shape as local config files so
 * the existing merge/normalize path applies uniformly (graph normalization,
 * materia reference validation, etc.). Central loadouts/materia intentionally
 * carry no persisted `source` field — their provenance is expressed through the
 * `central` layer scope in `loadoutSources`/`materiaSources`.
 *
 * `summaries` carries the current central version/content-hash per catalog item
 * id so config loading can resolve drift of local copies that originated from
 * these central items (§14). It is optional; when absent, drift is left unset
 * rather than fabricated (§14.3).
 */
export interface CentralCatalogConfigSource {
  /** Central loadout definitions keyed by display name. */
  readonly loadouts?: Readonly<Record<string, MateriaPipelineConfig>>;
  /** Central materia definitions keyed by materia id. */
  readonly materia?: Readonly<Record<string, MateriaConfig>>;
  /**
   * Secret-free catalog identity metadata for connected local UI actions.
   * This preserves the stable catalog id when a loadout's merged key is its
   * display name rather than that id.
   */
  readonly items?: readonly ConnectedCatalogItemMetadata[];
  /**
   * Current central catalog item summaries keyed by catalog item id, used to
   * resolve drift against local copies. Populated by the control-plane adapter
   * from `CatalogAccessPort`; content hashes must be in the same deterministic
   * space as local definition digests (see `computeDefinitionDigest`).
   */
  readonly summaries?: Readonly<Record<string, CentralCatalogItemSummary>>;
  /** Freshness of this process-local central snapshot. */
  readonly snapshot?: CentralCatalogSnapshotMetadata;
}

/**
 * Central catalog item summary used for drift comparison: the current central
 * version and content hash for a catalog item id. A structural subset of the
 * application `CatalogItemSummary`; kept local to the config layer so config
 * loading does not depend on the application control-plane DTOs.
 */
export interface CentralCatalogItemSummary {
  /** Current central version (monotonic string). */
  readonly version: string;
  /** Current central content hash of the definition. */
  readonly contentHash: string;
  /** RFC3339 timestamp of the last central update, when known. */
  readonly updatedAt?: string;
}

/** Label surfaced for the central layer where file-backed layers show a path. */
export const CENTRAL_CATALOG_LAYER_LABEL = "central";

/** Human-readable source label that makes stale execution input unambiguous. */
export function centralCatalogLayerLabel(source: CentralCatalogConfigSource): string {
  if (source.snapshot?.status !== "last-known") return CENTRAL_CATALOG_LAYER_LABEL;
  return `${CENTRAL_CATALOG_LAYER_LABEL} (last-known snapshot from ${source.snapshot.fetchedAt})`;
}

/** True when a central source carries no loadout or materia definitions. */
export function isCentralCatalogSourceEmpty(source: CentralCatalogConfigSource | undefined): boolean {
  if (!source) return true;
  const hasLoadouts = source.loadouts !== undefined && Object.keys(source.loadouts).length > 0;
  const hasMateria = source.materia !== undefined && Object.keys(source.materia).length > 0;
  return !hasLoadouts && !hasMateria;
}

/**
 * True when a central source carries catalog summaries that enable drift
 * resolution. Drift is left unset (not fabricated) when this is false
 * (docs/enterprise-control-plane.md §14.3).
 */
export function hasCentralCatalogSummaries(source: CentralCatalogConfigSource | undefined): boolean {
  // An empty, present record is meaningful: central was reached and every
  // previously tracked origin is now orphaned. Absence means comparison was
  // unavailable.
  return source?.summaries !== undefined;
}

/** Composite key for {@link CentralCatalogConfigSource.summaries}, disambiguating
 *  loadout and materia catalog items that may share an id (`${kind}:${id}`). */
export function centralCatalogSummaryKey(kind: "loadout" | "materia", catalogItemId: string): string {
  return `${kind}:${catalogItemId}`;
}

/**
 * Project a central source into the partial config consumed by config layering.
 *
 * Loadouts and materia are shallow-cloned so layer merging owns any mutation
 * during normalization; the underlying catalog definitions stay read-only.
 * Central definitions are kept structurally as-is so the shared merge path
 * applies the same normalization as local layers.
 */
export function centralCatalogSourceToPartial(source: CentralCatalogConfigSource): Partial<PiMateriaConfig> {
  const partial: Partial<PiMateriaConfig> = {};
  const loadouts = shallowCloneRecord(source.loadouts);
  const materia = shallowCloneRecord(source.materia);
  if (loadouts) partial.loadouts = loadouts;
  if (materia) partial.materia = materia;
  return partial;
}

function shallowCloneRecord<T>(value: Readonly<Record<string, T>> | undefined): Record<string, T> | undefined {
  if (value === undefined) return undefined;
  const clone: Record<string, T> = {};
  for (const [key, entry] of Object.entries(value)) clone[key] = entry;
  return clone;
}
