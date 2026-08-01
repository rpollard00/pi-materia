import type { MateriaCastState } from "../types.js";

export const DEFAULT_MAX_NO_ADVANCE_CYCLES = 3;

export class MateriaNoAdvanceCycleExhaustionError extends Error {
  public readonly itemKey: string;
  public readonly count: number;
  public readonly limit: number;
  public readonly sockets: string[];

  constructor(itemKey: string, count: number, limit: number, sockets: string[]) {
    const route = sockets.join(" -> ");
    super(`Materia no-advance cycle limit exceeded for itemKey "${itemKey}" (${count}/${limit}); sockets involved: ${route}.`);
    this.name = "MateriaNoAdvanceCycleExhaustionError";
    this.itemKey = itemKey;
    this.count = count;
    this.limit = limit;
    this.sockets = [...sockets];
  }
}

/**
 * Records socket starts for the current work item. Re-entering a socket already
 * on the current path closes one no-advance cycle. The path then starts again
 * at that socket so overlapping graph shapes remain bounded deterministically.
 *
 * Re-entry via an explicit retry edge ({@code explicitRetryEdge}) is governed
 * solely by that edge's per-item {@code maxTraversals} policy. The structural
 * no-advance counter does not stack an unrelated cumulative cap on top of the
 * configured retry budget; only genuinely unbounded same-item cycles advance
 * the counter and can fail with route diagnostics.
 */
export function recordNoAdvanceSocketStart(
  state: MateriaCastState,
  socketId: string,
  limit: number = DEFAULT_MAX_NO_ADVANCE_CYCLES,
  explicitRetryEdge = false,
): void {
  const itemKey = state.currentItemKey;
  if (itemKey === undefined) {
    resetNoAdvanceCycles(state);
    return;
  }

  const tracker = state.noAdvanceCycles;
  if (!tracker || tracker.itemKey !== itemKey) {
    state.noAdvanceCycles = { itemKey, count: 0, socketPath: [socketId] };
    return;
  }

  const previousIndex = tracker.socketPath.lastIndexOf(socketId);
  if (previousIndex < 0) {
    tracker.socketPath.push(socketId);
    return;
  }

  const sockets = [...tracker.socketPath.slice(previousIndex), socketId];
  // The path always restarts at the re-entered socket so overlapping graph
  // shapes stay bounded deterministically, but an explicit retry re-entry
  // never advances the structural counter.
  tracker.socketPath = [socketId];
  tracker.lastCycleSockets = sockets;
  if (explicitRetryEdge) return;
  tracker.count += 1;
  if (tracker.count > limit) {
    throw new MateriaNoAdvanceCycleExhaustionError(itemKey, tracker.count, limit, sockets);
  }
}

/** Clear cycle history as soon as the work-item cursor advances. */
export function resetNoAdvanceCycles(state: MateriaCastState): void {
  state.noAdvanceCycles = undefined;
}
