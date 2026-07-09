import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { safeTimestamp } from "../utilities/artifacts.js";
import { resolveArtifactRoot } from "../config/config.js";
import { getEffectivePipelineConfig, loopIteratorForSocket } from "./pipeline.js";
import { getResolvedPipelineSocket } from "../loadout/loadoutAccessors.js";
import { parseSocketJson } from "../utilities/json.js";
import { applyGenericHandoffEnvelope } from "../application/handoff.js";
import { flushBusOutcomes } from "./eventBus.js";
import { activeMateriaSystemPrompt, buildMultiTurnFinalizationPrompt, buildSyntheticCastContext, isPausedMultiTurnRefinement, materiaPrompt, multiTurnRefinementGuidance, renderTemplate } from "../application/promptAssembly.js";
import type { CastStartOptions } from "../application/ports.js";
export { activeMateriaSystemPrompt, buildIsolatedMateriaContext } from "../application/promptAssembly.js";
export { currentMateria, materiaStatusLabel } from "./sessionState.js";
export { classifyTurnFailure, extendEdgeTraversalAllowanceForRevive, extendSameSocketRecoveryAllowanceForRevive } from "../application/recoveryPolicy.js";
import { captureReworkFeedbackForRoute } from "../application/reworkFeedback.js";
import { applyAdvance, applyAssignments, currentItem, enforceEdgeLimit, evaluateCondition, getPath, MateriaEdgeTraversalExhaustionError, resolveEmptyLoopExhaustionTarget, resolveValue, selectNextEdge, selectNextTarget, setCurrentItem, setPath } from "../application/workflowTransitions.js";
import { executeUtilitySocketWithDeps } from "../application/utilityExecution.js";
import { classifyTurnFailure, errorMessage, extendEdgeTraversalAllowanceForRevive, extendSameSocketRecoveryAllowanceForRevive, nonRecoverableTurnError } from "../application/recoveryPolicy.js";
import { handoffValidationIssues, validateHandoffJsonOutput } from "../handoff/handoffValidation.js";
import { canonicalGeneratorConfigFor } from "../graph/generator.js";
import { applyMateriaModelSettings } from "../config/modelSettings.js";
import { resolveActiveModelPolicy } from "./modelPolicyResolver.js";
import { formatMateriaNotificationDisplay } from "../presentation/notificationFormatting.js";
import { buildMateriaTextOutputMessage } from "../presentation/textOutput.js";
import type { LoadedConfig, MateriaCastState, PiMateriaConfig, ResolvedMateriaSocket, ResolvedMateriaPipeline, ResolvedMateriaUtilitySocket } from "../types.js";
import { formatUsage, showUsageSummary, updateWidget } from "../presentation/ui.js";
import { createRunState, recordUsageModelSelection } from "../telemetry/usage.js";
import { executeBuiltInUtility, hasBuiltInUtility } from "../utilities/utilityRegistry.js";
import { appendEvent, appendManifest, initializeRun, recordSocketParsedJson, recordUtilityInput as recordUtilityInputFile, shortMetadataLabel } from "../infrastructure/castArtifacts.js";
import { clearCastState, listLatestCastStates, listResumableCastStates, listRevivableCastStates, loadActiveCastState, loadCastStateById, saveCastState } from "../infrastructure/castStateRepository.js";
import { assertBudget, writeUsage } from "../infrastructure/castUsage.js";
import { executeCommandUtility } from "../infrastructure/utilityCommandExecutor.js";
import { castLoadoutIdentity, hashConfig, loadConfigFromState, resolvePersistedCastLoadoutIdentity } from "./configPersistence.js";
import { materiaModelSelection } from "./modelSelection.js";
import { recordMultiTurnRefinement, recordSocketOutput, writeContextArtifact } from "./artifactRecording.js";
import { assistantErrorMessage, assistantText, agentEndFailureMessage, captureUsage, findLatestAssistantEntry, describeStaleCompletion, recordActiveTurnProvenance, updateToolScope, type StaleCompletionReason } from "./agentTurnState.js";
import { activeResolvedSocket, currentMateria, currentRefinementTurn, currentSocketId, currentSocketOrThrow, currentSocketState, currentSocketVisit, isAgentResolvedSocket, isMultiTurnResolvedAgentSocket, materiaStatusLabel, nextRefinementTurn, resolvedSocketConfig, setCurrentSocketId, setCurrentSocketState, socketMateriaName, socketVisit, startTaskAttempt } from "./sessionState.js";
import { effectiveResolvedSocketConfig, resolvedMateriaDisplayName, resolvedMateriaId } from "./resolvedMateria.js";
import { nativeEventing } from "./nativeEventing.js";
import { createCastTermination } from "./castTermination.js";
import { createTurnRecovery } from "./turnRecovery.js";
import { createSocketEventProcessing } from "./socketEventProcessing.js";
import { createAgentPromptDispatch, type AdvancementLifecycleDiagnostics } from "./agentPromptDispatch.js";
import {
  buildPipelineSocketDetails,
  findMultiTurnAgentSockets,
  isAgentControllerPresetActive,
  validateAgentControllerMultiTurnSockets,
} from "./agentControllerCompatibility.js";
export {
  buildPipelineSocketDetails,
  findMultiTurnAgentSockets,
  isAgentControllerPresetActive,
  validateAgentControllerMultiTurnSockets,
} from "./agentControllerCompatibility.js";
export type { AgentControllerValidationResult, PipelineSocketDetail } from "./agentControllerCompatibility.js";
export { clearCastState, listLatestCastStates, listResumableCastStates, listRevivableCastStates, loadActiveCastState, loadCastStateById, saveCastState } from "../infrastructure/castStateRepository.js";


