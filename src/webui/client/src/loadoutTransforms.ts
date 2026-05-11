import type { MateriaEdgeCondition } from '../../../types.js';
import {
  canDeleteSocket,
  clearSocketMateria,
  findLoopExitConnectionContext,
  getSocketLayout,
  isEmptySocket,
  makeEmptySocket,
  makeNewSocketId,
  placeMateriaInSocket,
  setLoadoutSocketLayout,
  loopExitRouteId,
  type LegacyPipelineNode,
  type PipelineConfig,
  type PipelineLoop,
  type PipelineNode,
  type SocketLayout,
} from './loadoutModel.js';

export type LoadoutTransform = (loadout: PipelineConfig) => PipelineConfig;

function replaceNodes(loadout: PipelineConfig, sockets: Record<string, PipelineNode>): PipelineConfig {
  return { ...loadout, sockets };
}

function replaceLoops(loadout: PipelineConfig, loops: Record<string, PipelineLoop> | undefined): PipelineConfig {
  const next = { ...loadout };
  if (loops && Object.keys(loops).length > 0) next.loops = loops;
  else delete next.loops;
  return next;
}

function withoutUndefinedEdges(node: PipelineNode): PipelineNode {
  if (node.edges && node.edges.length > 0) return node;
  const next = { ...node };
  delete next.edges;
  return next;
}

function deleteOptionalDone<T extends { done?: string }>(container: T | undefined, deletedSocketId: string): T | undefined {
  if (!container || container.done !== deletedSocketId) return container;
  const next = { ...container };
  delete next.done;
  return next;
}

function removeLoopRuntimeControls(loadout: PipelineConfig, sockets: Record<string, PipelineNode>, loop: PipelineLoop): Record<string, PipelineNode> {
  const exitSource = loop.exit?.from;
  const sourceNode = exitSource ? sockets[exitSource] : undefined;
  if (!exitSource || !sourceNode) return sockets;

  const loopExitTargets = new Set((loop.exits ?? []).map((route) => route.targetSocketId));
  const advanceDoneTarget = loop.exit?.to;
  if (advanceDoneTarget && advanceDoneTarget !== 'end') loopExitTargets.add(advanceDoneTarget);

  let nextSource = sourceNode;
  if (sourceNode.advance && sourceNode.advance.done === advanceDoneTarget) {
    nextSource = { ...nextSource };
    delete nextSource.advance;
  }
  if (sourceNode.edges && loopExitTargets.size > 0) {
    const edges = sourceNode.edges.filter((edge) => !loopExitTargets.has(edge.to));
    nextSource = withoutUndefinedEdges({ ...nextSource, edges });
  }
  if (nextSource === sourceNode) return sockets;
  return { ...sockets, [exitSource]: nextSource };
}

export function applyLoadoutTransform(loadout: PipelineConfig, transform: LoadoutTransform): PipelineConfig {
  return transform(loadout);
}

export function setSocketLayouts(loadout: PipelineConfig, layouts: Record<string, SocketLayout | undefined>): PipelineConfig {
  let next = loadout;
  for (const [socketId, layout] of Object.entries(layouts)) {
    next = setLoadoutSocketLayout(next, socketId, layout);
  }
  return next;
}

function socketLimitsEqual(left: PipelineNode['limits'] | undefined, right: PipelineNode['limits'] | undefined): boolean {
  return (left?.maxVisits ?? undefined) === (right?.maxVisits ?? undefined)
    && (left?.maxEdgeTraversals ?? undefined) === (right?.maxEdgeTraversals ?? undefined)
    && (left?.maxOutputBytes ?? undefined) === (right?.maxOutputBytes ?? undefined);
}

export function setSocketLimits(loadout: PipelineConfig, socketId: string, limits: PipelineNode['limits'] | undefined): PipelineConfig {
  const node = loadout.sockets?.[socketId];
  if (!loadout.sockets || !node) return loadout;
  const nextLimits = limits && Object.keys(limits).length > 0 ? limits : undefined;
  if (socketLimitsEqual(node.limits, nextLimits)) return loadout;
  const nextNode = { ...node };
  if (nextLimits) nextNode.limits = { ...nextLimits };
  else delete nextNode.limits;
  return replaceNodes(loadout, { ...loadout.sockets, [socketId]: nextNode });
}

