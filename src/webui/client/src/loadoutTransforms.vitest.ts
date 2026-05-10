import { describe, expect, it } from 'vitest';
import { analyzeLoadoutGraph } from '../../../loadoutGraphAnalysis.js';
import type { PipelineConfig } from './loadoutModel.js';
import {
  addEdgeToLoadout,
  clearLoopExitInLoadout,
  clearMateriaFromSocket,
  createConnectedEmptySocket,
  createTaskLoop,
  deleteLoopFromLoadout,
  deleteSocketImmutable,
  removeEdgeFromLoadout,
  removeLegacyNextFromLoadout,
  removeLoopExitRouteFromLoadout,
  setSocketMateria,
  swapSocketMateria,
  toggleEdgeConditionInLoadout,
  toggleLoopExitRouteCondition,
  updateLoopExitInLoadout,
  upsertLoopExitRouteInLoadout,
} from './loadoutTransforms.js';

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function baseLoadout(): PipelineConfig {
  return {
    entry: 'Socket-1',
    nodes: {
      'Socket-1': { socketKind: 'entry', type: 'agent', materia: 'planner', edges: [{ when: 'always', to: 'Socket-2' }] },
      'Socket-2': { socketKind: 'normal', empty: true, edges: [{ when: 'always', to: 'Socket-3' }] },
      'Socket-3': { socketKind: 'normal', type: 'agent', materia: 'Build', edges: [{ when: 'always', to: 'Socket-4' }] },
      'Socket-4': { socketKind: 'normal', type: 'agent', materia: 'Maintain', edges: [{ when: 'always', to: 'Socket-3' }] },
    },
    layout: { sockets: { 'Socket-1': { x: 0, y: 0 }, 'Socket-2': { x: 1, y: 0 } } },
    loops: {
      work: {
        label: 'Work loop',
        nodes: ['Socket-3', 'Socket-4'],
        consumes: { from: 'Socket-1', output: 'workItems' },
        exit: { from: 'Socket-4', when: 'satisfied', to: 'end' },
        exits: [{ id: 'exit:Socket-4:always', from: 'Socket-4', condition: 'always', targetSocketId: 'Socket-2' }],
      },
    },
  };
}

