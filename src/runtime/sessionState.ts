import { getResolvedPipelineSocket } from "../loadout/loadoutAccessors.js";
import type { MateriaAgentConfig, MateriaCastState, ResolvedMateriaAgentSocket, ResolvedMateriaSocket } from "../types.js";

export function socketVisit(state: MateriaCastState, socketId: string): number {
  return state.visits[socketId] ?? 0;
}

export function currentSocketVisit(state: MateriaCastState, fallback = 0): number {
  const socketId = currentSocketId(state);
  return socketId ? socketVisit(state, socketId) : fallback;
}

export function activeResolvedSocket(state: MateriaCastState): ResolvedMateriaSocket | undefined {
  const socketId = currentSocketId(state);
  return socketId ? getResolvedPipelineSocket(state.pipeline, socketId) : undefined;
}

export function currentRefinementTurn(state: MateriaCastState, socketId: string): number {
  return state.multiTurnRefinements?.[refinementIdentityKey(state, socketId)] ?? 0;
}

export function nextRefinementTurn(state: MateriaCastState, socketId: string): number {
  state.multiTurnRefinements ??= {};
  const key = refinementIdentityKey(state, socketId);
  const turn = (state.multiTurnRefinements[key] ?? 0) + 1;
  state.multiTurnRefinements[key] = turn;
  return turn;
}

function refinementIdentityKey(state: MateriaCastState, socketId: string): string {
  return JSON.stringify([socketId, state.currentItemKey ?? "__singleton__", socketVisit(state, socketId)]);
}

function taskIdentityKey(state: MateriaCastState, socketId: string): string {
  return JSON.stringify([socketId, state.currentItemKey ?? "__singleton__"]);
}

export function startTaskAttempt(state: MateriaCastState, socketId: string): number {
  state.taskAttempts ??= {};
  const key = taskIdentityKey(state, socketId);
  const attempt = (state.taskAttempts[key] ?? 0) + 1;
  state.taskAttempts[key] = attempt;
  return attempt;
}

export function currentTaskAttempt(state: MateriaCastState): number | undefined {
  const socketId = currentSocketId(state);
  if (!socketId) return undefined;
  return state.runState.attempt ?? state.taskAttempts?.[taskIdentityKey(state, socketId)];
}

export function currentMateria(state: MateriaCastState): MateriaAgentConfig {
  const socket = currentSocketOrThrow(state);
  if (!isAgentResolvedSocket(socket)) throw new Error(`Current Materia socket "${socket.id}" is a utility socket and has no materia.`);
  return socket.materia;
}

export function materiaStatusLabel(state: MateriaCastState, socket?: ResolvedMateriaSocket, options: { suffix?: string; includeItem?: boolean } = {}): string {
  const base = socketMateriaName(socket) ?? state.currentMateria ?? socket?.id ?? currentSocketId(state) ?? state.phase;
  const parts = [base];
  if (options.suffix) parts.push(options.suffix);
  if (options.includeItem !== false && state.currentItemLabel) parts.push(state.currentItemLabel);
  return parts.join(":");
}

export function resolvedSocketConfig<TSocket extends ResolvedMateriaSocket>(socket: TSocket): TSocket["socket"] {
  return socket.socket;
}

export function socketMateriaName(socket: ResolvedMateriaSocket | undefined): string | undefined {
  return socket && isAgentResolvedSocket(socket) ? resolvedSocketConfig(socket).materia : undefined;
}

export function isAgentResolvedSocket(socket: ResolvedMateriaSocket): socket is ResolvedMateriaAgentSocket {
  return resolvedSocketConfig(socket).type === "agent";
}

export function isMultiTurnResolvedAgentSocket(socket: ResolvedMateriaSocket): socket is ResolvedMateriaAgentSocket {
  return isAgentResolvedSocket(socket) && socket.materia.multiTurn === true;
}

export function currentSocketId(state: MateriaCastState): string | undefined {
  return state.currentSocketId;
}

export function setCurrentSocketId(state: MateriaCastState, socketId: string | undefined): void {
  state.currentSocketId = socketId;
}

export function currentSocketState(state: MateriaCastState): MateriaCastState["socketState"] {
  return state.socketState;
}

export function setCurrentSocketState(state: MateriaCastState, socketState: MateriaCastState["socketState"]): void {
  state.socketState = socketState;
}

export function currentSocketOrThrow(state: MateriaCastState): ResolvedMateriaSocket {
  const socketId = currentSocketId(state);
  const socket = socketId ? getResolvedPipelineSocket(state.pipeline, socketId) : state.pipeline.entry;
  if (!socket) throw new Error(`Current Materia socket "${socketId}" is not in the resolved grid.`);
  return socket;
}
