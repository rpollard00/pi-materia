import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import path from "node:path";
import { safeTimestamp } from "../utilities/artifacts.js";
import { resolveArtifactRoot } from "../config/config.js";
import { getEffectivePipelineConfig, loopIteratorForSocket } from "./pipeline.js";
import { getResolvedPipelineSocket } from "../loadout/loadoutAccessors.js";
import { parseSocketJson } from "../utilities/json.js";
import { applyGenericHandoffEnvelope } from "../application/handoff.js";
import { activeMateriaSystemPrompt, buildMultiTurnFinalizationPrompt, buildSocketPrompt, buildSyntheticCastContext, isPausedMultiTurnRefinement, materiaPrompt, multiTurnRefinementGuidance, renderTemplate } from "../application/promptAssembly.js";
export { activeMateriaSystemPrompt, buildIsolatedMateriaContext } from "../application/promptAssembly.js";
export { currentMateria, materiaStatusLabel } from "./sessionState.js";
export { classifyTurnFailure, extendSameSocketRecoveryAllowanceForRevive } from "../application/recoveryPolicy.js";
import { applyAdvance, applyAssignments, currentItem, evaluateCondition, getPath, resolveEmptyLoopExhaustionTarget, resolveValue, selectNextTarget, setCurrentItem, setPath } from "../application/workflowTransitions.js";
import { executeUtilitySocketWithDeps } from "../application/utilityExecution.js";
import { classifyTurnFailure, errorMessage, extendSameSocketRecoveryAllowanceForRevive, nonRecoverableTurnError, recoveryDiagnosticLabel, recoveryTurnMode, type TurnFailureClassification } from "../application/recoveryPolicy.js";
import { maybeRunProactiveCompactionWorkflow, runSameSocketRecoveryCompaction } from "../application/compactionWorkflow.js";
import { handleSameSocketRecoverableTurnFailureWorkflow, runSameSocketRecoveryActionWorkflow, type SameSocketRecoveryActionOptions } from "../application/recoveryWorkflow.js";
import { validateHandoffJsonOutput } from "../handoff/handoffValidation.js";
import { applyMateriaModelSettings } from "../config/modelSettings.js";
import { formatMateriaCastContent, formatMateriaNotificationDisplay } from "../presentation/notificationFormatting.js";
import type { LoadedConfig, MateriaCastState, PiMateriaConfig, ResolvedMateriaSocket, ResolvedMateriaPipeline, ResolvedMateriaUtilitySocket } from "../types.js";
import { formatUsage, showUsageSummary, updateWidget } from "../presentation/ui.js";
import { createRunState, recordUsageModelSelection } from "../telemetry/usage.js";
import { executeBuiltInUtility, hasBuiltInUtility } from "../utilities/utilityRegistry.js";
import { appendEvent, appendManifest, initializeRun, recordSocketParsedJson, recordUtilityInput as recordUtilityInputFile, shortMetadataLabel } from "../infrastructure/castArtifacts.js";
import { clearCastState, listLatestCastStates, listResumableCastStates, listRevivableCastStates, loadActiveCastState, loadCastStateById, saveCastState } from "../infrastructure/castStateRepository.js";
import { assertBudget, writeUsage } from "../infrastructure/castUsage.js";
import { executeCommandUtility } from "../infrastructure/utilityCommandExecutor.js";
import { hashConfig, loadConfigFromState, resolvePersistedCastLoadoutName } from "./configPersistence.js";
import { materiaModelSelection } from "./modelSelection.js";
import { recordMultiTurnRefinement, recordSocketOutput, writeContextArtifact } from "./artifactRecording.js";
import { assistantErrorMessage, assistantText, agentEndFailureMessage, captureUsage, findLatestAssistantEntry, updateToolScope, type ToolScopeRuntimeWarning } from "./agentTurnState.js";
import { activeResolvedSocket, currentMateria, currentRefinementTurn, currentSocketId, currentSocketOrThrow, currentSocketState, currentSocketVisit, isAgentResolvedSocket, isMultiTurnResolvedAgentSocket, materiaStatusLabel, nextRefinementTurn, resolvedSocketConfig, setCurrentSocketId, setCurrentSocketState, socketMateriaName, socketVisit, startTaskAttempt } from "./sessionState.js";
import { effectiveResolvedSocketConfig, resolvedMateriaDisplayName } from "./resolvedMateria.js";
export { clearCastState, listLatestCastStates, listResumableCastStates, listRevivableCastStates, loadActiveCastState, loadCastStateById, saveCastState } from "../infrastructure/castStateRepository.js";


const DEFAULT_MAX_SOCKET_VISITS = 25;
export { defaultProactiveCompactionThresholdPercent } from "./compaction.js";

type AdvancementLifecycleDiagnostics = {
  finalizedMultiTurn?: boolean;
  sourceSocketId?: string;
  sourceMateriaName?: string;
  nextSocketTarget?: string;
  dispatchTriggerMode?: string;
};

function advancementDiagnosticsEnabled(diagnostics?: AdvancementLifecycleDiagnostics): boolean {
  return Boolean(diagnostics?.finalizedMultiTurn || process.env.PI_MATERIA_ADVANCEMENT_DEBUG?.trim());
}

function contextIdleState(ctx: ExtensionContext): boolean | string {
  const maybeCtx = ctx as ExtensionContext & { isIdle?: unknown };
  if (typeof maybeCtx.isIdle !== "function") return "unavailable";
  try {
    return maybeCtx.isIdle();
  } catch (error) {
    return `error:${errorMessage(error)}`;
  }
}

