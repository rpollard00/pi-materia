import type { MateriaConfig, MateriaPipelineConfig, PiMateriaConfig } from "../types.js";

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
 */
export interface CentralCatalogConfigSource {
  /** Central loadout definitions keyed by display name. */
  readonly loadouts?: Readonly<Record<string, MateriaPipelineConfig>>;
  /** Central materia definitions keyed by materia id. */
  readonly materia?: Readonly<Record<string, MateriaConfig>>;
}

/** Label surfaced for the central layer where file-backed layers show a path. */
export const CENTRAL_CATALOG_LAYER_LABEL = "central";

/** True when a central source carries no loadout or materia definitions. */
export function isCentralCatalogSourceEmpty(source: CentralCatalogConfigSource | undefined): boolean {
  if (!source) return true;
  const hasLoadouts = source.loadouts !== undefined && Object.keys(source.loadouts).length > 0;
  const hasMateria = source.materia !== undefined && Object.keys(source.materia).length > 0;
  return !hasLoadouts && !hasMateria;
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
