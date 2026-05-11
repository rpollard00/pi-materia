import type { MateriaAgentConfig, MateriaCastState } from "../types.js";
import {
  classifyRecoverableTurnFailure,
  ensureRecoveryAllowance,
  errorMessage,
  recoveryDiagnosticLabel,
  recoveryIdentityKey,
  recoveryTurnMode,
  type RecoverableTurnFailure,
} from "./recoveryPolicy.js";
import { summarizeCompactionResult } from "./compactionWorkflow.js";

export interface SameSocketRecoveryWorkflowDeps {
  appendEvent(runState: MateriaCastState["runState"], type: string, data: Record<string, unknown>): Promise<void>;
  writeUsage(runState: MateriaCastState["runState"]): Promise<void>;
  saveState(state: MateriaCastState): void;
  failCast(state: MateriaCastState, error: unknown, entryId?: string, options?: { preserveRecoveryExhaustion?: boolean }): Promise<void>;
  updateToolScope(materia: MateriaAgentConfig): void;
  sendMateriaTurn(state: MateriaCastState, prompt: string, options?: { skipProactiveCompaction?: boolean }): Promise<void>;
  buildRecoveryPrompt(state: MateriaCastState): string;
  updateWidget(state: MateriaCastState): void;
  notifyWarning(message: string): void;
  setCurrentSocketState(state: MateriaCastState, socketState: MateriaCastState["socketState"]): void;
  currentSocketId(state: MateriaCastState): string | undefined;
  currentSocketVisit(state: MateriaCastState, fallback?: number): number;
  shortMetadataLabel(value: string | undefined): string | undefined;
  currentMateria(state: MateriaCastState): MateriaAgentConfig;
  runRecoveryAction(state: MateriaCastState, options: SameSocketRecoveryActionOptions): Promise<void>;
}

export interface SameSocketRecoveryActionOptions {
  action: "compact";
  reason: "context_window";
  key: string;
  attempt: number;
  maxAttempts: number;
  entryId?: string;
}

export interface SameSocketRecoveryActionDeps {
  appendEvent(runState: MateriaCastState["runState"], type: string, data: Record<string, unknown>): Promise<void>;
  saveState(state: MateriaCastState): void;
  runCompaction(state: MateriaCastState): Promise<unknown>;
  currentSocketId(state: MateriaCastState): string | undefined;
}

