import {
  assertValidLoadoutSaveSemantics,
  makeEmptyEntryLoadout,
  normalizeMateriaConfigEdges,
  type MateriaConfig,
  type PipelineConfig,
} from '../../../loadoutModel.js';
import { buildLoadouts } from '../../utils/graphLayout.js';
import { cloneConfig } from '../../utils/forms.js';
import { fromWebUiConfigDto } from '../../../../../loadoutDto.js';
import { makeDuplicateLoadoutName as makeSharedDuplicateLoadoutName } from '../../../../../../loadout/loadoutNames.js';
import type { LoadoutSourceScope, SaveTarget } from '../../types.js';

export type LoadoutIdFactory = (name: string) => string;

function randomLoadoutId(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'loadout';
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `user:${slug}:${uuid}`;
}

function loadoutId(loadout: PipelineConfig | undefined): string | undefined {
  return typeof loadout?.id === 'string' && loadout.id.trim() ? loadout.id.trim() : undefined;
}

function fallbackNameAfterDelete(draftLoadouts: Record<string, PipelineConfig>, name: string, viewedLoadoutName: string | undefined): string | undefined {
  if (viewedLoadoutName !== name) return viewedLoadoutName;
  const deleted = draftLoadouts[name];
  const originDefaultId = typeof deleted?.originDefaultId === 'string' ? deleted.originDefaultId : undefined;
  if (originDefaultId) {
    const defaultFallback = Object.entries(draftLoadouts).find(([candidate, loadout]) => candidate !== name && loadoutId(loadout) === originDefaultId);
    if (defaultFallback) return defaultFallback[0];
  }
  return Object.keys(draftLoadouts).find((candidate) => candidate !== name);
}

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
    ...(config.activeLoadout === activeLoadoutName ? { activeLoadout: nextName } : {}),
  });
}

export function createLoadoutDraft(config: MateriaConfig, name: string, makeId: LoadoutIdFactory = randomLoadoutId) {
  const draftLoadouts = buildLoadouts(config);
  return normalizeMateriaConfigEdges({
    ...config,
    loadouts: { ...draftLoadouts, [name]: { ...makeEmptyEntryLoadout(), id: makeId(name), source: 'user', lockState: 'unlocked' } },
  });
}

export function makeDuplicateLoadoutName(loadouts: Record<string, PipelineConfig>, name: string) {
  return makeSharedDuplicateLoadoutName(loadouts, name);
}

export function duplicateLoadoutDraft({
  config,
  name,
  nextName = makeDuplicateLoadoutName(buildLoadouts(config), name),
  makeId = randomLoadoutId,
}: {
  config: MateriaConfig;
  name: string;
  nextName?: string;
  makeId?: LoadoutIdFactory;
}) {
  const draftLoadouts = buildLoadouts(config);
  const loadout = draftLoadouts[name];
  if (!loadout || draftLoadouts[nextName]) return normalizeMateriaConfigEdges(config);
  const sourceId = loadoutId(loadout);
  const duplicated = {
    ...cloneConfig(loadout),
    id: makeId(nextName),
    source: 'user',
    lockState: 'unlocked',
    ...(loadout.source === 'default' && sourceId ? { originDefaultId: sourceId } : {}),
  };
  return normalizeMateriaConfigEdges({
    ...config,
    loadouts: { ...draftLoadouts, [nextName]: duplicated },
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
  const deletedLoadoutId = loadoutId(draftLoadouts[name]);
  const fallbackName = fallbackNameAfterDelete(draftLoadouts, name, activeLoadoutName);
  const remainingLoadouts = Object.fromEntries(Object.entries(draftLoadouts).filter(([candidate]) => candidate !== name));
  const fallbackLoadoutId = loadoutId(remainingLoadouts[fallbackName ?? '']);
  return {
    config: normalizeMateriaConfigEdges({
      ...config,
      loadouts: remainingLoadouts,
      ...(config.activeLoadout === name ? { activeLoadout: fallbackName } : {}),
      ...(deletedLoadoutId && config.activeLoadoutId === deletedLoadoutId ? (fallbackLoadoutId ? { activeLoadoutId: fallbackLoadoutId } : { activeLoadoutId: undefined }) : {}),
    }),
    fallbackName,
  };
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
  const loadouts: Record<string, PipelineConfig | null> = Object.fromEntries(
    Object.entries(preparedDraft.loadouts ?? {}).filter(([, loadout]) => loadout?.source !== 'default'),
  );
  for (const name of deletedLoadoutNames) loadouts[name] = null;
  return fromWebUiConfigDto({ ...preparedDraft, loadouts } as never) as Omit<MateriaConfig, 'loadouts'> & { loadouts?: Record<string, PipelineConfig | null> };
}

export function saveTargetForSource(current: SaveTarget, sourceScope: LoadoutSourceScope | undefined) {
  return sourceScope === 'project' || sourceScope === 'explicit' ? sourceScope : current;
}