export function setSocketMateria(loadout: PipelineConfig, socketId: string, materia: PipelineNode): PipelineConfig {
  const target = loadout.sockets?.[socketId];
  if (!loadout.sockets || !target || isEmptySocket(materia)) return loadout;
  const nextNode = placeMateriaInSocket(target, materia);
  if (nextNode === target) return loadout;
  return replaceNodes(loadout, { ...loadout.sockets, [socketId]: nextNode });
}

export function swapSocketMateria(loadout: PipelineConfig, a: string, b: string): PipelineConfig {
  const sockets = loadout.sockets;
  const source = sockets?.[a];
  const target = sockets?.[b];
  if (!sockets || !source || !target || a === b || isEmptySocket(source)) return loadout;
  return replaceNodes(loadout, {
    ...sockets,
    [b]: placeMateriaInSocket(target, source),
    [a]: placeMateriaInSocket(source, target),
  });
}

export function clearMateriaFromSocket(loadout: PipelineConfig, socketId: string): PipelineConfig {
  const node = loadout.sockets?.[socketId];
  if (!loadout.sockets || !node || isEmptySocket(node)) return loadout;
  return replaceNodes(loadout, { ...loadout.sockets, [socketId]: clearSocketMateria(node) });
}

export function createConnectedEmptySocket(loadout: PipelineConfig, afterSocketId: string): PipelineConfig {
  const source = loadout.sockets?.[afterSocketId];
  if (!loadout.sockets || !source) return loadout;
  const newId = makeNewSocketId(loadout.sockets);
  const sourceLayout = getSocketLayout(loadout, afterSocketId);
  const newNode = makeEmptySocket();
  const loopExitContext = findLoopExitConnectionContext(loadout, afterSocketId);
  const sockets = { ...loadout.sockets, [newId]: newNode };
  const withLayout = (next: PipelineConfig) => sourceLayout ? setLoadoutSocketLayout(next, newId, { x: (sourceLayout.x ?? 0) + 1, y: sourceLayout.y ?? 0 }) : next;
  if (loopExitContext) return withLayout(upsertLoopExitRouteInLoadout({ ...loadout, sockets }, loopExitContext.loopId, afterSocketId, 'always', newId));

  const priorAlways = source.edges?.find((edge) => edge.when === 'always')?.to;
  const inserted = priorAlways ? { ...newNode, edges: [{ when: 'always' as const, to: priorAlways }] } : newNode;
  sockets[newId] = inserted;
  sockets[afterSocketId] = { ...source, edges: [...(source.edges ?? []).filter((edge) => edge.when !== 'always'), { when: 'always', to: newId }] };
  return withLayout(replaceNodes(loadout, sockets));
}

