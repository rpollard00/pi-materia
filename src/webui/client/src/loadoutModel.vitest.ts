import { describe, expect, it } from 'vitest';
import {
  buildMateriaPalette,
  makeEmptyEntryLoadout,
  makeEmptySocket,
  placeMateriaInSocket,
  type MateriaBehaviorConfig,
  type MateriaConfig,
  type PipelineConfig,
  type PipelineNode,
} from './loadoutModel.js';

const paletteSignature = (definitions: Record<string, MateriaBehaviorConfig>) => JSON.stringify(buildMateriaPalette(definitions));

describe('loadout materia palette model', () => {
  it('derives the palette only from configured materia definitions', () => {
    const materia = {
      Build: { prompt: 'build' },
      Check: { prompt: 'check' },
    } satisfies Record<string, MateriaBehaviorConfig>;
    const loadouts: Record<string, PipelineConfig> = {
      Active: {
        entry: 'Entry',
        nodes: {
          Entry: { type: 'agent', materia: 'Build' },
          'Socket-only': { type: 'agent', materia: 'AdHoc' },
        },
      },
    };

    expect(buildMateriaPalette(materia).map(([id]) => id)).toEqual(['Build', 'Check']);
    expect(Object.values(loadouts.Active.nodes ?? {}).some((node) => node.materia === 'AdHoc')).toBe(true);
  });

  it('keeps palette contents stable when palette materia is placed into a new loadout socket', () => {
    const materia = {
      Build: { prompt: 'build' },
      Plan: { prompt: 'plan' },
    } satisfies Record<string, MateriaBehaviorConfig>;
    const before = paletteSignature(materia);
    const loadout = makeEmptyEntryLoadout();
    const buildMateria = buildMateriaPalette(materia).find(([id]) => id === 'Build')?.[1];

    loadout.nodes!.Entry = placeMateriaInSocket(loadout.nodes!.Entry, buildMateria);

    expect(loadout.nodes!.Entry).toMatchObject({ type: 'agent', materia: 'Build', empty: false });
    expect(paletteSignature(materia)).toBe(before);
  });

  it('keeps palette contents stable when connected empty sockets are added', () => {
    const materia = {
      Build: { prompt: 'build' },
      Check: { prompt: 'check' },
    } satisfies Record<string, MateriaBehaviorConfig>;
    const before = paletteSignature(materia);
    const loadout = makeEmptyEntryLoadout();
    loadout.nodes!.Entry.next = 'Entry-Socket';
    loadout.nodes!['Entry-Socket'] = makeEmptySocket({ layout: { x: 1, y: 0 } });

    expect(Object.keys(loadout.nodes!)).toEqual(['Entry', 'Entry-Socket']);
    expect(paletteSignature(materia)).toBe(before);
  });

  it('preserves each socket structure when swapping socket materia', () => {
    const source: PipelineNode = {
      type: 'agent',
      materia: 'Build',
      next: 'AfterSource',
      edges: [{ to: 'SourceEdge', when: 'satisfied' }],
      layout: { x: 1, y: 2 },
      limits: { maxVisits: 3 },
      socketKind: 'source-metadata',
    };
    const target: PipelineNode = {
      type: 'agent',
      materia: 'Check',
      next: 'AfterTarget',
      edges: [{ to: 'TargetEdge', when: 'not_satisfied' }],
      layout: { x: 5, y: 6 },
      limits: { maxOutputBytes: 1024 },
      socketKind: 'target-metadata',
    };

    const newTarget = placeMateriaInSocket(target, source);
    const newSource = placeMateriaInSocket(source, target);

    expect(newTarget).toMatchObject({ type: 'agent', materia: 'Build', next: 'AfterTarget', layout: { x: 5, y: 6 }, limits: { maxOutputBytes: 1024 }, socketKind: 'target-metadata' });
    expect(newTarget.edges).toEqual([{ to: 'TargetEdge', when: 'not_satisfied' }]);
    expect(newSource).toMatchObject({ type: 'agent', materia: 'Check', next: 'AfterSource', layout: { x: 1, y: 2 }, limits: { maxVisits: 3 }, socketKind: 'source-metadata' });
    expect(newSource.edges).toEqual([{ to: 'SourceEdge', when: 'satisfied' }]);
  });

  it('does not add socketed materia into config.materia when saving grid edits', () => {
    const materia = {
      Build: { prompt: 'build' },
    } satisfies Record<string, MateriaBehaviorConfig>;
    const loadout = makeEmptyEntryLoadout();
    loadout.nodes!.Entry = placeMateriaInSocket(loadout.nodes!.Entry, buildMateriaPalette(materia)[0][1]);
    loadout.nodes!['Entry-Socket'] = { type: 'agent', materia: 'SocketOnly' };
    const savePayload: MateriaConfig = {
      activeLoadout: 'Draft',
      materia,
      loadouts: { Draft: loadout },
    };

    expect(Object.keys(savePayload.materia ?? {})).toEqual(['Build']);
    expect(savePayload.loadouts!.Draft.nodes!['Entry-Socket'].materia).toBe('SocketOnly');
  });
});
