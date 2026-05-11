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
  type LegacyPipelineSocket,
  type PipelineConfig,
  type PipelineLoop,
  type PipelineSocket,
  type SocketLayout,
} from './loadoutModel.js';

export type LoadoutTransform = (loadout: PipelineConfig) => PipelineConfig;

function replaceSockets(loadout: PipelineConfig, sockets: Record<string, PipelineSocket>): PipelineConfig {
  return { ...loadout, sockets };
}

function replaceLoops(loadout: PipelineConfig, loops: Record<string, PipelineLoop> | undefined): PipelineConfig {
  const next = { ...loadout };
  if (loops && Object.keys(loops).length > 0) next.loops = loops;
  else delete next.loops;
  return next;
}

function withoutUndefinedEdges(socket: PipelineSocket): PipelineSocket {
  if (socket.edges && socket.edges.length > 0) return socket;
  const next = { ...socket };
  delete next.edges;
  return next;
}

function deleteOptionalDone<T extends { done?: string }>(container: T | undefined, deletedSocketId: string): T | undefined {
  if (!container || container.done !== deletedSocketId) return container;
  const next = { ...container };
  delete next.done;
  return next;
}

function removeLoopRuntimeControls(loadout: PipelineConfig, sockets: Record<string, PipelineSocket>, loop: PipelineLoop): Record<string, PipelineSocket> {
  const exitSource = loop.exit?.from;
  const sourceSocket = exitSource ? sockets[exitSource] : undefined;
  if (!exitSource || !sourceSocket) return sockets;

  const loopExitTargets = new Set((loop.exits ?? []).map((route) => route.targetSocketId));
  const advanceDoneTarget = loop.exit?.to;
  if (advanceDoneTarget && advanceDoneTarget !== 'end') loopExitTargets.add(advanceDoneTarget);

  let nextSource = sourceSocket;
  if (sourceSocket.advance && sourceSocket.advance.done === advanceDoneTarget) {
    nextSource = { ...nextSource };
    delete nextSource.advance;
  }
  if (sourceSocket.edges && loopExitTargets.size > 0) {
    const edges = sourceSocket.edges.filter((edge) => !loopExitTargets.has(edge.to));
    nextSource = withoutUndefinedEdges({ ...nextSource, edges });
  }
  if (nextSource === sourceSocket) return sockets;
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

function socketLimitsEqual(left: PipelineSocket['limits'] | undefined, right: PipelineSocket['limits'] | undefined): boolean {
  return (left?.maxVisits ?? undefined) === (right?.maxVisits ?? undefined)
    && (left?.maxEdgeTraversals ?? undefined) === (right?.maxEdgeTraversals ?? undefined)
    && (left?.maxOutputBytes ?? undefined) === (right?.maxOutputBytes ?? undefined);
}

export function setSocketLimits(loadout: PipelineConfig, socketId: string, limits: PipelineSocket['limits'] | undefined): PipelineConfig {
  const socket = loadout.sockets?.[socketId];
  if (!loadout.sockets || !socket) return loadout;
  const nextLimits = limits && Object.keys(limits).length > 0 ? limits : undefined;
  if (socketLimitsEqual(socket.limits, nextLimits)) return loadout;
  const nextSocket = { ...socket };
  if (nextLimits) nextSocket.limits = { ...nextLimits };
  else delete nextSocket.limits;
  return replaceSockets(loadout, { ...loadout.sockets, [socketId]: nextSocket });
}

export function setSocketMateria(loadout: PipelineConfig, socketId: string, materia: PipelineSocket): PipelineConfig {
  const target = loadout.sockets?.[socketId];
  if (!loadout.sockets || !target || isEmptySocket(materia)) return loadout;
  const nextSocket = placeMateriaInSocket(target, materia);
  if (nextSocket === target) return loadout;
  return replaceSockets(loadout, { ...loadout.sockets, [socketId]: nextSocket });
}

export function swapSocketMateria(loadout: PipelineConfig, a: string, b: string): PipelineConfig {
  const sockets = loadout.sockets;
  const source = sockets?.[a];
  const target = sockets?.[b];
  if (!sockets || !source || !target || a === b || isEmptySocket(source)) return loadout;
  return replaceSockets(loadout, {
    ...sockets,
    [b]: placeMateriaInSocket(target, source),
    [a]: placeMateriaInSocket(source, target),
  });
}

export function clearMateriaFromSocket(loadout: PipelineConfig, socketId: string): PipelineConfig {
  const socket = loadout.sockets?.[socketId];
  if (!loadout.sockets || !socket || isEmptySocket(socket)) return loadout;
  return replaceSockets(loadout, { ...loadout.sockets, [socketId]: clearSocketMateria(socket) });
}

export function createConnectedEmptySocket(loadout: PipelineConfig, afterSocketId: string): PipelineConfig {
  const source = loadout.sockets?.[afterSocketId];
  if (!loadout.sockets || !source) return loadout;
  const newId = makeNewSocketId(loadout.sockets);
  const sourceLayout = getSocketLayout(loadout, afterSocketId);
  const newSocket = makeEmptySocket();
  const loopExitContext = findLoopExitConnectionContext(loadout, afterSocketId);
  const sockets = { ...loadout.sockets, [newId]: newSocket };
  const withLayout = (next: PipelineConfig) => sourceLayout ? setLoadoutSocketLayout(next, newId, { x: (sourceLayout.x ?? 0) + 1, y: sourceLayout.y ?? 0 }) : next;
  if (loopExitContext) return withLayout(upsertLoopExitRouteInLoadout({ ...loadout, sockets }, loopExitContext.loopId, afterSocketId, 'always', newId));

  const priorAlways = source.edges?.find((edge) => edge.when === 'always')?.to;
  const inserted = priorAlways ? { ...newSocket, edges: [{ when: 'always' as const, to: priorAlways }] } : newSocket;
  sockets[newId] = inserted;
  sockets[afterSocketId] = { ...source, edges: [...(source.edges ?? []).filter((edge) => edge.when !== 'always'), { when: 'always', to: newId }] };
  return withLayout(replaceSockets(loadout, sockets));
}

export function deleteSocketImmutable(loadout: PipelineConfig, socketId: string): PipelineConfig {
  const socket = loadout.sockets?.[socketId];
  if (!loadout.sockets || !canDeleteSocket(socket)) return loadout;

  let sockets: Record<string, PipelineSocket> = { ...loadout.sockets };
  delete sockets[socketId];
  for (const [id, current] of Object.entries(sockets)) {
    let next = current as LegacyPipelineSocket;
    const edges = current.edges?.filter((edge) => edge.to !== socketId);
    if (edges && edges.length !== (current.edges ?? []).length) next = withoutUndefinedEdges({ ...next, edges }) as LegacyPipelineSocket;
    if (next.next === socketId) {
      next = { ...next };
      delete next.next;
    }
    const foreach = deleteOptionalDone(next.foreach, socketId);
    const advance = deleteOptionalDone(next.advance as { done?: string } | undefined, socketId) as PipelineSocket['advance'];
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

  return setLoadoutSocketLayout(replaceLoops(replaceSockets(loadout, sockets), loops), socketId, undefined);
}

export function createTaskLoop(loadout: PipelineConfig, loopId: string, label: string, sockets: string[], consumes: { from: string; output: string }, exit: { from: string; when: MateriaEdgeCondition; to: string }): PipelineConfig {
  if (sockets.length === 0) return loadout;
  let nextLoadout = loadout;
  if (sockets.length === 1) {
    const socketId = sockets[0];
    const socket = loadout.sockets?.[socketId];
    if (loadout.sockets && socket && !(socket.edges ?? []).some((edge) => edge.to === socketId)) {
      nextLoadout = replaceSockets(loadout, { ...loadout.sockets, [socketId]: { ...socket, edges: [{ when: 'always', to: socketId }] } });
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
  const socket = loadout.sockets?.[from];
  if (!loadout.sockets || !socket || !loadout.sockets[to]) return loadout;
  return replaceSockets(loadout, { ...loadout.sockets, [from]: { ...socket, edges: [...(socket.edges ?? []), { to, when }] } });
}

export function removeEdgeFromLoadout(loadout: PipelineConfig, from: string, edgeIndex: number): PipelineConfig {
  const socket = loadout.sockets?.[from];
  if (!loadout.sockets || !socket?.edges?.[edgeIndex]) return loadout;
  const edges = socket.edges.filter((_, index) => index !== edgeIndex);
  return replaceSockets(loadout, { ...loadout.sockets, [from]: withoutUndefinedEdges({ ...socket, edges }) });
}

export function removeLegacyNextFromLoadout(loadout: PipelineConfig, from: string): PipelineConfig {
  const socket = loadout.sockets?.[from] as LegacyPipelineSocket | undefined;
  if (!loadout.sockets || !socket?.next) return loadout;
  const next = { ...socket };
  delete next.next;
  return replaceSockets(loadout, { ...loadout.sockets, [from]: next });
}

export function toggleEdgeConditionInLoadout(loadout: PipelineConfig, from: string, to: string, when: MateriaEdgeCondition, nextWhen: MateriaEdgeCondition, edgeIndex?: number): PipelineConfig {
  const socket = loadout.sockets?.[from] as LegacyPipelineSocket | undefined;
  if (!loadout.sockets || !socket) return loadout;
  if (edgeIndex === undefined) {
    const next = { ...socket, edges: [...(socket.edges ?? []), { to, when: nextWhen }] };
    delete next.next;
    return replaceSockets(loadout, { ...loadout.sockets, [from]: next });
  }
  const candidate = socket.edges?.[edgeIndex];
  if (!candidate) return loadout;
  const edges = socket.edges!.map((edge, index) => index === edgeIndex ? { ...edge, when: nextWhen } : edge);
  return replaceSockets(loadout, { ...loadout.sockets, [from]: { ...socket, edges } });
}
