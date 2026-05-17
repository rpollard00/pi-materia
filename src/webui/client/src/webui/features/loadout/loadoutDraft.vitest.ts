import { describe, expect, it } from 'vitest';
import type { MateriaConfig } from '../../../loadoutModel.js';
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
} from './loadoutDraft.js';

const config = {
  activeLoadout: 'Alpha',
  loadouts: {
    Alpha: { entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Build' } } },
    Beta: { entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Test' } } },
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

  it('creates an empty entry loadout without changing the runtime active loadout', () => {
    const frozen = deepFreeze(config);
    const created = createLoadoutDraft(frozen, 'New Loadout 3');

    expect(created.activeLoadout).toBe('Alpha');
    expect(created.loadouts?.['New Loadout 3']?.entry).toBeTruthy();
    expect(Object.keys(created.loadouts?.['New Loadout 3']?.sockets ?? {})).toHaveLength(1);
    expect((config.loadouts as Record<string, unknown>)['New Loadout 3']).toBeUndefined();
  });

  it('duplicates a loadout as an independent user-owned staged copy without changing the runtime active loadout', () => {
    const frozen = deepFreeze({
      ...config,
      loadouts: { ...config.loadouts, Alpha: { ...config.loadouts.Alpha, id: 'default:alpha', source: 'default' } },
    } satisfies MateriaConfig);
    const duplicated = duplicateLoadoutDraft({ config: frozen, name: 'Alpha', nextName: 'Alpha Copy', makeId: () => 'user:alpha-copy:test' });

    expect(duplicated.activeLoadout).toBe('Alpha');
    expect(duplicated.loadouts?.['Alpha Copy']).toMatchObject({
      ...config.loadouts.Alpha,
      id: 'user:alpha-copy:test',
      source: 'user',
      lockState: 'unlocked',
      originDefaultId: 'default:alpha',
    });
    expect(duplicated.loadouts?.['Alpha Copy']).not.toBe(config.loadouts.Alpha);
    expect(duplicated.loadouts?.['Alpha Copy']?.sockets).not.toBe(config.loadouts.Alpha.sockets);
    expect(config.loadouts.Alpha).toBeTruthy();
    expect(config.activeLoadout).toBe('Alpha');
  });

  it('chooses a unique duplicate loadout name with numbered suffixes', () => {
    expect(makeDuplicateLoadoutName({
      ...config.loadouts,
      'Alpha Copy': config.loadouts.Alpha,
      'Alpha Copy 2': config.loadouts.Alpha,
    }, 'Alpha')).toBe('Alpha Copy 3');
  });

  it('deletes an active loadout and returns the fallback active name', () => {
    const frozen = deepFreeze(config);
    const deleted = deleteLoadoutDraft({ config: frozen, name: 'Alpha', activeLoadoutName: 'Alpha' });

    expect(deleted.fallbackName).toBe('Beta');
    expect(deleted.config.activeLoadout).toBe('Beta');
    expect(deleted.config.loadouts?.Alpha).toBeUndefined();
    expect(config.loadouts.Alpha).toBeTruthy();
  });

  it('falls back to the shipped default when deleting a duplicate of that default', () => {
    const deleted = deleteLoadoutDraft({
      config: {
        activeLoadout: 'Alpha Copy',
        loadouts: {
          Alpha: { ...config.loadouts.Alpha, id: 'default:alpha', source: 'default' },
          'Alpha Copy': { ...config.loadouts.Alpha, id: 'user:alpha-copy', source: 'user', originDefaultId: 'default:alpha' },
          Beta: config.loadouts.Beta,
        },
      },
      name: 'Alpha Copy',
      activeLoadoutName: 'Alpha Copy',
    });

    expect(deleted.fallbackName).toBe('Alpha');
    expect(deleted.config.activeLoadout).toBe('Alpha');
    expect(deleted.config.loadouts?.['Alpha Copy']).toBeUndefined();
    expect(deleted.config.loadouts?.Alpha).toBeDefined();
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

  it('adds null deletion markers and omits readonly defaults from saved config payloads without mutating the draft', () => {
    const frozen = deepFreeze({
      ...config,
      loadouts: { ...config.loadouts, Alpha: { ...config.loadouts.Alpha, source: 'default' } },
    } satisfies MateriaConfig);
    const payload = buildConfigToSave(frozen, ['Beta']);

    expect(payload.loadouts?.Beta).toBeNull();
    expect(payload.loadouts?.Alpha).toBeUndefined();
    expect(config.loadouts.Beta).toMatchObject({ entry: 'Socket-1' });
  });

  it('migrates socket layout into loadout layout before save', () => {
    const payload = buildConfigToSave({
      loadouts: {
        Alpha: {
          entry: 'Socket-1',
          layout: { sockets: { 'Socket-2': { x: 9, y: 9 }, Missing: { x: 99, y: 99 } } },
          sockets: {
            'Socket-1': { materia: 'Build', layout: { x: 1, y: 2 } },
            'Socket-2': { materia: 'Test', layout: { x: 3, y: 4 } },
          },
        },
      },
    }, []);

    expect(payload.loadouts?.Alpha?.layout?.sockets).toEqual({ 'Socket-1': { x: 1, y: 2 }, 'Socket-2': { x: 9, y: 9 } });
    expect(payload.loadouts?.Alpha?.sockets?.['Socket-1'].layout).toBeUndefined();
    expect(payload.loadouts?.Alpha?.sockets?.['Socket-2'].layout).toBeUndefined();
  });

  it('round-trips WebUI sockets to canonical sockets for save payloads', () => {
    const payload = buildConfigToSave({
      activeLoadout: 'Alpha',
      materia: { planner: { prompt: 'plan', generator: true }, Build: { prompt: 'build' } },
      loadouts: {
        Alpha: {
          entry: 'Socket-1',
          sockets: {
            'Socket-1': { materia: 'planner', parse: 'json', assign: { workItems: '$.workItems' }, edges: [{ when: 'always', to: 'Socket-2' }] },
            'Socket-2': { materia: 'Build', edges: [{ when: 'always', to: 'Socket-2' }] },
          },
          loops: { work: { sockets: ['Socket-2'], consumes: { from: 'Socket-1', output: 'workItems' } } },
        },
      },
    }, []);

    expect(payload.loadouts?.Alpha?.sockets?.['Socket-1'].edges).toEqual([{ when: 'always', to: 'Socket-2' }]);
    expect(payload.loadouts?.Alpha?.loops?.work.sockets).toEqual(['Socket-2']);
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
