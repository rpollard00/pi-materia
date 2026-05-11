import type { MateriaCastSocketState, MateriaCastState, MateriaRunState, UsageReport, UsageTotals } from "./types.js";

/**
 * Socket-first accessors for persisted/plugin cast DTOs.
 *
 * Saved casts, manifest events, usage reports, and WebUI monitor payloads still
 * expose legacy field names such as `currentNode`, `nodeState`, event `node`,
 * and `byNode`. Core code should use these helpers so those legacy names stay
 * isolated at the compatibility boundary.
 */
export function currentCastSocketId(state: MateriaCastState): string | undefined {
  return state.currentNode ?? state.runState.currentNode;
}

export function setCurrentCastSocketId(state: MateriaCastState, socketId: string | undefined): void {
  state.currentNode = socketId;
  state.runState.currentNode = socketId;
}

export function currentCastSocketState(state: MateriaCastState): MateriaCastSocketState | undefined {
  return state.nodeState;
}

export function setCurrentCastSocketState(state: MateriaCastState, socketState: MateriaCastSocketState | undefined): void {
  state.nodeState = socketState;
}

export function runStateCurrentSocketId(state: MateriaRunState): string | undefined {
  return state.currentNode;
}

export function setRunStateCurrentSocketId(state: MateriaRunState, socketId: string | undefined): void {
  state.currentNode = socketId;
}

export function usageBySocket(usage: UsageReport): Record<string, UsageTotals> {
  return usage.byNode;
}
