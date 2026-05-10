import {
  assertValidLoadoutSaveSemantics,
  makeEmptyEntryLoadout,
  normalizeMateriaConfigEdges,
  type MateriaConfig,
  type PipelineConfig,
} from '../../../loadoutModel.js';
import { buildLoadouts } from '../../utils/graphLayout.js';
import type { LoadoutSourceScope, SaveTarget } from '../../types.js';

export function makeNewLoadoutName(loadouts: Record<string, PipelineConfig>) {
  let index = Object.keys(loadouts).length + 1;
  let name = `New Loadout ${index}`;
  while (loadouts[name]) name = `New Loadout ${++index}`;
  return name;
}

export function renameLoadoutDraft({
  config,
  activeLoadoutName,
  nextName,
}: {
  config: MateriaConfig;
  activeLoadoutName: string;
  nextName: string;
}) {
  const draftLoadouts = buildLoadouts(config);
  if (!draftLoadouts[activeLoadoutName] || draftLoadouts[nextName]) return normalizeMateriaConfigEdges(config);
  const { [activeLoadoutName]: renamedLoadout, ...remainingLoadouts } = draftLoadouts;
  return normalizeMateriaConfigEdges({
    ...config,
    loadouts: { ...remainingLoadouts, [nextName]: renamedLoadout },
    activeLoadout: nextName,
  });
}

export function createLoadoutDraft(config: MateriaConfig, name: string) {
  const draftLoadouts = buildLoadouts(config);
  return normalizeMateriaConfigEdges({
    ...config,
    loadouts: { ...draftLoadouts, [name]: makeEmptyEntryLoadout() },
    activeLoadout: name,
  });
}

export function deleteLoadoutDraft({
  config,
  name,
  activeLoadoutName,
}: {
  config: MateriaConfig;
  name: string;
  activeLoadoutName: string | undefined;
}) {
  const draftLoadouts = buildLoadouts(config);
  const remainingNames = Object.keys(draftLoadouts).filter((candidate) => candidate !== name);
  const fallbackName = activeLoadoutName === name ? remainingNames[0] : activeLoadoutName;
  const remainingLoadouts = Object.fromEntries(Object.entries(draftLoadouts).filter(([candidate]) => candidate !== name));
  return { config: normalizeMateriaConfigEdges({ ...config, loadouts: remainingLoadouts, activeLoadout: fallbackName }), fallbackName };
}

export function deletedLoadoutNamesAfterRename({
  current,
  baselineConfig,
  previousName,
  nextName,
}: {
  current: string[];
  baselineConfig: MateriaConfig | undefined;
  previousName: string;
  nextName: string;
}) {
  const withoutRevertedTarget = current.filter((name) => name !== nextName);
  if (!baselineConfig?.loadouts?.[previousName] || withoutRevertedTarget.includes(previousName)) return withoutRevertedTarget;
  return [...withoutRevertedTarget, previousName];
}

export function buildConfigToSave(normalizedDraft: MateriaConfig, deletedLoadoutNames: string[]) {
  const preparedDraft = normalizeMateriaConfigEdges(normalizedDraft);
  assertValidLoadoutSaveSemantics(preparedDraft);
  const loadouts: Record<string, PipelineConfig | null> = { ...(preparedDraft.loadouts ?? {}) };
  for (const name of deletedLoadoutNames) loadouts[name] = null;
  return { ...preparedDraft, loadouts } as Omit<MateriaConfig, 'loadouts'> & { loadouts?: Record<string, PipelineConfig | null> };
}

export function saveTargetForSource(current: SaveTarget, sourceScope: LoadoutSourceScope | undefined) {
  return sourceScope === 'project' || sourceScope === 'explicit' ? sourceScope : current;
}
