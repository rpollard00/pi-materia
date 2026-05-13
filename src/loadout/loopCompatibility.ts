import { TERMINAL_GRAPH_TARGET } from "../graph/graphSemantics.js";
import type { MateriaEdgeCondition, MateriaLoopConfig, MateriaLoopExitRouteConfig, MateriaPipelineConfig, MateriaPipelineSocketConfig } from "../types.js";

export type LoopRoutingCompatibilityKind = "legacy-loop-exit" | "legacy-advance-done" | "legacy-terminal-back-edge";

export interface LoopRoutingCompatibilityDetection {
  kind: LoopRoutingCompatibilityKind;
  loopId: string;
  socketId: string;
  targetSocketId?: string;
  condition?: MateriaEdgeCondition;
}

export interface LoopRoutingCompatibilityResult {
  normalized: boolean;
  detections: LoopRoutingCompatibilityDetection[];
}

/**
 * Named anti-corruption boundary for persisted/UI-authored loop routing.
 *
 * New-model loadouts put post-loop routing in loops.<id>.exits. Older loadouts
 * may still carry it in loops.<id>.exit or in the loop exit source's
 * advance.done. This shim preserves legacy fields and UI-only graph
 * decorations, but mirrors socket-valued legacy routes into canonical exits so
 * runtime, validation, link compilation, and save preparation can rely on the
 * structured model. Terminal `end` is not mirrored: absence of a canonical exit
 * route already means terminal fallback in the new model.
 */
export function normalizeLegacyLoopRoutingCompatibilityInPlace(loadout: MateriaPipelineConfig): LoopRoutingCompatibilityResult {
  const detections: LoopRoutingCompatibilityDetection[] = [];
  let normalized = false;

  for (const [loopId, loop] of Object.entries(loadout.loops ?? {})) {
    if (normalizeLegacyLoopExit(loadout, loopId, loop, detections)) normalized = true;
    if (normalizeLegacyAdvanceDone(loadout, loopId, loop, detections)) normalized = true;
    detectLegacyTerminalBackEdges(loadout, loopId, loop, detections);
  }

  return { normalized, detections };
}

export function isCanonicalOrNormalizedLoopRouting(loadout: MateriaPipelineConfig): boolean {
  for (const [, loop] of Object.entries(loadout.loops ?? {})) {
    if (loop.exit?.to && loop.exit.to !== TERMINAL_GRAPH_TARGET && !hasCanonicalRoute(loop, loop.exit.from, loop.exit.when, loop.exit.to)) return false;
    for (const socketId of loop.sockets ?? []) {
      const socket = loadout.sockets?.[socketId];
      const done = socket?.advance?.done;
      if (done && done !== TERMINAL_GRAPH_TARGET && !hasCanonicalRoute(loop, socketId, advanceRouteCondition(socket), done)) return false;
    }
  }
  return true;
}

function normalizeLegacyLoopExit(loadout: MateriaPipelineConfig, loopId: string, loop: MateriaLoopConfig, detections: LoopRoutingCompatibilityDetection[]): boolean {
  const exit = loop.exit;
  if (!exit) return false;
  detections.push({ kind: "legacy-loop-exit", loopId, socketId: exit.from, targetSocketId: exit.to, condition: exit.when });
  if (exit.to === TERMINAL_GRAPH_TARGET || !loadout.sockets?.[exit.to] || hasCanonicalRoute(loop, exit.from, exit.when, exit.to)) return false;
  upsertCanonicalLoopExit(loop, { id: loopExitRouteId(exit.from, exit.when), from: exit.from, condition: exit.when, targetSocketId: exit.to });
  return true;
}

function normalizeLegacyAdvanceDone(loadout: MateriaPipelineConfig, loopId: string, loop: MateriaLoopConfig, detections: LoopRoutingCompatibilityDetection[]): boolean {
  let normalized = false;
  for (const socketId of loop.sockets ?? []) {
    const socket = loadout.sockets?.[socketId];
    const done = socket?.advance?.done;
    if (!done) continue;
    detections.push({ kind: "legacy-advance-done", loopId, socketId, targetSocketId: done, condition: advanceRouteCondition(socket) });
    if (done === TERMINAL_GRAPH_TARGET || !loadout.sockets?.[done]) continue;
    const condition = advanceRouteCondition(socket);
    if (hasCanonicalRoute(loop, socketId, condition, done)) continue;
    upsertCanonicalLoopExit(loop, { id: loopExitRouteId(socketId, condition), from: socketId, condition, targetSocketId: done });
    normalized = true;
  }
  return normalized;
}

function detectLegacyTerminalBackEdges(loadout: MateriaPipelineConfig, loopId: string, loop: MateriaLoopConfig, detections: LoopRoutingCompatibilityDetection[]): void {
  const loopSockets = new Set(loop.sockets ?? []);
  for (const socketId of loopSockets) {
    const socket = loadout.sockets?.[socketId];
    for (const edge of socket?.edges ?? []) {
      if (loopSockets.has(edge.to)) detections.push({ kind: "legacy-terminal-back-edge", loopId, socketId, targetSocketId: edge.to, condition: edge.when });
    }
  }
}

function hasCanonicalRoute(loop: MateriaLoopConfig, from: string, condition: MateriaEdgeCondition, targetSocketId: string): boolean {
  return (loop.exits ?? []).some((route) => route.from === from && route.condition === condition && route.targetSocketId === targetSocketId);
}

function upsertCanonicalLoopExit(loop: MateriaLoopConfig, route: MateriaLoopExitRouteConfig): void {
  const routes = (loop.exits ?? []).filter((candidate) => !(candidate.from === route.from && candidate.condition === route.condition));
  loop.exits = [...routes, route];
}

function advanceRouteCondition(socket: MateriaPipelineSocketConfig | undefined): MateriaEdgeCondition {
  const when = socket?.advance?.when;
  return when === "satisfied" || when === "not_satisfied" || when === "always" ? when : "always";
}

function loopExitRouteId(from: string, condition: MateriaEdgeCondition): string {
  return `exit:${from}:${condition}`;
}
