import type { MateriaConfigLayerScope, PiMateriaConfig } from "../types.js";

type Loadouts = PiMateriaConfig["loadouts"];

export interface DefaultLoadoutResolution {
  loadoutName: string | null;
  loadoutId: string | null;
  warning?: string;
}

const SOURCE_RANK: Record<MateriaConfigLayerScope, number> = {
  explicit: 0,
  project: 1,
  user: 2,
  default: 3,
};

export function resolveDefaultLoadout(
  requestedDefault: string | null | undefined,
  loadouts: Loadouts,
  sources: Record<string, MateriaConfigLayerScope> = {},
): DefaultLoadoutResolution {
  const requested = requestedDefault?.trim();
  if (!requested) return { loadoutName: null, loadoutId: null };

  const byExactName = findExactName(loadouts, requested);
  if (byExactName) return byExactName;

  const byExactId = findBestExactId(loadouts, sources, requested);
  if (byExactId) return byExactId;

  const available = Object.keys(loadouts ?? {});
  return {
    loadoutName: null,
    loadoutId: null,
    warning: available.length
      ? `Configured default Materia loadout "${requested}" was not found; keeping the current active loadout. Available loadouts: ${available.join(", ")}.`
      : `Configured default Materia loadout "${requested}" was not found because no loadouts are configured.`,
  };
}

export function resolveLoadoutReference(
  requestedLoadout: string,
  loadouts: Loadouts,
  sources: Record<string, MateriaConfigLayerScope> = {},
): { loadoutName: string; loadoutId?: string } | null {
  const requested = requestedLoadout.trim();
  if (!requested) return null;
  const byExactName = findExactName(loadouts, requested);
  if (byExactName?.loadoutName) return { loadoutName: byExactName.loadoutName, ...(byExactName.loadoutId ? { loadoutId: byExactName.loadoutId } : {}) };
  const byExactId = findBestExactId(loadouts, sources, requested);
  if (byExactId?.loadoutName) return { loadoutName: byExactId.loadoutName, ...(byExactId.loadoutId ? { loadoutId: byExactId.loadoutId } : {}) };
  return null;
}

function findExactName(loadouts: Loadouts, name: string): DefaultLoadoutResolution | null {
  const loadout = loadouts?.[name];
  if (!isPlainObject(loadout)) return null;
  return { loadoutName: name, loadoutId: loadoutId(loadout) ?? null };
}

function findBestExactId(loadouts: Loadouts, sources: Record<string, MateriaConfigLayerScope>, id: string): DefaultLoadoutResolution | null {
  const matches = Object.entries(loadouts ?? {})
    .filter((entry) => isPlainObject(entry[1]) && loadoutId(entry[1]) === id)
    .sort(([left], [right]) => sourceRank(sources[left]) - sourceRank(sources[right]));
  const [name, loadout] = matches[0] ?? [];
  return name ? { loadoutName: name, loadoutId: loadoutId(loadout) ?? null } : null;
}

function sourceRank(source: MateriaConfigLayerScope | undefined): number {
  return source ? SOURCE_RANK[source] : SOURCE_RANK.default;
}

function loadoutId(loadout: { id?: unknown }): string | undefined {
  const id = loadout.id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
