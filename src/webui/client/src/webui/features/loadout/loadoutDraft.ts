import {
  assertValidLoadoutSaveSemantics,
  makeEmptyEntryLoadout,
  normalizeMateriaConfigEdges,
  type MateriaConfig,
  type PipelineConfig,
} from '../../../loadoutModel.js';
import { buildLoadouts } from '../../utils/graphLayout.js';
import { cloneConfig } from '../../utils/forms.js';
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
  const next = cloneConfig(config);
  const draftLoadouts = buildLoadouts(next);
  if (!draftLoadouts[activeLoadoutName] || draftLoadouts[nextName]) return normalizeMateriaConfigEdges(next);
  draftLoadouts[nextName] = draftLoadouts[activeLoadoutName];
  delete draftLoadouts[activeLoadoutName];
  next.loadouts = draftLoadouts;
  next.activeLoadout = nextName;
  return normalizeMateriaConfigEdges(next);
}

export function createLoadoutDraft(config: MateriaConfig, name: string) {
  const next = cloneConfig(config);
  const draftLoadouts = buildLoadouts(next);
  draftLoadouts[name] = makeEmptyEntryLoadout();
  next.loadouts = draftLoadouts;
  next.activeLoadout = name;
  return normalizeMateriaConfigEdges(next);
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
  const next = cloneConfig(config);
  const draftLoadouts = buildLoadouts(next);
  const remainingNames = Object.keys(draftLoadouts).filter((candidate) => candidate !== name);
  const fallbackName = activeLoadoutName === name ? remainingNames[0] : activeLoadoutName;
  delete draftLoadouts[name];
  next.loadouts = draftLoadouts;
  next.activeLoadout = fallbackName;
  return { config: normalizeMateriaConfigEdges(next), fallbackName };
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
  const configToSave = cloneConfig(preparedDraft) as Omit<MateriaConfig, 'loadouts'> & { loadouts?: Record<string, PipelineConfig | null> };
  if (deletedLoadoutNames.length > 0) {
    configToSave.loadouts = { ...(configToSave.loadouts ?? {}) };
    for (const name of deletedLoadoutNames) configToSave.loadouts[name] = null;
  }
  return configToSave;
}

export function saveTargetForSource(current: SaveTarget, sourceScope: LoadoutSourceScope | undefined) {
  return sourceScope === 'project' || sourceScope === 'explicit' ? sourceScope : current;
}
