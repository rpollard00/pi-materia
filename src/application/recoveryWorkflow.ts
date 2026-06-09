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
import { evaluateContextErrorRecovery, type ContextErrorRecoveryAction, type ContextErrorRecoveryDecision } from "./contextErrorRecoveryPolicy.js";
import { summarizeCompactionResult, type ContextPressureAssessment } from "./compactionWorkflow.js";

export interface SameSocketRecoveryWorkflowDeps {
  appendEvent(runState: MateriaCastState["runState"], type: string, data: Record<string, unknown>): Promise<void>;
  writeUsage(runState: MateriaCastState["runState"]): Promise<void>;
  saveState(state: MateriaCastState): void;
  failCast(state: MateriaCastState, error: unknown, entryId?: string, options?: { preserveRecoveryExhaustion?: boolean }): Promise<void>;
  updateToolScope(materia: MateriaAgentConfig): void | Promise<void>;
  sendMateriaTurn(state: MateriaCastState, prompt: string, options?: { skipProactiveCompaction?: boolean }): Promise<void>;
  buildRecoveryPrompt(state: MateriaCastState): string;
  updateWidget(state: MateriaCastState): void;
  notifyWarning(message: string): void;
  setCurrentSocketState(state: MateriaCastState, socketState: MateriaCastState["socketState"]): void;
  currentSocketId(state: MateriaCastState): string | undefined;
  currentSocketVisit(state: MateriaCastState, fallback?: number): number;
  shortMetadataLabel(value: string | undefined): string | undefined;
  currentMateria(state: MateriaCastState): MateriaAgentConfig;
  assessContextPressure?(state: MateriaCastState): Promise<ContextPressureAssessment>;
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

interface RecoveryPreparation {
  action?: SameSocketRecoveryActionOptions;
  contextDecision?: {
    action: ContextErrorRecoveryAction;
    compactBecausePressure: boolean;
    compactBecauseRepeatedStrongSignal: boolean;
    compactBecauseConfirmedOverflow: boolean;
  };
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
  options: { entryId?: string; allowGenericTurnFailure?: boolean } = {},
): Promise<boolean> {
  const reason = classifyRecoverableTurnFailure(error, { allowGenericTurnFailure: options.allowGenericTurnFailure });
  if (!reason) return false;

  const key = recoveryIdentityKey(state);
  state.recoveryAttempts ??= {};
  const allowance = ensureRecoveryAllowance(state, key, { reason });
  // Persist the recovery reason and original error message so prompt assembly can
  // inject reason-specific hints (e.g. timeout avoidance) across all retry attempts.
  state.recoveryReasons ??= {};
  state.recoveryReasons[key] = reason;
  state.recoveryErrorMessages ??= {};
  if (!state.recoveryErrorMessages[key]) {
    state.recoveryErrorMessages[key] = errorMessage(error);
  }
  const previousAttempts = state.recoveryAttempts[key] ?? 0;
  let maxAttempts = allowance.effectiveMaxAttempts;
  const jsonRepairMetadata = jsonOutputRepairRecoveryMetadata(state);
  if (previousAttempts >= maxAttempts) {
    const exhausted = jsonRepairMetadata
      ? `JSON output repair retry exhausted for ${recoveryDiagnosticLabel(state)} after ${previousAttempts}/${maxAttempts} attempt(s): ${errorMessage(error)}`
      : `Same-socket recovery exhausted for ${recoveryDiagnosticLabel(state)} after ${previousAttempts}/${maxAttempts} attempt(s): ${errorMessage(error)}`;
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
      ...jsonRepairMetadata,
    };
    await deps.appendEvent(state.runState, "same_socket_recovery_exhausted", { reason, key, attempts: previousAttempts, attempt: previousAttempts, originalMaxAttempts: allowance.originalMaxAttempts, effectiveMaxAttempts: allowance.effectiveMaxAttempts, maxAttempts, reviveCount: allowance.reviveCount, error: errorMessage(error), entryId: options.entryId, socket: deps.currentSocketId(state), itemKey: state.currentItemKey, mode: recoveryTurnMode(state), ...jsonRepairMetadata });
    await deps.failCast(state, new Error(exhausted), options.entryId, { preserveRecoveryExhaustion: true });
    return true;
  }

  const attempt = previousAttempts + 1;
  const preparation = await sameSocketRecoveryPreparation(state, deps, reason, error, key, previousAttempts, attempt, maxAttempts, options.entryId);
  maxAttempts = allowance.effectiveMaxAttempts;
  state.recoveryAttempts[key] = attempt;
  state.awaitingResponse = true;
  deps.setCurrentSocketState(state, "awaiting_agent_response");
  state.updatedAt = Date.now();
  state.runState.lastMessage = jsonRepairMetadata
    ? `Retrying ${recoveryDiagnosticLabel(state)} because the previous JSON output was invalid (${attempt}/${maxAttempts}).`
    : `Retrying ${recoveryDiagnosticLabel(state)} after recoverable ${reason} failure (${attempt}/${maxAttempts}).`;
  await deps.appendEvent(state.runState, "same_socket_recovery_start", recoveryEventData(state, deps, reason, key, attempt, allowance, maxAttempts, error, options.entryId));
  await deps.writeUsage(state.runState);
  deps.saveState(state);