async function appendAdvancementDiagnostic(ctx: ExtensionContext, state: MateriaCastState, stage: string, diagnostics?: AdvancementLifecycleDiagnostics, details: Record<string, unknown> = {}): Promise<void> {
  if (!advancementDiagnosticsEnabled(diagnostics)) return;
  await appendEvent(state.runState, "advancement_lifecycle", {
    diagnostic: true,
    stage,
    castId: state.castId,
    currentSocketId: currentSocketId(state),
    sourceSocketId: diagnostics?.sourceSocketId,
    materiaName: state.currentMateria ?? diagnostics?.sourceMateriaName,
    sourceMateriaName: diagnostics?.sourceMateriaName,
    phase: state.phase,
    socketState: currentSocketState(state),
    active: state.active,
    awaitingResponse: state.awaitingResponse,
    multiTurnFinalizing: state.multiTurnFinalizing,
    nextSocketTarget: diagnostics?.nextSocketTarget,
    dispatchTriggerMode: diagnostics?.dispatchTriggerMode,
    isIdle: contextIdleState(ctx),
    ...details,
  });
}

async function updateSocketToolScope(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, socket: ResolvedMateriaSocket): Promise<void> {
  if (!isAgentResolvedSocket(socket)) return;
  const emittedWarnings: ToolScopeRuntimeWarning[] = [];
  updateToolScope(pi, socket.materia, {
    context: toolScopeWarningContext(state, socket),
    onWarning: (warning) => { emittedWarnings.push(warning); },
  });
  for (const warning of emittedWarnings) {
    await appendToolScopeWarningEvent(state, warning);
    ctx.ui.notify(warning.message, "warning");
  }
}

async function appendToolScopeWarningEvent(state: MateriaCastState, warning: ToolScopeRuntimeWarning): Promise<void> {
  await appendEvent(state.runState, "tool_scope_warning", {
    warning: true,
    message: warning.message,
    warnings: warning.warnings,
    unavailableTools: warning.unavailableTools,
    activeTools: warning.activeTools,
    configuredTools: warning.configuredTools,
    socket: warning.context.socket,
    materia: warning.context.materia,
    itemKey: warning.context.itemKey,
    visit: warning.context.visit,
  });
}

function toolScopeWarningContext(state: MateriaCastState, socket: ResolvedMateriaSocket) {
  return {
    socket: socket.id,
    materia: socketMateriaName(socket),
    itemKey: state.currentItemKey,
    visit: socketVisit(state, socket.id),
  };
}

export async function startNativeCast(pi: ExtensionAPI, ctx: ExtensionContext, loaded: LoadedConfig, pipeline: ResolvedMateriaPipeline, request: string, options?: { initialData?: Record<string, unknown>; startEventDetails?: Record<string, unknown> }): Promise<MateriaCastState> {
  const config = loaded.config;
  const artifactRoot = resolveArtifactRoot(ctx.cwd, config.artifactDir);
  const castId = safeTimestamp();
  const runDir = path.join(artifactRoot, castId);

  const effectivePipeline = getEffectivePipelineConfig(config);
  const runState = createRunState(castId, runDir, ctx.model, effectivePipeline.loadoutName);
  runState.currentSocketId = pipeline.entry.id;
  runState.currentMateria = socketMateriaName(pipeline.entry);
  runState.lastMessage = pipeline.entry.id;
  await initializeRun(runDir, config, { castId, request, configSource: loaded.source, sessionFile: ctx.sessionManager.getSessionFile(), entries: [] });
  await writeUsage(runState);
  await appendEvent(runState, "cast_start", { request, configSource: loaded.source, artifactRoot, pipeline: effectivePipeline.pipeline, loadout: effectivePipeline.loadoutName, nativeSession: true, isolatedMateriaContext: true, ...(options?.startEventDetails ?? {}) });

  const state: MateriaCastState = {
    version: 2,
    active: true,
    castId,
    request,
    configSource: loaded.source,
    configHash: hashConfig(config),
    cwd: ctx.cwd,
    runDir,
    artifactRoot,
    phase: pipeline.entry.id,
    currentSocketId: pipeline.entry.id,
    currentMateria: socketMateriaName(pipeline.entry),
    awaitingResponse: true,
    socketState: "awaiting_agent_response",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    data: { ...(options?.initialData ?? {}) },
    cursors: {},
    visits: {},
    multiTurnRefinements: {},
    taskAttempts: {},
    edgeTraversals: {},
    runState,
    pipeline,
  };

  pi.setSessionName(`materia: ${request.slice(0, 60)}`);
  saveCastState(pi, state);
  updateWidget(ctx, state, { replaceOwner: true });
  ctx.ui.notify(`pi-materia cast started. Artifacts: ${runDir}`, "info");
  await startSocket(pi, ctx, state, pipeline.entry);
  return state;
}

export async function continueNativeCast(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState): Promise<void> {
  if (!state.active) throw new Error("No active pi-materia cast to continue.");
  if (state.awaitingResponse) throw new Error("Materia is already awaiting a Pi agent response.");

  if (currentSocketState(state) === "awaiting_user_refinement") {
    if (!isPausedMultiTurnRefinement(state)) {
      throw new Error("Materia is awaiting user refinement, but the current socket's resolved materia is not multi-turn.");
    }
    await startMultiTurnFinalizationTurn(pi, ctx, state);
    return;
  }

  await startSocket(pi, ctx, state, currentSocketOrThrow(state));
}

export async function reviveNativeCast(pi: ExtensionAPI, ctx: ExtensionContext, castId: string): Promise<MateriaCastState> {
  const state = loadCastStateById(ctx, castId);
  if (!state) throw new Error(`Unknown pi-materia cast id "${castId}" in this session.`);
  assertNoActiveNativeCast(ctx, state, "reviving");
  const result = extendSameSocketRecoveryAllowanceForRevive(state);
  await appendEvent(state.runState, "cast_revive", {
    castId: state.castId,
    exhaustedRecoveryKey: result.key,
    recoveryContext: {
      key: result.key,
      socket: state.recoveryExhaustion?.socket ?? currentSocketId(state),
      mode: state.recoveryExhaustion?.mode,
      itemKey: state.currentItemKey,
    },
    priorEffectiveMaxAttempts: result.priorEffectiveMaxAttempts,
    increment: result.increment,
    newEffectiveMaxAttempts: result.newEffectiveMaxAttempts,
    reviveCount: result.reviveCount,
  });
  saveCastState(pi, state);
  return resumeValidatedNativeCast(pi, ctx, state);
}

