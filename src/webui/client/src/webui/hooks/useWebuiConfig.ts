import { useEffect, useMemo, useRef, useState } from 'react';
import {
  normalizeMateriaConfigEdges,
  type MateriaConfig,
} from '../../loadoutModel.js';
import { buildLoadouts } from '../utils/graphLayout.js';
import { cloneConfig } from '../utils/forms.js';
import type { ActiveLoadoutResponse, ConfigResponse, LoadedConfigResponse, LoadoutSourceScope, SaveTarget } from '../types.js';
import {
  buildConfigToSave,
  createLoadoutDraft,
  deletedLoadoutNamesAfterRename,
  deleteLoadoutDraft,
  makeNewLoadoutName,
  renameLoadoutDraft,
  saveTargetForSource,
} from '../features/loadout/loadoutDraft.js';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isLoadedConfigResponse(value: unknown): value is LoadedConfigResponse {
  return isObjectRecord(value) && isObjectRecord(value.config) && ('source' in value || 'loadoutSources' in value || !('loadouts' in value));
}

function normalizeConfigSnapshot(
  payload: ConfigResponse | ActiveLoadoutResponse | MateriaConfig | LoadedConfigResponse | undefined,
  fallback?: MateriaConfig,
): { config: MateriaConfig; source?: string; loadoutSources?: Record<string, LoadoutSourceScope> } {
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
  };
}

async function fetchMateriaConfig(): Promise<{ config: MateriaConfig; source: string; loadoutSources: Record<string, LoadoutSourceScope> }> {
  const response = await fetch('/api/config');
  const body = await response.json() as ConfigResponse;
  const snapshot = normalizeConfigSnapshot(body);
  return { config: snapshot.config, source: snapshot.source ?? 'unknown', loadoutSources: snapshot.loadoutSources ?? {} };
}

function activeLoadoutMessage(body: ActiveLoadoutResponse): string {
  if (typeof body.error === 'string') return body.error;
  if (body.error?.message) return body.error.message;
  return body.message ?? 'Active loadout change failed.';
}

