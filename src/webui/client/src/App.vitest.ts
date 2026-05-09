import { describe, expect, it } from 'vitest';
import { formatLoopDisplayLabel, getLoopRegions } from './App.js';
import { makeEmptySocket, type PipelineConfig } from './loadoutModel.js';

const loopLoadout = {
  entry: 'Socket-1',
  nodes: {
    'Socket-1': { type: 'agent', materia: 'Build' },
    'Socket-2': { type: 'agent', materia: 'Auto-Eval' },
    'Socket-3': { type: 'agent', materia: 'Maintain' },
    'Socket-4': makeEmptySocket(),
  },
  loops: {
    taskIteration: {
      label: 'Loop: Socket-1 → Socket-2 → Socket-3',
      nodes: ['Socket-1', 'Socket-2', 'Socket-3'],
      consumes: { from: 'Socket-1', output: 'workItems' },
    },
  },
} satisfies PipelineConfig;

describe('loop display labels', () => {
  it('formats persisted loop socket-id labels with materia names for the loop panel', () => {
    expect(formatLoopDisplayLabel(
      loopLoadout,
      'taskIteration',
      loopLoadout.loops!.taskIteration.nodes,
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
      loops: { taskIteration: { nodes: ['Socket-1', 'Socket-4', 'Socket-99'] } },
    } satisfies PipelineConfig;

    expect(formatLoopDisplayLabel(loadout, 'taskIteration', loadout.loops.taskIteration.nodes)).toBe('Build → Empty → Socket-99');
    expect(loadout.loops.taskIteration.nodes).toEqual(['Socket-1', 'Socket-4', 'Socket-99']);
  });
});
