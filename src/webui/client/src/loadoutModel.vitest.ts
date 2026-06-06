import { describe, expect, it } from 'vitest';
import { analyzeLoadoutGraph, reconcileLoadoutLoopConsumersFromGraph } from '../../../graph/loadoutGraphAnalysis.js';
import {
  assertValidLoadoutSaveSemantics,
  buildMateriaPalette,
  canonicalizeUtilitySocketReferences,
  canDeleteSocket,
  deleteSocketFromLoadout,
  formatSocketLabel,
  getSocketLabel,
  findLoopExitConnectionContext,
  makeEmptyEntryLoadout,
  makeEmptySocket,
  makeNewSocketId,
  normalizeMateriaConfigEdges,
  placeMateriaInSocket,
  removeLoopExitRoute,
  resolveMateriaColor,
  upsertLoopExitRoute,
  type MateriaBehaviorConfig,
  type MateriaConfig,
  type PipelineConfig,
  type PipelineSocket,
} from './loadoutModel.js';

const paletteSignature = (definitions: Record<string, MateriaBehaviorConfig>) => JSON.stringify(buildMateriaPalette(definitions));

describe('loadout socket display model', () => {
  it('labels the initial entry socket as Empty through the shared display helper', () => {
    const loadout = makeEmptyEntryLoadout();

    expect(loadout.entry).toBe('Socket-1');
    expect(Object.keys(loadout.sockets!)).toEqual(['Socket-1']);
    expect(loadout.sockets!['Socket-1'].socketKind).toBe('entry');
    expect(getSocketLabel('Socket-1', loadout.sockets!['Socket-1'])).toBe('Empty');
    expect(formatSocketLabel('Socket-1', loadout.sockets!['Socket-1'])).toBe('Socket-1 (Empty)');
  });

  it('keeps socket-first loadouts in the WebUI DTO during normalization', () => {
    const config = normalizeMateriaConfigEdges({
      activeLoadout: 'Canonical',
      materia: { planner: { prompt: 'plan', generator: true }, Build: { prompt: 'build' } },
      loadouts: {
        Canonical: {
          entry: 'Socket-1',
          sockets: {
            'Socket-1': { materia: 'planner', parse: 'json', assign: { workItems: '$.workItems' }, edges: [{ when: 'always', to: 'Socket-2' }] },
            'Socket-2': { materia: 'Build', edges: [{ when: 'always', to: 'Socket-2' }] },
          },
          loops: { work: { sockets: ['Socket-2'], consumes: { from: 'Socket-1', output: 'workItems' } } },
        },
      },
    } as any);

    expect(config.loadouts?.Canonical.sockets?.['Socket-1'].materia).toBe('planner');
    expect(config.loadouts?.Canonical.sockets?.['Socket-1'].socketKind).toBe('entry');
    expect(config.loadouts?.Canonical.loops?.work.sockets).toEqual(['Socket-2']);
    expect(() => assertValidLoadoutSaveSemantics(config)).not.toThrow();
  });

  it('rejects semantic ids when creating a new empty entry socket', () => {
    expect(() => makeEmptyEntryLoadout('Build')).toThrow(/Invalid socket id "Build" referenced by new loadout entry/);
    expect(() => makeEmptyEntryLoadout('Socket-03')).toThrow(/Expected Socket-N/);
  });

  it('labels newly added compatible empty sockets as Empty while preserving semantic socket structure', () => {
    const loadout = makeEmptyEntryLoadout();
    loadout.sockets!['Socket-1'].edges = [{ when: 'always', to: 'Socket-2' }];
    loadout.sockets!['Socket-2'] = makeEmptySocket({ edges: [{ when: 'always', to: 'After' }], layout: { x: 1, y: 0 }, limits: { maxVisits: 2 } });

    expect(getSocketLabel('Socket-2', loadout.sockets!['Socket-2'])).toBe('Empty');
    expect(loadout.sockets!['Socket-2']).toEqual({ empty: true, socketKind: 'normal', edges: [{ when: 'always', to: 'After' }], limits: { maxVisits: 2 } });
  });

  it('formats contextual socket labels without renaming the socket id', () => {
    expect(formatSocketLabel('Socket-2', { materia: 'Consult' })).toBe('Socket-2 (Consult)');
    expect(formatSocketLabel('Socket-3', { type: 'utility', label: 'Detect VCS', utility: 'vcs.detect' })).toBe('Socket-3 (Detect VCS)');
    expect(formatSocketLabel('Socket-4', { type: 'utility', utility: 'vcs.detect' })).toBe('Socket-4 (vcs.detect)');
    expect(formatSocketLabel('Socket-5', { materia: 'detectVcs' }, { detectVcs: { type: 'utility', label: 'Detect VCS', color: 'materia-color-cyan' } })).toBe('Socket-5 (Detect VCS)');
  });

  it('builds utility palette sockets as canonical references without copied executable fields', () => {
    const palette = buildMateriaPalette({
      ensureArtifactsIgnored: {
        type: 'utility',
        label: 'Ensure Ignore',
        color: 'materia-color-cyan',
        utility: 'project.ensureIgnored',
        command: ['node', 'config/utilities/ensure-ignored.mjs'],
        params: { patterns: ['.pi/pi-materia/'] },
        timeoutMs: 1000,
        parse: 'json',
        assign: { artifactIgnore: '$' },
      },
    });

    expect(palette).toEqual([['ensureArtifactsIgnored', { materia: 'ensureArtifactsIgnored' }]]);
    expect(getSocketLabel('Socket-1', palette[0][1], { ensureArtifactsIgnored: { type: 'utility', label: 'Ensure Ignore' } })).toBe('Ensure Ignore');
  });
});

