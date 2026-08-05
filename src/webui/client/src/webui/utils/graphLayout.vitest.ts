import { describe, expect, it } from 'vitest';
import { makeEmptySocket, type PipelineConfig } from '../../loadoutModel.js';
import type { LoadoutEdge, PositionedSocket, RoutedLoadoutEdge } from '../types.js';
import { formatLoopDisplayLabel, getLoopRegions, parallelFanInVisualId, parallelForkVisualId, routeLoadoutEdges } from './graphLayout.js';
import { buildParallelLoopVisuals } from './parallelLoopVisuals.js';

function qControlXs(cyclePath: string): number[] {
  return Array.from(cyclePath.matchAll(/Q\s+(-?\d+(?:\.\d+)?)\s+-?\d+(?:\.\d+)?/g)).map((match) => Number(match[1]));
}

function positioned(ids: string[]) {
  return new Map(ids.map((id, index) => [id, { id, x: index * 240, y: 120 }])) as Parameters<typeof getLoopRegions>[1];
}

function positionedSockets(ids: string[]) {
  return new Map(ids.map((id, index) => [id, { id, socket: makeEmptySocket(), index, x: index * 240, y: 120 }])) as Map<string, PositionedSocket>;
}

function cubicRoute(route: RoutedLoadoutEdge) {
  const numbers = route.path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  expect(numbers).toHaveLength(8);
  return {
    start: { x: numbers[0]!, y: numbers[1]! },
    sourceControl: { x: numbers[2]!, y: numbers[3]! },
    targetControl: { x: numbers[4]!, y: numbers[5]! },
    end: { x: numbers[6]!, y: numbers[7]! },
  };
}

function pathEndpoints(path: string) {
  const numbers = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  return {
    start: { x: numbers[0]!, y: numbers[1]! },
    end: { x: numbers[numbers.length - 2]!, y: numbers[numbers.length - 1]! },
  };
}

const loopLoadout = {
  entry: 'Socket-1',
  sockets: {
    'Socket-1': { materia: 'Build' },
    'Socket-2': { materia: 'Auto-Eval' },
    'Socket-3': { materia: 'Maintain' },
    'Socket-4': makeEmptySocket(),
  },
  loops: {
    taskIteration: {
      sockets: ['Socket-1', 'Socket-2', 'Socket-3'],
      consumes: { from: 'Socket-1', output: 'workItems' },
    },
  },
} satisfies PipelineConfig;

describe('loadout edge routing', () => {
  it('separates reciprocal same-row edges while preserving their directions', () => {
    const edges: LoadoutEdge[] = [
      { id: 'Socket-1:always:Socket-2', from: 'Socket-1', to: 'Socket-2', when: 'always', kind: 'normal', edgeIndex: 0 },
      { id: 'Socket-2:always:Socket-1', from: 'Socket-2', to: 'Socket-1', when: 'always', kind: 'normal', edgeIndex: 0 },
    ];

    const routed = routeLoadoutEdges(edges, positionedSockets(['Socket-1', 'Socket-2']));
    expect(routed.map((route) => route.edge.id)).toEqual(['Socket-1:always:Socket-2', 'Socket-2:always:Socket-1']);
    expect(routed.map((route) => ({ from: route.edge.from, to: route.edge.to }))).toEqual([
      { from: 'Socket-1', to: 'Socket-2' },
      { from: 'Socket-2', to: 'Socket-1' },
    ]);

    const forward = cubicRoute(routed[0]!);
    const reverse = cubicRoute(routed[1]!);
    const centerLineY = (forward.start.y + forward.end.y + reverse.start.y + reverse.end.y) / 4;
    const labelCenterLineY = centerLineY - 10;

    expect(forward.sourceControl.y - centerLineY).toBeLessThan(0);
    expect(forward.targetControl.y - centerLineY).toBeLessThan(0);
    expect(reverse.sourceControl.y - centerLineY).toBeGreaterThan(0);
    expect(reverse.targetControl.y - centerLineY).toBeGreaterThan(0);
    expect(routed[0]!.labelY - labelCenterLineY).toBeLessThan(0);
    expect(routed[1]!.labelY - labelCenterLineY).toBeGreaterThan(0);
  });
});