export async function resumeNativeCast(pi: ExtensionAPI, ctx: ExtensionContext, castId: string): Promise<MateriaCastState> {
  const state = loadCastStateById(ctx, castId);
  if (!state) throw new Error(`Unknown pi-materia cast id "${castId}" in this session.`);
  assertNoActiveNativeCast(ctx, state, "recasting");
  assertRecastableNativeCast(state);
  return resumeValidatedNativeCast(pi, ctx, state);
}

function assertNoActiveNativeCast(ctx: ExtensionContext, state: MateriaCastState, action: "recasting" | "reviving"): void {
  const active = loadActiveCastState(ctx);
  if (active?.active) {
    if (active.castId === state.castId) throw new Error(`pi-materia cast ${state.castId} is already running.`);
    throw new Error(`A pi-materia cast is already active (${active.castId}). Abort it before ${action} ${state.castId}.`);
  }
}

function assertRecastableNativeCast(state: MateriaCastState): void {
  if (state.active) throw new Error(`pi-materia cast ${state.castId} is already running.`);
  if (state.phase === "complete" || currentSocketState(state) === "complete") throw new Error(`pi-materia cast ${state.castId} is complete and cannot be recast.`);
  if (state.phase !== "failed" && currentSocketState(state) !== "failed") throw new Error(`pi-materia cast ${state.castId} is not failed or aborted (phase: ${state.phase}, socket state: ${currentSocketState(state) ?? "unknown"}).`);
}

async function resumeValidatedNativeCast(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState): Promise<MateriaCastState> {
  const socket = currentSocketOrThrow(state);
  const previousFailure = state.failedReason;

  state.recoveryExhaustion = undefined;
  state.active = true;
  state.phase = socket.id;
  setCurrentSocketId(state, socket.id);
  state.currentMateria = socketMateriaName(socket);
  state.awaitingResponse = isAgentResolvedSocket(socket);
  setCurrentSocketState(state, isAgentResolvedSocket(socket) ? "awaiting_agent_response" : "running_utility");
  state.failedReason = undefined;
  state.runState.endedAt = undefined;
  state.runState.loadoutName ||= await resolvePersistedCastLoadoutName(state);
  state.runState.currentSocketId = socket.id;
  state.runState.currentMateria = socketMateriaName(socket);
  state.runState.lastMessage = `Recasting from socket ${socket.id}.`;
  await appendEvent(state.runState, "cast_recast", { socket: socket.id, materia: socketMateriaName(socket), previousFailure, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), visit: socketVisit(state, socket.id), reusedActivePrompt: isAgentResolvedSocket(socket) && Boolean(state.activeTurnPrompt) });
  await writeUsage(state.runState);
  saveCastState(pi, state);
  ctx.ui.setStatus("materia", materiaStatusLabel(state, socket));
  updateWidget(ctx, state, { replaceOwner: true });

  if (isAgentResolvedSocket(socket) && state.activeTurnPrompt) {
    await updateSocketToolScope(pi, ctx, state, socket);
    await sendMateriaTurn(pi, ctx, state, state.activeTurnPrompt);
  } else {
    await startSocket(pi, ctx, state, socket);
  }
  ctx.ui.notify(`pi-materia cast ${state.castId} recast from socket "${socket.id}".`, "info");
  return state;
}

function isActiveMultiTurnFinalizationTurn(state: MateriaCastState): boolean {
  const socket = activeResolvedSocket(state);
  return state.multiTurnFinalizing === true
    && state.active === true
    && state.awaitingResponse === true
    && currentSocketState(state) === "awaiting_agent_response"
    && Boolean(socket && isMultiTurnResolvedAgentSocket(socket));
}

function clearStaleMultiTurnFinalizing(state: MateriaCastState): boolean {
  if (state.multiTurnFinalizing !== true || isActiveMultiTurnFinalizationTurn(state)) return false;
  state.multiTurnFinalizing = false;
  state.updatedAt = Date.now();
  return true;
}

async function startMultiTurnFinalizationTurn(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState): Promise<void> {
  const socket = currentSocketOrThrow(state);
  if (!isMultiTurnResolvedAgentSocket(socket)) {
    state.multiTurnFinalizing = false;
    throw new Error(`Cannot finalize refinement for socket "${socket.id}" because its resolved materia is not multi-turn.`);
  }
  const appliedModel = await applyMateriaModelSettings(pi, ctx, { materiaName: resolvedSocketConfig(socket).materia, model: socket.materia.model, thinking: socket.materia.thinking });
  const materiaModel = materiaModelSelection(appliedModel);
  state.currentMateria = socketMateriaName(socket);
  state.currentMateriaModel = materiaModel;
  state.runState.currentMateria = socketMateriaName(socket);
  state.runState.currentMateriaModel = materiaModel;
  state.awaitingResponse = true;
  setCurrentSocketState(state, "awaiting_agent_response");
  state.multiTurnFinalizing = true;
  state.updatedAt = Date.now();
  const refinementTurn = currentRefinementTurn(state, socket.id) + 1;
  recordUsageModelSelection(state.runState.usage, { socket: socket.id, materia: resolvedSocketConfig(socket).materia, taskId: state.currentItemKey, attempt: state.runState.attempt, materiaModel });
  await writeUsage(state.runState);
  await appendEvent(state.runState, "materia_model_settings", { socket: socket.id, materia: resolvedSocketConfig(socket).materia, visit: socketVisit(state, socket.id), itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), materiaModel, refinementTurn, finalization: true });
  await updateSocketToolScope(pi, ctx, state, socket);
  saveCastState(pi, state);
  ctx.ui.setStatus("materia", materiaStatusLabel(state, socket));
  updateWidget(ctx, state);
  await sendMateriaTurn(pi, ctx, state, buildMultiTurnFinalizationPrompt(state, socket));
}