describe('loadout normalization model', () => {
  it('normalizes current loadout socket kinds before save', () => {
    const config = normalizeMateriaConfigEdges({
      loadouts: {
        Current: {
          entry: 'Socket-2',
          sockets: {
            'Socket-1': { materia: 'Build', socketKind: 'entry' as never },
            'Socket-2': { materia: 'Plan' },
            'Socket-3': { materia: 'Check', socketKind: 'invalid' as never },
          },
        },
      },
    });

    expect(config.loadouts?.Current.sockets?.['Socket-1'].socketKind).toBe('normal');
    expect(config.loadouts?.Current.sockets?.['Socket-2'].socketKind).toBe('entry');
    expect(config.loadouts?.Current.sockets?.['Socket-3'].socketKind).toBe('normal');
    expect(canDeleteSocket(config.loadouts?.Current.sockets?.['Socket-2'])).toBe(false);
    expect(canDeleteSocket(config.loadouts?.Current.sockets?.['Socket-3'])).toBe(true);
  });

  it('migrates socket layout into loadout-level socket layout and strips semantic socket layout', () => {
    const config = normalizeMateriaConfigEdges({
      loadouts: {
        Current: {
          entry: 'Socket-1',
          layout: { sockets: { 'Socket-2': { x: 20, y: 30 }, Missing: { x: 99, y: 99 } } },
          sockets: {
            'Socket-1': { materia: 'Build', layout: { x: 1, y: 2 } },
            'Socket-2': { materia: 'Check', layout: { x: 3, y: 4 } },
            'Socket-3': { materia: 'Ship' },
          },
        },
      },
    });

    const loadout = config.loadouts?.Current;
    expect(loadout?.layout?.sockets).toEqual({ 'Socket-1': { x: 1, y: 2 }, 'Socket-2': { x: 20, y: 30 } });
    expect(loadout?.sockets?.['Socket-1'].layout).toBeUndefined();
    expect(loadout?.sockets?.['Socket-2'].layout).toBeUndefined();
    expect(loadout?.sockets?.['Socket-3'].layout).toBeUndefined();
  });

  it('keeps loadouts without layout valid during normalization', () => {
    const config = normalizeMateriaConfigEdges({ loadouts: { Bare: { entry: 'Socket-1', sockets: { 'Socket-1': { empty: true } } } } });

    expect(config.loadouts?.Bare.layout).toBeUndefined();
    expect(config.loadouts?.Bare.sockets?.['Socket-1'].socketKind).toBe('entry');
  });

  it('prunes copied utility execution fields from canonical utility socket references before save', () => {
    const config = canonicalizeUtilitySocketReferences({
      materia: { detectVcs: { type: 'utility', label: 'Detect VCS', command: ['node', 'detect-vcs.mjs'], parse: 'json', assign: { vcs: '$' } } },
      loadouts: {
        Hooks: {
          entry: 'Socket-1',
          sockets: {
            'Socket-1': {
              materia: 'detectVcs',
              utility: 'vcs.detect',
              command: ['copied'],
              params: { copied: true },
              timeoutMs: 1,
              parse: 'json',
              assign: { copied: '$' },
              edges: [{ when: 'always', to: 'end' }],
            },
          },
        },
      },
    });

    expect(config.loadouts?.Hooks.sockets?.['Socket-1']).toEqual({ materia: 'detectVcs', edges: [{ when: 'always', to: 'end' }] });
  });

  it('rejects unknown materia references during save validation', () => {
    const unknown = normalizeMateriaConfigEdges({
      materia: { Build: { type: 'agent', prompt: 'Build.' } },
      loadouts: { Hooks: { entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'missingUtility' } } } },
    }, { semantic: false });
    expect(() => assertValidLoadoutSaveSemantics(unknown)).toThrow(/socket references unknown materia/);
  });

  it('generator-to-generator sockets do not materialize parse/assign during normalization (derived at runtime)', () => {
    const config = normalizeMateriaConfigEdges({
      activeLoadout: 'Yolo',
      loadouts: {
        Yolo: {
          entry: 'Socket-1',
          sockets: {
            'Socket-1': { materia: 'planner', edges: [{ when: 'always', to: 'Socket-2' }] },
            'Socket-2': { materia: 'refiner', assign: { tasks: '$.tasks' }, edges: [{ when: 'always', to: 'end' }] },
          },
        },
      },
      materia: {
        planner: { prompt: 'Plan.', generator: true },
        refiner: { prompt: 'Refine.', generator: true },
      },
    });

    // Generator parse/assign are derived at runtime; normalization does not materialize them onto sockets
    expect(config.loadouts?.Yolo.sockets?.['Socket-1'].parse).toBeUndefined();
    expect(config.loadouts?.Yolo.sockets?.['Socket-1'].assign).toBeUndefined();
    expect(config.loadouts?.Yolo.sockets?.['Socket-2'].parse).toBeUndefined();
    // Non-canonical assign keys are preserved
    expect(config.loadouts?.Yolo.sockets?.['Socket-2'].assign?.tasks).toBe('$.tasks');
  });

  it('generator-to-loop source sockets retain authored parse (runtime validation rejects conflicts)', () => {
    const config = normalizeMateriaConfigEdges({
      loadouts: {
        Loop: {
          entry: 'Socket-1',
          loops: { taskIteration: { sockets: ['Socket-2'], consumes: { from: 'Socket-1', output: 'workItems' } } },
          sockets: {
            'Socket-1': { materia: 'planner', parse: 'text', edges: [{ when: 'always', to: 'Socket-2' }] },
            'Socket-2': { materia: 'Build' },
          },
        },
      },
      materia: {
        planner: { prompt: 'Plan.', generator: true },
        Build: { prompt: 'Build.' },
      },
    });

    // Normalization does not override authored parse on generator sockets;
    // runtime pipeline validation rejects conflicting parse values (e.g. parse:"text" on a generator).
    expect(config.loadouts?.Loop.sockets?.['Socket-1'].parse).toBe('text');
    expect(config.loadouts?.Loop.sockets?.['Socket-1'].assign).toBeUndefined();
    expect(config.loadouts?.Loop.sockets?.['Socket-2'].parse).toBeUndefined();
  });

  it('reconciles stale loop consumer metadata when a generator is inserted before an existing loop', () => {
    const config = normalizeMateriaConfigEdges({
      loadouts: {
        Loop: {
          entry: 'Socket-1',
          loops: {
            taskIteration: {
              sockets: ['Socket-3', 'Socket-4'],
              consumes: { from: 'Socket-1', output: 'workItems' },
              exit: { from: 'Socket-4', when: 'satisfied', to: 'end' },
            },
          },
          sockets: {
            'Socket-1': { materia: 'planner', edges: [{ when: 'always', to: 'Socket-2' }] },
            'Socket-2': { materia: 'refiner', edges: [{ when: 'always', to: 'Socket-3' }] },
            'Socket-3': { materia: 'Build', edges: [{ when: 'always', to: 'Socket-4' }] },
            'Socket-4': { materia: 'Maintain', edges: [{ when: 'always', to: 'Socket-3' }] },
          },
        },
      },
      materia: {
        planner: { prompt: 'Plan.', generator: true },
        refiner: { prompt: 'Refine.', generator: true },
        Build: { prompt: 'Build.' },
        Maintain: { prompt: 'Maintain.' },
      },
    });

    const loadout = config.loadouts?.Loop;
    expect(loadout?.loops?.taskIteration.consumes?.from).toBe('Socket-2');
    // Generator parse/assign are derived at runtime; normalization does not materialize them
    expect(loadout?.sockets?.['Socket-2'].parse).toBeUndefined();
    expect(loadout?.sockets?.['Socket-2'].assign).toBeUndefined();
    expect(loadout?.sockets?.['Socket-4'].advance).toEqual({ cursor: 'workItemIndex', items: 'state.workItems', when: 'satisfied' });
    expect(loadout?.loops?.taskIteration.exits).toBeUndefined();
  });

  it('analyzes loop consumer sources from graph topology without mutating input', () => {
    const loadout = {
      entry: 'Socket-1',
      loops: {
        taskIteration: {
          sockets: ['Socket-3'],
          consumes: { from: 'Socket-1', output: 'workItems' },
        },
      },
      sockets: {
        'Socket-1': { materia: 'planner', edges: [{ when: 'always', to: 'Socket-2' }] },
        'Socket-2': { materia: 'refiner', edges: [{ when: 'always', to: 'Socket-3' }] },
        'Socket-3': { materia: 'Build' },
      },
    } as any;
    const before = JSON.stringify(loadout);

    const analysis = analyzeLoadoutGraph(loadout, {
      planner: { generator: true },
      refiner: { generator: true },
      Build: {},
    });
    const reconciled = reconcileLoadoutLoopConsumersFromGraph(loadout, {
      planner: { generator: true },
      refiner: { generator: true },
      Build: {},
    });

    expect(JSON.stringify(loadout)).toBe(before);
    expect(analysis.loopConsumerSources.get('taskIteration')).toEqual({ from: 'Socket-2', output: 'workItems' });
    expect(analysis.workItemProducingSocketIds).toEqual(new Set(['Socket-2', 'Socket-1']));
    expect(analysis.diagnostics).toEqual([
      expect.objectContaining({ code: 'loop-consumer-stale', loopId: 'taskIteration', from: 'Socket-1' }),
    ]);
    expect(reconciled.loops?.taskIteration.consumes?.from).toBe('Socket-2');
    expect(JSON.stringify(reconcileLoadoutLoopConsumersFromGraph(reconciled, { planner: { generator: true }, refiner: { generator: true } }))).toBe(JSON.stringify(reconciled));
  });

  it('diagnoses missing and ambiguous graph-derived loop consumer sources', () => {
    const missing = analyzeLoadoutGraph({
      sockets: {
        'Socket-1': { materia: 'planner' },
        'Socket-2': { materia: 'Build' },
      },
      loops: { work: { sockets: ['Socket-2'], consumes: { from: 'Socket-1', output: 'workItems' } } },
    }, { planner: { generator: true }, Build: {} });

    const ambiguous = analyzeLoadoutGraph({
      sockets: {
        'Socket-1': { materia: 'planner', edges: [{ when: 'always', to: 'Socket-3' }] },
        'Socket-2': { materia: 'refiner', edges: [{ when: 'always', to: 'Socket-3' }] },
        'Socket-3': { materia: 'Build' },
      },
      loops: { work: { sockets: ['Socket-3'], consumes: { from: 'Socket-1', output: 'workItems' } } },
    }, { planner: { generator: true }, refiner: { generator: true }, Build: {} });

    expect(missing.diagnostics).toEqual([expect.objectContaining({ code: 'loop-consumer-missing', loopId: 'work' })]);
    expect(ambiguous.diagnostics).toEqual([expect.objectContaining({ code: 'loop-consumer-ambiguous', loopId: 'work' })]);
  });

  it('canonicalizes current UI outputFormat fields to parse before save', () => {
    const config = normalizeMateriaConfigEdges({
      materia: {
        Critique: { prompt: 'Review.', outputFormat: 'json' } as MateriaBehaviorConfig,
      },
      loadouts: {
        Draft: {
          entry: 'Socket-1',
          sockets: {
            'Socket-1': { materia: 'Critique', outputFormat: 'json' } as PipelineSocket,
          },
        },
      },
    });

    expect(config.materia?.Critique.parse).toBe('json');
    expect(config.materia?.Critique).not.toHaveProperty('outputFormat');
    expect(config.loadouts?.Draft.sockets?.['Socket-1'].parse).toBe('json');
    expect(config.loadouts?.Draft.sockets?.['Socket-1']).not.toHaveProperty('outputFormat');
  });

  it('rejects text-output sockets with satisfied/not_satisfied routes before save', () => {
    const config = normalizeMateriaConfigEdges({
      loadouts: {
        HojoLike: {
          entry: 'Socket-1',
          sockets: {
            'Socket-1': { materia: 'Build', parse: 'text', edges: [{ when: 'satisfied', to: 'Socket-2' }] },
            'Socket-2': { materia: 'Maintain' },
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
          sockets: {
            'Socket-1': { materia: 'Build', parse: 'text', edges: [{ when: 'always', to: 'Socket-2' }] },
            'Socket-2': { materia: 'Maintain' },
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
          sockets: {
            'Socket-1': { materia: 'Auto-Eval', parse: 'json', edges: [{ when: 'satisfied', to: 'Socket-2' }, { when: 'not_satisfied', to: 'Socket-3' }] },
            'Socket-2': { materia: 'Maintain' },
            'Socket-3': { materia: 'Build' },
          },
        },
      },
    });

    expect(() => assertValidLoadoutSaveSemantics(config)).not.toThrow();
  });

  it('validates save semantics through shared normalization without mutating editor state', () => {
    const config: MateriaConfig = {
      materia: { Generate: { generator: true }, Build: {} },
      loadouts: {
        EditorState: {
          entry: 'Socket-1',
          sockets: {
            'Socket-1': { materia: 'Generate', edges: [{ when: 'always', to: 'Socket-2' }] } as PipelineSocket,
            'Socket-2': { materia: 'Build', layout: { x: 10, y: 20 } },
          },
          loops: {
            work: { sockets: ['Socket-2'], consumes: { from: 'Stale', output: 'workItems' } },
          },
        },
      },
    };

    expect(() => assertValidLoadoutSaveSemantics(config)).not.toThrow();
    expect(config.loadouts?.EditorState.sockets?.['Socket-1']).toHaveProperty('edges');
    expect(config.loadouts?.EditorState.sockets?.['Socket-1']).not.toHaveProperty('next');
    expect(config.loadouts?.EditorState.sockets?.['Socket-2']).toHaveProperty('layout');
    expect(config.loadouts?.EditorState.loops?.work.consumes?.from).toBe('Stale');
  });

  it('materializes loop exit control fields before save without deleting back-edges', () => {
    const config = normalizeMateriaConfigEdges({
      loadouts: {
        Yolo: {
          entry: 'Socket-1',
          loops: {
            loopSelection: {
              sockets: ['Socket-3', 'Socket-4'],
              consumes: { from: 'Socket-1', output: 'workItems' },
              exit: { from: 'Socket-4', when: 'satisfied', to: 'end' },
            },
          },
          sockets: {
            'Socket-1': { materia: 'planner', edges: [{ when: 'always', to: 'Socket-3' }] },
            'Socket-3': { materia: 'Build', edges: [{ when: 'always', to: 'Socket-4' }] },
            'Socket-4': { materia: 'Maintain', edges: [{ when: 'always', to: 'Socket-3' }] },
          },
        },
      },
      materia: {
        planner: { prompt: 'Plan.', generator: true },
        Build: { prompt: 'Build.' },
        Maintain: { prompt: 'Maintain.' },
      },
    });

    expect(config.loadouts?.Yolo.sockets?.['Socket-4'].parse).toBe('json');
    expect(config.loadouts?.Yolo.sockets?.['Socket-4'].advance).toEqual({ cursor: 'workItemIndex', items: 'state.workItems', when: 'satisfied' });
    expect(config.loadouts?.Yolo.loops?.loopSelection.exits).toBeUndefined();
    expect(config.loadouts?.Yolo.sockets?.['Socket-4'].edges).toEqual([{ when: 'always', to: 'Socket-3' }]);
  });
});