describe('parallel loop symbolic visuals', () => {
  it('derives stable three-line fork and direct fan-in visuals without adding lane sockets', () => {
    const loadout = {
      entry: 'Socket-1',
      sockets: {
        'Socket-1': { materia: 'Planner', edges: [{ when: 'always', to: 'Socket-2' }] },
        'Socket-2': { utility: 'Setup', edges: [{ when: 'always', to: 'Socket-3' }] },
        'Socket-3': { materia: 'Build', edges: [{ when: 'always', to: 'Socket-4' }] },
        'Socket-4': { materia: 'Eval', edges: [{ when: 'always', to: 'Socket-3' }] },
        'Socket-5': { materia: 'Continue' },
      },
      loops: {
        parallelWork: {
          sockets: ['Socket-3', 'Socket-4'],
          consumes: { from: 'Socket-1', output: 'workItems' },
          exit: { from: 'Socket-4', when: 'satisfied', to: 'Socket-5' },
          parallel: { maxConcurrency: 2 },
        },
      },
    } satisfies PipelineConfig;
    const region = getLoopRegions(loadout, positioned(['Socket-1', 'Socket-2', 'Socket-3', 'Socket-4', 'Socket-5']), {
      Planner: { type: 'agent', description: '', generator: true, parallel: true },
    })[0]!;

    expect(region.parallel).toBe(true);
    expect(region.parallelVisuals?.fork.id).toBe(parallelForkVisualId('parallelWork'));
    expect(region.parallelVisuals?.fork.paths).toHaveLength(3);
    expect(region.parallelVisuals?.fork.arrowPathIndex).toBe(1);
    expect(region.parallelVisuals?.fork.sourceSocketId).toBe('Socket-1');
    expect(region.parallelVisuals?.fork.targetSocketId).toBe('Socket-2');
    expect(region.parallelVisuals?.fork.label).toBe('Fan-Out');
    expect(region.parallelVisuals?.fanIn.map((visual) => visual.id)).toEqual([
      parallelFanInVisualId('parallelWork'),
    ]);
    expect(region.parallelVisuals?.fanIn.map((visual) => visual.sourceSocketId)).toEqual(['Socket-4']);
    expect(region.parallelVisuals?.fanIn.map((visual) => visual.targetSocketId)).toEqual(['Socket-5']);
    expect(region.parallelVisuals?.fanIn.map((visual) => visual.label)).toEqual(['Fan-In']);
    expect(region.parallelVisuals?.preludeSocketIds).toEqual(['Socket-2']);
    expect(region.parallelVisuals?.loopSocketIds).toEqual(['Socket-3', 'Socket-4']);
    expect(Object.keys(loadout.sockets)).toHaveLength(5);
  });
});

describe('parallel loop boundary routing', () => {
  const region = {
    generatorSocketId: 'Socket-1',
    entrySocketId: 'Socket-2',
    preludeSocketIds: ['Socket-2'],
    loopId: 'parallelWork',
    loopSocketIds: ['Socket-3'],
    continuationSocketId: 'Socket-5',
  };
  const loop = { sockets: ['Socket-3'], exit: { from: 'Socket-3', when: 'satisfied' as const, to: 'Socket-5' } };

  function visualFor(coords: Record<string, { x: number; y: number }>) {
    const positions = new Map(Object.entries(coords).map(([id, point], index) => [id, {
      id,
      socket: makeEmptySocket(),
      index,
      ...point,
    }])) as Map<string, PositionedSocket>;
    return buildParallelLoopVisuals(undefined, 'parallelWork', loop, region, positions, 0, 0, 0, 0);
  }

  it('uses boundary endpoints, perpendicular lanes, and one center arrow for every orientation', () => {
    const horizontal = visualFor({
      'Socket-1': { x: 0, y: 0 }, 'Socket-2': { x: 240, y: 0 }, 'Socket-3': { x: 480, y: 0 }, 'Socket-5': { x: 720, y: 0 },
    });
    expect(horizontal.fork.paths).toHaveLength(3);
    expect(horizontal.fork.paths.map(pathEndpoints).map(({ start, end }) => ({ start, end }))).toEqual([
      { start: { x: 112, y: 37 }, end: { x: 260, y: 37 } },
      { start: { x: 112, y: 46 }, end: { x: 260, y: 46 } },
      { start: { x: 112, y: 55 }, end: { x: 260, y: 55 } },
    ]);
    expect(horizontal.fork.arrowPathIndex).toBe(1);

    const vertical = visualFor({
      'Socket-1': { x: 0, y: 0 }, 'Socket-2': { x: 0, y: 240 }, 'Socket-3': { x: 0, y: 480 }, 'Socket-5': { x: 0, y: 720 },
    });
    expect(pathEndpoints(vertical.fork.paths[1]!).start).toEqual({ x: 66, y: 92 });
    expect(pathEndpoints(vertical.fork.paths[1]!).end).toEqual({ x: 66, y: 240 });

    const diagonal = visualFor({
      'Socket-1': { x: 0, y: 0 }, 'Socket-2': { x: 240, y: 120 }, 'Socket-3': { x: 480, y: 240 }, 'Socket-5': { x: 720, y: 360 },
    });
    const diagonalCenter = pathEndpoints(diagonal.fork.paths[1]!);
    expect(diagonalCenter.start.x).toBeGreaterThan(100);
    expect(diagonalCenter.end.x).toBeGreaterThan(diagonalCenter.start.x);
    expect(diagonalCenter.end.y).toBeGreaterThan(diagonalCenter.start.y);

    const reversed = visualFor({
      'Socket-1': { x: 480, y: 0 }, 'Socket-2': { x: 240, y: 0 }, 'Socket-3': { x: 0, y: 0 }, 'Socket-5': { x: -240, y: 0 },
    });
    const reversedCenter = pathEndpoints(reversed.fork.paths[1]!);
    expect(reversedCenter.start.x).toBeGreaterThan(reversedCenter.end.x);
  });

  it('moves both derived boundaries and labels with moved sockets', () => {
    const first = visualFor({
      'Socket-1': { x: 0, y: 0 }, 'Socket-2': { x: 240, y: 0 }, 'Socket-3': { x: 480, y: 0 }, 'Socket-5': { x: 720, y: 0 },
    });
    const moved = visualFor({
      'Socket-1': { x: 0, y: 168 }, 'Socket-2': { x: 240, y: 336 }, 'Socket-3': { x: 480, y: 504 }, 'Socket-5': { x: 720, y: 672 },
    });
    expect(moved.fork.paths).not.toEqual(first.fork.paths);
    expect(moved.fanIn[0]?.path).not.toBe(first.fanIn[0]?.path);
    expect(moved.fork.labelY).not.toBe(first.fork.labelY);
    expect(moved.fanIn[0]?.labelY).not.toBe(first.fanIn[0]?.labelY);
  });
});