export async function handleAgentEnd(pi: ExtensionAPI, event: { messages: unknown[] }, ctx: ExtensionContext): Promise<void> {
  const state = loadActiveCastState(ctx);
  if (!state?.active) return;
  const socketAtEnd = currentSocketOrThrow(state);
  const clearedStaleFinalizing = clearStaleMultiTurnFinalizing(state);
  if (clearedStaleFinalizing) saveCastState(pi, state);
  const acceptingRefinement = !state.awaitingResponse && currentSocketState(state) === "awaiting_user_refinement" && isMultiTurnResolvedAgentSocket(socketAtEnd);
  if (!state.awaitingResponse && !acceptingRefinement) return;

  const latest = findLatestAssistantEntry(ctx.sessionManager.getEntries(), state.lastProcessedEntryId);
  if (!latest || latest.entry.id === state.lastProcessedEntryId) {
    const eventFailure = agentEndFailureMessage(event);
    if (!eventFailure) return;
    const error = new Error(`Pi agent turn failed before producing an assistant response for socket "${currentSocketId(state) ?? state.phase}": ${eventFailure}`);
    if (classifyTurnFailure(error) === "transient_transport") {
      await preserveAwaitingAfterTransientTransportFailure(pi, ctx, state, error);
      return;
    }
    const recovered = await handleSameSocketRecoverableTurnFailure(pi, ctx, state, error, { allowGenericTurnFailure: shouldRetryGenericTurnFailure(error) });
    if (!recovered) await failCast(pi, ctx, state, error);
    return;
  }

  const text = assistantText(latest.message);
  const agentError = assistantErrorMessage(latest.message);
  const wasAwaitingFinalization = isActiveMultiTurnFinalizationTurn(state);
  state.lastProcessedEntryId = latest.entry.id;
  state.lastAssistantText = text;
  captureUsage(state, latest.message);

  if (agentError) {
    const error = new Error(`Pi agent turn failed for socket "${currentSocketId(state) ?? state.phase}": ${agentError}`);
    if (classifyTurnFailure(error) === "transient_transport") {
      await preserveAwaitingAfterTransientTransportFailure(pi, ctx, state, error, { entryId: latest.entry.id });
      return;
    }
    const recovered = await handleSameSocketRecoverableTurnFailure(pi, ctx, state, error, { entryId: latest.entry.id, allowGenericTurnFailure: shouldRetryGenericTurnFailure(error) });
    if (!recovered) await failCast(pi, ctx, state, error, latest.entry.id);
    return;
  }

  state.awaitingResponse = false;
  setCurrentSocketState(state, "idle");
  state.updatedAt = Date.now();

  try {
    const socket = currentSocketOrThrow(state);
    // Runtime contract: non-multiTurn agent sockets complete on agent_end and
    // immediately parse/assign/route into the next socket. Only resolved
    // multiTurn agent sockets pause here, and they complete only after the
    // explicit /materia continue finalization turn below.
    if (isMultiTurnResolvedAgentSocket(socket)) {
      if (wasAwaitingFinalization) {
        const diagnostics: AdvancementLifecycleDiagnostics = { finalizedMultiTurn: true, sourceSocketId: socket.id, sourceMateriaName: socketMateriaName(socket), dispatchTriggerMode: "deferred-triggerTurn" };
        await appendAdvancementDiagnostic(ctx, state, "finalized_multi_turn_handle_entry", diagnostics, { boundary: "sync_state_advancement" });
        state.multiTurnFinalizing = false;
        setCurrentSocketState(state, "idle");
        saveCastState(pi, state);
        await completeSocket(pi, ctx, state, text, latest.entry.id, { finalizedMultiTurn: true, diagnostics });
        await appendAdvancementDiagnostic(ctx, state, "finalized_multi_turn_handle_exit", diagnostics, { boundary: "sync_state_advancement" });
        return;
      }
      state.multiTurnFinalizing = false;
      const refinement = await recordMultiTurnRefinement(state, socket, text, latest.entry.id);
      setCurrentSocketState(state, "awaiting_user_refinement");
      state.runState.lastMessage = `Multi-turn socket ${socket.id} waiting for refinement; run /materia continue to finalize.`;
      await writeUsage(state.runState);
      await appendEvent(state.runState, "socket_refinement", { socket: socket.id, materia: socketMateriaName(socket), artifact: refinement.artifact, entryId: latest.entry.id, refinementTurn: refinement.turn, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), materiaModel: state.currentMateriaModel });
      saveCastState(pi, state);
      ctx.ui.setStatus("materia", materiaStatusLabel(state, socket, { suffix: "refine", includeItem: false }));
      updateWidget(ctx, state);
      ctx.ui.notify(`pi-materia multi-turn socket "${socket.id}" is waiting for refinement; run /materia continue to finalize.`, "info");
      return;
    }
    await completeSocket(pi, ctx, state, text, latest.entry.id);
  } catch (error) {
    state.active = false;
    state.phase = "failed";
    state.multiTurnFinalizing = false;
    setCurrentSocketState(state, "failed");
    state.failedReason = error instanceof Error ? error.message : String(error);
    state.runState.lastMessage = state.failedReason;
    markRunEnded(state);
    await appendEvent(state.runState, "cast_end", { ok: false, error: state.failedReason });
    await writeUsage(state.runState);
    await appendManifest(state, { phase: "failed", entryId: latest.entry.id });
    saveCastState(pi, state);
    ctx.ui.setStatus("materia", "failed");
    updateWidget(ctx, state);
    ctx.ui.notify(`pi-materia cast failed: ${state.failedReason}`, "error");
  }
}

