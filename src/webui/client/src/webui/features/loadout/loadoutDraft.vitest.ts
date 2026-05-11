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

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

describe('loadout draft mutations', () => {
  it('renames the active loadout without mutating the source config', () => {
    const frozen = deepFreeze(config);
    const renamed = renameLoadoutDraft({ config: frozen, activeLoadoutName: 'Alpha', nextName: 'Gamma' });

    expect(renamed.activeLoadout).toBe('Gamma');
    expect(renamed.loadouts?.Gamma).toMatchObject(config.loadouts.Alpha);
    expect(renamed.loadouts?.Alpha).toBeUndefined();
    expect(config.loadouts.Alpha).toBeTruthy();
  });

  it('creates an empty entry loadout and makes it active', () => {
    const frozen = deepFreeze(config);
    const created = createLoadoutDraft(frozen, 'New Loadout 3');

    expect(created.activeLoadout).toBe('New Loadout 3');
    expect(created.loadouts?.['New Loadout 3']?.entry).toBeTruthy();
    expect(Object.keys(created.loadouts?.['New Loadout 3']?.nodes ?? {})).toHaveLength(1);
    expect((config.loadouts as Record<string, unknown>)['New Loadout 3']).toBeUndefined();
  });

  it('deletes an active loadout and returns the fallback active name', () => {
    const frozen = deepFreeze(config);
    const deleted = deleteLoadoutDraft({ config: frozen, name: 'Alpha', activeLoadoutName: 'Alpha' });

    expect(deleted.fallbackName).toBe('Beta');
    expect(deleted.config.activeLoadout).toBe('Beta');
    expect(deleted.config.loadouts?.Alpha).toBeUndefined();
    expect(config.loadouts.Alpha).toBeTruthy();
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

  it('adds null deletion markers to saved config payloads without mutating the draft', () => {
    const frozen = deepFreeze(config);
    const payload = buildConfigToSave(frozen, ['Beta']);

    expect(payload.loadouts?.Beta).toBeNull();
    expect(payload.loadouts?.Alpha).toMatchObject({ entry: 'Socket-1', sockets: config.loadouts.Alpha.nodes });
    expect(payload.loadouts?.Alpha).not.toHaveProperty('nodes');
    expect(config.loadouts.Beta).toMatchObject({ entry: 'Socket-1' });
  });

  it('migrates legacy node layout into loadout layout before save', () => {
    const payload = buildConfigToSave({
      loadouts: {
        Alpha: {
          entry: 'Socket-1',
          layout: { sockets: { 'Socket-2': { x: 9, y: 9 }, Missing: { x: 99, y: 99 } } },
          nodes: {
            'Socket-1': { type: 'agent', materia: 'Build', layout: { x: 1, y: 2 } },
            'Socket-2': { type: 'agent', materia: 'Test', layout: { x: 3, y: 4 } },
          },
        },
      },
    }, []);

    expect(payload.loadouts?.Alpha?.layout?.sockets).toEqual({ 'Socket-1': { x: 1, y: 2 }, 'Socket-2': { x: 9, y: 9 } });
    expect(payload.loadouts?.Alpha?.sockets?.['Socket-1'].layout).toBeUndefined();
    expect(payload.loadouts?.Alpha?.sockets?.['Socket-2'].layout).toBeUndefined();
    expect(payload.loadouts?.Alpha).not.toHaveProperty('nodes');
  });

  it('round-trips WebUI nodes to canonical sockets for save payloads', () => {
    const payload = buildConfigToSave({
      activeLoadout: 'Alpha',
      materia: { planner: { prompt: 'plan', generator: true }, Build: { prompt: 'build' } },
      loadouts: {
        Alpha: {
          entry: 'Socket-1',
          nodes: {
            'Socket-1': { type: 'agent', materia: 'planner', parse: 'json', assign: { workItems: '$.workItems' }, edges: [{ when: 'always', to: 'Socket-2' }] },
            'Socket-2': { type: 'agent', materia: 'Build', edges: [{ when: 'always', to: 'Socket-2' }] },
          },
          loops: { work: { nodes: ['Socket-2'], consumes: { from: 'Socket-1', output: 'workItems' } } },
        },
      },
    }, []);

    expect(payload.loadouts?.Alpha?.sockets?.['Socket-1'].edges).toEqual([{ when: 'always', to: 'Socket-2' }]);
    expect(payload.loadouts?.Alpha?.loops?.work.sockets).toEqual(['Socket-2']);
    expect(payload.loadouts?.Alpha).not.toHaveProperty('nodes');
    expect(payload.loadouts?.Alpha?.loops?.work).not.toHaveProperty('nodes');
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
