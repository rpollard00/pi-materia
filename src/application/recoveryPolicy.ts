import { isActiveMultiTurnSocket } from "./promptAssembly.js";
import { evaluateContextErrorRecovery } from "./contextErrorRecoveryPolicy.js";
import type { MateriaCastState, MateriaRecoveryAllowance, MateriaRecoveryReason, ResolvedMateriaSocket } from "../types.js";

const DEFAULT_MAX_SAME_SOCKET_RECOVERY_ATTEMPTS = 1;
const TOOL_TIMEOUT_MIN_RECOVERY_ATTEMPTS = 3;

export type TurnFailureClassification = MateriaRecoveryReason | "transient_transport";
export type RecoverableTurnFailure = MateriaRecoveryReason;

export interface TurnFailureClassificationOptions {
  /** Set only from lifecycle boundaries that have proven the active agent turn is safe to resend. */
  allowGenericTurnFailure?: boolean;
}

/**
 * Classify a turn-level agent error for routing to transient/recoverable/terminal paths.
 *
 * ## Recovered transport warning vs terminal failure semantics
 *
 * Transport-level blips (WebSocket errors, stream-ended-without-finish-reason) are
 * transient and must NOT force a terminal cast failure. When classified as
 * {@link transient_transport}, the caller preserves the active/awaiting state and
 * continues normally—no `cast_end ok:false`, no `failed` phase/socketState, no
 * failed manifest entries. A later successful assistant response completes the cast
 * normally.
 *
 * Terminal failures are reserved for non-recoverable errors, exhausted same-socket
 * recovery budgets, utility failures, and post-advance lifecycle failures—all of
 * which land in `failCast`. Keep this classification narrow: only transport-layer
 * messages with clear transient semantics should return `"transient_transport"`.
 * Structured provider errors (even when wrapped in transport text) and generic
 * failure messages must fall through to recovery or terminal handling.
 */
export function classifyTurnFailure(error: unknown, options: TurnFailureClassificationOptions = {}): TurnFailureClassification | undefined {
  const message = errorMessage(error);
  if (evaluateContextErrorRecovery(error).action === "compact") return "context_window";
  if (isToolTimeoutFailure(message)) return "tool_timeout";
  // Order matters: check stream-ended first (more specific signal), then
  // generic websocket failures. Both return transient_transport so the cast
  // stays active and awaiting—no failed state or cast_end ok:false.
  if (isStreamEndedTransportFailure(message)) return "transient_transport";
  if (isPlainWebSocketTransportFailure(message)) return "transient_transport";
  if (options.allowGenericTurnFailure === true) return "turn_failure";
  return undefined;
}

