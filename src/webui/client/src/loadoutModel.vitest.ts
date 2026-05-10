import { describe, expect, it } from 'vitest';
import {
  assertValidLoadoutSaveSemantics,
  buildMateriaPalette,
  canDeleteSocket,
  deleteSocketFromLoadout,
  formatSocketLabel,
  getNodeLabel,
  makeEmptyEntryLoadout,
  makeEmptySocket,
  makeNewSocketId,
  normalizeMateriaConfigEdges,
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
    expect(loadout.nodes!['Socket-1'].socketKind).toBe('entry');
    expect(getNodeLabel('Socket-1', loadout.nodes!['Socket-1'])).toBe('Empty');
    expect(formatSocketLabel('Socket-1', loadout.nodes!['Socket-1'])).toBe('Socket-1 (Empty)');
  });

  it('rejects semantic ids when creating a new empty entry socket', () => {
    expect(() => makeEmptyEntryLoadout('Build')).toThrow(/Invalid socket id "Build" referenced by new loadout entry/);
    expect(() => makeEmptyEntryLoadout('Socket-03')).toThrow(/Expected Socket-N/);
  });

  it('labels newly added compatible empty sockets as Empty while preserving socket structure', () => {
    const loadout = makeEmptyEntryLoadout();
    loadout.nodes!['Socket-1'].edges = [{ when: 'always', to: 'Socket-2' }];
    loadout.nodes!['Socket-2'] = makeEmptySocket({ edges: [{ when: 'always', to: 'After' }], layout: { x: 1, y: 0 }, limits: { maxVisits: 2 } });

    expect(getNodeLabel('Socket-2', loadout.nodes!['Socket-2'])).toBe('Empty');
    expect(loadout.nodes!['Socket-2']).toEqual({ empty: true, socketKind: 'normal', edges: [{ when: 'always', to: 'After' }], layout: { x: 1, y: 0 }, limits: { maxVisits: 2 } });
  });

  it('formats contextual socket labels without renaming the socket id', () => {
    expect(formatSocketLabel('Socket-2', { type: 'agent', materia: 'Consult' })).toBe('Socket-2 (Consult)');
    expect(formatSocketLabel('Socket-3', { type: 'utility', label: 'Detect VCS', utility: 'vcs.detect' })).toBe('Socket-3 (Detect VCS)');
    expect(formatSocketLabel('Socket-4', { type: 'utility', utility: 'vcs.detect' })).toBe('Socket-4 (vcs.detect)');
  });
});

