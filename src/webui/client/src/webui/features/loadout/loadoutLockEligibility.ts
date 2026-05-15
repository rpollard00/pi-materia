import { getLoadoutEditPolicy, type LoadoutUserLockState } from '../../../../../../domain/loadout.js';
import { normalizeMateriaConfigEdges, type PipelineConfig } from '../../../loadoutModel.js';
import type { LoadoutSourceScope } from '../../types.js';
import { cloneConfig } from '../../utils/forms.js';

export interface LoadoutLockEligibility {
  eligible: boolean;
  reason: string | null;
}

export interface LoadoutLockEligibilityInput {
  name: string;
  lockState: LoadoutUserLockState;
  draftLoadouts: Record<string, PipelineConfig>;
  baselineLoadouts: Record<string, PipelineConfig>;
  loadoutSources: Record<string, LoadoutSourceScope>;
}

type JsonObject = { [key: string]: unknown };

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortObjectKeys(nested)]),
  );
}

function comparableLoadoutForLock(name: string, loadout: PipelineConfig | undefined): unknown {
  if (!loadout) return undefined;
  const comparable = cloneConfig(loadout);
  delete comparable.lockState;
  const normalizedLoadout = normalizeMateriaConfigEdges({ loadouts: { [name]: comparable } }, { semantic: false }).loadouts?.[name] ?? comparable;
  return sortObjectKeys({ name, loadout: normalizedLoadout });
}

function loadoutLockContentKey(name: string, loadout: PipelineConfig | undefined): string {
  return JSON.stringify(comparableLoadoutForLock(name, loadout));
}

function persistedLoadoutEntryById(loadouts: Record<string, PipelineConfig>, id: string | undefined): [string, PipelineConfig] | undefined {
  if (!id) return undefined;
  return Object.entries(loadouts).find(([, loadout]) => loadout.id === id);
}

export function getLoadoutLockEligibility({ name, lockState, draftLoadouts, baselineLoadouts, loadoutSources }: LoadoutLockEligibilityInput): LoadoutLockEligibility {
  const loadout = draftLoadouts[name];
  if (!name || !loadout) return { eligible: false, reason: 'Loadout was not found.' };
  const policy = getLoadoutEditPolicy({ source: (loadoutSources[name] ?? loadout.source ?? 'user') as never, lockState: loadout.lockState as never });
  if (policy.readonly) return { eligible: false, reason: policy.reason };
  if (lockState === 'unlocked') return { eligible: true, reason: null };

  const persistedEntry = persistedLoadoutEntryById(baselineLoadouts, loadout.id);
  if (!persistedEntry) return { eligible: false, reason: 'Save or revert pending edits before locking edit mode.' };

  const [persistedName, persistedLoadout] = persistedEntry;
  if (loadoutLockContentKey(name, loadout) !== loadoutLockContentKey(persistedName, persistedLoadout)) {
    return { eligible: false, reason: 'Save or revert pending edits before locking edit mode.' };
  }
  return { eligible: true, reason: null };
}