async function completeSocket(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, text: string, entryId: string, options: { finalizedMultiTurn?: boolean; diagnostics?: AdvancementLifecycleDiagnostics } = {}): Promise<void> {
  const config = await loadConfigFromState(state);
  const socket = currentSocketOrThrow(state);
  const diagnostics = options.diagnostics ?? (options.finalizedMultiTurn ? { finalizedMultiTurn: true, sourceSocketId: socket.id, sourceMateriaName: socketMateriaName(socket), dispatchTriggerMode: "deferred-triggerTurn" } : undefined);
  await appendAdvancementDiagnostic(ctx, state, "socket_completion_entry", diagnostics, { boundary: "sync_state_advancement", entryId });
  if (isMultiTurnResolvedAgentSocket(socket) && !options.finalizedMultiTurn) {
    throw new Error(`Internal multi-turn state error for socket "${socket.id}": completion requires explicit /materia continue finalization.`);
  }
  const artifact = await recordSocketOutput(state, socket, text, entryId);
  state.lastOutput = text;

  let parsed: unknown = text;
  if (effectiveResolvedSocketConfig(socket).parse === "json") {
    try {
      parsed = parseSocketJson<unknown>(socket.id, text);
      parsed = validateHandoffJsonOutput(parsed, { socketId: socket.id, socket: socket.socket });
    } catch (error) {
      const validationError = new Error(`Pre-commit output validation failed for socket "${socket.id}": ${errorMessage(error)}`);
      if (isMultiTurnResolvedAgentSocket(socket) && options.finalizedMultiTurn) {
        throw validationError;
      }
      if (isAgentResolvedSocket(socket)) {
        const recovered = await handleSameSocketRecoverableTurnFailure(pi, ctx, state, validationError, { entryId, allowGenericTurnFailure: true });
        if (recovered) return;
        throw nonRecoverableTurnError(state, validationError);
      }
      throw validationError;
    }
    state.lastJson = parsed;
    await recordSocketParsedJson({ state, socketId: socket.id, visit: socketVisit(state, socket.id), parsed });
  }

  applyGenericHandoffEnvelope(state, parsed, socket);
  applyAssignments(state, socket, parsed);
  const advanceTarget = applyAdvance(state, socket, parsed);
  const finalizedRefinement = isMultiTurnResolvedAgentSocket(socket);
  await appendEvent(state.runState, "socket_complete", { socket: socket.id, materia: socketMateriaName(socket), materiaLabel: resolvedMateriaDisplayName(socket), artifact, parsed: effectiveResolvedSocketConfig(socket).parse === "json", entryId, finalizedRefinement: finalizedRefinement || undefined, refinementTurn: finalizedRefinement ? currentRefinementTurn(state, socket.id) : undefined, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), materiaModel: state.currentMateriaModel });
  await assertBudget(config, state.runState, ctx);

  const nextTarget = advanceTarget ?? selectNextTarget(state, socket, parsed, config);
  if (diagnostics) diagnostics.nextSocketTarget = nextTarget ?? "end";
  const nextDiagnostics = diagnostics ? { ...diagnostics } : undefined;
  await appendAdvancementDiagnostic(ctx, state, "socket_completion_exit", nextDiagnostics, { boundary: "sync_state_advancement", entryId });
  await advanceToSocket(pi, ctx, state, nextTarget, entryId, nextDiagnostics);
}

async function advanceToSocket(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, targetId: string | undefined, entryId: string, diagnostics?: AdvancementLifecycleDiagnostics): Promise<void> {
  const target = targetId ?? "end";
  const nextDiagnostics = diagnostics ? { ...diagnostics, nextSocketTarget: target } : undefined;
  await appendAdvancementDiagnostic(ctx, state, "socket_advancement_entry", nextDiagnostics, { boundary: "sync_state_advancement", entryId });
  if (target === "end") {
    await finishCast(pi, ctx, state, entryId, "Cast complete.");
    await appendAdvancementDiagnostic(ctx, state, "socket_advancement_exit", nextDiagnostics, { boundary: "sync_state_advancement", entryId });
    return;
  }
  const socket = getResolvedPipelineSocket(state.pipeline, target);
  if (!socket) throw new Error(`Unknown graph target "${target}"`);
  await startSocket(pi, ctx, state, socket, nextDiagnostics);
  await appendAdvancementDiagnostic(ctx, state, "socket_advancement_exit", nextDiagnostics, { boundary: "sync_state_advancement", entryId });
}

