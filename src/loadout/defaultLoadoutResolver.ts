import type { MateriaConfigLayerScope, PiMateriaConfig } from "../types.js";

type Loadouts = PiMateriaConfig["loadouts"];

export interface DefaultLoadoutResolution {
  loadoutName: string | null;
  loadoutId: string | null;
  warning?: string;
}

// Lower rank = higher precedence (first match wins on id ties). Mirrors config
// precedence: bundled defaults < central catalog < user < project < explicit
// (docs/enterprise-control-plane.md §5). `central` outranks shipped defaults
// but is always overridden by a local user/project/explicit definition.
const SOURCE_RANK: Record<MateriaConfigLayerScope, number> = {
  explicit: 0,
  project: 1,
  user: 2,
  central: 3,
  default: 4,
};

export function resolveDefaultLoadout(
  requestedDefault: string | null | undefined,
  loadouts: Loadouts,
  sources: Record<string, MateriaConfigLayerScope> = {},
): DefaultLoadoutResolution {
  const requested = requestedDefault?.trim();
  if (!requested) return { loadoutName: null, loadoutId: null };

  const byExactName = findExactName(loadouts, sources, requested);
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

export function resolveQuestDefaultLoadout(
  requestedQuestDefault: string | null | undefined,
  loadouts: Loadouts,
  sources: Record<string, MateriaConfigLayerScope> = {},
): DefaultLoadoutResolution {
  const requested = requestedQuestDefault?.trim();
  if (!requested) return { loadoutName: null, loadoutId: null };
  const resolved = resolveDefaultLoadout(requested, loadouts, sources);
  if (resolved.loadoutId || !resolved.warning) return resolved;
  const available = Object.keys(loadouts ?? {});
  return {
    loadoutName: null,
    loadoutId: null,
    warning: available.length
      ? `Configured quest default Materia loadout "${requested}" was not found; quest launches will fall back to the current active loadout. Available loadouts: ${available.join(", ")}.`
      : `Configured quest default Materia loadout "${requested}" was not found because no loadouts are configured; quest launches will fall back to the current active loadout.`,
  };
}

export interface LoadoutReferenceResolution {
  loadoutName: string;
  loadoutId?: string;
}

export function resolveLoadoutReference(
  requestedLoadout: string,
  loadouts: Loadouts,
  sources: Record<string, MateriaConfigLayerScope> = {},
): LoadoutReferenceResolution | null {
  const requested = requestedLoadout.trim();
  if (!requested) return null;
  const byExactName = findExactName(loadouts, sources, requested);
  if (byExactName?.loadoutName) return { loadoutName: byExactName.loadoutName, ...(byExactName.loadoutId ? { loadoutId: byExactName.loadoutId } : {}) };
  const byExactId = findBestExactId(loadouts, sources, requested);
  if (byExactId?.loadoutName) return { loadoutName: byExactId.loadoutName, ...(byExactId.loadoutId ? { loadoutId: byExactId.loadoutId } : {}) };
  return null;
}

export function resolveLoadoutSelection(
  requestedLoadout: string,
  loadouts: Loadouts,
  sources: Record<string, MateriaConfigLayerScope> = {},
): LoadoutReferenceResolution | null {
  return resolveLoadoutReference(requestedLoadout, loadouts, sources) ?? resolveSourcePrefixedLoadout(requestedLoadout, loadouts, sources);
}

function findExactName(loadouts: Loadouts, sources: Record<string, MateriaConfigLayerScope>, name: string): DefaultLoadoutResolution | null {
  const loadout = loadouts?.[name];
  if (!isPlainObject(loadout)) return null;
  return { loadoutName: name, loadoutId: loadoutId(loadout) ?? synthesizedLoadoutId(sources[name], name) };
}

function findBestExactId(loadouts: Loadouts, sources: Record<string, MateriaConfigLayerScope>, id: string): DefaultLoadoutResolution | null {
  const matches = Object.entries(loadouts ?? {})
    .filter(([name, loadout]) => isPlainObject(loadout) && (loadoutId(loadout) === id || synthesizedLoadoutId(sources[name], name) === id))
    .sort(([left], [right]) => sourceRank(sources[left]) - sourceRank(sources[right]));
  const [name, loadout] = matches[0] ?? [];
  return name && isPlainObject(loadout) ? { loadoutName: name, loadoutId: loadoutId(loadout) ?? synthesizedLoadoutId(sources[name], name) } : null;
}

function resolveSourcePrefixedLoadout(loadoutName: string, loadouts: Loadouts, sources: Record<string, MateriaConfigLayerScope> = {}): LoadoutReferenceResolution | null {
  const [source, id] = loadoutName.split(":", 2);
  if (!isLoadoutSource(source) || !id) return null;
  const entry = Object.keys(loadouts ?? {}).find((name) => sources[name] === source && name.toLowerCase() === id);
  return entry ? { loadoutName: entry, loadoutId: loadoutName } : null;
}

function sourceRank(source: MateriaConfigLayerScope | undefined): number {
  return source ? SOURCE_RANK[source] : SOURCE_RANK.default;
}

function isLoadoutSource(value: string | undefined): value is MateriaConfigLayerScope {
  return value === "default" || value === "central" || value === "user" || value === "project" || value === "explicit";
}

function synthesizedLoadoutId(source: MateriaConfigLayerScope | undefined, name: string): string {
  return `${source ?? "project"}:${name.toLowerCase()}`;
}

function loadoutId(loadout: { id?: unknown }): string | undefined {
  const id = loadout.id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
