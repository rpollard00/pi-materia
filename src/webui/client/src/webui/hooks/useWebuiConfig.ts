import { useEffect, useMemo, useRef, useState } from 'react';
import {
  normalizeMateriaConfigEdges,
  validateLoadoutSaveSemantics,
  type MateriaConfig,
  type PipelineConfig,
} from '../../loadoutModel.js';
import { getLoadoutEditPolicy, type LoadoutUserLockState } from '../../../../../domain/loadout.js';
import { toast } from '../../toast/index.js';
import { getConfig, saveConfig, setActiveLoadout, setDefaultLoadout as persistDefaultLoadout } from '../api/index.js';
import { buildLoadouts } from '../utils/graphLayout.js';
import { cloneConfig } from '../utils/forms.js';
import type { ActiveLoadoutResponse, ConfigResponse, LoadedConfigResponse, LoadoutSourceScope, SaveTarget } from '../types.js';
import {
  buildConfigToSave,
  createLoadoutDraft,
  deletedLoadoutNamesAfterRename,
  deleteLoadoutDraft,
  duplicateLoadoutDraft,
  makeDuplicateLoadoutName,
  makeNewLoadoutName,
  renameLoadoutDraft,
  saveTargetForSource,
} from '../features/loadout/loadoutDraft.js';
import { getLoadoutLockEligibility, type LoadoutLockEligibility } from '../features/loadout/loadoutLockEligibility.js';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isLoadedConfigResponse(value: unknown): value is LoadedConfigResponse {
  return isObjectRecord(value) && isObjectRecord(value.config) && ('source' in value || 'loadoutSources' in value || !('loadouts' in value));
}

function normalizeConfigSnapshot(
  payload: ConfigResponse | ActiveLoadoutResponse | MateriaConfig | LoadedConfigResponse | undefined,
  fallback?: MateriaConfig,
): { config: MateriaConfig; source?: string; loadoutSources?: Record<string, LoadoutSourceScope>; defaultLoadoutId?: string | null } {
  const wrapper = isLoadedConfigResponse(payload) ? payload : undefined;
  const response = isObjectRecord(payload) ? payload as ConfigResponse : undefined;
  const rawConfig = wrapper?.config ?? response?.config ?? payload ?? {};
  const unwrappedConfig = isLoadedConfigResponse(rawConfig) ? rawConfig.config ?? {} : rawConfig;
  const config = normalizeMateriaConfigEdges(unwrappedConfig as MateriaConfig);
  if ((!config.loadouts || Object.keys(config.loadouts).length === 0) && fallback?.loadouts) {
    config.loadouts = cloneConfig(fallback.loadouts);
  }
  if (!config.materia && fallback?.materia) config.materia = cloneConfig(fallback.materia);
  return {
    config,
    source: wrapper?.source ?? response?.source,
    loadoutSources: wrapper?.loadoutSources ?? response?.loadoutSources,
    defaultLoadoutId: wrapper?.defaultLoadoutId ?? response?.defaultLoadoutId,
  };
}

async function fetchMateriaConfig(): Promise<{ config: MateriaConfig; source: string; loadoutSources: Record<string, LoadoutSourceScope>; defaultLoadoutId: string | null }> {
  const body = await getConfig();
  const snapshot = normalizeConfigSnapshot(body);
  return { config: snapshot.config, source: snapshot.source ?? 'unknown', loadoutSources: snapshot.loadoutSources ?? {}, defaultLoadoutId: snapshot.defaultLoadoutId ?? null };
}

function activeLoadoutMessage(body: ActiveLoadoutResponse): string {
  if (typeof body.error === 'string') return body.error;
  if (body.error?.message) return body.error.message;
  return body.message ?? 'Active loadout change failed.';
}

function defaultLoadoutMessage(body: { error?: string | { message?: string }; message?: string }): string {
  if (typeof body.error === 'string') return body.error;
  if (body.error?.message) return body.error.message;
  return body.message ?? 'Default loadout change failed.';
}