export function deleteSocketImmutable(loadout: PipelineConfig, socketId: string): PipelineConfig {
  const node = loadout.sockets?.[socketId];
  if (!loadout.sockets || !canDeleteSocket(node)) return loadout;

  let sockets: Record<string, PipelineNode> = { ...loadout.sockets };
  delete sockets[socketId];
  for (const [id, current] of Object.entries(sockets)) {
    let next = current as LegacyPipelineNode;
    const edges = current.edges?.filter((edge) => edge.to !== socketId);
    if (edges && edges.length !== (current.edges ?? []).length) next = withoutUndefinedEdges({ ...next, edges }) as LegacyPipelineNode;
    if (next.next === socketId) {
      next = { ...next };
      delete next.next;
    }
    const foreach = deleteOptionalDone(next.foreach, socketId);
    const advance = deleteOptionalDone(next.advance as { done?: string } | undefined, socketId) as PipelineNode['advance'];
    if (foreach !== next.foreach || advance !== next.advance) next = { ...next, foreach, advance };
    if (foreach === undefined && 'foreach' in next) delete next.foreach;
    if (advance === undefined && 'advance' in next) delete next.advance;
    if (next !== current) sockets[id] = next;
  }

  let loops = loadout.loops ? { ...loadout.loops } : undefined;
  for (const [loopId, loop] of Object.entries(loadout.loops ?? {})) {
    if (loop.sockets.includes(socketId) || loop.consumes?.from === socketId || loop.exit?.from === socketId || loop.exits?.some((route) => route.from === socketId)) {
      sockets = removeLoopRuntimeControls(loadout, sockets, loop);
      delete loops?.[loopId];
      continue;
    }
    let nextLoop = loop;
    const consumes = deleteOptionalDone(loop.consumes, socketId);
    const iterator = deleteOptionalDone(loop.iterator, socketId);
    if (consumes !== loop.consumes || iterator !== loop.iterator) nextLoop = { ...nextLoop, consumes, iterator };
    if (loop.exit?.to === socketId) nextLoop = { ...nextLoop, exit: { ...loop.exit, to: 'end' } };
    if (loop.exits) {
      const exits = loop.exits.filter((route) => route.targetSocketId !== socketId);
      if (exits.length !== loop.exits.length) nextLoop = exits.length > 0 ? { ...nextLoop, exits } : { ...nextLoop };
      if (exits.length === 0 && loop.exits.length > 0) delete nextLoop.exits;
    }
    if (nextLoop !== loop && loops) loops[loopId] = nextLoop;
  }

  return setLoadoutSocketLayout(replaceLoops(replaceNodes(loadout, sockets), loops), socketId, undefined);
}

export function createTaskLoop(loadout: PipelineConfig, loopId: string, label: string, sockets: string[], consumes: { from: string; output: string }, exit: { from: string; when: MateriaEdgeCondition; to: string }): PipelineConfig {
  if (sockets.length === 0) return loadout;
  let nextLoadout = loadout;
  if (sockets.length === 1) {
    const socketId = sockets[0];
    const node = loadout.sockets?.[socketId];
    if (loadout.sockets && node && !(node.edges ?? []).some((edge) => edge.to === socketId)) {
      nextLoadout = replaceNodes(loadout, { ...loadout.sockets, [socketId]: { ...node, edges: [{ when: 'always', to: socketId }] } });
    }
  }
  return { ...nextLoadout, loops: { ...(nextLoadout.loops ?? {}), [loopId]: { label, sockets, consumes, exit } } };
}

export function updateLoopExitInLoadout(loadout: PipelineConfig, loopId: string, exit: { from: string; when: MateriaEdgeCondition; to: string }): PipelineConfig {
  const loop = loadout.loops?.[loopId];
  if (!loadout.loops || !loop) return loadout;
  const sockets = loadout.sockets ? removeLoopRuntimeControls(loadout, loadout.sockets, loop) : loadout.sockets;
  const nextLoop: PipelineLoop = { ...loop, exit };
  if (loop.exit?.from && loop.exit.from !== exit.from) delete nextLoop.exits;
  return { ...loadout, ...(sockets && sockets !== loadout.sockets ? { sockets } : {}), loops: { ...loadout.loops, [loopId]: nextLoop } };
}

export function clearLoopExitInLoadout(loadout: PipelineConfig, loopId: string): PipelineConfig {
  const loop = loadout.loops?.[loopId];
  if (!loadout.loops || !loop || (!loop.exit && !loop.exits)) return loadout;
  const nextLoop = { ...loop };
  delete nextLoop.exit;
  delete nextLoop.exits;
  return { ...loadout, loops: { ...loadout.loops, [loopId]: nextLoop } };
}

export function deleteLoopFromLoadout(loadout: PipelineConfig, loopId: string): PipelineConfig {
  if (!loadout.loops?.[loopId]) return loadout;
  const loops = { ...loadout.loops };
  delete loops[loopId];
  return replaceLoops(loadout, loops);
}

