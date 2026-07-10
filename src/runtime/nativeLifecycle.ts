import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { safeTimestamp } from "../utilities/artifacts.js";
import { resolveArtifactRoot } from "../config/config.js";
import { getEffectivePipelineConfig } from "./pipeline.js";
import { getResolvedPipelineSocket } from "../loadout/loadoutAccessors.js";
import { applyGenericHandoffEnvelope } from "../application/handoff.js";
import { flushBusOutcomes } from "./eventBus.js";
import { renderTemplate } from "../application/promptAssembly.js";
import type { CastStartOptions } from "../application/ports.js";
export { activeMateriaSystemPrompt, buildIsolatedMateriaContext } from "../application/promptAssembly.js";
export { currentMateria, materiaStatusLabel } from "./sessionState.js";
export { classifyTurnFailure, extendEdgeTraversalAllowanceForRevive, extendSameSocketRecoveryAllowanceForRevive } from "../application/recoveryPolicy.js";
import { applyAdvance, applyAssignments, evaluateCondition, resolveEmptyLoopExhaustionTarget, resolveValue, selectNextTarget, setCurrentItem, setPath } from "../application/workflowTransitions.js";
import { extendEdgeTraversalAllowanceForRevive, extendSameSocketRecoveryAllowanceForRevive } from "../application/recoveryPolicy.js";
import { applyMateriaModelSettings } from "../config/modelSettings.js";
import { resolveActiveModelPolicy } from "./modelPolicyResolver.js";
import type { LoadedConfig, MateriaCastState, ResolvedMateriaPipeline } from "../types.js";
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
import { recordActiveTurnProvenance, updateToolScope } from "./agentTurnState.js";
import { currentMateria, currentSocketId, currentSocketOrThrow, currentSocketState, currentSocketVisit, isAgentResolvedSocket, materiaStatusLabel, setCurrentSocketId, setCurrentSocketState, socketMateriaName, socketVisit } from "./sessionState.js";
import { nativeEventing } from "./nativeEventing.js";
import { createCastTermination } from "./castTermination.js";
import { createTurnRecovery } from "./turnRecovery.js";
import { createSocketEventProcessing } from "./socketEventProcessing.js";
import { createAgentPromptDispatch } from "./agentPromptDispatch.js";
import { createSocketOutputCommit } from "./socketOutputCommit.js";
import { createSocketExecution } from "./socketExecution.js";
import { createAgentLifecycle } from "./agentLifecycle.js";
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

const { commitSocketOutput } = createSocketOutputCommit({
  artifacts: {
    appendEvent,
    recordSocketOutput,
    recordSocketParsedJson,
    shortMetadataLabel,
  },
  state: {
    loadConfigFromState,
  },
  eventing: {
    processSocketEvents,
    emitLifecycleEvent,
  },
  recovery: {
    buildJsonOutputRepairContext,
    classifyJsonOutputValidationKind,
    handleSameSocketRecoverableTurnFailure,
  },
  lifecycle: {
    failCast,
  },
  diagnostics: {
    agentEndAdvancementDiagnostics,
    appendAdvancementDiagnostic,
  },
  budget: {
    assertBudget,
  },
});

const { completeSocket, startSocket } = createSocketExecution({
  artifacts: {
    appendEvent,
    recordUtilityInput: recordUtilityInputFile,
    shortMetadataLabel,
    writeUsage,
  },
  state: {
    loadConfigFromState,
    saveCastState,
  },
  eventing: {
    emitLifecycleEvent,
  },
  models: {
    applyMateriaModelSettings,
    resolveActiveModelPolicy,
    materiaModelSelection,
    recordUsageModelSelection,
  },
  utility: {
    executeCommand: executeCommandUtility,
    executeBuiltInUtility,
    hasBuiltInUtility,
  },
  prompts: {
    appendAdvancementDiagnostic,
    dispatchSocketPrompt,
    updateSocketToolScope,
  },
  output: {
    commitSocketOutput,
  },
  lifecycle: {
    failCast,
    finishCast,
  },
  ui: {
    updateWidget,
  },
});

const agentLifecycle = createAgentLifecycle({
  artifacts: {
    appendEvent,
    appendManifest,
    recordMultiTurnRefinement,
    writeContextArtifact,
    writeUsage,
    shortMetadataLabel,
  },
  state: {
    loadActiveCastState,
    saveCastState,
    recordActiveTurnProvenance,
  },
  models: {
    applyMateriaModelSettings,
    resolveActiveModelPolicy,
    materiaModelSelection,
    recordUsageModelSelection,
  },
  eventing: {
    emitLifecycleEvent,
  },
  recovery: {
    preserveAwaitingAfterTransientTransportFailure,
    handleSameSocketRecoverableTurnFailure,
    shouldRetryGenericTurnFailure,
  },
  dispatch: {
    agentEndAdvancementDiagnostics,
    appendAdvancementDiagnostic,
    sendMateriaTurn,
    updateSocketToolScope,
  },
  completion: {
    completeSocket,
  },
  termination: {
    failCast,
  },
  ui: {
    updateWidget,
  },
});

const { startMultiTurnFinalizationTurn } = agentLifecycle;
export const handleAgentEnd = agentLifecycle.handleAgentEnd;
export const prepareAgentStartSystemPrompt = agentLifecycle.prepareAgentStartSystemPrompt;
export const prepareMultiTurnRefinementTurn = agentLifecycle.prepareMultiTurnRefinementTurn;

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