describe('loadout normalization model', () => {
  it('normalizes legacy loadout socket kinds before save', () => {
    const config = normalizeMateriaConfigEdges({
      loadouts: {
        Legacy: {
          entry: 'Socket-2',
          nodes: {
            'Socket-1': { type: 'agent', materia: 'Build', socketKind: 'entry' as never },
            'Socket-2': { type: 'agent', materia: 'Plan' },
            'Socket-3': { type: 'agent', materia: 'Check', socketKind: 'invalid' as never },
          },
        },
      },
    });

    expect(config.loadouts?.Legacy.nodes?.['Socket-1'].socketKind).toBe('normal');
    expect(config.loadouts?.Legacy.nodes?.['Socket-2'].socketKind).toBe('entry');
    expect(config.loadouts?.Legacy.nodes?.['Socket-3'].socketKind).toBe('normal');
    expect(canDeleteSocket(config.loadouts?.Legacy.nodes?.['Socket-2'])).toBe(false);
    expect(canDeleteSocket(config.loadouts?.Legacy.nodes?.['Socket-3'])).toBe(true);
  });

  it('normalizes generator-to-generator sockets to canonical JSON workItems assignment before save', () => {
    const config = normalizeMateriaConfigEdges({
      activeLoadout: 'Yolo',
      loadouts: {
        Yolo: {
          entry: 'Socket-1',
          nodes: {
            'Socket-1': { type: 'agent', materia: 'planner', edges: [{ when: 'always', to: 'Socket-2' }] },
            'Socket-2': { type: 'agent', materia: 'refiner', assign: { tasks: '$.tasks' }, edges: [{ when: 'always', to: 'end' }] },
          },
        },
      },
      materia: {
        planner: { prompt: 'Plan.', generator: true },
        refiner: { prompt: 'Refine.', generator: true },
      },
    });

    expect(config.loadouts?.Yolo.nodes?.['Socket-1'].parse).toBe('json');
    expect(config.loadouts?.Yolo.nodes?.['Socket-1'].assign?.workItems).toBe('$.workItems');
    expect(config.loadouts?.Yolo.nodes?.['Socket-2'].parse).toBe('json');
    expect(config.loadouts?.Yolo.nodes?.['Socket-2'].assign?.workItems).toBe('$.workItems');
  });

  it('normalizes generator-to-loop source sockets to canonical JSON workItems assignment before save', () => {
    const config = normalizeMateriaConfigEdges({
      loadouts: {
        Loop: {
          entry: 'Socket-1',
          loops: { taskIteration: { nodes: ['Socket-2'], consumes: { from: 'Socket-1', output: 'workItems' } } },
          nodes: {
            'Socket-1': { type: 'agent', materia: 'planner', parse: 'text', edges: [{ when: 'always', to: 'Socket-2' }] },
            'Socket-2': { type: 'agent', materia: 'Build' },
          },
        },
      },
      materia: {
        planner: { prompt: 'Plan.', generator: true },
        Build: { prompt: 'Build.' },
      },
    });

    expect(config.loadouts?.Loop.nodes?.['Socket-1'].parse).toBe('json');
    expect(config.loadouts?.Loop.nodes?.['Socket-1'].assign?.workItems).toBe('$.workItems');
    expect(config.loadouts?.Loop.nodes?.['Socket-2'].parse).toBeUndefined();
  });

  it('canonicalizes legacy UI outputFormat fields to parse before save', () => {
    const config = normalizeMateriaConfigEdges({
      materia: {
        Critique: { prompt: 'Review.', outputFormat: 'json' } as MateriaBehaviorConfig,
      },
      loadouts: {
        Draft: {
          entry: 'Socket-1',
          nodes: {
            'Socket-1': { type: 'agent', materia: 'Critique', outputFormat: 'json' } as PipelineNode,
          },
        },
      },
    });

    expect(config.materia?.Critique.parse).toBe('json');
    expect(config.materia?.Critique).not.toHaveProperty('outputFormat');
    expect(config.loadouts?.Draft.nodes?.['Socket-1'].parse).toBe('json');
    expect(config.loadouts?.Draft.nodes?.['Socket-1']).not.toHaveProperty('outputFormat');
  });

  it('rejects text-output sockets with satisfied/not_satisfied routes before save', () => {
    const config = normalizeMateriaConfigEdges({
      loadouts: {
        HojoLike: {
          entry: 'Socket-1',
          nodes: {
            'Socket-1': { type: 'agent', materia: 'Build', parse: 'text', edges: [{ when: 'satisfied', to: 'Socket-2' }] },
            'Socket-2': { type: 'agent', materia: 'Maintain' },
          },
        },
      },
    });

    expect(() => assertValidLoadoutSaveSemantics(config)).toThrow(/HojoLike.*Socket-1 \(Build\).*satisfied\/not_satisfied routing requires JSON output parsing/s);
  });

  it('allows text-output sockets with only always routes before save', () => {
    const config = normalizeMateriaConfigEdges({
      loadouts: {
        TextFlow: {
          entry: 'Socket-1',
          nodes: {
            'Socket-1': { type: 'agent', materia: 'Build', parse: 'text', edges: [{ when: 'always', to: 'Socket-2' }] },
            'Socket-2': { type: 'agent', materia: 'Maintain' },
          },
        },
      },
    });

    expect(() => assertValidLoadoutSaveSemantics(config)).not.toThrow();
  });

  it('allows JSON-output sockets with satisfied/not_satisfied routes before save', () => {
    const config = normalizeMateriaConfigEdges({
      loadouts: {
        JsonControl: {
          entry: 'Socket-1',
          nodes: {
            'Socket-1': { type: 'agent', materia: 'Auto-Eval', parse: 'json', edges: [{ when: 'satisfied', to: 'Socket-2' }, { when: 'not_satisfied', to: 'Socket-3' }] },
            'Socket-2': { type: 'agent', materia: 'Maintain' },
            'Socket-3': { type: 'agent', materia: 'Build' },
          },
        },
      },
    });

    expect(() => assertValidLoadoutSaveSemantics(config)).not.toThrow();
  });

  it('materializes loop exit control fields before save without deleting back-edges', () => {
    const config = normalizeMateriaConfigEdges({
      loadouts: {
        Yolo: {
          entry: 'Socket-1',
          loops: {
            loopSelection: {
              nodes: ['Socket-3', 'Socket-4'],
              consumes: { from: 'Socket-1', output: 'workItems' },
              exit: { from: 'Socket-4', when: 'satisfied', to: 'end' },
            },
          },
          nodes: {
            'Socket-1': { type: 'agent', materia: 'planner', edges: [{ when: 'always', to: 'Socket-3' }] },
            'Socket-3': { type: 'agent', materia: 'Build', edges: [{ when: 'always', to: 'Socket-4' }] },
            'Socket-4': { type: 'agent', materia: 'Maintain', edges: [{ when: 'always', to: 'Socket-3' }] },
          },
        },
      },
      materia: {
        planner: { prompt: 'Plan.', generator: true },
        Build: { prompt: 'Build.' },
        Maintain: { prompt: 'Maintain.' },
      },
    });

    expect(config.loadouts?.Yolo.nodes?.['Socket-4'].parse).toBe('json');
    expect(config.loadouts?.Yolo.nodes?.['Socket-4'].advance).toEqual({ cursor: 'workItemIndex', items: 'state.workItems', done: 'end', when: 'satisfied' });
    expect(config.loadouts?.Yolo.nodes?.['Socket-4'].edges).toEqual([{ when: 'always', to: 'Socket-3' }]);
  });
});

