import { describe, expect, it } from 'vitest';
import { makeEmptySocket, type PipelineConfig } from '../../loadoutModel.js';
import { formatLoopDisplayLabel, getLoopRegions } from './graphLayout.js';

function qControlXs(cyclePath: string): number[] {
  return Array.from(cyclePath.matchAll(/Q\s+(-?\d+(?:\.\d+)?)\s+-?\d+(?:\.\d+)?/g)).map((match) => Number(match[1]));
}

function positioned(ids: string[]) {
  return new Map(ids.map((id, index) => [id, { id, x: index * 240, y: 120 }])) as Parameters<typeof getLoopRegions>[1];
}

const loopLoadout = {
  entry: 'Socket-1',
  sockets: {
    'Socket-1': { type: 'agent', materia: 'Build' },
    'Socket-2': { type: 'agent', materia: 'Auto-Eval' },
    'Socket-3': { type: 'agent', materia: 'Maintain' },
    'Socket-4': makeEmptySocket(),
  },
  loops: {
    taskIteration: {
      label: 'Loop: Socket-1 → Socket-2 → Socket-3',
      sockets: ['Socket-1', 'Socket-2', 'Socket-3'],
      consumes: { from: 'Socket-1', output: 'workItems' },
    },
  },
} satisfies PipelineConfig;

describe('loop display labels', () => {
  it('formats persisted loop socket-id labels with materia names for the loop panel', () => {
    expect(formatLoopDisplayLabel(
      loopLoadout,
      'taskIteration',
      loopLoadout.loops!.taskIteration.sockets,
      loopLoadout.loops!.taskIteration.label,
    )).toBe('Loop: Build → Auto-Eval → Maintain');
  });

  it('uses the same materia-name sequence for loadout grid loop regions', () => {
    const positions = new Map([
      ['Socket-1', { id: 'Socket-1', x: 120, y: 160 }],
      ['Socket-2', { id: 'Socket-2', x: 380, y: 160 }],
      ['Socket-3', { id: 'Socket-3', x: 640, y: 160 }],
    ]) as Parameters<typeof getLoopRegions>[1];

    expect(getLoopRegions(loopLoadout, positions)[0]?.label).toBe('Loop: Build → Auto-Eval → Maintain');
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
        'Socket-1': { type: 'agent', materia: 'Build', edges: [{ when: 'always', to: 'Socket-3' }] },
        'Socket-2': { type: 'agent', materia: 'Maintain' },
        'Socket-3': { type: 'agent', materia: 'Auto-Eval', edges: [{ when: 'satisfied', to: 'Socket-2' }] },
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
        'Socket-1': { type: 'agent', materia: 'Build', edges: [{ when: 'satisfied', to: 'Socket-2' }, { when: 'always', to: 'Socket-3' }] },
        'Socket-2': { type: 'agent', materia: 'Auto-Eval' },
        'Socket-3': { type: 'agent', materia: 'Maintain', edges: [{ when: 'always', to: 'Socket-2' }] },
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
        'Socket-1': { type: 'agent', materia: 'Build', edges: [{ when: 'always', to: 'Socket-3' }] },
        'Socket-2': { type: 'agent', materia: 'Maintain' },
        'Socket-3': { type: 'agent', materia: 'Auto-Eval', edges: [{ when: 'always', to: 'Socket-2' }] },
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
        'Socket-1': { type: 'agent', materia: 'Build', edges: [{ when: 'always', to: 'Socket-2' }, { when: 'always', to: 'Socket-3' }] },
        'Socket-2': { type: 'agent', materia: 'Auto-Eval' },
        'Socket-3': { type: 'agent', materia: 'Maintain' },
      },
      loops: { review: { sockets: ['Socket-3', 'Socket-1', 'Socket-2'] } },
    } satisfies PipelineConfig;

    const xs = qControlXs(getLoopRegions(loadout, positioned(['Socket-1', 'Socket-2', 'Socket-3']))[0]!.cyclePath);
    const centers = [...xs].sort((a, b) => a - b);
    expect(xs).toEqual([centers[2], centers[0], centers[1]]);
  });
});
