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
 */
export function recordNoAdvanceSocketStart(
  state: MateriaCastState,
  socketId: string,
  limit: number = DEFAULT_MAX_NO_ADVANCE_CYCLES,
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
  tracker.count += 1;
  tracker.socketPath = [socketId];
  tracker.lastCycleSockets = sockets;
  if (tracker.count > limit) {
    throw new MateriaNoAdvanceCycleExhaustionError(itemKey, tracker.count, limit, sockets);
  }
}

/** Clear cycle history as soon as the work-item cursor advances. */
export function resetNoAdvanceCycles(state: MateriaCastState): void {
  state.noAdvanceCycles = undefined;
}