describe('loadout socket deletion model', () => {
  it('blocks entry socket deletion while allowing normal sockets', () => {
    const loadout = normalizeMateriaConfigEdges({ loadouts: { Active: makeEmptyEntryLoadout() } }).loadouts!.Active;
    loadout.nodes!['Socket-2'] = makeEmptySocket();

    expect(deleteSocketFromLoadout(loadout, 'Socket-1')).toBe(false);
    expect(loadout.nodes!['Socket-1']).toBeTruthy();
    expect(deleteSocketFromLoadout(loadout, 'Socket-2')).toBe(true);
    expect(loadout.nodes!['Socket-2']).toBeUndefined();
  });

  it('removes incoming and outgoing socket references when deleting a normal socket', () => {
    const loadout = normalizeMateriaConfigEdges({
      loadouts: {
        Active: {
          entry: 'Socket-1',
          nodes: {
            'Socket-1': { socketKind: 'entry', edges: [{ when: 'always', to: 'Socket-2' }], foreach: { items: 'state.items', done: 'Socket-2' } },
            'Socket-2': { socketKind: 'normal', edges: [{ when: 'always', to: 'Socket-3' }], advance: { cursor: 'i', items: 'state.items', done: 'Socket-3' } },
            'Socket-3': { socketKind: 'normal', edges: [{ when: 'satisfied', to: 'Socket-2' }] },
          },
        },
      },
    }).loadouts!.Active;

    expect(deleteSocketFromLoadout(loadout, 'Socket-2')).toBe(true);

    expect(Object.keys(loadout.nodes!)).toEqual(['Socket-1', 'Socket-3']);
    expect(loadout.nodes!['Socket-1'].edges).toBeUndefined();
    expect(loadout.nodes!['Socket-1'].foreach?.done).toBeUndefined();
    expect(loadout.nodes!['Socket-3'].edges).toBeUndefined();
  });

  it('cleans loop metadata and control targets referencing a deleted socket', () => {
    const loadout = normalizeMateriaConfigEdges({
      loadouts: {
        Active: {
          entry: 'Socket-1',
          loops: {
            selected: {
              nodes: ['Socket-2', 'Socket-3'],
              consumes: { from: 'Socket-1', output: 'workItems' },
              exit: { from: 'Socket-3', when: 'satisfied', to: 'Socket-4' },
              exits: [{ id: 'selected-exit', from: 'Socket-3', condition: 'always', targetSocketId: 'Socket-4' }],
            },
            targetOnly: {
              nodes: ['Socket-3'],
              consumes: { from: 'Socket-1', output: 'workItems', done: 'Socket-4' },
              iterator: { items: 'state.workItems', done: 'Socket-4' },
              exit: { from: 'Socket-3', when: 'always', to: 'Socket-4' },
              exits: [
                { id: 'target-socket-4', from: 'Socket-3', condition: 'always', targetSocketId: 'Socket-4' },
                { id: 'target-socket-1', from: 'Socket-3', condition: 'satisfied', targetSocketId: 'Socket-1' },
              ],
            },
          },
          nodes: {
            'Socket-1': { socketKind: 'entry', type: 'agent', materia: 'planner', edges: [{ when: 'always', to: 'Socket-2' }] },
            'Socket-2': { socketKind: 'normal', edges: [{ when: 'always', to: 'Socket-3' }] },
            'Socket-3': { socketKind: 'normal', edges: [{ when: 'always', to: 'Socket-2' }] },
            'Socket-4': { socketKind: 'normal' },
          },
        },
      },
    }).loadouts!.Active;

    expect(deleteSocketFromLoadout(loadout, 'Socket-2')).toBe(true);
    expect(loadout.loops?.selected).toBeUndefined();
    expect(loadout.loops?.targetOnly?.consumes?.done).toBe('Socket-4');

    expect(deleteSocketFromLoadout(loadout, 'Socket-4')).toBe(true);
    expect(loadout.loops?.targetOnly?.consumes?.done).toBeUndefined();
    expect(loadout.loops?.targetOnly?.iterator?.done).toBeUndefined();
    expect(loadout.loops?.targetOnly?.exit?.to).toBe('end');
    expect(loadout.loops?.targetOnly?.exits).toEqual([{ id: 'target-socket-1', from: 'Socket-3', condition: 'satisfied', targetSocketId: 'Socket-1' }]);
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

    expect(loadout.nodes!['Socket-1']).toEqual({ type: 'utility', utility: 'vcs.detect', parse: 'json', assign: { vcs: '$' }, empty: false, socketKind: 'entry' });
    expect(getNodeLabel('Socket-1', loadout.nodes!['Socket-1'])).toBe('vcs.detect');
  });

  it('keeps palette contents stable when palette materia is placed into a new loadout socket', () => {
    const materia = {
      Build: { prompt: 'build', parse: 'json', assign: { satisfied: '$.satisfied' } },
      Plan: { prompt: 'plan' },
    } satisfies Record<string, MateriaBehaviorConfig>;
    const before = paletteSignature(materia);
    const loadout = makeEmptyEntryLoadout();
    const buildMateria = buildMateriaPalette(materia).find(([id]) => id === 'Build')?.[1];

    loadout.nodes!['Socket-1'] = placeMateriaInSocket(loadout.nodes!['Socket-1'], buildMateria);

    expect(loadout.nodes!['Socket-1']).toMatchObject({ type: 'agent', materia: 'Build', parse: 'json', assign: { satisfied: '$.satisfied' }, empty: false });
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
      socketKind: 'entry',
    };
    const target: PipelineNode = {
      type: 'agent',
      materia: 'Check',
      edges: [{ to: 'TargetEdge', when: 'not_satisfied' }, { to: 'AfterTarget', when: 'always' }],
      layout: { x: 5, y: 6 },
      limits: { maxOutputBytes: 1024 },
      socketKind: 'normal',
    };

    const newTarget = placeMateriaInSocket(target, source);
    const newSource = placeMateriaInSocket(source, target);

    expect(newTarget).toMatchObject({ type: 'agent', materia: 'Build', layout: { x: 5, y: 6 }, limits: { maxOutputBytes: 1024 }, socketKind: 'normal' });
    expect(newTarget.edges).toEqual([{ to: 'TargetEdge', when: 'not_satisfied' }, { to: 'AfterTarget', when: 'always' }]);
    expect(newSource).toMatchObject({ type: 'agent', materia: 'Check', layout: { x: 1, y: 2 }, limits: { maxVisits: 3 }, socketKind: 'entry' });
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