export function upsertLoopExitRouteInLoadout(loadout: PipelineConfig, loopId: string, from: string, condition: MateriaEdgeCondition, targetSocketId: string): PipelineConfig {
  const loop = loadout.loops?.[loopId];
  if (!loadout.loops || !loop || loop.exit?.from !== from || !loadout.sockets?.[targetSocketId]) return loadout;
  const route = { id: loopExitRouteId(from, condition), from, condition, targetSocketId };
  const exits = [...(loop.exits ?? []).filter((candidate) => !(candidate.from === from && candidate.condition === condition)), route];
  return { ...loadout, loops: { ...loadout.loops, [loopId]: { ...loop, exits } } };
}

export function removeLoopExitRouteFromLoadout(loadout: PipelineConfig, loopId: string, routeId: string): PipelineConfig {
  const loop = loadout.loops?.[loopId];
  if (!loadout.loops || !loop?.exits) return loadout;
  const exits = loop.exits.filter((route) => route.id !== routeId);
  if (exits.length === loop.exits.length) return loadout;
  const nextLoop = exits.length > 0 ? { ...loop, exits } : { ...loop };
  if (exits.length === 0) delete nextLoop.exits;
  return { ...loadout, loops: { ...loadout.loops, [loopId]: nextLoop } };
}

export function toggleLoopExitRouteCondition(loadout: PipelineConfig, loopId: string, routeId: string, nextCondition: MateriaEdgeCondition): PipelineConfig {
  const loop = loadout.loops?.[loopId];
  const route = loop?.exits?.find((candidate) => candidate.id === routeId);
  if (!loadout.loops || !loop?.exits || !route) return loadout;
  const exits = loop.exits.map((candidate) => candidate.id === routeId ? { ...candidate, condition: nextCondition } : candidate);
  return { ...loadout, loops: { ...loadout.loops, [loopId]: { ...loop, exits } } };
}

export function addEdgeToLoadout(loadout: PipelineConfig, from: string, to: string, when: MateriaEdgeCondition): PipelineConfig {
  const node = loadout.sockets?.[from];
  if (!loadout.sockets || !node || !loadout.sockets[to]) return loadout;
  return replaceNodes(loadout, { ...loadout.sockets, [from]: { ...node, edges: [...(node.edges ?? []), { to, when }] } });
}

export function removeEdgeFromLoadout(loadout: PipelineConfig, from: string, edgeIndex: number): PipelineConfig {
  const node = loadout.sockets?.[from];
  if (!loadout.sockets || !node?.edges?.[edgeIndex]) return loadout;
  const edges = node.edges.filter((_, index) => index !== edgeIndex);
  return replaceNodes(loadout, { ...loadout.sockets, [from]: withoutUndefinedEdges({ ...node, edges }) });
}

export function removeLegacyNextFromLoadout(loadout: PipelineConfig, from: string): PipelineConfig {
  const node = loadout.sockets?.[from] as LegacyPipelineNode | undefined;
  if (!loadout.sockets || !node?.next) return loadout;
  const next = { ...node };
  delete next.next;
  return replaceNodes(loadout, { ...loadout.sockets, [from]: next });
}

export function toggleEdgeConditionInLoadout(loadout: PipelineConfig, from: string, to: string, when: MateriaEdgeCondition, nextWhen: MateriaEdgeCondition, edgeIndex?: number): PipelineConfig {
  const node = loadout.sockets?.[from] as LegacyPipelineNode | undefined;
  if (!loadout.sockets || !node) return loadout;
  if (edgeIndex === undefined) {
    const next = { ...node, edges: [...(node.edges ?? []), { to, when: nextWhen }] };
    delete next.next;
    return replaceNodes(loadout, { ...loadout.sockets, [from]: next });
  }
  const candidate = node.edges?.[edgeIndex];
  if (!candidate) return loadout;
  const edges = node.edges!.map((edge, index) => index === edgeIndex ? { ...edge, when: nextWhen } : edge);
  return replaceNodes(loadout, { ...loadout.sockets, [from]: { ...node, edges } });
}