  try {
    if (preparation.action) await deps.runRecoveryAction(state, preparation.action);
    await deps.updateToolScope(deps.currentMateria(state));
    await deps.sendMateriaTurn(state, deps.buildRecoveryPrompt(state), { skipProactiveCompaction: true });
    await deps.appendEvent(state.runState, "same_socket_recovery_retry", { reason, key, attempt, originalMaxAttempts: allowance.originalMaxAttempts, effectiveMaxAttempts: allowance.effectiveMaxAttempts, maxAttempts, reviveCount: allowance.reviveCount, socket: deps.currentSocketId(state), itemKey: state.currentItemKey, mode: recoveryTurnMode(state), ...jsonRepairMetadata });
    deps.saveState(state);
    deps.updateWidget(state);
    deps.notifyWarning(recoveryWarningMessage(state, reason, attempt, maxAttempts, preparation));
    return true;
  } catch (retryError) {
    await deps.appendEvent(state.runState, "same_socket_recovery_retry_failed", { reason, key, attempt, maxAttempts, error: errorMessage(retryError), originalError: errorMessage(error), entryId: options.entryId, socket: deps.currentSocketId(state), itemKey: state.currentItemKey, mode: recoveryTurnMode(state), ...jsonRepairMetadata });
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

async function sameSocketRecoveryPreparation(
  state: MateriaCastState,
  deps: SameSocketRecoveryWorkflowDeps,
  reason: RecoverableTurnFailure,
  error: unknown,
  key: string,
  previousAttempts: number,
  attempt: number,
  maxAttempts: number,
  entryId: string | undefined,
): Promise<RecoveryPreparation> {
  if (reason !== "context_window") return {};
  const pressure = await deps.assessContextPressure?.(state);
  const priorGuardedRetries = state.contextWindowRecoveryGuards?.[key] ?? 0;
  const decision = evaluateContextErrorRecovery(error);
  // Evidence-gated compaction invariant: provider context_length_exceeded
  // responses can be transient or misleading, so same-socket recovery only
  // forces compaction when pressure corroborates the failure, the error
  // message carries explicit per-side overflow token counts (confirmed
  // overflow), or the same recovery key repeats a strong context-window
  // signal.
  const compactBecauseConfirmedOverflow = decision.overflowTelemetry !== undefined;
  const compactBecausePressure = pressure?.shouldCompact === true;
  const compactBecauseRepeatedStrongSignal = priorGuardedRetries > 0 && decision.strongContextSignal;
  const shouldCompact = compactBecauseConfirmedOverflow || compactBecausePressure || compactBecauseRepeatedStrongSignal;
  const action = shouldCompact ? "compact" : "retry_without_compaction";

  await deps.appendEvent(state.runState, "context_window_recovery_decision", contextWindowRecoveryDecisionEventData(state, deps, {
    action,
    key,
    attempt,
    maxAttempts,
    entryId,
    decision,
    pressure,
    priorGuardedRetries,
    compactBecausePressure,
    compactBecauseRepeatedStrongSignal,
    compactBecauseConfirmedOverflow,
  }));

  if (shouldCompact) {
    return {
      contextDecision: { action, compactBecausePressure, compactBecauseRepeatedStrongSignal, compactBecauseConfirmedOverflow },
      action: { action: "compact", reason, key, attempt, maxAttempts, entryId },
    };
  }

  state.contextWindowRecoveryGuards ??= {};
  state.contextWindowRecoveryGuards[key] = priorGuardedRetries + 1;
  const allowance = ensureRecoveryAllowance(state, key);
  allowance.effectiveMaxAttempts = Math.max(allowance.effectiveMaxAttempts, previousAttempts + 2);
  return { contextDecision: { action, compactBecausePressure, compactBecauseRepeatedStrongSignal, compactBecauseConfirmedOverflow } };
}

function contextWindowRecoveryDecisionEventData(
  state: MateriaCastState,
  deps: SameSocketRecoveryWorkflowDeps,
  options: {
    action: "compact" | "retry_without_compaction";
    key: string;
    attempt: number;
    maxAttempts: number;
    entryId?: string;
    decision: ContextErrorRecoveryDecision;
    pressure?: ContextPressureAssessment;
    priorGuardedRetries: number;
    compactBecausePressure: boolean;
    compactBecauseRepeatedStrongSignal: boolean;
    compactBecauseConfirmedOverflow: boolean;
  },
): Record<string, unknown> {
  return {
    action: options.action,
    reason: "context_window",
    key: options.key,
    attempt: options.attempt,
    maxAttempts: options.maxAttempts,
    entryId: options.entryId,
    providerType: options.decision.provider.type,
    providerCode: options.decision.provider.code,
    providerParam: options.decision.provider.param,
    strongContextSignal: options.decision.strongContextSignal,
    transientProviderSignal: options.decision.transientProviderSignal,
    contextTokens: options.pressure?.tokens,
    contextWindow: options.pressure?.contextWindow,
    contextPercent: options.pressure?.percent,
    thresholdPercent: options.pressure?.thresholdPercent,
    thresholdMode: options.pressure?.thresholdMode,
    thresholdTier: options.pressure?.thresholdTier,
    contextPressureShouldCompact: options.pressure?.shouldCompact,
    priorGuardedRetries: options.priorGuardedRetries,
    compactBecausePressure: options.compactBecausePressure,
    compactBecauseRepeatedStrongSignal: options.compactBecauseRepeatedStrongSignal,
    compactBecauseConfirmedOverflow: options.compactBecauseConfirmedOverflow,
    overflowTelemetry: options.decision.overflowTelemetry,
    socket: deps.currentSocketId(state),
    itemKey: state.currentItemKey,
    itemLabel: state.currentItemLabel,
    itemLabelShort: deps.shortMetadataLabel(state.currentItemLabel),
    visit: deps.currentSocketVisit(state, undefined),
    mode: recoveryTurnMode(state),
  };
}

function recoveryWarningMessage(
  state: MateriaCastState,
  reason: RecoverableTurnFailure,
  attempt: number,
  maxAttempts: number,
  preparation: RecoveryPreparation,
): string {
  const jsonRepairMetadata = jsonOutputRepairRecoveryMetadata(state);
  if (jsonRepairMetadata) return `pi-materia retrying ${recoveryDiagnosticLabel(state)} because the previous JSON output was invalid (${attempt}/${maxAttempts}).`;
  if (reason === "tool_timeout") {
    return `pi-materia retrying ${recoveryDiagnosticLabel(state)} after tool timeout (${attempt}/${maxAttempts}).`;
  }
  if (reason === "context_window" && preparation.contextDecision?.action === "retry_without_compaction") {
    return `pi-materia retrying ${recoveryDiagnosticLabel(state)} without compaction for suspected transient provider/context failure (${attempt}/${maxAttempts}).`;
  }
  if (reason === "context_window" && preparation.contextDecision?.compactBecauseConfirmedOverflow) {
    return `pi-materia compacted and retrying ${recoveryDiagnosticLabel(state)} after confirmed provider context-window overflow (${attempt}/${maxAttempts}).`;
  }
  if (reason === "context_window" && preparation.contextDecision?.compactBecauseRepeatedStrongSignal) {
    return `pi-materia compacted and retrying ${recoveryDiagnosticLabel(state)} after repeated confirmed context-window failure (${attempt}/${maxAttempts}).`;
  }
  if (reason === "context_window" && preparation.contextDecision?.compactBecausePressure) {
    return `pi-materia compacted and retrying ${recoveryDiagnosticLabel(state)} after context-window failure with high context pressure (${attempt}/${maxAttempts}).`;
  }
  return `pi-materia retrying ${recoveryDiagnosticLabel(state)} after recoverable ${reason} failure (${attempt}/${maxAttempts}).`;
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
  return { reason, key, attempt, originalMaxAttempts: allowance.originalMaxAttempts, effectiveMaxAttempts: allowance.effectiveMaxAttempts, maxAttempts, reviveCount: allowance.reviveCount, error: errorMessage(error), entryId, socket: deps.currentSocketId(state), itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: deps.shortMetadataLabel(state.currentItemLabel), visit: deps.currentSocketVisit(state, undefined), mode: recoveryTurnMode(state), ...jsonOutputRepairRecoveryMetadata(state) };
}

function jsonOutputRepairRecoveryMetadata(state: MateriaCastState): Record<string, unknown> | undefined {
  const repair = state.jsonOutputRepair;
  if (!repair) return undefined;
  return {
    recoveryKind: "json_output_repair",
    validationKind: repair.validationKind,
    excerptLength: repair.excerptLength,
    excerptTruncated: repair.truncated,
  };
}

function actionEventData(state: MateriaCastState, deps: SameSocketRecoveryActionDeps, options: SameSocketRecoveryActionOptions): Record<string, unknown> {
  return { action: options.action, reason: options.reason, key: options.key, attempt: options.attempt, maxAttempts: options.maxAttempts, entryId: options.entryId, socket: deps.currentSocketId(state), itemKey: state.currentItemKey, mode: recoveryTurnMode(state) };
}