function mergeReloadedConfigIntoDraft(current: MateriaConfig | undefined, reloaded: MateriaConfig, preserveLoadoutEdits: boolean): MateriaConfig {
  if (!preserveLoadoutEdits || !current) return normalizeMateriaConfigEdges(reloaded);
  return normalizeMateriaConfigEdges({
    ...cloneConfig(current),
    materia: reloaded.materia ? cloneConfig(reloaded.materia) : undefined,
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
  const comparable = normalizeMateriaConfigEdges(cloneConfig(config));
  // activeLoadout is the user's current UI/session selection. It remains in the
  // persisted config for compatibility, but selecting a loadout must not require
  // a save or make the header report staged edits by itself.
  delete comparable.activeLoadout;
  return sortObjectKeys(comparable);
}

export function dirtyConfigKey(config: MateriaConfig | undefined): string {
  return JSON.stringify(configForDirtyComparison(config));
}

function demoConfig(): MateriaConfig {
  return normalizeMateriaConfigEdges({
    activeLoadout: 'Demo Loadout',
    loadouts: {
      'Demo Loadout': {
        entry: 'Socket-1',
        nodes: {
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

  useEffect(() => {
    draftConfigRef.current = draftConfig;
  }, [draftConfig]);

  const loadouts = useMemo(() => buildLoadouts(draftConfig ?? {}), [draftConfig]);
  const persistedLoadouts = useMemo(() => buildLoadouts(baselineConfig ?? draftConfig ?? {}), [baselineConfig, draftConfig]);
  const activeLoadoutName = draftConfig?.activeLoadout && loadouts[draftConfig.activeLoadout] ? draftConfig.activeLoadout : Object.keys(loadouts)[0];
  const persistedActiveLoadoutName = baselineConfig?.activeLoadout && persistedLoadouts[baselineConfig.activeLoadout]
    ? baselineConfig.activeLoadout
    : Object.keys(persistedLoadouts)[0];
  const activeLoadout = activeLoadoutName ? loadouts[activeLoadoutName] : undefined;
  const isDirty = dirtyConfigKey(baselineConfig) !== dirtyConfigKey(draftConfig);

  function updateDraft(updater: (config: MateriaConfig) => void) {
    setDraftConfig((current) => {
      const next = cloneConfig(current ?? {});
      if (!next.loadouts) next.loadouts = buildLoadouts(next);
      updater(next);
      return normalizeMateriaConfigEdges(next);
    });
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
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function switchLoadout(name: string) {
    updateDraft((config) => {
      config.activeLoadout = name;
    });
    setLoadoutNameInput(name);
    setStatus(`Viewing loadout: ${name}`);
  }

  async function setPersistedActiveLoadout(name: string) {
    setStatus(`Changing active loadout to ${name}…`);
    const response = await fetch('/api/loadout/active', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const body = await response.json() as ActiveLoadoutResponse;
    if (!response.ok || body.ok === false) {
      const message = activeLoadoutMessage(body);
      setStatus(`Active loadout change failed: ${message}`);
      throw new Error(message);
    }
    const readyStatus = body.message ?? `Active loadout changed to ${body.activeLoadout ?? name}.`;
    if (body.config) {
      const snapshot = normalizeConfigSnapshot(body, baselineConfig ?? draftConfigRef.current);
      const nextConfig = normalizeMateriaConfigEdges({ ...snapshot.config, activeLoadout: body.activeLoadout ?? snapshot.config.activeLoadout ?? name });
      setBaselineConfig(nextConfig);
      if (snapshot.source) setSource(snapshot.source);
      if (snapshot.loadoutSources) setLoadoutSources(snapshot.loadoutSources);
      setStatus(readyStatus);
    } else {
      await reloadConfig({ preserveLoadoutEdits: true, readyStatus });
    }
    return body.activeLoadout ?? name;
  }

  function commitActiveLoadoutRename(rawName = loadoutNameInput) {
    if (!activeLoadoutName) return false;
    const nextName = rawName.trim();
    if (!nextName) {
      setStatus('Cannot rename loadout: name cannot be empty.');
      return false;
    }
    if (nextName === activeLoadoutName) {
      setLoadoutNameInput(activeLoadoutName);
      return true;
    }
    if (loadouts[nextName]) {
      setStatus(`Cannot rename loadout: ${nextName} already exists.`);
      return false;
    }
    const previousName = activeLoadoutName;
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
    const { config, fallbackName } = deleteLoadoutDraft({ config: draftConfig ?? {}, name, activeLoadoutName });
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
    setStatus('Reverted staged edits.');
  }

  async function saveDraft() {
    if (!draftConfig) return;
    setStatus('Saving staged loadout edits…');
    const normalizedDraft = normalizeMateriaConfigEdges(draftConfig);
    const configToSave = buildConfigToSave(normalizedDraft, deletedLoadoutNames);
    const response = await fetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: saveTarget, config: configToSave }),
    });
    const body = await response.json();
    if (!response.ok || body.ok === false) throw new Error(body.error ?? 'Save failed');
    setBaselineConfig(normalizedDraft);
    setDraftConfig(normalizedDraft);
    setDeletedLoadoutNames([]);
    setLoadoutSources((current) => {
      const next = { ...current };
      for (const name of deletedLoadoutNames) delete next[name];
      for (const name of Object.keys(normalizedDraft.loadouts ?? {})) if (!next[name]) next[name] = body.target ?? saveTarget;
      return next;
    });
    setStatus(`Saved staged loadout edits to ${body.target ?? saveTarget} scope.`);
  }

  return {
    activeLoadout,
    activeLoadoutName,
    baselineConfig,
    canDeleteLoadout,
    canRevert: Boolean(baselineConfig),
    commitActiveLoadoutRename,
    createLoadout,
    deleteLoadout,
    draftConfig,
    isDirty,
    loadoutNameInput,
    loadoutSources,
    loadouts,
    persistedActiveLoadoutName,
    persistedLoadouts,
    reloadConfig,
    revertDraft,
    saveDraft,
    saveTarget,
    setLoadoutNameInput,
    setPersistedActiveLoadout,
    setSaveTarget,
    setStatus,
    source,
    status,
    switchLoadout,
    updateDraft,
  };
}
