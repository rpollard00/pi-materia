import { describe, expect, it } from 'vitest';
import {
  buildMateriaPalette,
  formatSocketLabel,
  getNodeLabel,
  makeEmptyEntryLoadout,
  makeEmptySocket,
  makeNewSocketId,
  placeMateriaInSocket,
  resolveMateriaColor,
  type MateriaBehaviorConfig,
  type MateriaConfig,
  type PipelineConfig,
  type PipelineNode,
} from './loadoutModel.js';

const paletteSignature = (definitions: Record<string, MateriaBehaviorConfig>) => JSON.stringify(buildMateriaPalette(definitions));

describe('loadout socket display model', () => {
  it('labels the initial entry socket as Empty through the shared display helper', () => {
    const loadout = makeEmptyEntryLoadout();

    expect(loadout.entry).toBe('Socket-1');
    expect(Object.keys(loadout.nodes!)).toEqual(['Socket-1']);
    expect(getNodeLabel('Socket-1', loadout.nodes!['Socket-1'])).toBe('Empty');
    expect(formatSocketLabel('Socket-1', loadout.nodes!['Socket-1'])).toBe('Socket-1 (Empty)');
  });

  it('labels newly added compatible empty sockets as Empty while preserving socket structure', () => {
    const loadout = makeEmptyEntryLoadout();
    loadout.nodes!['Socket-1'].edges = [{ when: 'always', to: 'Socket-2' }];
    loadout.nodes!['Socket-2'] = makeEmptySocket({ edges: [{ when: 'always', to: 'After' }], layout: { x: 1, y: 0 }, limits: { maxVisits: 2 } });

    expect(getNodeLabel('Socket-2', loadout.nodes!['Socket-2'])).toBe('Empty');
    expect(loadout.nodes!['Socket-2']).toEqual({ empty: true, edges: [{ when: 'always', to: 'After' }], layout: { x: 1, y: 0 }, limits: { maxVisits: 2 } });
  });

  it('formats contextual socket labels without renaming the socket id', () => {
    expect(formatSocketLabel('Socket-2', { type: 'agent', materia: 'Consult' })).toBe('Socket-2 (Consult)');
    expect(formatSocketLabel('Socket-3', { type: 'utility', label: 'Detect VCS', utility: 'vcs.detect' })).toBe('Socket-3 (Detect VCS)');
    expect(formatSocketLabel('Socket-4', { type: 'utility', utility: 'vcs.detect' })).toBe('Socket-4 (vcs.detect)');
  });
});

describe('loadout materia color model', () => {
  it('resolves configured colors by materia identity for both palette and socketed materia', () => {
    const materia = {
      Build: { prompt: 'build', color: 'from-emerald-200 via-lime-300 to-green-700' },
      Maintain: { prompt: 'maintain', color: 'from-fuchsia-200 via-pink-300 to-purple-700' },
    } satisfies Record<string, MateriaBehaviorConfig>;
    const paletteMaintain = buildMateriaPalette(materia).find(([id]) => id === 'Maintain')?.[1];
    const socketedMaintain = placeMateriaInSocket(makeEmptySocket({ layout: { x: 1, y: 0 } }), paletteMaintain);

    expect(resolveMateriaColor('Maintain', materia)).toBe('from-fuchsia-200 via-pink-300 to-purple-700');
    expect(resolveMateriaColor(socketedMaintain.materia as string, materia)).toBe(resolveMateriaColor('Maintain', materia));
  });

  it('uses a deterministic centralized fallback for materia without configured colors', () => {
    const first = resolveMateriaColor('User-Created-Materia', {});
    const second = resolveMateriaColor('User-Created-Materia', { Other: { color: 'from-sky-200 via-cyan-300 to-blue-600' } });

    expect(first).toBe(second);
  });
});

