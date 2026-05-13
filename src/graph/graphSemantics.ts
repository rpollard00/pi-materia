import { TERMINAL_ADVANCE_TARGET } from "../domain/socket.js";
import { resolveLoopExitRoute, type LoopExitRouteResolutionOptions } from "./loopExitRoutes.js";
import type { MateriaLoopConfig, ResolvedMateriaPipeline } from "../types.js";

export const TERMINAL_GRAPH_TARGET = TERMINAL_ADVANCE_TARGET;

export type GraphTargetClassification =
  | { kind: "socket"; target: string }
  | { kind: "terminal"; target: typeof TERMINAL_GRAPH_TARGET }
  | { kind: "unknown"; target: string };

export type SocketTargetSet = ReadonlySet<string> | readonly string[] | Record<string, unknown>;

export interface LoopExhaustionResolutionOptions extends LoopExitRouteResolutionOptions {
  /**
   * Why the loop is being exhausted. Both empty-loop entry and post-final-item
   * completion use the same canonical exit-or-terminal semantics; this field is
   * retained for diagnostics/call-site clarity.
   */
  reason: "empty-loop" | "post-final-item";
}

export interface LoopExitIndexEntry {
  loopId: string;
  loop: Pick<MateriaLoopConfig, "exit" | "exits">;
}

export type LoopExitIndex = ReadonlyMap<string, readonly LoopExitIndexEntry[]>;

/** Classify a graph target without treating arbitrary strings as valid targets. */
export function classifyGraphTarget(target: string, socketTargets: SocketTargetSet): GraphTargetClassification {
  if (target === TERMINAL_GRAPH_TARGET) return { kind: "terminal", target: TERMINAL_GRAPH_TARGET };
  if (hasSocketTarget(socketTargets, target)) return { kind: "socket", target };
  return { kind: "unknown", target };
}

/** Remap a graph target while preserving the terminal `end` sentinel unchanged. */
export function remapGraphTargetPreservingTerminal(target: string, socketIdMap: ReadonlyMap<string, string> | Record<string, string>): string {
  if (target === TERMINAL_GRAPH_TARGET) return TERMINAL_GRAPH_TARGET;
  return isReadonlyMap(socketIdMap) ? socketIdMap.get(target) ?? target : socketIdMap[target] ?? target;
}

/**
 * Build a socket-id index for loop-exit metadata so runtime callers do not scan
 * every loop on every exhausted item.
 */
export function buildLoopExitIndex(loops: Record<string, MateriaLoopConfig> | undefined): LoopExitIndex {
  const index = new Map<string, LoopExitIndexEntry[]>();
  for (const [loopId, loop] of Object.entries(loops ?? {})) {
    const sources = new Set<string>();
    if (loop.exit?.from) sources.add(loop.exit.from);
    for (const route of loop.exits ?? []) sources.add(route.from);
    for (const from of sources) {
      const entries = index.get(from) ?? [];
      entries.push({ loopId, loop });
      index.set(from, entries);
    }
  }
  return index;
}

/** Resolve canonical loop exhaustion: loop-owned exit route, otherwise terminal `end`. */
export function resolveCanonicalLoopExhaustionTarget(loop: Pick<MateriaLoopConfig, "exit" | "exits"> | undefined, options: LoopExhaustionResolutionOptions): string {
  return resolveLoopExitRoute(loop, options)?.targetSocketId ?? TERMINAL_GRAPH_TARGET;
}

/** Resolve canonical loop exhaustion from a precomputed loop-exit index. */
export function resolveIndexedLoopExhaustionTarget(index: LoopExitIndex, from: string, options: Omit<LoopExhaustionResolutionOptions, "from">): string {
  return resolveIndexedLoopExitRouteTarget(index, from, options) ?? TERMINAL_GRAPH_TARGET;
}

/**
 * Migration-only indexed bridge for old loadouts where advance.done encoded
 * post-loop routing. Runtime callers should use this explicit compatibility
 * boundary instead of inlining `canonicalRoute ?? advance.done`.
 */
export function resolveIndexedLoopExhaustionTargetWithLegacyAdvanceDoneFallback(index: LoopExitIndex, from: string, legacyAdvanceDone: string | undefined, options: Omit<LoopExhaustionResolutionOptions, "from">): string {
  return resolveIndexedLoopExitRouteTarget(index, from, options) ?? legacyAdvanceDone ?? TERMINAL_GRAPH_TARGET;
}

/** Return only a canonical loop-exit route target from the index, if one exists. */
export function resolveIndexedLoopExitRouteTarget(index: LoopExitIndex, from: string, options: Omit<LoopExhaustionResolutionOptions, "from">): string | undefined {
  for (const entry of index.get(from) ?? []) {
    const route = resolveLoopExitRoute(entry.loop, { ...options, from });
    if (route) return route.targetSocketId;
  }
  return undefined;
}

/**
 * Migration-only bridge for old loadouts where advance.done encoded post-loop
 * routing. New-model code should prefer resolveCanonicalLoopExhaustionTarget().
 */
export function resolveLoopExhaustionTargetWithLegacyAdvanceDoneFallback(loop: Pick<MateriaLoopConfig, "exit" | "exits"> | undefined, legacyAdvanceDone: string | undefined, options: LoopExhaustionResolutionOptions): string {
  const canonicalRoute = resolveLoopExitRoute(loop, options)?.targetSocketId;
  return canonicalRoute ?? legacyAdvanceDone ?? TERMINAL_GRAPH_TARGET;
}

export function loopExitIndexForPipeline(pipeline: Pick<ResolvedMateriaPipeline, "loops">): LoopExitIndex {
  return cachedLoopExitIndexFor(pipeline);
}

const LOOP_EXIT_INDEX_CACHE = new WeakMap<object, LoopExitIndex>();

function cachedLoopExitIndexFor(pipeline: Pick<ResolvedMateriaPipeline, "loops">): LoopExitIndex {
  const key = pipeline as object;
  const cached = LOOP_EXIT_INDEX_CACHE.get(key);
  if (cached) return cached;
  const index = buildLoopExitIndex(pipeline.loops);
  LOOP_EXIT_INDEX_CACHE.set(key, index);
  return index;
}

function hasSocketTarget(socketTargets: SocketTargetSet, target: string): boolean {
  if (socketTargets instanceof Set) return socketTargets.has(target);
  if (Array.isArray(socketTargets)) return socketTargets.includes(target);
  return Object.prototype.hasOwnProperty.call(socketTargets, target);
}

function isReadonlyMap(value: ReadonlyMap<string, string> | Record<string, string>): value is ReadonlyMap<string, string> {
  return typeof (value as ReadonlyMap<string, string>).get === "function";
}