async function startSocket(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, socket: ResolvedMateriaSocket, diagnostics?: AdvancementLifecycleDiagnostics): Promise<void> {
  const config = await loadConfigFromState(state);
  const nextDiagnostics = diagnostics ? { ...diagnostics, nextSocketTarget: socket.id } : undefined;
  await appendAdvancementDiagnostic(ctx, state, "next_socket_start_entry", nextDiagnostics, { boundary: "sync_state_advancement", targetSocketId: socket.id, targetMateriaName: socketMateriaName(socket) });
  const hasItem = setCurrentItem(state, socket);
  const loop = loopIteratorForSocket(state.pipeline, socket.id);
  if (loop && !hasItem) return await advanceToSocket(pi, ctx, state, resolveEmptyLoopExhaustionTarget(state, socket, loop.done), "foreach-empty");
  enforceSocketVisitLimit(state, socket, config);
  const attempt = startTaskAttempt(state, socket.id);

  state.phase = socket.id;
  setCurrentSocketId(state, socket.id);
  state.currentMateria = socketMateriaName(socket);
  state.currentMateriaModel = undefined;
  state.awaitingResponse = isAgentResolvedSocket(socket);
  setCurrentSocketState(state, isAgentResolvedSocket(socket) ? "awaiting_agent_response" : "running_utility");
  state.multiTurnFinalizing = false;
  state.updatedAt = Date.now();
  state.runState.currentSocketId = socket.id;
  state.runState.currentMateria = socketMateriaName(socket);
  state.runState.currentMateriaModel = undefined;
  state.runState.currentTask = state.currentItemLabel;
  state.runState.attempt = attempt;
  state.runState.lastMessage = socket.id;
  await writeUsage(state.runState);
  await appendEvent(state.runState, "socket_start", { socket: socket.id, materia: socketMateriaName(socket), materiaLabel: resolvedMateriaDisplayName(socket), itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), visit: socketVisit(state, socket.id) });
  saveCastState(pi, state);
  updateWidget(ctx, state);
  ctx.ui.setStatus("materia", materiaStatusLabel(state, socket));
  await appendAdvancementDiagnostic(ctx, state, "next_socket_start_exit", nextDiagnostics, { boundary: "sync_state_advancement", targetSocketId: socket.id, targetMateriaName: socketMateriaName(socket), agentSocket: isAgentResolvedSocket(socket) });

  if (!isAgentResolvedSocket(socket)) {
    state.awaitingResponse = false;
    setCurrentSocketState(state, "running_utility");
    state.currentMateria = socketMateriaName(socket);
    state.currentMateriaModel = undefined;
    state.runState.currentMateria = socketMateriaName(socket);
    state.runState.currentMateriaModel = undefined;
    saveCastState(pi, state);
    try {
      const result = await executeUtilitySocket(state, socket);
      await completeSocket(pi, ctx, state, result.output, result.entryId);
    } catch (error) {
      await failCast(pi, ctx, state, error, `utility:${socket.id}:${socketVisit(state, socket.id)}`);
    }
    return;
  }

  state.awaitingResponse = true;
  setCurrentSocketState(state, "awaiting_agent_response");
  saveCastState(pi, state);
  const appliedModel = await applyMateriaModelSettings(pi, ctx, { materiaName: resolvedSocketConfig(socket).materia, model: socket.materia.model, thinking: socket.materia.thinking });
  const materiaModel = materiaModelSelection(appliedModel);
  state.currentMateriaModel = materiaModel;
  state.runState.currentMateriaModel = materiaModel;
  recordUsageModelSelection(state.runState.usage, { socket: socket.id, materia: resolvedSocketConfig(socket).materia, taskId: state.currentItemKey, attempt: state.runState.attempt, materiaModel });
  await writeUsage(state.runState);
  await appendEvent(state.runState, "materia_model_settings", { socket: socket.id, materia: resolvedSocketConfig(socket).materia, visit: socketVisit(state, socket.id), itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), materiaModel });
  saveCastState(pi, state);
  await updateSocketToolScope(pi, ctx, state, socket);
  await appendAdvancementDiagnostic(ctx, state, "dispatch_scheduling", nextDiagnostics, { boundary: "async_prompt_dispatch_attempt", targetSocketId: socket.id, targetMateriaName: socketMateriaName(socket), dispatchTriggerMode: nextDiagnostics?.dispatchTriggerMode ?? "immediate-triggerTurn" });
  const dispatch = () => sendMateriaTurn(pi, ctx, state, buildSocketPrompt(state, socket), { diagnostics: nextDiagnostics });
  if (nextDiagnostics?.dispatchTriggerMode === "deferred-triggerTurn") {
    scheduleDeferredPromptDispatch(pi, ctx, state, socket, dispatch, nextDiagnostics);
    return;
  }
  await dispatch();
}

function scheduleDeferredPromptDispatch(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, socket: ResolvedMateriaSocket, dispatch: () => Promise<void>, diagnostics?: AdvancementLifecycleDiagnostics): void {
  setTimeout(() => {
    void (async () => {
      try {
        await appendAdvancementDiagnostic(ctx, state, "deferred_dispatch_execution", diagnostics, { boundary: "deferred_prompt_dispatch", targetSocketId: socket.id, targetMateriaName: socketMateriaName(socket) });
        await dispatch();
      } catch (error) {
        const message = `Deferred pi-materia prompt dispatch failed for socket "${socket.id}": ${errorMessage(error)}`;
        console.error(message, error);
        try {
          await appendEvent(state.runState, "deferred_dispatch_failure", { error: errorMessage(error), socket: socket.id, materia: socketMateriaName(socket), castId: state.castId, diagnostic: true });
          await failCast(pi, ctx, state, new Error(message), `deferred-dispatch:${socket.id}`);
        } catch (failError) {
          console.error(`Failed to persist deferred dispatch failure for socket "${socket.id}": ${errorMessage(failError)}`, failError);
          ctx.ui.notify(message, "error");
        }
      }
    })();
  }, 0);
}

async function executeUtilitySocket(state: MateriaCastState, socket: ResolvedMateriaUtilitySocket): Promise<{ output: string; entryId: string }> {
  return executeUtilitySocketWithDeps(state, socket, {
    executeCommand: executeCommandUtility,
    executeBuiltInUtility,
    hasBuiltInUtility,
    recordUtilityInput: (input) => recordUtilityInputFile({ state, socketId: socket.id, materia: socketMateriaName(socket), materiaLabel: resolvedMateriaDisplayName(socket), visit: socketVisit(state, socket.id), input }),
    appendUtilityInputEvent: (artifact, visit) => appendEvent(state.runState, "utility_input", { socket: socket.id, materia: socketMateriaName(socket), materiaLabel: resolvedMateriaDisplayName(socket), artifact, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), visit }),
  });
}

async function preserveAwaitingAfterTransientTransportFailure(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, error: unknown, options: { entryId?: string } = {}): Promise<void> {
  state.active = true;
  state.awaitingResponse = true;
  setCurrentSocketState(state, "awaiting_agent_response");
  state.updatedAt = Date.now();
  state.runState.lastMessage = `Transient transport failure while awaiting ${recoveryDiagnosticLabel(state)}; preserving active Pi turn: ${errorMessage(error)}`;
  await appendEvent(state.runState, "transient_transport_turn_failure", { warning: true, error: errorMessage(error), entryId: options.entryId, socket: currentSocketId(state), itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), mode: recoveryTurnMode(state) });
  await writeUsage(state.runState);
  saveCastState(pi, state);
  updateWidget(ctx, state);
  ctx.ui.notify(`pi-materia warning: ${state.runState.lastMessage}`, "warning");
}