describe('loadout materia palette model', () => {
  it('derives the palette only from configured materia definitions', () => {
    const materia = {
      Build: { prompt: 'build' },
      Check: { prompt: 'check' },
    } satisfies Record<string, MateriaBehaviorConfig>;
    const loadouts: Record<string, PipelineConfig> = {
      Active: {
        entry: 'Socket-1',
        nodes: {
          'Socket-1': { type: 'agent', materia: 'Build' },
          'Socket-only': { type: 'agent', materia: 'AdHoc' },
        },
      },
    };

    expect(buildMateriaPalette(materia).map(([id]) => id)).toEqual(['Build', 'Check']);
    expect(Object.values(loadouts.Active.nodes ?? {}).some((node) => node.materia === 'AdHoc')).toBe(true);
  });

  it('includes first-class utility materia in the palette with executable bindings', () => {
    const materia = {
      ensureArtifactsIgnored: {
        type: 'utility',
        label: 'Ensure artifacts ignored',
        description: 'Ensure artifacts are ignored',
        group: 'Utility',
        utility: 'project.ensureIgnored',
        parse: 'json',
        params: { patterns: ['.pi/pi-materia/'] },
        assign: { artifactIgnore: '$' },
      },
      detectVcs: {
        type: 'utility',
        label: 'Detect VCS',
        group: 'Utility',
        utility: 'vcs.detect',
        parse: 'json',
        assign: { vcs: '$' },
      },
      Build: { prompt: 'build' },
    } satisfies Record<string, MateriaBehaviorConfig>;

    const palette = buildMateriaPalette(materia);
    expect(palette.map(([id]) => id)).toEqual(['ensureArtifactsIgnored', 'detectVcs', 'Build']);
    expect(palette.find(([id]) => id === 'ensureArtifactsIgnored')?.[1]).toMatchObject({
      type: 'utility',
      label: 'Ensure artifacts ignored',
      utility: 'project.ensureIgnored',
      parse: 'json',
      params: { patterns: ['.pi/pi-materia/'] },
      assign: { artifactIgnore: '$' },
    });
    expect(materia.ensureArtifactsIgnored.group).toBe('Utility');
  });

  it('places palette-created utility materia as normal executable utility nodes', () => {
    const materia = {
      detectVcs: { type: 'utility', label: 'Detect VCS', group: 'Utility', utility: 'vcs.detect', parse: 'json', assign: { vcs: '$' } },
    } satisfies Record<string, MateriaBehaviorConfig>;
    const loadout = makeEmptyEntryLoadout();
    const utilityMateria = buildMateriaPalette(materia)[0][1];

    loadout.nodes!['Socket-1'] = placeMateriaInSocket(loadout.nodes!['Socket-1'], utilityMateria);

    expect(loadout.nodes!['Socket-1']).toEqual({ type: 'utility', utility: 'vcs.detect', parse: 'json', assign: { vcs: '$' }, empty: false });
    expect(getNodeLabel('Socket-1', loadout.nodes!['Socket-1'])).toBe('vcs.detect');
  });

  it('keeps palette contents stable when palette materia is placed into a new loadout socket', () => {
    const materia = {
      Build: { prompt: 'build' },
      Plan: { prompt: 'plan' },
    } satisfies Record<string, MateriaBehaviorConfig>;
    const before = paletteSignature(materia);
    const loadout = makeEmptyEntryLoadout();
    const buildMateria = buildMateriaPalette(materia).find(([id]) => id === 'Build')?.[1];

    loadout.nodes!['Socket-1'] = placeMateriaInSocket(loadout.nodes!['Socket-1'], buildMateria);

    expect(loadout.nodes!['Socket-1']).toMatchObject({ type: 'agent', materia: 'Build', empty: false });
    expect(paletteSignature(materia)).toBe(before);
  });

  it('keeps palette contents stable when connected empty sockets are added', () => {
    const materia = {
      Build: { prompt: 'build' },
      Check: { prompt: 'check' },
    } satisfies Record<string, MateriaBehaviorConfig>;
    const before = paletteSignature(materia);
    const loadout = makeEmptyEntryLoadout();
    loadout.nodes!['Socket-1'].edges = [{ when: 'always', to: 'Socket-2' }];
    loadout.nodes!['Socket-2'] = makeEmptySocket({ layout: { x: 1, y: 0 } });

    expect(Object.keys(loadout.nodes!)).toEqual(['Socket-1', 'Socket-2']);
    expect(paletteSignature(materia)).toBe(before);
  });

  it('preserves each socket structure when swapping socket materia', () => {
    const source: PipelineNode = {
      type: 'agent',
      materia: 'Build',
      edges: [{ to: 'SourceEdge', when: 'satisfied' }, { to: 'AfterSource', when: 'always' }],
      layout: { x: 1, y: 2 },
      limits: { maxVisits: 3 },
      socketKind: 'source-metadata',
    };
    const target: PipelineNode = {
      type: 'agent',
      materia: 'Check',
      edges: [{ to: 'TargetEdge', when: 'not_satisfied' }, { to: 'AfterTarget', when: 'always' }],
      layout: { x: 5, y: 6 },
      limits: { maxOutputBytes: 1024 },
      socketKind: 'target-metadata',
    };

    const newTarget = placeMateriaInSocket(target, source);
    const newSource = placeMateriaInSocket(source, target);

    expect(newTarget).toMatchObject({ type: 'agent', materia: 'Build', layout: { x: 5, y: 6 }, limits: { maxOutputBytes: 1024 }, socketKind: 'target-metadata' });
    expect(newTarget.edges).toEqual([{ to: 'TargetEdge', when: 'not_satisfied' }, { to: 'AfterTarget', when: 'always' }]);
    expect(newSource).toMatchObject({ type: 'agent', materia: 'Check', layout: { x: 1, y: 2 }, limits: { maxVisits: 3 }, socketKind: 'source-metadata' });
    expect(newSource.edges).toEqual([{ to: 'SourceEdge', when: 'satisfied' }, { to: 'AfterSource', when: 'always' }]);
  });

  it('does not add socketed materia into config.materia when saving grid edits', () => {
    const materia = {
      Build: { prompt: 'build' },
    } satisfies Record<string, MateriaBehaviorConfig>;
    const loadout = makeEmptyEntryLoadout();
    loadout.nodes!['Socket-1'] = placeMateriaInSocket(loadout.nodes!['Socket-1'], buildMateriaPalette(materia)[0][1]);
    loadout.nodes!['Socket-2'] = { type: 'agent', materia: 'SocketOnly' };
    const savePayload: MateriaConfig = {
      activeLoadout: 'Draft',
      materia,
      loadouts: { Draft: loadout },
    };

    expect(Object.keys(savePayload.materia ?? {})).toEqual(['Build']);
    expect(savePayload.loadouts!.Draft.nodes!['Socket-2'].materia).toBe('SocketOnly');
  });

  it('finds the next unused static Socket-N id independent of predecessor names', () => {
    expect(makeNewSocketId({ 'Socket-1': {}, 'Socket-3': {}, Build: {} })).toBe('Socket-2');
    expect(makeNewSocketId({ Build: {}, 'Build-Socket': {}, 'Socket-1': {}, 'Socket-2': {} })).toBe('Socket-3');
  });
});
