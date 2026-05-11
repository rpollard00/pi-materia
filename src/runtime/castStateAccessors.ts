import type { MateriaCastSocketState, MateriaCastState, MateriaRunState, UsageReport, UsageTotals } from "../types.js";

/**
 * Socket-first accessors for persisted/plugin cast DTOs.
 *
 * Saved casts, manifest events, usage reports, and WebUI monitor payloads use
 * canonical socket field names such as `currentSocketId`, `socketState`, event
 * `socket`, and `bySocket`.
 */
export function currentCastSocketId(state: MateriaCastState): string | undefined {
  return state.currentSocketId ?? state.runState.currentSocketId;
}

export function setCurrentCastSocketId(state: MateriaCastState, socketId: string | undefined): void {
  state.currentSocketId = socketId;
  state.runState.currentSocketId = socketId;
}

export function currentCastSocketState(state: MateriaCastState): MateriaCastSocketState | undefined {
  return state.socketState;
}

export function setCurrentCastSocketState(state: MateriaCastState, socketState: MateriaCastSocketState | undefined): void {
  state.socketState = socketState;
}

export function runStateCurrentSocketId(state: MateriaRunState): string | undefined {
  return state.currentSocketId;
}

export function setRunStateCurrentSocketId(state: MateriaRunState, socketId: string | undefined): void {
  state.currentSocketId = socketId;
}

export function usageBySocket(usage: UsageReport): Record<string, UsageTotals> {
  return usage.bySocket;
}
