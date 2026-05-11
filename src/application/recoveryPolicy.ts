import { isActiveMultiTurnSocket } from "./promptAssembly.js";
import type { MateriaCastState, MateriaRecoveryAllowance, ResolvedMateriaSocket } from "../types.js";

const DEFAULT_MAX_SAME_SOCKET_RECOVERY_ATTEMPTS = 1;

export type TurnFailureClassification = "context_window" | "transient_transport";
export type RecoverableTurnFailure = "context_window";

export function classifyTurnFailure(error: unknown): TurnFailureClassification | undefined {
  const message = errorMessage(error);
  if (isContextWindowFailureMessage(message)) return "context_window";
  if (isPlainWebSocketTransportFailure(message)) return "transient_transport";
  return undefined;
}

export function classifyRecoverableTurnFailure(error: unknown): RecoverableTurnFailure | undefined {
  return classifyTurnFailure(error) === "context_window" ? "context_window" : undefined;
}

export function recoveryTurnMode(state: MateriaCastState): "normal" | "refinement" | "finalization" {
  if (state.multiTurnFinalizing === true) return "finalization";
  return isActiveMultiTurnSocket(state) ? "refinement" : "normal";
}

export function recoveryIdentityKey(state: MateriaCastState): string {
  const socketId = currentSocketId(state) ?? state.phase;
  const visit = currentSocketVisit(state, 0);
  const refinementTurn = currentSocketId(state) ? currentRefinementTurn(state, currentSocketId(state)!) : 0;
  return JSON.stringify([recoveryTurnMode(state), socketId, state.currentItemKey ?? "__singleton__", visit, refinementTurn]);
}

export function ensureRecoveryAllowance(state: MateriaCastState, key: string): MateriaRecoveryAllowance {
  state.recoveryAllowances ??= {};
  const existing = state.recoveryAllowances[key];
  if (isValidRecoveryAllowance(existing)) return existing;
  const originalMaxAttempts = DEFAULT_MAX_SAME_SOCKET_RECOVERY_ATTEMPTS;
  const allowance: MateriaRecoveryAllowance = { originalMaxAttempts, effectiveMaxAttempts: originalMaxAttempts, reviveCount: 0 };
  state.recoveryAllowances[key] = allowance;
  return allowance;
}

export function isValidRecoveryAllowance(value: unknown): value is MateriaRecoveryAllowance {
  const allowance = value as Partial<MateriaRecoveryAllowance> | undefined;
  return Boolean(
    allowance &&
    Number.isSafeInteger(allowance.originalMaxAttempts) && allowance.originalMaxAttempts! > 0 &&
    Number.isSafeInteger(allowance.effectiveMaxAttempts) && allowance.effectiveMaxAttempts! >= allowance.originalMaxAttempts! &&
    Number.isSafeInteger(allowance.reviveCount) && allowance.reviveCount! >= 0
  );
}

export interface MateriaReviveAllowanceResult {
  key: string;
  priorEffectiveMaxAttempts: number;
  increment: number;
  newEffectiveMaxAttempts: number;
  reviveCount: number;
}

export function extendSameSocketRecoveryAllowanceForRevive(state: MateriaCastState): MateriaReviveAllowanceResult {
  if (state.active) throw new Error(`pi-materia cast ${state.castId} is still active and cannot be revived.`);
  if (state.phase !== "failed" && currentSocketState(state) !== "failed") throw new Error(`pi-materia cast ${state.castId} is not failed and cannot be revived.`);
  const exhaustion = state.recoveryExhaustion;
  if (!exhaustion || exhaustion.kind !== "same_socket_recovery_exhausted") {
    throw new Error(`pi-materia cast ${state.castId} is not revivable: missing structured same-socket recovery exhaustion metadata. Use /materia recast for general failed casts.`);
  }
  if (!exhaustion.key) throw new Error(`pi-materia cast ${state.castId} is not revivable: exhausted recovery context is missing.`);
  if (!exhaustion.failedReason || exhaustion.failedReason !== state.failedReason) {
    throw new Error(`pi-materia cast ${state.castId} is not revivable: same-socket recovery exhaustion metadata does not match the current terminal failure. Use /materia recast for general failed casts.`);
  }
  const allowance = state.recoveryAllowances?.[exhaustion.key];
  if (!isValidRecoveryAllowance(allowance)) {
    throw new Error(`pi-materia cast ${state.castId} is not revivable: recovery allowance metadata is missing or invalid. Use /materia recast instead.`);
  }
  const priorEffectiveMaxAttempts = allowance.effectiveMaxAttempts;
  const increment = allowance.originalMaxAttempts;
  allowance.effectiveMaxAttempts = priorEffectiveMaxAttempts + increment;
  allowance.reviveCount += 1;
  exhaustion.effectiveMaxAttempts = allowance.effectiveMaxAttempts;
  exhaustion.originalMaxAttempts = allowance.originalMaxAttempts;
  exhaustion.reviveCount = allowance.reviveCount;
  state.updatedAt = Date.now();
  return { key: exhaustion.key, priorEffectiveMaxAttempts, increment, newEffectiveMaxAttempts: allowance.effectiveMaxAttempts, reviveCount: allowance.reviveCount };
}

export function recoveryDiagnosticLabel(state: MateriaCastState): string {
  const item = state.currentItemKey ? ` item ${JSON.stringify(state.currentItemKey)}` : "";
  return `${recoveryTurnMode(state)} turn for socket "${currentSocketId(state) ?? state.phase}"${item}`;
}

export function nonRecoverableTurnError(state: MateriaCastState, error: unknown): Error {
  return new Error(`Non-recoverable turn failure for ${recoveryDiagnosticLabel(state)} (same-socket recovery not attempted): ${errorMessage(error)}`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isContextWindowFailureMessage(message: string): boolean {
  return /context[_-]?length[_-]?exceeded|context[_-]?window[_-]?exceeded|context (window|length|limit|overflow)|token limit|max(?:imum)? tokens|input too long|request too large|too many tokens/i.test(message);
}

function isPlainWebSocketTransportFailure(message: string): boolean {
  const normalized = message.trim().replace(/\s+/g, " ");
  return /(?:^|:\s*)(?:error:\s*)?websocket (?:error|closed|close|connection (?:closed|error|lost)|disconnected)(?:\s+\d{3,4})?\.?$/i.test(normalized);
}

function currentSocketVisit(state: MateriaCastState, fallback = 0): number {
  const socketId = currentSocketId(state);
  if (!socketId) return fallback;
  return state.visits[socketId] ?? fallback;
}

function currentRefinementTurn(state: MateriaCastState, socketId: string): number {
  return state.multiTurnRefinements?.[refinementIdentityKey(state, socketId)] ?? 0;
}

function refinementIdentityKey(state: MateriaCastState, socketId: string): string {
  return state.currentItemKey ? `${socketId}:${state.currentItemKey}` : socketId;
}

function currentSocketId(state: MateriaCastState): string | undefined {
  if (state.currentSocketId && state.currentSocketId !== "complete" && state.currentSocketId !== "failed") return state.currentSocketId;
  if (state.phase !== "complete" && state.phase !== "failed") return state.phase;
  return undefined;
}

function currentSocketState(state: MateriaCastState): MateriaCastState["socketState"] {
  return state.socketState;
}

export function currentSocketForRecovery(state: MateriaCastState): ResolvedMateriaSocket | undefined {
  const socketId = currentSocketId(state);
  return socketId ? state.pipeline.sockets[socketId] : undefined;
}