describe('immutable loadout transforms', () => {
  it('creates connected sockets with structural sharing and without mutating the previous loadout', () => {
    const previous = deepFreeze(baseLoadout());

    const next = createConnectedEmptySocket(previous, 'Socket-1');

    expect(next).not.toBe(previous);
    expect(next.nodes).not.toBe(previous.nodes);
    expect(next.nodes?.['Socket-2']).toBe(previous.nodes?.['Socket-2']);
    expect(next.nodes?.['Socket-1']).not.toBe(previous.nodes?.['Socket-1']);
    expect(next.nodes?.['Socket-5']).toEqual({ socketKind: 'normal', empty: true, edges: [{ when: 'always', to: 'Socket-2' }] });
    expect(next.layout?.sockets?.['Socket-5']).toEqual({ x: 1, y: 0 });
    expect(previous.nodes?.['Socket-1'].edges).toEqual([{ when: 'always', to: 'Socket-2' }]);
  });

  it('places, swaps, and clears materia by cloning only affected sockets', () => {
    const previous = deepFreeze(baseLoadout());
    const placed = setSocketMateria(previous, 'Socket-2', { type: 'agent', materia: 'Review', parse: 'json' });
    expect(placed.nodes?.['Socket-2']).toMatchObject({ type: 'agent', materia: 'Review', parse: 'json', empty: false });
    expect(placed.nodes?.['Socket-1']).toBe(previous.nodes?.['Socket-1']);
    expect(previous.nodes?.['Socket-2']).toEqual({ socketKind: 'normal', empty: true, edges: [{ when: 'always', to: 'Socket-3' }] });
    expect(previous.layout?.sockets?.['Socket-2']).toEqual({ x: 1, y: 0 });

    const swapped = swapSocketMateria(placed, 'Socket-1', 'Socket-2');
    expect(swapped.nodes?.['Socket-1']).toMatchObject({ materia: 'Review', socketKind: 'entry' });
    expect(swapped.nodes?.['Socket-2']).toMatchObject({ materia: 'planner', socketKind: 'normal' });

    const cleared = clearMateriaFromSocket(swapped, 'Socket-1');
    expect(cleared.nodes?.['Socket-1']).toMatchObject({ empty: true, socketKind: 'entry' });
    expect(swapped.nodes?.['Socket-1']).toMatchObject({ materia: 'Review' });
  });

  it('adds and removes graph edges and legacy next links immutably', () => {
    const withLegacy: PipelineConfig = baseLoadout();
    withLegacy.nodes = { ...withLegacy.nodes!, 'Socket-5': { socketKind: 'normal' }, Legacy: { socketKind: 'normal', next: 'Socket-1' } };
    const previous = deepFreeze(withLegacy);
    const added = addEdgeToLoadout(previous, 'Socket-2', 'Socket-5', 'satisfied');
    expect(added.nodes?.['Socket-2'].edges).toEqual([{ when: 'always', to: 'Socket-3' }, { when: 'satisfied', to: 'Socket-5' }]);
    expect(previous.nodes?.['Socket-2'].edges).toEqual([{ when: 'always', to: 'Socket-3' }]);

    const removed = removeEdgeFromLoadout(added, 'Socket-2', 0);
    expect(removed.nodes?.['Socket-2'].edges).toEqual([{ when: 'satisfied', to: 'Socket-5' }]);

    const withoutNext = removeLegacyNextFromLoadout(previous, 'Legacy');
    expect(withoutNext.nodes?.Legacy).not.toHaveProperty('next');
    expect(previous.nodes?.Legacy).toHaveProperty('next', 'Socket-1');

    const toggled = toggleEdgeConditionInLoadout(previous, 'Socket-1', 'Socket-2', 'always', 'satisfied', 0);
    expect(toggled.nodes?.['Socket-1'].edges).toEqual([{ when: 'satisfied', to: 'Socket-2' }]);
  });

  it('creates, edits, clears, deletes loops and loop-exit routes without mutating inputs', () => {
    const previous = deepFreeze(baseLoadout());
    const created = createTaskLoop(previous, 'single', 'Single', ['Socket-2'], { from: 'Socket-1', output: 'workItems' }, { from: 'Socket-2', when: 'always', to: 'end' });
    expect(created.loops?.single).toBeDefined();
    expect(created.nodes?.['Socket-2'].edges).toContainEqual({ when: 'always', to: 'Socket-2' });
    expect(previous.loops?.single).toBeUndefined();

    const updated = updateLoopExitInLoadout(previous, 'work', { from: 'Socket-3', when: 'always', to: 'Socket-2' });
    expect(updated.loops?.work.exit).toEqual({ from: 'Socket-3', when: 'always', to: 'Socket-2' });
    expect(updated.loops?.work.exits).toBeUndefined();
    expect(previous.loops?.work.exit).toEqual({ from: 'Socket-4', when: 'satisfied', to: 'end' });

    const cleared = clearLoopExitInLoadout(previous, 'work');
    expect(cleared.loops?.work.exit).toBeUndefined();
    expect(previous.loops?.work.exit).toBeDefined();

    const upserted = upsertLoopExitRouteInLoadout(previous, 'work', 'Socket-4', 'not_satisfied', 'Socket-2');
    expect(upserted.loops?.work.exits).toContainEqual({ id: 'exit:Socket-4:not_satisfied', from: 'Socket-4', condition: 'not_satisfied', targetSocketId: 'Socket-2' });

    const toggledRoute = toggleLoopExitRouteCondition(previous, 'work', 'exit:Socket-4:always', 'not_satisfied');
    expect(toggledRoute.loops?.work.exits?.[0]).toMatchObject({ id: 'exit:Socket-4:always', condition: 'not_satisfied' });

    const removedRoute = removeLoopExitRouteFromLoadout(previous, 'work', 'exit:Socket-4:always');
    expect(removedRoute.loops?.work.exits).toBeUndefined();
    expect(previous.loops?.work.exits).toHaveLength(1);

    const deleted = deleteLoopFromLoadout(previous, 'work');
    expect(deleted.loops).toBeUndefined();
    expect(previous.loops?.work).toBeDefined();
  });

  it('deletes sockets and cleans edges/loops without mutating previous branches', () => {
    const previous = deepFreeze(baseLoadout());
    const next = deleteSocketImmutable(previous, 'Socket-2');

    expect(next.nodes?.['Socket-2']).toBeUndefined();
    expect(next.nodes?.['Socket-1'].edges).toBeUndefined();
    expect(previous.nodes?.['Socket-1'].edges).toEqual([{ when: 'always', to: 'Socket-2' }]);
    expect(next.loops?.work.exits).toBeUndefined();
  });

  it('returns the same reference for no-op edits', () => {
    const previous = deepFreeze(baseLoadout());
    expect(deleteSocketImmutable(previous, 'Socket-1')).toBe(previous);
    expect(addEdgeToLoadout(previous, 'missing', 'Socket-1', 'always')).toBe(previous);
    expect(removeLoopExitRouteFromLoadout(previous, 'work', 'missing')).toBe(previous);
  });

  it('returns changed semantic references so graph analysis sees generator insertion before a loop', () => {
    const definitions = { planner: { generator: true }, refiner: { generator: true }, Build: {}, Maintain: {} };
    const directToLoop = baseLoadout();
    directToLoop.nodes!['Socket-1'].edges = [{ when: 'always', to: 'Socket-3' }];
    const previous = deepFreeze(directToLoop);
    const inserted = setSocketMateria(createConnectedEmptySocket(previous, 'Socket-1'), 'Socket-5', { type: 'agent', materia: 'refiner' });

    expect(inserted).not.toBe(previous);
    expect(inserted.nodes).not.toBe(previous.nodes);
    const analysis = analyzeLoadoutGraph(inserted, definitions);
    expect(analysis.workItemProducingSocketIds.has('Socket-5')).toBe(true);
    expect(analysis.loopConsumerSources.get('work')?.from).toBe('Socket-5');
    expect(previous.nodes?.['Socket-1'].edges).toEqual([{ when: 'always', to: 'Socket-3' }]);
  });
});