describe('loop display labels', () => {
  it('derives loop labels from member materia names for the loop panel', () => {
    expect(formatLoopDisplayLabel(
      loopLoadout,
      'taskIteration',
      loopLoadout.loops!.taskIteration.sockets,
    )).toBe('Build → Auto-Eval → Maintain');
  });

  it('uses the same materia-name sequence for loadout grid loop regions', () => {
    const positions = new Map([
      ['Socket-1', { id: 'Socket-1', x: 120, y: 160 }],
      ['Socket-2', { id: 'Socket-2', x: 380, y: 160 }],
      ['Socket-3', { id: 'Socket-3', x: 640, y: 160 }],
    ]) as Parameters<typeof getLoopRegions>[1];

    expect(getLoopRegions(loopLoadout, positions)[0]?.label).toBe('Build → Auto-Eval → Maintain');
  });

  it('falls back safely for unassigned loop members without changing stored socket ids', () => {
    const loadout = {
      ...loopLoadout,
      loops: { taskIteration: { sockets: ['Socket-1', 'Socket-4', 'Socket-99'] } },
    } satisfies PipelineConfig;

    expect(formatLoopDisplayLabel(loadout, 'taskIteration', loadout.loops.taskIteration.sockets)).toBe('Build → Empty → Socket-99');
    expect(loadout.loops.taskIteration.sockets).toEqual(['Socket-1', 'Socket-4', 'Socket-99']);
  });

  it('orders virtual loop cycle paths by happy-path edges instead of stored Socket-N order', () => {
    const loadout = {
      entry: 'Socket-1',
      sockets: {
        'Socket-1': { materia: 'Build', edges: [{ when: 'always', to: 'Socket-3' }] },
        'Socket-2': { materia: 'Maintain' },
        'Socket-3': { materia: 'Auto-Eval', edges: [{ when: 'satisfied', to: 'Socket-2' }] },
      },
      loops: { review: { sockets: ['Socket-1', 'Socket-2', 'Socket-3'] } },
    } satisfies PipelineConfig;

    const storedOrderXs = qControlXs(getLoopRegions(loadout, positioned(['Socket-1', 'Socket-2', 'Socket-3']))[0]!.cyclePath);
    const centers = [...storedOrderXs].sort((a, b) => a - b);
    expect(storedOrderXs).toEqual([centers[0], centers[2], centers[1]]);
  });

  it('prefers Always edges before Satisfied edges when deriving loop display order', () => {
    const loadout = {
      entry: 'Socket-1',
      sockets: {
        'Socket-1': { materia: 'Build', edges: [{ when: 'satisfied', to: 'Socket-2' }, { when: 'always', to: 'Socket-3' }] },
        'Socket-2': { materia: 'Auto-Eval' },
        'Socket-3': { materia: 'Maintain', edges: [{ when: 'always', to: 'Socket-2' }] },
      },
      loops: { review: { sockets: ['Socket-1', 'Socket-2', 'Socket-3'] } },
    } satisfies PipelineConfig;

    const xs = qControlXs(getLoopRegions(loadout, positioned(['Socket-1', 'Socket-2', 'Socket-3']))[0]!.cyclePath);
    const centers = [...xs].sort((a, b) => a - b);
    expect(xs).toEqual([centers[0], centers[2], centers[1]]);
  });

  it('targets a configured loop exit source when a complete internal happy path can reach it', () => {
    const loadout = {
      entry: 'Socket-1',
      sockets: {
        'Socket-1': { materia: 'Build', edges: [{ when: 'always', to: 'Socket-3' }] },
        'Socket-2': { materia: 'Maintain' },
        'Socket-3': { materia: 'Auto-Eval', edges: [{ when: 'always', to: 'Socket-2' }] },
      },
      loops: { review: { sockets: ['Socket-1', 'Socket-2', 'Socket-3'], exit: { from: 'Socket-2', when: 'satisfied', to: 'end' } } },
    } satisfies PipelineConfig;

    const xs = qControlXs(getLoopRegions(loadout, positioned(['Socket-1', 'Socket-2', 'Socket-3']))[0]!.cyclePath);
    const centers = [...xs].sort((a, b) => a - b);
    expect(xs).toEqual([centers[0], centers[2], centers[1]]);
  });

  it('falls back deterministically to stored loop order for ambiguous or incomplete topology', () => {
    const loadout = {
      entry: 'Socket-1',
      sockets: {
        'Socket-1': { materia: 'Build', edges: [{ when: 'always', to: 'Socket-2' }, { when: 'always', to: 'Socket-3' }] },
        'Socket-2': { materia: 'Auto-Eval' },
        'Socket-3': { materia: 'Maintain' },
      },
      loops: { review: { sockets: ['Socket-3', 'Socket-1', 'Socket-2'] } },
    } satisfies PipelineConfig;

    const xs = qControlXs(getLoopRegions(loadout, positioned(['Socket-1', 'Socket-2', 'Socket-3']))[0]!.cyclePath);
    const centers = [...xs].sort((a, b) => a - b);
    expect(xs).toEqual([centers[2], centers[0], centers[1]]);
  });

  it('does not use not-satisfied edges to derive the happy-path loop display order', () => {
    const loadout = {
      entry: 'Socket-1',
      sockets: {
        'Socket-1': { materia: 'Build', edges: [{ when: 'not_satisfied', to: 'Socket-3' }] },
        'Socket-2': { materia: 'Auto-Eval' },
        'Socket-3': { materia: 'Maintain', edges: [{ when: 'not_satisfied', to: 'Socket-2' }] },
      },
      loops: { review: { sockets: ['Socket-1', 'Socket-2', 'Socket-3'] } },
    } satisfies PipelineConfig;

    const xs = qControlXs(getLoopRegions(loadout, positioned(['Socket-1', 'Socket-2', 'Socket-3']))[0]!.cyclePath);
    const centers = [...xs].sort((a, b) => a - b);
    expect(xs).toEqual([centers[0], centers[1], centers[2]]);
  });

  it('does not treat loop-exit routes as internal loop cycle edges', () => {
    const loadout = {
      entry: 'Socket-1',
      sockets: {
        'Socket-1': { materia: 'Build' },
        'Socket-2': { materia: 'Auto-Eval' },
        'Socket-3': { materia: 'Maintain' },
      },
      loops: {
        review: {
          sockets: ['Socket-1', 'Socket-2', 'Socket-3'],
          exit: { from: 'Socket-1', when: 'satisfied', to: 'end' },
          exits: [{ id: 'exit-satisfied', from: 'Socket-1', condition: 'satisfied', targetSocketId: 'Socket-3' }],
        },
      },
    } satisfies PipelineConfig;

    const xs = qControlXs(getLoopRegions(loadout, positioned(['Socket-1', 'Socket-2', 'Socket-3']))[0]!.cyclePath);
    const centers = [...xs].sort((a, b) => a - b);
    expect(xs).toEqual([centers[0], centers[1], centers[2]]);
  });
});