export function classifyRecoverableTurnFailure(error: unknown, options: TurnFailureClassificationOptions = {}): RecoverableTurnFailure | undefined {
  const classification = classifyTurnFailure(error, options);
  return classification === "context_window" || classification === "tool_timeout" || classification === "turn_failure" ? classification : undefined;
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

export function ensureRecoveryAllowance(state: MateriaCastState, key: string, options?: { reason?: MateriaRecoveryReason }): MateriaRecoveryAllowance {
  state.recoveryAllowances ??= {};
  const existing = state.recoveryAllowances[key];
  if (isValidRecoveryAllowance(existing)) {
    if (options?.reason === "tool_timeout") {
      existing.originalMaxAttempts = Math.max(existing.originalMaxAttempts, TOOL_TIMEOUT_MIN_RECOVERY_ATTEMPTS);
      existing.effectiveMaxAttempts = Math.max(existing.effectiveMaxAttempts, TOOL_TIMEOUT_MIN_RECOVERY_ATTEMPTS);
    }
    return existing;
  }
  const originalMaxAttempts = options?.reason === "tool_timeout"
    ? Math.max(DEFAULT_MAX_SAME_SOCKET_RECOVERY_ATTEMPTS, TOOL_TIMEOUT_MIN_RECOVERY_ATTEMPTS)
    : DEFAULT_MAX_SAME_SOCKET_RECOVERY_ATTEMPTS;
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

export interface MateriaEdgeReviveAllowanceResult {
  key: string;
  priorEffectiveLimit: number;
  increment: number;
  newEffectiveLimit: number;
  reviveCount: number;
}

export function extendEdgeTraversalAllowanceForRevive(state: MateriaCastState): MateriaEdgeReviveAllowanceResult {
  if (state.active) throw new Error(`pi-materia cast ${state.castId} is still active and cannot be revived.`);
  if (state.phase !== "failed" && currentSocketState(state) !== "failed") throw new Error(`pi-materia cast ${state.castId} is not failed and cannot be revived.`);
  const exhaustion = state.recoveryExhaustion;
  if (!exhaustion || exhaustion.kind !== "edge_traversal_exhausted") {
    throw new Error(`pi-materia cast ${state.castId} is not revivable: missing structured edge traversal exhaustion metadata. Use /materia recast for general failed casts.`);
  }
  if (!exhaustion.key) throw new Error(`pi-materia cast ${state.castId} is not revivable: exhausted edge context is missing.`);
  if (!exhaustion.failedReason || exhaustion.failedReason !== state.failedReason) {
    throw new Error(`pi-materia cast ${state.castId} is not revivable: edge traversal exhaustion metadata does not match the current terminal failure. Use /materia recast for general failed casts.`);
  }
  const allowance = state.edgeAllowances?.[exhaustion.key];
  if (!allowance || !Number.isSafeInteger(allowance.originalLimit) || allowance.originalLimit <= 0 || !Number.isSafeInteger(allowance.effectiveLimit) || allowance.effectiveLimit < allowance.originalLimit || !Number.isSafeInteger(allowance.reviveCount) || allowance.reviveCount < 0) {
    throw new Error(`pi-materia cast ${state.castId} is not revivable: edge allowance metadata is missing or invalid. Use /materia recast instead.`);
  }
  const priorEffectiveLimit = allowance.effectiveLimit;
  const increment = allowance.originalLimit;
  allowance.effectiveLimit = priorEffectiveLimit + increment;
  allowance.reviveCount += 1;
  exhaustion.effectiveLimit = allowance.effectiveLimit;
  exhaustion.reviveCount = allowance.reviveCount;
  state.updatedAt = Date.now();
  return { key: exhaustion.key, priorEffectiveLimit, increment, newEffectiveLimit: allowance.effectiveLimit, reviveCount: allowance.reviveCount };
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

/**
 * Detect explicit WebSocket-layer transport failures that should not force a
 * terminal cast failure. These are transient by nature (connection blips) and
 * the Pi agent will recover on the next turn.
 */
function isPlainWebSocketTransportFailure(message: string): boolean {
  const normalized = message.trim().replace(/\s+/g, " ");
  return /(?:^|:\s*)(?:error:\s*)?websocket (?:error|closed|close|connection (?:closed|error|lost)|disconnected)(?:\s+\d{3,4})?\.?$/i.test(normalized);
}

/**
 * Detect stream-ended-without-finish-reason transport failures from the Pi
 * agent provider layer. These are transient stream-level errors where the
 * provider connection dropped or the stream was cut before a finish_reason
 * arrived. Like WebSocket blips, these should not force terminal cast failure.
 *
 * Rejects messages that contain a structured provider error payload anywhere
 * in the message (e.g. `Codex error: {"type":"error",...}`) so that provider
 * errors are never masked by a trailing stream-ended transport message.
 * {@link evaluateContextErrorRecovery} already handles {@code context_window}
 * classification before this check; other structured provider errors that
 * appear alongside stream-ended text fall through for recovery or terminal
 * handling.
 */
function isStreamEndedTransportFailure(message: string): boolean {
  const normalized = message.trim();
  // Refuse to classify as transient transport when the message contains an
  // embedded structured provider error payload (Codex/Anthropic/etc. JSON).
  // In that case the provider signal should govern, even if the stream-ended
  // text happens to appear at the end of the wrapper.
  if (/\b(?:codex|anthropic|openai|provider)\s+error\s*:\s*\{|\{"type"\s*:\s*"error"/i.test(normalized)) return false;
  return /stream\s+ended\s+without\s+finish[_-]?reason\s*\.?$/i.test(normalized);
}

function isToolTimeoutFailure(message: string): boolean {
  const normalized = message.trim().replace(/\s+/g, " ");
  // Pi bash tool returns: "Command timed out after N seconds"
  // Agent-level: "bash command timed out", "tool call timed out"
  // Turn-level: "turn timed out", "agent turn exceeded"
  // Utility: "Utility command timed out for socket"
  return /\b(?:tool(?:[_ -]call)?|bash|command)\s+timed?\s*out\b|\btimed?\s*out\s+(?:after\s+\d+|waiting for|during)\b/i.test(normalized);
}

function currentSocketVisit(state: MateriaCastState, fallback = 0): number {
  const socketId = currentSocketId(state);
  if (!socketId) return fallback;
  return state.visits?.[socketId] ?? fallback;
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
