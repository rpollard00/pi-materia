import { classifyGraphTarget, remapGraphTargetPreservingTerminal, TERMINAL_ADVANCE_TARGET, type GraphTargetClassification, type SocketTargetSet } from "../domain/socket.js";
import { resolveLoopExitRoute, type LoopExitRouteResolutionOptions } from "./loopExitRoutes.js";
import type { MateriaLoopConfig, ResolvedMateriaPipeline } from "../types.js";

export const TERMINAL_GRAPH_TARGET = TERMINAL_ADVANCE_TARGET;

export { classifyGraphTarget, remapGraphTargetPreservingTerminal, type GraphTargetClassification, type SocketTargetSet };

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
  loop: Pick<MateriaLoopConfig, "exits">;
}

export type LoopExitIndex = ReadonlyMap<string, readonly LoopExitIndexEntry[]>;

/**
 * Build a socket-id index for loop-exit metadata so runtime callers do not scan
 * every loop on every exhausted item.
 */
export function buildLoopExitIndex(loops: Record<string, MateriaLoopConfig> | undefined): LoopExitIndex {
  const index = new Map<string, LoopExitIndexEntry[]>();
  for (const [loopId, loop] of Object.entries(loops ?? {})) {
    const sources = new Set<string>();
    for (const socketId of loop.sockets ?? []) sources.add(socketId);
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
export function resolveCanonicalLoopExhaustionTarget(loop: Pick<MateriaLoopConfig, "exits"> | undefined, options: LoopExhaustionResolutionOptions): string {
  return resolveLoopExitRoute(loop, options)?.targetSocketId ?? TERMINAL_GRAPH_TARGET;
}

/** Resolve canonical loop exhaustion from a precomputed loop-exit index. */
export function resolveIndexedLoopExhaustionTarget(index: LoopExitIndex, from: string, options: Omit<LoopExhaustionResolutionOptions, "from">): string {
  return resolveIndexedLoopExitRouteTarget(index, from, options) ?? TERMINAL_GRAPH_TARGET;
}

/** Return only a canonical loop-exit route target from the index, if one exists. */
export function resolveIndexedLoopExitRouteTarget(index: LoopExitIndex, from: string, options: Omit<LoopExhaustionResolutionOptions, "from">): string | undefined {
  for (const entry of index.get(from) ?? []) {
    const route = resolveLoopExitRoute(entry.loop, { ...options, from });
    if (route) return route.targetSocketId;
  }
  return undefined;
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