function shouldRetryGenericTurnFailure(error: unknown): boolean {
  const message = errorMessage(error);
  return /\b(?:auth|invalid[_ -]?request|provider rejected|different provider failure)\b/i.test(message);
}

async function handleSameSocketRecoverableTurnFailure(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, error: unknown, options: { entryId?: string; allowGenericTurnFailure?: boolean } = {}): Promise<boolean> {
  return handleSameSocketRecoverableTurnFailureWorkflow(state, error, {
    appendEvent,
    writeUsage,
    saveState: (nextState) => saveCastState(pi, nextState),
    failCast: (nextState, nextError, entryId, failOptions) => failCast(pi, ctx, nextState, nextError, entryId, failOptions),
    updateToolScope: async (materia) => {
      const emittedWarnings: ToolScopeRuntimeWarning[] = [];
      updateToolScope(pi, materia, { context: { socket: currentSocketId(state), materia: state.currentMateria, itemKey: state.currentItemKey, visit: currentSocketVisit(state, undefined) }, onWarning: (warning) => { emittedWarnings.push(warning); } });
      for (const warning of emittedWarnings) {
        await appendToolScopeWarningEvent(state, warning);
        ctx.ui.notify(warning.message, "warning");
      }
    },
    sendMateriaTurn: (nextState, prompt, turnOptions) => sendMateriaTurn(pi, ctx, nextState, prompt, turnOptions),
    buildRecoveryPrompt: buildSameSocketRecoveryPrompt,
    updateWidget: (nextState) => updateWidget(ctx, nextState),
    notifyWarning: (message) => ctx.ui.notify(message, "warning"),
    setCurrentSocketState,
    currentSocketId,
    currentSocketVisit,
    shortMetadataLabel,
    currentMateria,
    runRecoveryAction: (nextState, actionOptions) => runSameSocketRecoveryAction(pi, ctx, nextState, actionOptions),
  }, options);
}

async function runSameSocketRecoveryAction(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, options: SameSocketRecoveryActionOptions): Promise<void> {
  return runSameSocketRecoveryActionWorkflow(state, options, {
    appendEvent,
    saveState: (nextState) => saveCastState(pi, nextState),
    runCompaction: (nextState) => runSameSocketRecoveryCompaction(ctx, nextState),
    currentSocketId,
  });
}

async function maybeRunProactiveCompaction(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState): Promise<void> {
  // This is a pre-turn transcript snapshot from Pi core. It does not include
  // request material added later in this turn: the hidden Materia prompt,
  // synthetic isolated cast context, before_agent_start system-prompt suffix,
  // active-turn tool results retained by context isolation, or provider-specific
  // tokenization overhead. Keep docs/materia-compaction-budgeting.md in sync
  // when changing this decision point.
  await maybeRunProactiveCompactionWorkflow(ctx, state, {
    loadConfigFromState,
    appendEvent,
    writeUsage,
    saveState: (nextState) => saveCastState(pi, nextState),
    notifyWarning: (message) => ctx.ui.notify(message, "warning"),
    currentSocketId,
    currentSocketVisit,
    shortMetadataLabel,
  });
}

function buildSameSocketRecoveryPrompt(state: MateriaCastState): string {
  if (state.activeTurnPrompt) return state.activeTurnPrompt;
  const socket = currentSocketOrThrow(state);
  if (recoveryTurnMode(state) === "finalization") return buildMultiTurnFinalizationPrompt(state, socket);
  return buildSocketPrompt(state, socket);
}

async function failCast(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, error: unknown, entryId?: string, options: { preserveRecoveryExhaustion?: boolean } = {}): Promise<void> {
  if (!options.preserveRecoveryExhaustion) state.recoveryExhaustion = undefined;
  state.active = false;
  state.awaitingResponse = false;
  state.multiTurnFinalizing = false;
  setCurrentSocketState(state, "failed");
  state.phase = "failed";
  state.failedReason = error instanceof Error ? error.message : String(error);
  state.runState.lastMessage = state.failedReason;
  markRunEnded(state);
  await appendEvent(state.runState, "cast_end", { ok: false, error: state.failedReason, entryId, socket: currentSocketId(state) });
  await writeUsage(state.runState);
  await appendManifest(state, { phase: "failed", socket: currentSocketId(state), materia: state.currentMateria, itemKey: state.currentItemKey, entryId });
  saveCastState(pi, state);
  ctx.ui.setStatus("materia", "failed");
  updateWidget(ctx, state);
  ctx.ui.notify(`pi-materia cast failed: ${state.failedReason}`, "error");
}

function markRunEnded(state: MateriaCastState): void {
  state.runState.endedAt ??= Date.now();
}

function enforceSocketVisitLimit(state: MateriaCastState, socket: ResolvedMateriaSocket, config: PiMateriaConfig): void {
  const count = (state.visits[socket.id] ?? 0) + 1;
  const limit = resolvedSocketConfig(socket).limits?.maxVisits ?? config.limits?.maxSocketVisits ?? DEFAULT_MAX_SOCKET_VISITS;
  if (count > limit) throw new Error(`Materia socket visit limit exceeded for ${socket.id} (${count}/${limit}).`);
  state.visits[socket.id] = count;
}

async function finishCast(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, entryId: string, message: string): Promise<void> {
  state.active = false;
  state.phase = "complete";
  state.awaitingResponse = false;
  state.multiTurnFinalizing = false;
  setCurrentSocketState(state, "complete");
  state.recoveryExhaustion = undefined;
  state.updatedAt = Date.now();
  state.runState.lastMessage = message;
  markRunEnded(state);
  await writeUsage(state.runState);
  await appendEvent(state.runState, "cast_end", { ok: true, usage: state.runState.usage, entryId });
  await appendManifest(state, { phase: "complete", entryId });
  saveCastState(pi, state);
  ctx.ui.setStatus("materia", "done");
  updateWidget(ctx, state);
  showUsageSummary(ctx, state.runState);
  ctx.ui.notify(`pi-materia cast complete. ${formatUsage(state.runState.usage, state.runState.usage.costKind)}`, "info");
}

