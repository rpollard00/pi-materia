import { describe, expect, it } from 'vitest';
import { makeEmptySocket, type PipelineConfig } from '../../loadoutModel.js';
import type { LoadoutEdge, PositionedSocket, RoutedLoadoutEdge } from '../types.js';
import { formatLoopDisplayLabel, getLoopRegions, routeLoadoutEdges } from './graphLayout.js';

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
