import { describe, expect, it } from 'vitest';
import type { MateriaConfig } from '../../../loadoutModel.js';
import {
  buildConfigToSave,
  createLoadoutDraft,
  deletedLoadoutNamesAfterRename,
  deleteLoadoutDraft,
  makeNewLoadoutName,
  renameLoadoutDraft,
  saveTargetForSource,
} from './loadoutDraft.js';

const config = {
  activeLoadout: 'Alpha',
  loadouts: {
    Alpha: { entry: 'Socket-1', nodes: { 'Socket-1': { type: 'agent', materia: 'Build' } } },
    Beta: { entry: 'Socket-1', nodes: { 'Socket-1': { type: 'agent', materia: 'Test' } } },
  },
} satisfies MateriaConfig;

describe('loadout draft mutations', () => {
  it('renames the active loadout without mutating the source config', () => {
    const renamed = renameLoadoutDraft({ config, activeLoadoutName: 'Alpha', nextName: 'Gamma' });

    expect(renamed.activeLoadout).toBe('Gamma');
    expect(renamed.loadouts?.Gamma).toMatchObject(config.loadouts.Alpha);
    expect(renamed.loadouts?.Alpha).toBeUndefined();
    expect(config.loadouts.Alpha).toBeTruthy();
  });

  it('creates an empty entry loadout and makes it active', () => {
    const created = createLoadoutDraft(config, 'New Loadout 3');

    expect(created.activeLoadout).toBe('New Loadout 3');
    expect(created.loadouts?.['New Loadout 3']?.entry).toBeTruthy();
    expect(Object.keys(created.loadouts?.['New Loadout 3']?.nodes ?? {})).toHaveLength(1);
  });

  it('deletes an active loadout and returns the fallback active name', () => {
    const deleted = deleteLoadoutDraft({ config, name: 'Alpha', activeLoadoutName: 'Alpha' });

    expect(deleted.fallbackName).toBe('Beta');
    expect(deleted.config.activeLoadout).toBe('Beta');
    expect(deleted.config.loadouts?.Alpha).toBeUndefined();
  });

  it('tracks persisted rename deletion markers while removing reverted target markers', () => {
    const next = deletedLoadoutNamesAfterRename({
      current: ['Gamma'],
      baselineConfig: config,
      previousName: 'Alpha',
      nextName: 'Gamma',
    });

    expect(next).toEqual(['Alpha']);
  });

  it('adds null deletion markers to saved config payloads', () => {
    const payload = buildConfigToSave(config, ['Beta']);

    expect(payload.loadouts?.Beta).toBeNull();
    expect(payload.loadouts?.Alpha).toMatchObject(config.loadouts.Alpha);
  });

  it('chooses the next unused loadout name without filling existing gaps unexpectedly', () => {
    expect(makeNewLoadoutName({ ...config.loadouts, 'New Loadout 3': config.loadouts.Alpha })).toBe('New Loadout 4');
  });

  it('routes saves for project and explicit loadouts back to their source scope', () => {
    expect(saveTargetForSource('user', 'project')).toBe('project');
    expect(saveTargetForSource('user', 'explicit')).toBe('explicit');
    expect(saveTargetForSource('project', 'default')).toBe('project');
    expect(saveTargetForSource('explicit', undefined)).toBe('explicit');
  });
});