const DEFAULT_MAX_SOCKET_VISITS = 25;
export { defaultProactiveCompactionThresholdPercent } from "./compaction.js";

const emitLifecycleEvent = nativeEventing.emitLifecycleEvent.bind(nativeEventing);
const getEventBus = nativeEventing.getEventBus.bind(nativeEventing);
const getResultAccumulator = nativeEventing.getResultAccumulator.bind(nativeEventing);
const initializeCastEventBus = nativeEventing.initializeCastEventBus.bind(nativeEventing);
const removeEventBus = nativeEventing.removeEventBus.bind(nativeEventing);
const startHeartbeat = nativeEventing.startHeartbeat.bind(nativeEventing);
const stopHeartbeat = nativeEventing.stopHeartbeat.bind(nativeEventing);

const castTermination = createCastTermination({
  eventing: {
    stopHeartbeat,
    emitLifecycleEvent,
    getEventBus,
    getResultAccumulator,
    flushBusOutcomes,
    removeEventBus,
  },
  artifacts: {
    appendEvent,
    appendManifest,
    writeUsage,
  },
  state: {
    clearCastState,
    saveCastState,
    currentSocketId,
    setCurrentSocketState,
  },
  ui: {
    updateWidget,
    showUsageSummary,
    formatUsage,
  },
});
const { failCastAtStart, failCast, finishCast } = castTermination;

const agentPromptDispatch = createAgentPromptDispatch({
  artifacts: {
    appendEvent,
    appendManifest,
    writeContextArtifact,
    writeUsage,
  },
  state: {
    loadActiveCastState,
    loadConfigFromState,
    saveCastState,
    recordActiveTurnProvenance,
    shortMetadataLabel,
  },
  tools: {
    updateToolScope,
  },
  lifecycle: {
    emitLifecycleEvent,
    failCast,
  },
});
const {
  agentEndAdvancementDiagnostics,
  appendAdvancementDiagnostic,
  castStartInitialPromptDiagnostics,
  dispatchSocketPrompt,
  sendMateriaTurn,
  updateSocketToolScope,
} = agentPromptDispatch;

const turnRecovery = createTurnRecovery({
  artifacts: {
    appendEvent,
    writeUsage,
  },
  state: {
    saveCastState,
    setCurrentSocketState,
    currentSocketId,
    currentSocketVisit,
    currentSocketOrThrow,
    currentMateria,
    shortMetadataLabel,
    loadConfigFromState,
  },
  lifecycle: {
    emitLifecycleEvent,
    failCast,
    sendMateriaTurn,
  },
  tools: {
    updateToolScope,
  },
  ui: {
    updateWidget,
    notifyWarning: (ctx, message) => ctx.ui.notify(message, "warning"),
  },
});
const {
  preserveAwaitingAfterTransientTransportFailure,
  handleSameSocketRecoverableTurnFailure,
  buildJsonOutputRepairContext,
  classifyJsonOutputValidationKind,
  shouldRetryGenericTurnFailure,
} = turnRecovery;

const { processSocketEvents } = createSocketEventProcessing({
  eventing: nativeEventing,
  repair: { buildJsonOutputRepairContext },
});

/**
 * Cancel a running cast, emitting `lifecycle.cast.cancelled` through
 * the event bus before clearing the cast state.
 *
 * This is the abort/cancel handler called when a user explicitly
 * aborts a cast or a quest runner cancels it. The event bus is
 * flushed and cleaned up before the cast state is cleared.
 *
 * Returns the cleared state for caller convenience.
 */