describe('loadout socket deletion model', () => {
  it('blocks entry socket deletion while allowing normal sockets', () => {
    const loadout = normalizeMateriaConfigEdges({ loadouts: { Active: makeEmptyEntryLoadout() } }).loadouts!.Active;
    loadout.sockets!['Socket-2'] = makeEmptySocket();

    expect(deleteSocketFromLoadout(loadout, 'Socket-1')).toBe(false);
    expect(loadout.sockets!['Socket-1']).toBeTruthy();
    expect(deleteSocketFromLoadout(loadout, 'Socket-2')).toBe(true);
    expect(loadout.sockets!['Socket-2']).toBeUndefined();
  });

  it('removes incoming and outgoing socket references when deleting a normal socket', () => {
    const loadout = normalizeMateriaConfigEdges({
      loadouts: {
        Active: {
          entry: 'Socket-1',
          sockets: {
            'Socket-1': { socketKind: 'entry', edges: [{ when: 'always', to: 'Socket-2' }], foreach: { items: 'state.items', done: 'Socket-2' } },
            'Socket-2': { socketKind: 'normal', edges: [{ when: 'always', to: 'Socket-3' }], advance: { cursor: 'i', items: 'state.items', done: 'Socket-3' } },
            'Socket-3': { socketKind: 'normal', edges: [{ when: 'satisfied', to: 'Socket-2' }] },
          },
        },
      },
    }).loadouts!.Active;

    expect(deleteSocketFromLoadout(loadout, 'Socket-2')).toBe(true);

    expect(Object.keys(loadout.sockets!)).toEqual(['Socket-1', 'Socket-3']);
    expect(loadout.sockets!['Socket-1'].edges).toBeUndefined();
    expect(loadout.sockets!['Socket-1'].foreach?.done).toBeUndefined();
    expect(loadout.sockets!['Socket-3'].edges).toBeUndefined();
  });

  it('cleans loop metadata and control targets referencing a deleted socket', () => {
    const loadout = normalizeMateriaConfigEdges({
      loadouts: {
        Active: {
          entry: 'Socket-1',
          loops: {
            selected: {
              sockets: ['Socket-2', 'Socket-3'],
              consumes: { from: 'Socket-1', output: 'workItems' },
              exit: { from: 'Socket-3', when: 'satisfied', to: 'Socket-4' },
              exits: [{ id: 'selected-exit', from: 'Socket-3', condition: 'always', targetSocketId: 'Socket-4' }],
            },
            targetOnly: {
              sockets: ['Socket-3'],
              consumes: { from: 'Socket-1', output: 'workItems', done: 'Socket-4' },
              iterator: { items: 'state.workItems', done: 'Socket-4' },
              exit: { from: 'Socket-3', when: 'always', to: 'Socket-4' },
              exits: [
                { id: 'target-socket-4', from: 'Socket-3', condition: 'always', targetSocketId: 'Socket-4' },
                { id: 'target-socket-1', from: 'Socket-3', condition: 'satisfied', targetSocketId: 'Socket-1' },
              ],
            },
          },
          sockets: {
            'Socket-1': { socketKind: 'entry', materia: 'planner', edges: [{ when: 'always', to: 'Socket-2' }] },
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

  it('removes loop-owned exits and stale materialized routes when deleting a loop member', () => {
    const loadout = normalizeMateriaConfigEdges({
      loadouts: {
        Active: {
          entry: 'Socket-1',
          loops: {
            selected: {
              sockets: ['Socket-2', 'Socket-3'],
              consumes: { from: 'Socket-1', output: 'workItems' },
              exit: { from: 'Socket-3', when: 'satisfied', to: 'Socket-4' },
              exits: [{ id: 'after-selected', from: 'Socket-3', condition: 'always', targetSocketId: 'Socket-5' }],
            },
          },
          sockets: {
            'Socket-1': { socketKind: 'entry', materia: 'planner', edges: [{ when: 'always', to: 'Socket-2' }] },
            'Socket-2': { socketKind: 'normal', edges: [{ when: 'always', to: 'Socket-3' }] },
            'Socket-3': {
              socketKind: 'normal',
              edges: [
                { when: 'always', to: 'Socket-2' },
                { when: 'always', to: 'Socket-5' },
              ],
              advance: { cursor: 'workItemIndex', items: 'state.workItems', done: 'Socket-4', when: 'satisfied' },
            },
            'Socket-4': { socketKind: 'normal' },
            'Socket-5': { socketKind: 'normal' },
          },
        },
      },
    }).loadouts!.Active;

    expect(deleteSocketFromLoadout(loadout, 'Socket-2')).toBe(true);

    expect(loadout.loops?.selected).toBeUndefined();
    expect(loadout.sockets!['Socket-3'].advance).toBeUndefined();
    expect(loadout.sockets!['Socket-3'].edges).toBeUndefined();
    expect(Object.values(loadout.sockets!).flatMap((socket) => socket.edges ?? [])).not.toContainEqual(expect.objectContaining({ to: 'Socket-5' }));
  });
});

describe('loop-exit connection mutation model', () => {
  it('finds loop-exit sockets and upserts routes without creating normal edges', () => {
    const loadout: PipelineConfig = {
      entry: 'Socket-1',
      sockets: {
        'Socket-1': { socketKind: 'entry' },
        'Socket-2': { socketKind: 'normal', edges: [{ when: 'always', to: 'Socket-2' }] },
        'Socket-3': { socketKind: 'normal' },
      },
      loops: {
        work: { sockets: ['Socket-2'], exit: { from: 'Socket-2', when: 'always', to: 'end' } },
      },
    };

    expect(findLoopExitConnectionContext(loadout, 'Socket-2')?.loopId).toBe('work');
    expect(upsertLoopExitRoute(loadout, 'work', 'Socket-2', 'always', 'Socket-3')).toEqual({
      id: 'exit:Socket-2:always',
      from: 'Socket-2',
      condition: 'always',
      targetSocketId: 'Socket-3',
    });

    expect(loadout.sockets!['Socket-2'].edges).toEqual([{ when: 'always', to: 'Socket-2' }]);
    expect(loadout.loops?.work.exits).toEqual([{ id: 'exit:Socket-2:always', from: 'Socket-2', condition: 'always', targetSocketId: 'Socket-3' }]);
  });

  it('replaces duplicate condition routes and removes loop-exit route metadata', () => {
    const loadout: PipelineConfig = {
      entry: 'Socket-1',
      sockets: {
        'Socket-1': { socketKind: 'entry' },
        'Socket-2': { socketKind: 'normal' },
        'Socket-3': { socketKind: 'normal' },
        'Socket-4': { socketKind: 'normal' },
      },
      loops: {
        work: { sockets: ['Socket-2'], exit: { from: 'Socket-2', when: 'always', to: 'end' } },
      },
    };

    upsertLoopExitRoute(loadout, 'work', 'Socket-2', 'satisfied', 'Socket-3');
    upsertLoopExitRoute(loadout, 'work', 'Socket-2', 'satisfied', 'Socket-4');

    expect(loadout.loops?.work.exits).toEqual([{ id: 'exit:Socket-2:satisfied', from: 'Socket-2', condition: 'satisfied', targetSocketId: 'Socket-4' }]);
    expect(removeLoopExitRoute(loadout, 'work', 'exit:Socket-2:satisfied')).toBe(true);
    expect(loadout.loops?.work.exits).toBeUndefined();
  });

  it('validates conditional loop-exit routes against JSON parse semantics before save', () => {
    const config: MateriaConfig = {
      loadouts: {
        Active: {
          entry: 'Socket-1',
          sockets: {
            'Socket-1': { socketKind: 'entry' },
            'Socket-2': { socketKind: 'normal', materia: 'Maintain', parse: 'text' },
            'Socket-3': { socketKind: 'normal' },
          },
          loops: {
            work: {
              sockets: ['Socket-2'],
              exit: { from: 'Socket-2', when: 'always', to: 'end' },
              exits: [{ id: 'exit:Socket-2:satisfied', from: 'Socket-2', condition: 'satisfied', targetSocketId: 'Socket-3' }],
            },
          },
        },
      },
    };

    expect(() => assertValidLoadoutSaveSemantics(config)).toThrow(/loops\.work\.exits\[0\]\.condition/);
    config.loadouts!.Active.sockets!['Socket-2'].parse = 'json';
    expect(() => assertValidLoadoutSaveSemantics(config)).not.toThrow();
  });
});

describe('loadout materia color model', () => {
  it('resolves configured colors by materia identity for agent and utility palette/socket materia', () => {
    const materia = {
      Build: { prompt: 'build', color: 'from-emerald-200 via-lime-300 to-green-700' },
      Maintain: { prompt: 'maintain', color: 'from-fuchsia-200 via-pink-300 to-purple-700' },
      detectVcs: { type: 'utility', label: 'Detect VCS', color: 'materia-color-cyan', command: ['node', 'detect-vcs.mjs'] },
    } satisfies Record<string, MateriaBehaviorConfig>;
    const paletteMaintain = buildMateriaPalette(materia).find(([id]) => id === 'Maintain')?.[1];
    const socketedMaintain = placeMateriaInSocket(makeEmptySocket({ layout: { x: 1, y: 0 } }), paletteMaintain);
    const paletteDetectVcs = buildMateriaPalette(materia).find(([id]) => id === 'detectVcs')?.[1];
    const socketedDetectVcs = placeMateriaInSocket(makeEmptySocket({ layout: { x: 2, y: 0 } }), paletteDetectVcs);

    expect(resolveMateriaColor('Maintain', materia)).toBe('from-fuchsia-200 via-pink-300 to-purple-700');
    expect(resolveMateriaColor(socketedMaintain.materia as string, materia)).toBe(resolveMateriaColor('Maintain', materia));
    expect(resolveMateriaColor('detectVcs', materia)).toBe('materia-color-cyan');
    expect(resolveMateriaColor(socketedDetectVcs.materia as string, materia)).toBe(resolveMateriaColor('detectVcs', materia));
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
        sockets: {
          'Socket-1': { materia: 'Build' },
          'Socket-only': { materia: 'AdHoc' },
        },
      },
    };

    expect(buildMateriaPalette(materia).map(([id]) => id)).toEqual(['Build', 'Check']);
    expect(Object.values(loadouts.Active.sockets ?? {}).some((socket) => socket.materia === 'AdHoc')).toBe(true);
  });

  it('includes first-class utility materia in the palette as canonical references', () => {
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
    expect(palette.find(([id]) => id === 'ensureArtifactsIgnored')?.[1]).toEqual({
      materia: 'ensureArtifactsIgnored',
    });
    expect(materia.ensureArtifactsIgnored.group).toBe('Utility');
  });

  it('places palette-created utility materia as normal reference utility sockets', () => {
    const materia = {
      detectVcs: { type: 'utility', label: 'Detect VCS', group: 'Utility', utility: 'vcs.detect', parse: 'json', assign: { vcs: '$' } },
    } satisfies Record<string, MateriaBehaviorConfig>;
    const loadout = makeEmptyEntryLoadout();
    const utilityMateria = buildMateriaPalette(materia)[0][1];

    loadout.sockets!['Socket-1'] = placeMateriaInSocket(loadout.sockets!['Socket-1'], utilityMateria);

    expect(loadout.sockets!['Socket-1']).toEqual({ materia: 'detectVcs', empty: false, socketKind: 'entry' });
    expect(getSocketLabel('Socket-1', loadout.sockets!['Socket-1'], materia)).toBe('Detect VCS');
  });

  it('keeps palette contents stable when palette materia is placed into a new loadout socket', () => {
    const materia = {
      Build: { prompt: 'build', parse: 'json', assign: { satisfied: '$.satisfied' } },
      Plan: { prompt: 'plan' },
    } satisfies Record<string, MateriaBehaviorConfig>;
    const before = paletteSignature(materia);
    const loadout = makeEmptyEntryLoadout();
    const buildMateria = buildMateriaPalette(materia).find(([id]) => id === 'Build')?.[1];

    loadout.sockets!['Socket-1'] = placeMateriaInSocket(loadout.sockets!['Socket-1'], buildMateria);

    // Non-generator agent sockets retain materia-owned parse/assign from the definition
    expect(loadout.sockets!['Socket-1']).toMatchObject({ materia: 'Build', parse: 'json', assign: { satisfied: '$.satisfied' }, empty: false });
    expect(paletteSignature(materia)).toBe(before);
  });

  it('generator materia palette sockets omit parse and assign (derived at runtime)', () => {
    const materia = {
      planner: { prompt: 'plan', generator: true, parse: 'json', assign: { workItems: '$.workItems' } },
      Build: { prompt: 'build', parse: 'json', assign: { satisfied: '$.satisfied' } },
    } satisfies Record<string, MateriaBehaviorConfig>;

    const palette = buildMateriaPalette(materia);
    const plannerPalette = palette.find(([id]) => id === 'planner')?.[1];
    const buildPalette = palette.find(([id]) => id === 'Build')?.[1];

    // Generator: parse and assign are omitted (derived at runtime)
    expect(plannerPalette?.parse).toBeUndefined();
    expect(plannerPalette?.assign).toBeUndefined();
    // Non-generator agent: parse and assign are preserved from the definition
    expect(buildPalette?.parse).toBe('json');
    expect(buildPalette?.assign).toEqual({ satisfied: '$.satisfied' });

    // Placing a generator palette socket produces a clean socket
    const loadout = makeEmptyEntryLoadout();
    loadout.sockets!['Socket-1'] = placeMateriaInSocket(loadout.sockets!['Socket-1'], plannerPalette);
    expect(loadout.sockets!['Socket-1']).toEqual({ materia: 'planner', empty: false, socketKind: 'entry' });
  });

  it('keeps palette contents stable when connected empty sockets are added', () => {
    const materia = {
      Build: { prompt: 'build' },
      Check: { prompt: 'check' },
    } satisfies Record<string, MateriaBehaviorConfig>;
    const before = paletteSignature(materia);
    const loadout = makeEmptyEntryLoadout();
    loadout.sockets!['Socket-1'].edges = [{ when: 'always', to: 'Socket-2' }];
    loadout.sockets!['Socket-2'] = makeEmptySocket({ layout: { x: 1, y: 0 } });

    expect(Object.keys(loadout.sockets!)).toEqual(['Socket-1', 'Socket-2']);
    expect(paletteSignature(materia)).toBe(before);
  });

  it('preserves each socket structure when swapping socket materia', () => {
    const source: PipelineSocket = {
      type: 'agent',
      materia: 'Build',
      edges: [{ to: 'SourceEdge', when: 'satisfied' }, { to: 'AfterSource', when: 'always' }],
      layout: { x: 1, y: 2 },
      limits: { maxVisits: 3 },
      socketKind: 'entry',
    };
    const target: PipelineSocket = {
      type: 'agent',
      materia: 'Check',
      edges: [{ to: 'TargetEdge', when: 'not_satisfied' }, { to: 'AfterTarget', when: 'always' }],
      layout: { x: 5, y: 6 },
      limits: { maxOutputBytes: 1024 },
      socketKind: 'normal',
    };

    const newTarget = placeMateriaInSocket(target, source);
    const newSource = placeMateriaInSocket(source, target);

    expect(newTarget).toMatchObject({ materia: 'Build', limits: { maxOutputBytes: 1024 }, socketKind: 'normal' });
    expect(newTarget.layout).toBeUndefined();
    expect(newTarget.edges).toEqual([{ to: 'TargetEdge', when: 'not_satisfied' }, { to: 'AfterTarget', when: 'always' }]);
    expect(newSource).toMatchObject({ materia: 'Check', limits: { maxVisits: 3 }, socketKind: 'entry' });
    expect(newSource.layout).toBeUndefined();
    expect(newSource.edges).toEqual([{ to: 'SourceEdge', when: 'satisfied' }, { to: 'AfterSource', when: 'always' }]);
  });

  it('does not add socketed materia into config.materia when saving grid edits', () => {
    const materia = {
      Build: { prompt: 'build' },
    } satisfies Record<string, MateriaBehaviorConfig>;
    const loadout = makeEmptyEntryLoadout();
    loadout.sockets!['Socket-1'] = placeMateriaInSocket(loadout.sockets!['Socket-1'], buildMateriaPalette(materia)[0][1]);
    loadout.sockets!['Socket-2'] = { materia: 'SocketOnly' };
    const savePayload: MateriaConfig = {
      activeLoadout: 'Draft',
      materia,
      loadouts: { Draft: loadout },
    };

    expect(Object.keys(savePayload.materia ?? {})).toEqual(['Build']);
    expect(savePayload.loadouts!.Draft.sockets!['Socket-2'].materia).toBe('SocketOnly');
  });

  it('finds the next unused static Socket-N id independent of predecessor names', () => {
    expect(makeNewSocketId({ 'Socket-1': {}, 'Socket-3': {}, Build: {} })).toBe('Socket-2');
    expect(makeNewSocketId({ Build: {}, 'Build-Socket': {}, 'Socket-1': {}, 'Socket-2': {} })).toBe('Socket-3');
  });
});