function hasLoadoutId(loadouts: Record<string, PipelineConfig>, loadoutId: string | null | undefined): boolean {
  return Boolean(loadoutId) && Object.values(loadouts).some((loadout) => loadout.id === loadoutId);
}

function loadoutIdForName(loadouts: Record<string, PipelineConfig>, name: string | undefined): string | undefined {
  return name ? loadouts[name]?.id : undefined;
}

function mergeReloadedConfigIntoDraft(current: MateriaConfig | undefined, reloaded: MateriaConfig, preserveLoadoutEdits: boolean): MateriaConfig {
  if (!preserveLoadoutEdits || !current) return normalizeMateriaConfigEdges(reloaded);
  return normalizeMateriaConfigEdges({
    ...current,
    materia: reloaded.materia,
  });
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

export function configForDirtyComparison(config: MateriaConfig | undefined): unknown {
  if (!config) return config;
  const comparable = normalizeMateriaConfigEdges(config, { semantic: false });
  // activeLoadout is the user's current UI/session selection. It remains in the
  // persisted config for compatibility, but selecting a loadout must not require
  // a save or make the header report staged edits by itself.
  delete comparable.activeLoadout;
  return sortObjectKeys(comparable);
}

export function dirtyConfigKey(config: MateriaConfig | undefined): string {
  return JSON.stringify(configForDirtyComparison(config));
}

function comparableLoadoutGraph(loadout: PipelineConfig | undefined): unknown {
  if (!loadout) return undefined;
  const comparable = cloneConfig(loadout);
  delete comparable.lockState;
  return sortObjectKeys(normalizeMateriaConfigEdges({ loadouts: { Current: comparable } }, { semantic: false }).loadouts?.Current ?? comparable);
}

function loadoutGraphKey(loadout: PipelineConfig | undefined): string {
  return JSON.stringify(comparableLoadoutGraph(loadout));
}

function validUserLockState(value: unknown): value is LoadoutUserLockState {
  return value === 'locked' || value === 'unlocked';
}

function policyForLoadout(loadout: PipelineConfig | undefined, source: LoadoutSourceScope | undefined) {
  return getLoadoutEditPolicy({ source: (loadout?.source ?? source ?? 'user') as never, lockState: loadout?.lockState as never });
}

function guardedDraftLoadoutsAfterUpdate({
  before,
  after,
  loadoutSources,
}: {
  before: Record<string, PipelineConfig>;
  after: Record<string, PipelineConfig>;
  loadoutSources: Record<string, LoadoutSourceScope>;
}): { loadouts: Record<string, PipelineConfig>; blocked: string[] } {
  let nextLoadouts = after;
  const blocked: string[] = [];
  for (const [name, previousLoadout] of Object.entries(before)) {
    const policy = policyForLoadout(previousLoadout, loadoutSources[name]);
    if (policy.canEdit) continue;
    const nextLoadout = nextLoadouts[name];
    if (loadoutGraphKey(previousLoadout) === loadoutGraphKey(nextLoadout)) continue;
    if (nextLoadouts === after) nextLoadouts = { ...after };
    const restored = cloneConfig(previousLoadout);
    if (!policy.readonly && validUserLockState(nextLoadout?.lockState)) restored.lockState = nextLoadout.lockState;
    nextLoadouts[name] = restored;
    blocked.push(`${name}: ${policy.reason}`);
  }
  return { loadouts: nextLoadouts, blocked };
}

function blockedProtectedLoadoutSaveChanges({
  baseline,
  draft,
  loadoutSources,
}: {
  baseline: MateriaConfig | undefined;
  draft: MateriaConfig;
  loadoutSources: Record<string, LoadoutSourceScope>;
}): string[] {
  const baselineLoadouts = buildLoadouts(baseline ?? {});
  const draftLoadouts = buildLoadouts(draft);
  const blocked: string[] = [];
  for (const [name, loadout] of Object.entries(draftLoadouts)) {
    const baselineLoadout = baselineLoadouts[name];
    if (!baselineLoadout) continue;
    const policy = policyForLoadout(loadout, loadoutSources[name]);
    if (policy.canEdit) continue;
    if (loadoutGraphKey(loadout) !== loadoutGraphKey(baselineLoadout)) blocked.push(`${name}: ${policy.reason}`);
  }
  for (const [name, loadout] of Object.entries(baselineLoadouts)) {
    if (draftLoadouts[name]) continue;
    const policy = policyForLoadout(loadout, loadoutSources[name]);
    if (!policy.canEdit) blocked.push(`${name}: ${policy.reason}`);
  }
  return blocked;
}

function demoConfig(): MateriaConfig {
  return normalizeMateriaConfigEdges({
    activeLoadout: 'Demo Loadout',
    loadouts: {
      'Demo Loadout': {
        entry: 'Socket-1',
        sockets: {
          'Socket-1': { type: 'agent', materia: 'planner', edges: [{ when: 'always', to: 'Socket-2' }] },
          'Socket-2': { type: 'agent', materia: 'Build', edges: [{ when: 'always', to: 'Socket-3' }] },
          'Socket-3': { type: 'agent', materia: 'Auto-Eval', edges: [{ when: 'always', to: 'Socket-4' }] },
          'Socket-4': { type: 'agent', materia: 'Maintain' },
        },
      },
    },
  });
}

export function useWebuiConfig() {
  const [baselineConfig, setBaselineConfig] = useState<MateriaConfig | undefined>();
  const [draftConfig, setDraftConfig] = useState<MateriaConfig | undefined>();
  const draftConfigRef = useRef<MateriaConfig | undefined>(undefined);
  const [source, setSource] = useState<string>('loading');
  const [loadoutSources, setLoadoutSources] = useState<Record<string, LoadoutSourceScope>>({});
  const [deletedLoadoutNames, setDeletedLoadoutNames] = useState<string[]>([]);
  const [loadoutNameInput, setLoadoutNameInput] = useState('');
  const [status, setStatus] = useState('Loading materia configuration…');
  const [saveTarget, setSaveTarget] = useState<SaveTarget>('user');
  const [defaultLoadoutId, setDefaultLoadoutId] = useState<string | null>(null);

  useEffect(() => {
    draftConfigRef.current = draftConfig;
  }, [draftConfig]);

  const loadouts = useMemo(() => buildLoadouts(draftConfig ?? {}), [draftConfig]);
  const persistedLoadouts = useMemo(() => buildLoadouts(baselineConfig ?? draftConfig ?? {}), [baselineConfig, draftConfig]);
  // The current config model stores the loadout being viewed/edited in
  // draftConfig.activeLoadout. Keep this staged editor selection separate from
  // the persisted runtime active loadout and from the upcoming durable default
  // preference (defaultLoadoutId). Selecting cards or creating/duplicating
  // drafts should update only these editing* values unless an explicit runtime
  // or default action is invoked.
  const editingLoadoutName = draftConfig?.activeLoadout && loadouts[draftConfig.activeLoadout] ? draftConfig.activeLoadout : Object.keys(loadouts)[0];
  const runtimeActiveLoadoutId = hasLoadoutId(persistedLoadouts, baselineConfig?.activeLoadoutId) ? baselineConfig?.activeLoadoutId : undefined;
  const runtimeActiveLoadoutName = Object.entries(persistedLoadouts).find(([, loadout]) => Boolean(runtimeActiveLoadoutId) && loadout.id === runtimeActiveLoadoutId)?.[0];
  const editingLoadout = editingLoadoutName ? loadouts[editingLoadoutName] : undefined;
  const activeLoadoutName = editingLoadoutName;
  const persistedActiveLoadoutName = runtimeActiveLoadoutName;
  const activeLoadout = editingLoadout;
  const editingLoadoutPolicy = policyForLoadout(editingLoadout, editingLoadoutName ? loadoutSources[editingLoadoutName] : undefined);
  const isDirty = dirtyConfigKey(baselineConfig) !== dirtyConfigKey(draftConfig);

  function readonlyStatus(action: string) {
    const message = `${action} blocked: ${editingLoadoutPolicy.reason}`;
    setStatus(message);
    return message;
  }

  /**
   * Compatibility builder boundary for non-loadout config edits and tests.
   * Routine loadout graph/layout edits should use updateLoadoutDraft or
   * updateLoadoutLayout so they structurally share untouched config branches.
   */
  function updateDraft(updater: (config: MateriaConfig) => void) {
    setDraftConfig((current) => {
      const previous = current ?? {};
      const beforeLoadouts = buildLoadouts(previous);
      const next = cloneConfig(previous);
      if (!next.loadouts) next.loadouts = buildLoadouts(next);
      updater(next);
      const normalizedNext = normalizeMateriaConfigEdges(next);
      const { loadouts: guardedLoadouts, blocked } = guardedDraftLoadoutsAfterUpdate({
        before: beforeLoadouts,
        after: buildLoadouts(normalizedNext),
        loadoutSources,
      });
      if (blocked.length > 0) {
        setStatus(`Blocked read-only loadout mutation. ${blocked.join(' ')}`);
        return normalizeMateriaConfigEdges({ ...normalizedNext, loadouts: guardedLoadouts });
      }
      return normalizedNext;
    });
  }

  function updateLoadoutDraft(loadoutName: string, updater: (loadout: PipelineConfig) => PipelineConfig) {
    const loadout = loadouts[loadoutName];
    const policy = policyForLoadout(loadout, loadoutSources[loadoutName]);
    if (!policy.canEdit) {
      setStatus(`Cannot edit ${loadoutName}: ${policy.reason}`);
      return false;
    }
    if (!loadout) return false;
    setDraftConfig((current) => {
      const config = current ?? {};
      const currentLoadouts = buildLoadouts(config);
      const currentLoadout = currentLoadouts[loadoutName];
      if (!currentLoadout) return current;
      const nextLoadout = updater(currentLoadout);
      if (nextLoadout === currentLoadout) return current;
      return normalizeMateriaConfigEdges({
        ...config,
        loadouts: { ...currentLoadouts, [loadoutName]: nextLoadout },
      });
    });
    return true;
  }

  function updateLoadoutLayout(loadoutName: string, updater: (loadout: PipelineConfig) => PipelineConfig) {
    const loadout = loadouts[loadoutName];
    const policy = policyForLoadout(loadout, loadoutSources[loadoutName]);
    if (!policy.canEdit) {
      setStatus(`Cannot edit ${loadoutName}: ${policy.reason}`);
      return false;
    }
    if (!loadout) return false;
    setDraftConfig((current) => {
      const config = current ?? {};
      const currentLoadouts = buildLoadouts(config);
      const currentLoadout = currentLoadouts[loadoutName];
      if (!currentLoadout) return current;
      const nextLoadout = updater(currentLoadout);
      if (nextLoadout === currentLoadout) return current;
      return {
        ...config,
        loadouts: { ...currentLoadouts, [loadoutName]: nextLoadout },
      };
    });
    return true;
  }

  async function reloadConfig({ preserveLoadoutEdits = false, readyStatus = 'Draft ready. Changes are staged until you save.', cancelled = () => false }: { preserveLoadoutEdits?: boolean; readyStatus?: string; cancelled?: () => boolean } = {}) {
    const loaded = await fetchMateriaConfig();
    if (cancelled()) return;
    const normalizedLoaded = normalizeMateriaConfigEdges(loaded.config);
    const nextDraft = mergeReloadedConfigIntoDraft(draftConfigRef.current, loaded.config, preserveLoadoutEdits);
    const nextLoadouts = buildLoadouts(nextDraft);
    const nextActive = nextDraft.activeLoadout && nextLoadouts[nextDraft.activeLoadout] ? nextDraft.activeLoadout : Object.keys(nextLoadouts)[0] ?? '';
    setBaselineConfig(normalizedLoaded);
    setDraftConfig(nextDraft);
    setLoadoutNameInput(nextActive);
    setSource(loaded.source);
    setLoadoutSources(loaded.loadoutSources ?? {});
    const nextPersistedLoadouts = buildLoadouts(normalizedLoaded);
    setDefaultLoadoutId(hasLoadoutId(nextPersistedLoadouts, loaded.defaultLoadoutId) ? loaded.defaultLoadoutId : null);
    if (!preserveLoadoutEdits) setDeletedLoadoutNames([]);
    setStatus(readyStatus);
  }

  useEffect(() => {
    let cancelled = false;
    reloadConfig({ cancelled: () => cancelled }).catch((error) => {
      if (cancelled) return;
      setStatus(`Using demo loadout data: ${error instanceof Error ? error.message : String(error)}`);
      const fallback = demoConfig();
      setBaselineConfig(cloneConfig(fallback));
      setDraftConfig(fallback);
      setLoadoutNameInput(fallback.activeLoadout ?? '');
      setSource('demo');
      setLoadoutSources({ 'Demo Loadout': 'default' });
      setDefaultLoadoutId(null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function switchEditingLoadoutDraft(name: string) {
    updateDraft((config) => {
      config.activeLoadout = name;
    });
    setLoadoutNameInput(name);
    setStatus(`Viewing loadout: ${name}`);
  }

  async function setDefaultLoadout(loadoutId: string | null) {
    const nextDefault = loadoutId?.trim() || null;
    setStatus(nextDefault ? `Setting default loadout to ${nextDefault}…` : 'Clearing default loadout…');
    let result: Awaited<ReturnType<typeof persistDefaultLoadout>>;
    try {
      result = await persistDefaultLoadout(nextDefault);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Default loadout change failed: ${message}`);
      toast({
        id: 'default-loadout-error',
        title: 'Could not update default loadout',
        description: `The default loadout preference was not changed. Try again or check the WebUI server: ${message}`,
        variant: 'error',
      });
      throw error;
    }
    const { response, body } = result;
    if (!response.ok || body.ok === false) {
      const message = defaultLoadoutMessage(body);
      setStatus(`Default loadout change failed: ${message}`);
      toast({
        id: 'default-loadout-error',
        title: 'Could not update default loadout',
        description: `The default loadout preference was not changed. ${message}`,
        variant: 'error',
      });
      throw new Error(message);
    }
    const savedDefault = body.defaultLoadoutId ?? null;
    setDefaultLoadoutId(savedDefault);
    const readyStatus = body.message ?? (savedDefault ? `Default loadout set to ${savedDefault}.` : 'Default loadout cleared.');
    setStatus(readyStatus);
    toast({
      id: `default-loadout-success:${savedDefault ?? 'none'}`,
      title: savedDefault ? 'Default loadout updated' : 'Default loadout cleared',
      description: readyStatus,
      variant: 'success',
    });
    return savedDefault;
  }

  function applyExternalRuntimeActiveLoadout(loadoutId: string, activeNameHint?: string) {
    const trimmedId = loadoutId.trim();
    if (!trimmedId || trimmedId === runtimeActiveLoadoutId) return false;
    const name = Object.entries(persistedLoadouts).find(([, loadout]) => loadout.id === trimmedId)?.[0] ?? activeNameHint;
    if (!name || !persistedLoadouts[name]) return false;
    // Monitor/session events are authoritative for runtime selection only; keep
    // staged draft loadout edits intact so cross-surface sync cannot clobber UI work.
    setBaselineConfig((current) => normalizeMateriaConfigEdges({ ...(current ?? {}), activeLoadout: name, activeLoadoutId: trimmedId }));
    setStatus(`Active loadout is now ${name}.`);
    return true;
  }

  async function setRuntimeActiveLoadout(loadoutId: string) {
    const name = Object.entries(persistedLoadouts).find(([, loadout]) => loadout.id === loadoutId)?.[0] ?? loadoutId;
    setStatus(`Changing active loadout to ${name}…`);
    let result: Awaited<ReturnType<typeof setActiveLoadout>>;
    try {
      result = await setActiveLoadout(loadoutId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Active loadout change failed: ${message}`);
      toast({
        id: 'active-loadout-error',
        title: 'Could not change active loadout',
        description: `The active loadout was not changed. Try again or check the WebUI server: ${message}`,
        variant: 'error',
      });
      throw error;
    }
    const { response, body } = result;
    if (!response.ok || body.ok === false) {
      const message = activeLoadoutMessage(body);
      setStatus(`Active loadout change failed: ${message}`);
      toast({
        id: 'active-loadout-error',
        title: 'Could not change active loadout',
        description: `The active loadout was not changed. ${message}`,
        variant: 'error',
      });
      throw new Error(message);
    }
    const activeName = body.activeLoadout ?? name;
    const activeLoadoutId = body.activeLoadoutId ?? loadoutId;
    const readyStatus = body.message ?? `Active loadout changed to ${activeName}.`;
    if (body.config) {
      const snapshot = normalizeConfigSnapshot(body, baselineConfig ?? draftConfigRef.current);
      const nextConfig = normalizeMateriaConfigEdges({ ...snapshot.config, activeLoadout: activeName ?? snapshot.config.activeLoadout ?? name, activeLoadoutId: snapshot.config.activeLoadoutId ?? activeLoadoutId });
      setBaselineConfig(nextConfig);
      if (snapshot.source) setSource(snapshot.source);
      if (snapshot.loadoutSources) setLoadoutSources(snapshot.loadoutSources);
      setStatus(readyStatus);
    } else {
      await reloadConfig({ preserveLoadoutEdits: true, readyStatus });
    }
    toast({
      id: `active-loadout-success:${activeName}`,
      title: 'Active loadout changed',
      description: readyStatus,
      variant: 'success',
    });
    return activeName;
  }

  function commitEditingLoadoutRename(rawName = loadoutNameInput) {
    if (!editingLoadoutName) return false;
    if (!editingLoadoutPolicy.canEdit) {
      readonlyStatus('Rename');
      setLoadoutNameInput(editingLoadoutName);
      return false;
    }
    const nextName = rawName.trim();
    if (!nextName) {
      setStatus('Cannot rename loadout: name cannot be empty.');
      return false;
    }
    if (nextName === editingLoadoutName) {
      setLoadoutNameInput(editingLoadoutName);
      return true;
    }
    if (loadouts[nextName]) {
      setStatus(`Cannot rename loadout: ${nextName} already exists.`);
      return false;
    }
    const previousName = editingLoadoutName;
    setDraftConfig((current) => renameLoadoutDraft({ config: current ?? {}, activeLoadoutName: previousName, nextName }));
    setDeletedLoadoutNames((current) => deletedLoadoutNamesAfterRename({ current, baselineConfig, previousName, nextName }));
    if (baselineConfig?.loadouts?.[previousName]) setSaveTarget((current) => saveTargetForSource(current, loadoutSources[previousName]));
    setLoadoutNameInput(nextName);
    setStatus(`Renamed loadout to ${nextName}. Save to persist.`);
    return true;
  }

  function createLoadout() {
    const name = makeNewLoadoutName(loadouts);
    setDraftConfig((current) => createLoadoutDraft(current ?? {}, name));
    setLoadoutNameInput(name);
    setStatus('Created a new draft loadout with one empty entry socket. Rename and save when ready.');
  }

  function duplicateLoadout(name: string) {
    const loadout = loadouts[name];
    if (!loadout) {
      setStatus(`Cannot duplicate ${name}: loadout was not found.`);
      return false;
    }
    const nextName = makeDuplicateLoadoutName(loadouts, name);
    setDraftConfig((current) => duplicateLoadoutDraft({ config: current ?? {}, name, nextName }));
    setLoadoutNameInput(nextName);
    const readyStatus = `Duplicated ${name} as ${nextName}. Save to persist.`;
    setStatus(readyStatus);
    toast({
      id: `loadout-duplicate:${nextName}`,
      title: 'Loadout duplicated',
      description: readyStatus,
      variant: 'success',
    });
    return true;
  }

  function getTargetLoadoutLockEligibility(name: string, lockState: LoadoutUserLockState): LoadoutLockEligibility {
    return getLoadoutLockEligibility({ name, lockState, draftLoadouts: loadouts, baselineLoadouts: persistedLoadouts, loadoutSources });
  }

  function setLoadoutLockState(name: string, lockState: LoadoutUserLockState) {
    const loadout = loadouts[name];
    if (!name || !loadout) return false;
    const eligibility = getTargetLoadoutLockEligibility(name, lockState);
    if (!eligibility.eligible) {
      const message = `${lockState === 'locked' ? 'Lock edit mode' : 'Unlock edit mode'} blocked: ${eligibility.reason ?? 'Loadout cannot be toggled.'}`;
      setStatus(message);
      toast({
        id: `loadout-lock-blocked:${name}:${lockState}`,
        title: lockState === 'locked' ? 'Cannot lock loadout' : 'Cannot unlock loadout',
        description: message,
        variant: 'validation',
      });
      return false;
    }
    if (loadout.lockState === lockState) return true;
    setDraftConfig((current) => {
      const config = current ?? {};
      const currentLoadouts = buildLoadouts(config);
      const currentLoadout = currentLoadouts[name];
      if (!currentLoadout) return current;
      return normalizeMateriaConfigEdges({
        ...config,
        loadouts: { ...currentLoadouts, [name]: { ...currentLoadout, lockState } },
      });
    });
    setStatus(lockState === 'locked' ? `Locked ${name}. Save to persist edit mode.` : `Unlocked ${name}. Save to persist edit mode.`);
    return true;
  }

  function setActiveLoadoutLockState(lockState: LoadoutUserLockState) {
    if (!editingLoadoutName) return false;
    return setLoadoutLockState(editingLoadoutName, lockState);
  }

  function canDeleteLoadout(name: string) {
    return Boolean(name && loadouts[name] && loadoutSources[name] !== 'default' && Object.keys(loadouts).length > 1);
  }

  function deleteLoadout(name: string) {
    if (!loadouts[name]) return false;
    if (loadoutSources[name] === 'default') {
      setStatus(`Cannot delete ${name}: shipped default loadouts are protected.`);
      return false;
    }
    const remainingNames = Object.keys(loadouts).filter((candidate) => candidate !== name);
    if (remainingNames.length === 0) {
      setStatus('Cannot delete the only loadout; create another loadout first.');
      return false;
    }
    const { config, fallbackName } = deleteLoadoutDraft({ config: draftConfig ?? {}, name, activeLoadoutName: editingLoadoutName });
    setDraftConfig(config);
    setLoadoutNameInput(fallbackName ?? '');
    if (baselineConfig?.loadouts?.[name]) {
      setDeletedLoadoutNames((current) => current.includes(name) ? current : [...current, name]);
      setSaveTarget((current) => saveTargetForSource(current, loadoutSources[name]));
    }
    setStatus(`Deleted loadout ${name}. Active loadout is now ${fallbackName}. Save to persist.`);
    return true;
  }

  function revertDraft() {
    setDraftConfig(cloneConfig(baselineConfig ?? {}));
    const readyStatus = 'Reverted staged edits.';
    setStatus(readyStatus);
    toast({
      id: 'loadout-revert-success',
      title: 'Staged edits reverted',
      description: readyStatus,
      variant: 'success',
    });
  }

  async function saveDraft() {
    if (!draftConfig) return;
    const normalizedDraft = normalizeMateriaConfigEdges(draftConfig);
    const blockedSaveChanges = blockedProtectedLoadoutSaveChanges({ baseline: baselineConfig, draft: normalizedDraft, loadoutSources });
    if (blockedSaveChanges.length > 0) {
      const message = `Cannot save staged loadout edits: ${blockedSaveChanges.join(' ')}`;
      setStatus(message);
      toast({
        id: 'readonly-loadout-save',
        title: 'Duplicate or unlock before editing',
        description: message,
        variant: 'validation',
      });
      throw new Error(message);
    }
    setStatus('Saving staged loadout edits…');
    const validationErrors = validateLoadoutSaveSemantics(normalizedDraft);
    if (validationErrors.length > 0) {
      const description = validationErrors.join('\n');
      setStatus(`Cannot save staged loadout edits: ${description}`);
      toast({
        id: 'loadout-validation',
        title: 'Cannot save loadout',
        description,
        variant: 'validation',
      });
      throw new Error(description);
    }

    const configToSave = buildConfigToSave(normalizedDraft, deletedLoadoutNames);
    let result: Awaited<ReturnType<typeof saveConfig>>;
    try {
      result = await saveConfig(saveTarget, configToSave);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Save failed: ${message}`);
      toast({
        id: `loadout-save-error:${saveTarget}`,
        title: 'Could not save loadout edits',
        description: `Your staged loadout edits were not saved. Try again or check the WebUI server: ${message}`,
        variant: 'error',
      });
      throw error;
    }
    const { response, body } = result;
    if (!response.ok || body.ok === false) {
      const message = body.error ?? 'Save failed';
      setStatus(`Save failed: ${message}`);
      toast({
        id: `loadout-save-error:${saveTarget}`,
        title: 'Could not save loadout edits',
        description: `Your staged loadout edits were not saved. ${message}`,
        variant: 'error',
      });
      throw new Error(message);
    }
    setBaselineConfig(normalizedDraft);
    setDraftConfig(normalizedDraft);
    setDeletedLoadoutNames([]);
    setLoadoutSources((current) => {
      const next = { ...current };
      for (const name of deletedLoadoutNames) delete next[name];
      for (const name of Object.keys(normalizedDraft.loadouts ?? {})) if (!next[name]) next[name] = body.target ?? saveTarget;
      return next;
    });
    const deletedLoadoutIds = new Set(deletedLoadoutNames.map((name) => loadoutIdForName(baselineConfig?.loadouts ?? {}, name)).filter((id): id is string => Boolean(id)));
    const deletedDefaultLoadoutId = defaultLoadoutId && deletedLoadoutIds.has(defaultLoadoutId) ? defaultLoadoutId : null;
    const readyStatus = `Saved staged loadout edits to ${body.target ?? saveTarget} scope.`;
    setStatus(readyStatus);
    toast({
      id: 'loadout-save-success',
      title: 'Loadout edits saved',
      description: readyStatus,
      variant: 'success',
    });
    if (deletedDefaultLoadoutId) {
      try {
        await setDefaultLoadout(null);
      } catch {
        // The loadout delete has already been saved. Keep the local preference
        // state unchanged so render-time validation suppresses the stale star;
        // reload/startup validation also treats the missing default as no
        // default even if preference cleanup could not be persisted.
      }
    }
  }

  return {
    activeLoadout,
    activeLoadoutPolicy: editingLoadoutPolicy,
    activeLoadoutName,
    baselineConfig,
    editingLoadout,
    editingLoadoutName,
    canDeleteLoadout,
    canRevert: Boolean(baselineConfig),
    commitActiveLoadoutRename: commitEditingLoadoutRename,
    commitEditingLoadoutRename,
    createLoadout,
    defaultLoadoutId,
    deleteLoadout,
    duplicateLoadout,
    draftConfig,
    isDirty,
    loadoutNameInput,
    loadoutSources,
    applyExternalRuntimeActiveLoadout,
    loadouts,
    persistedActiveLoadoutName,
    persistedLoadouts,
    runtimeActiveLoadoutId,
    reloadConfig,
    revertDraft,
    saveDraft,
    saveTarget,
    getLoadoutLockEligibility: getTargetLoadoutLockEligibility,
    setDefaultLoadout,
    setLoadoutNameInput,
    setPersistedActiveLoadout: setRuntimeActiveLoadout,
    setRuntimeActiveLoadout,
    setSaveTarget,
    setStatus,
    setActiveLoadoutLockState,
    setLoadoutLockState,
    source,
    status,
    switchEditingLoadoutDraft,
    switchLoadout: switchEditingLoadoutDraft,
    updateDraft,
    updateLoadoutDraft,
    updateLoadoutLayout,
  };
}