export async function handleSameSocketRecoverableTurnFailureWorkflow(
  state: MateriaCastState,
  error: unknown,
  deps: SameSocketRecoveryWorkflowDeps,
  options: { entryId?: string } = {},
): Promise<boolean> {
  const reason = classifyRecoverableTurnFailure(error);
  if (!reason) return false;

  const key = recoveryIdentityKey(state);
  state.recoveryAttempts ??= {};
  const allowance = ensureRecoveryAllowance(state, key);
  const previousAttempts = state.recoveryAttempts[key] ?? 0;
  const maxAttempts = allowance.effectiveMaxAttempts;
  if (previousAttempts >= maxAttempts) {
    const exhausted = `Same-socket recovery exhausted for ${recoveryDiagnosticLabel(state)} after ${previousAttempts}/${maxAttempts} attempt(s): ${errorMessage(error)}`;
    state.recoveryExhaustion = {
      kind: "same_socket_recovery_exhausted",
      reason,
      key,
      attempts: previousAttempts,
      originalMaxAttempts: allowance.originalMaxAttempts,
      effectiveMaxAttempts: allowance.effectiveMaxAttempts,
      reviveCount: allowance.reviveCount,
      failedReason: exhausted,
      socket: deps.currentSocketId(state),
      itemKey: state.currentItemKey,
      mode: recoveryTurnMode(state),
      exhaustedAt: Date.now(),
    };
    await deps.appendEvent(state.runState, "same_socket_recovery_exhausted", { reason, key, attempts: previousAttempts, originalMaxAttempts: allowance.originalMaxAttempts, effectiveMaxAttempts: allowance.effectiveMaxAttempts, maxAttempts, reviveCount: allowance.reviveCount, error: errorMessage(error), entryId: options.entryId, socket: deps.currentSocketId(state), itemKey: state.currentItemKey, mode: recoveryTurnMode(state) });
    await deps.failCast(state, new Error(exhausted), options.entryId, { preserveRecoveryExhaustion: true });
    return true;
  }

  const attempt = previousAttempts + 1;
  state.recoveryAttempts[key] = attempt;
  state.awaitingResponse = true;
  deps.setCurrentSocketState(state, "awaiting_agent_response");
  state.updatedAt = Date.now();
  state.runState.lastMessage = `Retrying ${recoveryDiagnosticLabel(state)} after recoverable ${reason} failure (${attempt}/${maxAttempts}).`;
  await deps.appendEvent(state.runState, "same_socket_recovery_start", recoveryEventData(state, deps, reason, key, attempt, allowance, maxAttempts, error, options.entryId));
  await deps.writeUsage(state.runState);
  deps.saveState(state);

  try {
    if (reason === "context_window") await deps.runRecoveryAction(state, { action: "compact", reason, key, attempt, maxAttempts, entryId: options.entryId });
    deps.updateToolScope(deps.currentMateria(state));
    await deps.sendMateriaTurn(state, deps.buildRecoveryPrompt(state), { skipProactiveCompaction: true });
    await deps.appendEvent(state.runState, "same_socket_recovery_retry", { reason, key, attempt, originalMaxAttempts: allowance.originalMaxAttempts, effectiveMaxAttempts: allowance.effectiveMaxAttempts, maxAttempts, reviveCount: allowance.reviveCount, socket: deps.currentSocketId(state), itemKey: state.currentItemKey, mode: recoveryTurnMode(state) });
    deps.saveState(state);
    deps.updateWidget(state);
    deps.notifyWarning(`pi-materia retrying ${recoveryDiagnosticLabel(state)} after recoverable ${reason} failure (${attempt}/${maxAttempts}).`);
    return true;
  } catch (retryError) {
    await deps.appendEvent(state.runState, "same_socket_recovery_retry_failed", { reason, key, attempt, maxAttempts, error: errorMessage(retryError), originalError: errorMessage(error), entryId: options.entryId, socket: deps.currentSocketId(state), itemKey: state.currentItemKey, mode: recoveryTurnMode(state) });
    await deps.failCast(state, new Error(`Same-socket recovery retry failed for ${recoveryDiagnosticLabel(state)}: ${errorMessage(retryError)}. Original failure: ${errorMessage(error)}`), options.entryId);
    return true;
  }
}

export async function runSameSocketRecoveryActionWorkflow(state: MateriaCastState, options: SameSocketRecoveryActionOptions, deps: SameSocketRecoveryActionDeps): Promise<void> {
  await deps.appendEvent(state.runState, "same_socket_recovery_action_start", actionEventData(state, deps, options));
  deps.saveState(state);

  try {
    const result = await deps.runCompaction(state);
    await deps.appendEvent(state.runState, "same_socket_recovery_action_complete", { ...actionEventData(state, deps, options), result: summarizeCompactionResult(result) });
    deps.saveState(state);
  } catch (actionError) {
    await deps.appendEvent(state.runState, "same_socket_recovery_action_failed", { ...actionEventData(state, deps, options), error: errorMessage(actionError) });
    throw new Error(`Same-socket recovery action compact failed for ${recoveryDiagnosticLabel(state)}: ${errorMessage(actionError)}`);
  }
}

function recoveryEventData(
  state: MateriaCastState,
  deps: SameSocketRecoveryWorkflowDeps,
  reason: RecoverableTurnFailure,
  key: string,
  attempt: number,
  allowance: { originalMaxAttempts: number; effectiveMaxAttempts: number; reviveCount: number },
  maxAttempts: number,
  error: unknown,
  entryId: string | undefined,
): Record<string, unknown> {
  return { reason, key, attempt, originalMaxAttempts: allowance.originalMaxAttempts, effectiveMaxAttempts: allowance.effectiveMaxAttempts, maxAttempts, reviveCount: allowance.reviveCount, error: errorMessage(error), entryId, socket: deps.currentSocketId(state), itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: deps.shortMetadataLabel(state.currentItemLabel), visit: deps.currentSocketVisit(state, undefined), mode: recoveryTurnMode(state) };
}

function actionEventData(state: MateriaCastState, deps: SameSocketRecoveryActionDeps, options: SameSocketRecoveryActionOptions): Record<string, unknown> {
  return { action: options.action, reason: options.reason, key: options.key, attempt: options.attempt, maxAttempts: options.maxAttempts, entryId: options.entryId, socket: deps.currentSocketId(state), itemKey: state.currentItemKey, mode: recoveryTurnMode(state) };
}