async function sendMateriaTurn(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, prompt: string, options: { skipProactiveCompaction?: boolean; diagnostics?: AdvancementLifecycleDiagnostics } = {}): Promise<void> {
  const diagnostics = options.diagnostics ? { ...options.diagnostics, dispatchTriggerMode: options.diagnostics.dispatchTriggerMode ?? "immediate-triggerTurn" } : undefined;
  await appendAdvancementDiagnostic(ctx, state, "dispatch_execution_entry", diagnostics, { boundary: "async_prompt_dispatch_attempt", promptLength: prompt.length });
  state.activeTurnPrompt = prompt;
  saveCastState(pi, state);
  if (!options.skipProactiveCompaction) await maybeRunProactiveCompaction(pi, ctx, state);
  const contextArtifact = await writeContextArtifact(pi, state, prompt);
  await appendManifest(state, { phase: state.phase, socket: currentSocketId(state), materia: state.currentMateria, itemKey: state.currentItemKey, visit: currentSocketVisit(state, undefined), artifact: contextArtifact, kind: "context", materiaModel: state.currentMateriaModel });

  const notificationMateria = resolvedMateriaDisplayName(activeResolvedSocket(state)) ?? state.currentMateria;
  const display = formatMateriaNotificationDisplay(notificationMateria, currentSocketId(state));
  pi.sendMessage({
    customType: "pi-materia",
    content: formatMateriaCastContent(notificationMateria, currentSocketId(state), state.currentItemLabel),
    display: true,
    details: { prefix: "materia", socketId: currentSocketId(state), materiaName: display.materiaName, socketOrdinal: display.socketOrdinal, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, eventType: "materia_prompt", materiaModel: state.currentMateriaModel },
  });

  pi.appendEntry("pi-materia-context", { phase: state.phase, socketId: currentSocketId(state), materiaName: state.currentMateria, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), artifact: contextArtifact, materiaModel: state.currentMateriaModel });
  pi.sendMessage({
    customType: "pi-materia-prompt",
    content: prompt,
    display: false,
    details: { phase: state.phase, socketId: currentSocketId(state), materiaName: state.currentMateria, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, materiaModel: state.currentMateriaModel },
  }, { triggerTurn: true });
  await appendAdvancementDiagnostic(ctx, state, "dispatch_execution_exit", diagnostics, { boundary: "async_prompt_dispatch_attempt", dispatchTriggerMode: "immediate-triggerTurn" });
}

export async function prepareAgentStartSystemPrompt(input: { pi: ExtensionAPI; session: ExtensionContext; state: MateriaCastState; systemPrompt: string }): Promise<string | undefined> {
  const { pi, session: ctx, state, systemPrompt } = input;
  if (currentSocketState(state) === "awaiting_user_refinement") await prepareMultiTurnRefinementTurn(pi, ctx, state);
  if (!state.awaitingResponse) return undefined;
  const materia = currentMateria(state);
  if (!materia) return undefined;
  return `${systemPrompt}\n\nMateria active materia (${currentSocketId(state) ?? state.phase}):\n${activeMateriaSystemPrompt(state, materia)}`;
}

export async function prepareMultiTurnRefinementTurn(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState): Promise<void> {
  if (!isPausedMultiTurnRefinement(state)) return;
  const socket = currentSocketOrThrow(state);
  if (!isAgentResolvedSocket(socket)) return;

  const appliedModel = await applyMateriaModelSettings(pi, ctx, { materiaName: resolvedSocketConfig(socket).materia, model: socket.materia.model, thinking: socket.materia.thinking });
  const materiaModel = materiaModelSelection(appliedModel);
  state.currentMateria = socketMateriaName(socket);
  state.currentMateriaModel = materiaModel;
  state.runState.currentMateria = socketMateriaName(socket);
  state.runState.currentMateriaModel = materiaModel;
  state.awaitingResponse = true;
  setCurrentSocketState(state, "awaiting_agent_response");
  state.multiTurnFinalizing = false;
  state.activeTurnPrompt = materiaPrompt(socket.materia, state, [buildSyntheticCastContext(state), multiTurnRefinementGuidance()]);
  state.updatedAt = Date.now();
  const refinementTurn = currentRefinementTurn(state, socket.id) + 1;
  recordUsageModelSelection(state.runState.usage, { socket: socket.id, materia: resolvedSocketConfig(socket).materia, taskId: state.currentItemKey, attempt: state.runState.attempt, materiaModel });
  await writeUsage(state.runState);
  await appendEvent(state.runState, "materia_model_settings", { socket: socket.id, materia: resolvedSocketConfig(socket).materia, visit: socketVisit(state, socket.id), itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), materiaModel, refinementTurn });
  const contextArtifact = await writeContextArtifact(pi, state, buildSyntheticCastContext(state), `refinement-${refinementTurn}-${safeTimestamp()}`);
  await appendManifest(state, { phase: state.phase, socket: currentSocketId(state), materia: state.currentMateria, itemKey: state.currentItemKey, visit: socketVisit(state, socket.id), artifact: contextArtifact, kind: "context_refinement", refinementTurn, materiaModel: state.currentMateriaModel });
  await appendEvent(state.runState, "context_refinement", { socket: socket.id, materia: socketMateriaName(socket), artifact: contextArtifact, refinementTurn, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), materiaModel });
  await updateSocketToolScope(pi, ctx, state, socket);
  saveCastState(pi, state);
  ctx.ui.setStatus("materia", materiaStatusLabel(state, socket));
  updateWidget(ctx, state);
}

export const nativeTestInternals = {
  applyAdvance,
  applyAssignments,
  applyGenericHandoffEnvelope,
  evaluateCondition,
  renderTemplate,
  resolveValue,
  selectNextTarget,
  resolveEmptyLoopExhaustionTarget,
  setCurrentItem,
  setPath,
};