export async function cancelNativeCast(
  pi: ExtensionAPI,
  state: MateriaCastState,
  reason = "aborted by user",
): Promise<MateriaCastState> {
  return castTermination.cancelNativeCast(pi, state, reason);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function startNativeCast(pi: ExtensionAPI, ctx: ExtensionContext, loaded: LoadedConfig, pipeline: ResolvedMateriaPipeline, request: string, options?: CastStartOptions): Promise<MateriaCastState> {
  const config = loaded.config;
  const artifactRoot = resolveArtifactRoot(ctx.cwd, config.artifactDir);
  const castId = safeTimestamp();
  const runDir = path.join(artifactRoot, castId);

  const effectivePipeline = getEffectivePipelineConfig(config);
  const loadoutIdentity = castLoadoutIdentity(config, effectivePipeline.pipeline, effectivePipeline.loadoutName);
  const runState = createRunState(castId, runDir, ctx.model, loadoutIdentity);
  runState.currentSocketId = pipeline.entry.id;
  runState.currentMateria = socketMateriaName(pipeline.entry);
  runState.lastMessage = pipeline.entry.id;
  await initializeRun(runDir, config, { castId, request, configSource: loaded.source, sessionFile: ctx.sessionManager.getSessionFile(), entries: [] });
  await writeUsage(runState);
  // Enrich cast_start artifact with resolved per-socket materia names and
  // multiTurn flags so future misconfigurations are diagnosable at a glance.
  const socketDetails = buildPipelineSocketDetails(pipeline);
  await appendEvent(runState, "cast_start", { request, configSource: loaded.source, artifactRoot, pipeline: effectivePipeline.pipeline, loadout: effectivePipeline.loadoutName, ...(loadoutIdentity.loadoutId ? { loadoutId: loadoutIdentity.loadoutId } : {}), nativeSession: true, isolatedMateriaContext: true, socketDetails, ...(options?.startEventDetails ?? {}) });

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

  // Initialize the event bus if eventing is enabled.
  const eventBus = initializeCastEventBus(config, state);

  // Start heartbeat only when eventing is enabled and the bus is registered.
  // (docs/runtime-eventing.md §7.3: heartbeat is opt-in, default off).
  if (eventBus) {
    startHeartbeat(state, config);
  }

  // Fail-fast: agent-controller eventing preset + multiTurn agent sockets
  // is a guaranteed stall (controller never sends /materia continue).
  const validation = validateAgentControllerMultiTurnSockets(config, pipeline);
  if (!validation.ok) {
    await failCastAtStart(pi, ctx, state, eventBus, {
      errorMessage: validation.errorMessage,
      entryId: pipeline.entry.id,
      entryMateria: socketMateriaName(pipeline.entry),
      lifecyclePayload: {
        error: validation.errorMessage,
        reason: "multiTurn_agent_socket_under_agent_controller",
        offendingSockets: validation.offendingSockets,
        socketDetails,
      },
    });
    return state;
  }

  // Emit lifecycle.cast.started through the event bus (no-op if eventing disabled).
  await emitLifecycleEvent(state, "lifecycle.cast.started", {
    severity: "info",
    message: request.slice(0, 200),
    payload: {
      request,
      ...(loadoutIdentity.loadoutId ? { loadoutId: loadoutIdentity.loadoutId } : {}),
      loadoutName: effectivePipeline.loadoutName,
      pipeline: effectivePipeline.pipeline,
      socketDetails,
    },
  });

  pi.setSessionName(`materia: ${request.slice(0, 60)}`);
  saveCastState(pi, state);
  updateWidget(ctx, state, { replaceOwner: true });
  ctx.ui.notify(`pi-materia cast started. Artifacts: ${runDir}`, "info");
  await startSocket(pi, ctx, state, pipeline.entry, castStartInitialPromptDiagnostics(state, pipeline.entry, options));
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

  const exhaustion = state.recoveryExhaustion;
  if (!exhaustion) {
    throw new Error(`pi-materia cast ${state.castId} is not revivable: missing structured exhaustion metadata. Use /materia recast instead.`);
  }

  if (exhaustion.kind === "edge_traversal_exhausted") {
    const result = extendEdgeTraversalAllowanceForRevive(state);
    await appendEvent(state.runState, "cast_revive", {
      castId: state.castId,
      exhaustedRecoveryKey: result.key,
      traversalContext: {
        from: exhaustion.from,
        to: exhaustion.to,
        key: result.key,
        count: exhaustion.count,
        itemKey: state.currentItemKey,
      },
      priorEffectiveLimit: result.priorEffectiveLimit,
      increment: result.increment,
      newEffectiveLimit: result.newEffectiveLimit,
      reviveCount: result.reviveCount,
    });

    // Clear failure markers and advance directly to the blocked target socket
    // instead of resending the completed source socket prompt.
    state.recoveryExhaustion = undefined;
    state.active = true;
    state.failedReason = undefined;
    state.runState.endedAt = undefined;
    const persistedLoadoutIdentity = await resolvePersistedCastLoadoutIdentity(state);
    state.runState.loadoutId ||= persistedLoadoutIdentity?.loadoutId;
    state.runState.loadoutName ||= persistedLoadoutIdentity?.loadoutName;
    state.runState.lastMessage = `Reviving cast ${state.castId} to blocked target ${exhaustion.to}.`;
    await writeUsage(state.runState);
    saveCastState(pi, state);

    const targetSocket = getResolvedPipelineSocket(state.pipeline, exhaustion.to);
    if (!targetSocket) throw new Error(`Revive target socket "${exhaustion.to}" is not in the pipeline.`);
    await startSocket(pi, ctx, state, targetSocket);
    ctx.ui.notify(`pi-materia cast ${state.castId} revived to blocked target socket "${exhaustion.to}".`, "info");
    return state;
  }

  // same_socket_recovery_exhausted
  const result = extendSameSocketRecoveryAllowanceForRevive(state);
  const sameSocketExhaustion = exhaustion as { kind: "same_socket_recovery_exhausted"; socket?: string; mode?: string };
  await appendEvent(state.runState, "cast_revive", {
    castId: state.castId,
    exhaustedRecoveryKey: result.key,
    recoveryContext: {
      key: result.key,
      socket: sameSocketExhaustion.socket ?? currentSocketId(state),
      mode: sameSocketExhaustion.mode,
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
  const persistedLoadoutIdentity = await resolvePersistedCastLoadoutIdentity(state);
  state.runState.loadoutId ||= persistedLoadoutIdentity?.loadoutId;
  state.runState.loadoutName ||= persistedLoadoutIdentity?.loadoutName;
  state.runState.currentSocketId = socket.id;
  state.runState.currentMateria = socketMateriaName(socket);
  state.runState.lastMessage = `Recasting from socket ${socket.id}.`;
  await appendEvent(state.runState, "cast_recast", { socket: socket.id, materia: socketMateriaName(socket), previousFailure, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), visit: socketVisit(state, socket.id), reusedActivePrompt: isAgentResolvedSocket(socket) && Boolean(state.activeTurnPrompt) });
  await writeUsage(state.runState);

  // Re-initialize the event bus for the resumed/revived cast.
  // The previous bus was cleaned up by failCast, but the castId is the same.
  // Restart heartbeat when eventing is enabled (docs/runtime-eventing.md §7.3).
  try {
    const config = await loadConfigFromState(state);
    const eventBus = initializeCastEventBus(config, state);
    if (eventBus) {
      startHeartbeat(state, config);
    }
  } catch {
    // Config load or bus init failure is non-fatal for recast.
  }

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
  const appliedModel = await applyMateriaModelSettings(pi, ctx, { materiaName: resolvedSocketConfig(socket).materia, model: socket.materia.model, thinking: socket.materia.thinking, policy: await resolveActiveModelPolicy(pi, ctx) });
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
  await sendMateriaTurn(pi, ctx, state, buildMultiTurnFinalizationPrompt(state, socket), { skipProactiveCompaction: appliedModel.modelSwitched });
}

/**
 * Record a diagnostic event (and lifecycle event) for an agent_end callback
 * whose latest assistant entry was ignored because it did not belong to the
 * turn currently awaiting a response. Does not mutate cast state.
 */
async function recordIgnoredStaleCompletion(state: MateriaCastState, reason: StaleCompletionReason): Promise<void> {
  await appendEvent(state.runState, "stale_agent_end_ignored", {
    diagnostic: true,
    castId: state.castId,
    reason: reason.reason,
    latestEntryId: reason.latestEntryId,
    activeTurnSocketId: reason.activeTurnSocketId,
    activeTurnVisit: reason.activeTurnVisit,
    ...(reason.activeTurnMateria !== undefined ? { activeTurnMateria: reason.activeTurnMateria } : {}),
    ...(reason.activeTurnBoundaryEntryId !== undefined ? { activeTurnBoundaryEntryId: reason.activeTurnBoundaryEntryId } : {}),
    ...(reason.currentSocketId !== undefined ? { currentSocketId: reason.currentSocketId } : {}),
    currentMateria: state.currentMateria,
    currentSocketId: currentSocketId(state),
    visit: currentSocketVisit(state, undefined),
  });
  await emitLifecycleEvent(state, "lifecycle.socket.stale_completion_ignored", {
    severity: "warning",
    socketId: reason.currentSocketId,
    materia: state.currentMateria,
    ...(state.currentItemKey !== undefined ? { itemKey: state.currentItemKey } : {}),
    ...(state.currentItemLabel !== undefined ? { itemLabel: state.currentItemLabel } : {}),
    payload: {
      reason: reason.reason,
      latestEntryId: reason.latestEntryId,
      activeTurnSocketId: reason.activeTurnSocketId,
      activeTurnVisit: reason.activeTurnVisit,
      ...(reason.activeTurnBoundaryEntryId !== undefined ? { activeTurnBoundaryEntryId: reason.activeTurnBoundaryEntryId } : {}),
      ...(reason.currentSocketId !== undefined ? { currentSocketId: reason.currentSocketId } : {}),
    },
  });
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
    if (!recovered) {
      // Emit lifecycle.socket.failed before the cast-level failure event.
      await emitLifecycleEvent(state, "lifecycle.socket.failed", {
        severity: "error",
        socketId: currentSocketId(state),
        materia: state.currentMateria,
        visit: currentSocketVisit(state, undefined),
        ...(state.currentItemKey !== undefined ? { itemKey: state.currentItemKey } : {}),
        ...(state.currentItemLabel !== undefined ? { itemLabel: state.currentItemLabel } : {}),
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
      await failCast(pi, ctx, state, error);
    }
    return;
  }

  // Active-turn provenance: ignore duplicate or stale agent_end callbacks whose
  // latest assistant entry does not belong to the turn currently awaiting a
  // response (e.g. a duplicate source-socket agent_end arriving after routing
  // has advanced to the target socket). Record a diagnostic and leave the
  // active turn awaiting its own response; do not advance lastProcessedEntryId.
  const staleCompletion = describeStaleCompletion(state, latest.entry.id);
  if (staleCompletion) {
    await recordIgnoredStaleCompletion(state, staleCompletion);
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
    if (!recovered) {
      // Emit lifecycle.socket.failed before the cast-level failure event.
      await emitLifecycleEvent(state, "lifecycle.socket.failed", {
        severity: "error",
        socketId: currentSocketId(state),
        materia: state.currentMateria,
        visit: currentSocketVisit(state, undefined),
        ...(state.currentItemKey !== undefined ? { itemKey: state.currentItemKey } : {}),
        ...(state.currentItemLabel !== undefined ? { itemLabel: state.currentItemLabel } : {}),
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
      await failCast(pi, ctx, state, error, latest.entry.id);
    }
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
        const diagnostics = agentEndAdvancementDiagnostics(state, socket, { finalizedMultiTurn: true });
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

      // Emit lifecycle.refinement.waiting through the event bus.
      await emitLifecycleEvent(state, "lifecycle.refinement.waiting", {
        severity: "info",
        socketId: socket.id,
        materia: resolvedMateriaId(socket) ?? socket.id,
        materiaLabel: resolvedMateriaDisplayName(socket),
        visit: socketVisit(state, socket.id),
        ...(state.currentItemKey !== undefined ? { itemKey: state.currentItemKey } : {}),
        ...(state.currentItemLabel !== undefined ? { itemLabel: state.currentItemLabel } : {}),
        payload: { refinementTurn: refinement.turn },
      });

      saveCastState(pi, state);
      ctx.ui.setStatus("materia", materiaStatusLabel(state, socket, { suffix: "refine", includeItem: false }));
      updateWidget(ctx, state);
      ctx.ui.notify(`pi-materia multi-turn socket "${socket.id}" is waiting for refinement; run /materia continue to finalize.`, "info");
      return;
    }
    await completeSocket(pi, ctx, state, text, latest.entry.id, { diagnostics: agentEndAdvancementDiagnostics(state, socket) });
  } catch (error) {
    // Emit lifecycle.socket.failed before the cast-level failure event.
    await emitLifecycleEvent(state, "lifecycle.socket.failed", {
      severity: "error",
      socketId: currentSocketId(state),
      materia: state.currentMateria,
      visit: currentSocketVisit(state, undefined),
      ...(state.currentItemKey !== undefined ? { itemKey: state.currentItemKey } : {}),
      ...(state.currentItemLabel !== undefined ? { itemLabel: state.currentItemLabel } : {}),
      payload: { error: error instanceof Error ? error.message : String(error) },
    });
    await failCast(pi, ctx, state, error, latest.entry.id);
  }
}

async function completeSocket(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, text: string, entryId: string, options: { finalizedMultiTurn?: boolean; diagnostics?: AdvancementLifecycleDiagnostics } = {}): Promise<void> {
  const config = await loadConfigFromState(state);
  const socket = currentSocketOrThrow(state);
  const diagnostics = options.diagnostics ?? (options.finalizedMultiTurn ? agentEndAdvancementDiagnostics(state, socket, { finalizedMultiTurn: true }) : undefined);
  await appendAdvancementDiagnostic(ctx, state, "socket_completion_entry", diagnostics, { boundary: "sync_state_advancement", entryId });
  if (isMultiTurnResolvedAgentSocket(socket) && !options.finalizedMultiTurn) {
    throw new Error(`Internal multi-turn state error for socket "${socket.id}": completion requires explicit /materia continue finalization.`);
  }
  const artifact = await recordSocketOutput(state, socket, text, entryId);
  state.lastOutput = text;

  let parsed: unknown = text;
  if (effectiveResolvedSocketConfig(socket).parse === "json") {
    // ── Phase 1: Parse JSON ───────────────────────────────────────
    try {
      parsed = parseSocketJson<unknown>(socket.id, text);
    } catch (error) {
      const validationError = new Error(`Pre-commit output validation failed for socket "${socket.id}": ${errorMessage(error)}`);
      if (isAgentResolvedSocket(socket)) {
        if (options.finalizedMultiTurn) state.multiTurnFinalizing = true;
        state.jsonOutputRepair = buildJsonOutputRepairContext(text, validationError, classifyJsonOutputValidationKind(error), handoffValidationIssues(error));
        const recovered = await handleSameSocketRecoverableTurnFailure(pi, ctx, state, validationError, { entryId, allowGenericTurnFailure: true });
        if (recovered) return;
        throw nonRecoverableTurnError(state, validationError);
      }
      throw validationError;
    }

    // ── Phase 2: Process event side-channel (docs/runtime-eventing.md §3)
    //    Extracted, validated, enriched, dispatched, and stripped BEFORE
    //    handoff validation so event never leaks into state or prompts.
    try {
      await processSocketEvents(state, parsed, text, socket);
    } catch (eventError) {
      // Agent sockets: invalid event shape triggers JSON repair/retry
      // (same as any other invalid JSON output field).
      // processSocketEvents already sets jsonOutputRepair for agents.
      if (isAgentResolvedSocket(socket)) {
        const validationError = eventError instanceof Error ? eventError : new Error(String(eventError));
        if (options.finalizedMultiTurn) state.multiTurnFinalizing = true;
        const recovered = await handleSameSocketRecoverableTurnFailure(pi, ctx, state, validationError, { entryId, allowGenericTurnFailure: true });
        if (recovered) return;
        throw nonRecoverableTurnError(state, validationError);
      }
      // Utility sockets: hard failure propagates.
      throw eventError;
    }

    // Strip event from raw text stored in state so it cannot leak into
    // downstream synthetic context via lastOutput/lastAssistantText
    // (docs/runtime-eventing.md §3.5). parsed already has event removed
    // by processSocketEvents; re-stringify it to get clean text.
    if (isPlainObject(parsed)) {
      text = JSON.stringify(parsed);
      state.lastOutput = text;
      if (state.lastAssistantText) state.lastAssistantText = text;
    }

    // ── Phase 3: Validate handoff output (event already stripped) ─
    try {
      parsed = validateHandoffJsonOutput(parsed, { socketId: socket.id, socket: effectiveResolvedSocketConfig(socket), agentOutput: isAgentResolvedSocket(socket), workItemsProducer: Boolean(canonicalGeneratorConfigFor(socket.materia)) });
    } catch (error) {
      const validationError = new Error(`Pre-commit output validation failed for socket "${socket.id}": ${errorMessage(error)}`);
      if (isAgentResolvedSocket(socket)) {
        if (options.finalizedMultiTurn) state.multiTurnFinalizing = true;
        state.jsonOutputRepair = buildJsonOutputRepairContext(text, validationError, classifyJsonOutputValidationKind(error), handoffValidationIssues(error));
        const recovered = await handleSameSocketRecoverableTurnFailure(pi, ctx, state, validationError, { entryId, allowGenericTurnFailure: true });
        if (recovered) return;
        throw nonRecoverableTurnError(state, validationError);
      }
      throw validationError;
    }

    // ── Phase 4: Record clean parsed output (event already stripped) ──
    state.jsonOutputRepair = undefined;
    state.lastJson = parsed;
    await recordSocketParsedJson({ state, socketId: socket.id, visit: socketVisit(state, socket.id), parsed });
  }

  applyGenericHandoffEnvelope(state, parsed, socket);
  // Surface the canonical renderable text payload as clean TUI prose. This is a
  // one-way presentation layer: it never mutates cast state or the authoritative
  // JSON envelope, which remains consumable by downstream materia.
  emitMateriaTextOutput(pi, state, socket, parsed);
  applyAssignments(state, socket, parsed);
  const advanceTarget = applyAdvance(state, socket, parsed);
  const finalizedRefinement = isMultiTurnResolvedAgentSocket(socket);
  await appendEvent(state.runState, "socket_complete", { socket: socket.id, materia: socketMateriaName(socket), materiaLabel: resolvedMateriaDisplayName(socket), artifact, parsed: effectiveResolvedSocketConfig(socket).parse === "json", entryId, finalizedRefinement: finalizedRefinement || undefined, refinementTurn: finalizedRefinement ? currentRefinementTurn(state, socket.id) : undefined, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), materiaModel: state.currentMateriaModel });

  // Emit lifecycle.socket.completed through the event bus.
  await emitLifecycleEvent(state, "lifecycle.socket.completed", {
    severity: "debug",
    socketId: socket.id,
    materia: resolvedMateriaId(socket) ?? socket.id,
    materiaLabel: resolvedMateriaDisplayName(socket),
    visit: socketVisit(state, socket.id),
    ...(state.currentItemKey !== undefined ? { itemKey: state.currentItemKey } : {}),
    ...(state.currentItemLabel !== undefined ? { itemLabel: state.currentItemLabel } : {}),
    payload: { finalizedRefinement: finalizedRefinement || undefined },
  });

  // Emit lifecycle.status for progress visibility (runtime-owned status emission).
  await emitLifecycleEvent(state, "lifecycle.status", {
    severity: "info",
    message: `Socket ${socket.id} completed`,
    socketId: socket.id,
    materia: resolvedMateriaId(socket) ?? socket.id,
    materiaLabel: resolvedMateriaDisplayName(socket),
    visit: socketVisit(state, socket.id),
    ...(state.currentItemKey !== undefined ? { itemKey: state.currentItemKey } : {}),
    ...(state.currentItemLabel !== undefined ? { itemLabel: state.currentItemLabel } : {}),
    payload: { phase: state.phase },
  });

  await assertBudget(config, state.runState, ctx);

  let nextTarget = advanceTarget;
  if (!nextTarget) {
    const nextEdge = selectNextEdge(state, socket, parsed);
    if (nextEdge) {
      try {
        enforceEdgeLimit(state, socket.id, nextEdge, config);
      } catch (error) {
        if (error instanceof MateriaEdgeTraversalExhaustionError) {
          const allowance = state.edgeAllowances?.[error.key];
          state.recoveryExhaustion = {
            kind: "edge_traversal_exhausted",
            from: error.from,
            to: error.to,
            key: error.key,
            count: error.count,
            originalLimit: error.originalLimit,
            effectiveLimit: error.effectiveLimit,
            reviveCount: allowance?.reviveCount ?? 0,
            failedReason: error.message,
            exhaustedAt: Date.now(),
          };
          await appendEvent(state.runState, "edge_traversal_exhausted", {
            from: error.from,
            to: error.to,
            key: error.key,
            count: error.count,
            originalLimit: error.originalLimit,
            effectiveLimit: error.effectiveLimit,
            reviveCount: allowance?.reviveCount ?? 0,
            socket: socket.id,
            materia: socketMateriaName(socket),
            itemKey: state.currentItemKey,
          });
          await failCast(pi, ctx, state, error, entryId, { preserveRecoveryExhaustion: true });
          return;
        }
        throw error;
      }
      nextTarget = nextEdge.to;
      captureReworkFeedbackForRoute(state, { sourceSocket: socket, targetSocketId: nextEdge.to, edge: nextEdge, parsed, rawOutput: text });
    } else {
      nextTarget = "end";
    }
  }
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
  if (loop && !hasItem) return await advanceToSocket(pi, ctx, state, resolveEmptyLoopExhaustionTarget(state, socket, loop.done), "foreach-empty", nextDiagnostics);
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

  // Emit lifecycle.socket.started through the event bus.
  await emitLifecycleEvent(state, "lifecycle.socket.started", {
    severity: "debug",
    socketId: socket.id,
    materia: resolvedMateriaId(socket) ?? socket.id,
    materiaLabel: resolvedMateriaDisplayName(socket),
    visit: socketVisit(state, socket.id),
    ...(state.currentItemKey !== undefined ? { itemKey: state.currentItemKey } : {}),
    ...(state.currentItemLabel !== undefined ? { itemLabel: state.currentItemLabel } : {}),
  });

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
      await completeSocket(pi, ctx, state, result.output, result.entryId, { diagnostics: nextDiagnostics });
    } catch (error) {
      // Emit lifecycle.socket.failed before the cast-level failure event.
      await emitLifecycleEvent(state, "lifecycle.socket.failed", {
        severity: "error",
        socketId: socket.id,
        materia: resolvedMateriaId(socket) ?? socket.id,
        materiaLabel: resolvedMateriaDisplayName(socket),
        visit: socketVisit(state, socket.id),
        ...(state.currentItemKey !== undefined ? { itemKey: state.currentItemKey } : {}),
        ...(state.currentItemLabel !== undefined ? { itemLabel: state.currentItemLabel } : {}),
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
      await failCast(pi, ctx, state, error, `utility:${socket.id}:${socketVisit(state, socket.id)}`);
    }
    return;
  }

  state.awaitingResponse = true;
  setCurrentSocketState(state, "awaiting_agent_response");
  saveCastState(pi, state);
  const appliedModel = await applyMateriaModelSettings(pi, ctx, { materiaName: resolvedSocketConfig(socket).materia, model: socket.materia.model, thinking: socket.materia.thinking, policy: await resolveActiveModelPolicy(pi, ctx) });
  const materiaModel = materiaModelSelection(appliedModel);
  state.currentMateriaModel = materiaModel;
  state.runState.currentMateriaModel = materiaModel;
  recordUsageModelSelection(state.runState.usage, { socket: socket.id, materia: resolvedSocketConfig(socket).materia, taskId: state.currentItemKey, attempt: state.runState.attempt, materiaModel });
  await writeUsage(state.runState);
  await appendEvent(state.runState, "materia_model_settings", { socket: socket.id, materia: resolvedSocketConfig(socket).materia, visit: socketVisit(state, socket.id), itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), materiaModel });
  saveCastState(pi, state);
  await updateSocketToolScope(pi, ctx, state, socket);
  await dispatchSocketPrompt(pi, ctx, state, socket, {
    diagnostics: nextDiagnostics,
    skipProactiveCompaction: appliedModel.modelSwitched === true,
  });
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

function enforceSocketVisitLimit(state: MateriaCastState, socket: ResolvedMateriaSocket, config: PiMateriaConfig): void {
  const count = (state.visits[socket.id] ?? 0) + 1;
  const limit = resolvedSocketConfig(socket).limits?.maxVisits ?? config.limits?.maxSocketVisits ?? DEFAULT_MAX_SOCKET_VISITS;
  if (count > limit) throw new Error(`Materia socket visit limit exceeded for ${socket.id} (${count}/${limit}).`);
  state.visits[socket.id] = count;
}

/**
 * Surface a materia's canonical renderable text payload as clean TUI prose.
 * Pure presentation: only emits a display message when the parsed handoff
 * carries a non-empty `text` field, and never mutates cast state or the
 * authoritative JSON envelope.
 */
function emitMateriaTextOutput(pi: ExtensionAPI, state: MateriaCastState, socket: ResolvedMateriaSocket, parsed: unknown): void {
  const notificationMateria = resolvedMateriaDisplayName(socket) ?? socketMateriaName(socket);
  const display = formatMateriaNotificationDisplay(notificationMateria, socket.id);
  const message = buildMateriaTextOutputMessage({
    parsed,
    materiaName: display.materiaName,
    socketId: socket.id,
    socketOrdinal: display.socketOrdinal,
    itemKey: state.currentItemKey,
    itemLabel: state.currentItemLabel,
  });
  if (message) pi.sendMessage(message);
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

  const appliedModel = await applyMateriaModelSettings(pi, ctx, { materiaName: resolvedSocketConfig(socket).materia, model: socket.materia.model, thinking: socket.materia.thinking, policy: await resolveActiveModelPolicy(pi, ctx) });
  const materiaModel = materiaModelSelection(appliedModel);
  state.currentMateria = socketMateriaName(socket);
  state.currentMateriaModel = materiaModel;
  state.runState.currentMateria = socketMateriaName(socket);
  state.runState.currentMateriaModel = materiaModel;
  state.awaitingResponse = true;
  setCurrentSocketState(state, "awaiting_agent_response");
  state.multiTurnFinalizing = false;
  state.activeTurnPrompt = materiaPrompt(socket.materia, state, [buildSyntheticCastContext(state), multiTurnRefinementGuidance()]);
  recordActiveTurnProvenance(state);
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
  emitLifecycleEvent,
  cancelNativeCast,
  getEventBus,
  getResultAccumulator,
  removeEventBus,
  startHeartbeat,
  stopHeartbeat,
  initializeCastEventBus,
  buildPipelineSocketDetails,
  findMultiTurnAgentSockets,
  isAgentControllerPresetActive,
  validateAgentControllerMultiTurnSockets,
  get castHeartbeats() { return nativeEventing.castHeartbeats; },
  get castEventBuses() { return nativeEventing.castEventBuses; },
};


