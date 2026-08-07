import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { applyGenericHandoffEnvelope } from "../application/handoff.js";
import { renderTemplate } from "../application/promptAssembly.js";
import { applyAdvance, applyAssignments, evaluateCondition, resolveEmptyLoopExhaustionTarget, resolveValue, selectNextTarget, setCurrentItem, setPath } from "../application/workflowTransitions.js";
import { applyMateriaModelSettings } from "../config/modelSettings.js";
import { appendEvent, appendManifest, initializeRun, recordSocketParsedJson, recordUtilityInput as recordUtilityInputFile, shortMetadataLabel } from "../infrastructure/castArtifacts.js";
import { createParallelLaneArtifactStore } from "../infrastructure/parallelLaneArtifacts.js";
import { createPiChildCastRunner } from "../infrastructure/piChildCastRunner.js";
import { clearCastState, listLatestCastStates, listResumableCastStates, listRevivableCastStates, loadActiveCastState, loadCastStateById, saveCastState } from "../infrastructure/castStateRepository.js";
import { assertBudget, writeUsage } from "../infrastructure/castUsage.js";
import { executeCommandUtility } from "../infrastructure/utilityCommandExecutor.js";
import { formatUsage, showUsageSummary, updateWidget } from "../presentation/ui.js";
import { recordUsageModelSelection } from "../telemetry/usage.js";
import type { MateriaCastState } from "../types.js";
import { executeBuiltInUtility, hasBuiltInUtility } from "../utilities/utilityRegistry.js";
import {
  buildPipelineSocketDetails,
  findMultiTurnAgentSockets,
  isAgentControllerPresetActive,
  validateAgentControllerMultiTurnSockets,
} from "./agentControllerCompatibility.js";
import { createAgentFinalizationRuntime } from "./agentFinalizationRuntime.js";
import { handleFinalizationToolExecutionEnd, type HandoffToolExecutionEndEvent } from "./finalizationDiagnostics.js";
import { createAgentLifecycle } from "./agentLifecycle.js";
import { createAgentPromptDispatch } from "./agentPromptDispatch.js";
import { recordActiveTurnProvenance, updateToolScope } from "./agentTurnState.js";
import { recordMultiTurnRefinement, recordSocketOutput, writeContextArtifact } from "./artifactRecording.js";
import { createCastLifecycle } from "./castLifecycle.js";
import { createCastTermination } from "./castTermination.js";
import { loadConfigFromState, persistCastBudget, resolvePersistedCastLoadoutIdentity } from "./configPersistence.js";
import { flushBusOutcomes } from "./eventBus.js";
import { resolveActiveModelPolicy } from "./modelPolicyResolver.js";
import { materiaModelSelection } from "./modelSelection.js";
import { nativeEventing } from "./nativeEventing.js";
import { createSocketEventProcessing } from "./socketEventProcessing.js";
import { createSocketExecution } from "./socketExecution.js";
import { createSocketOutputCommit } from "./socketOutputCommit.js";
import { createParallelLoopDispatcher } from "./parallelDispatcher.js";
import { currentMateria, currentSocketId, currentSocketOrThrow, currentSocketVisit, setCurrentSocketState } from "./sessionState.js";
import { createTurnRecovery } from "./turnRecovery.js";

export { activeMateriaSystemPrompt, buildIsolatedMateriaContext } from "../application/promptAssembly.js";
export { classifyTurnFailure, extendEdgeTraversalAllowanceForRevive, extendSameSocketRecoveryAllowanceForRevive } from "../application/recoveryPolicy.js";
export { clearCastState, listLatestCastStates, listResumableCastStates, listRevivableCastStates, loadActiveCastState, loadCastStateById, saveCastState } from "../infrastructure/castStateRepository.js";
export {
  buildPipelineSocketDetails,
  findMultiTurnAgentSockets,
  isAgentControllerPresetActive,
  validateAgentControllerMultiTurnSockets,
} from "./agentControllerCompatibility.js";
export type { AgentControllerValidationResult, PipelineSocketDetail } from "./agentControllerCompatibility.js";
export { defaultProactiveCompactionThresholdPercent } from "./compaction.js";
export { currentMateria, materiaStatusLabel } from "./sessionState.js";

const agentFinalization = createAgentFinalizationRuntime<object>();
const emitLifecycleEvent = nativeEventing.emitLifecycleEvent.bind(nativeEventing);
const getEventBus = nativeEventing.getEventBus.bind(nativeEventing);
const getResultAccumulator = nativeEventing.getResultAccumulator.bind(nativeEventing);
const initializeCastEventBus = nativeEventing.initializeCastEventBus.bind(nativeEventing);
const removeEventBus = nativeEventing.removeEventBus.bind(nativeEventing);
const startHeartbeat = nativeEventing.startHeartbeat.bind(nativeEventing);
const stopHeartbeat = nativeEventing.stopHeartbeat.bind(nativeEventing);
let parallelLoopDispatcher: ReturnType<typeof createParallelLoopDispatcher>;

const castTermination = createCastTermination({
  parallel: {
    cancel: (pi, state, reason) => parallelLoopDispatcher.cancel({ pi, state, reason }),
  },
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
  finalization: {
    deactivate: (pi) => agentFinalization.deactivate(pi),
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
    configureAgentFinalization: (pi, session, state, socket, config) =>
      agentFinalization.configure(pi, session, state, socket, config),
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
  preserveAwaitingAfterInferenceInterruption,
  preserveAwaitingAfterTransientTransportFailure,
  handleSameSocketRecoverableTurnFailure,
  buildJsonOutputRepairContext,
  classifyJsonOutputValidationKind,
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
    saveCastState,
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

const parallelLaneArtifacts = createParallelLaneArtifactStore();
parallelLoopDispatcher = createParallelLoopDispatcher({
  children: createPiChildCastRunner(),
  state: { saveCastState },
  artifacts: {
    appendEvent,
    writeUsage,
    lane: parallelLaneArtifacts,
  },
  runtimeEvents: {
    emit: (state, type, payload) => {
      const { loopId, laneId } = extractParallelRuntimeProvenance(payload);
      return emitLifecycleEvent(state, type, {
        socketId: loopId ? `parallel:${loopId}` : "parallel",
        materia: laneId ? `lane:${laneId}` : "parallel-coordinator",
        ...(laneId ? { itemKey: laneId, itemLabel: laneId } : {}),
        payload,
      });
    },
  },
  budget: {
    assertBudget: async (state, ctx) => assertBudget(await loadConfigFromState(state), state.runState, ctx),
  },
  onBudgetExceeded: async (pi, ctx, state, error, entryId) => failCast(pi, ctx, state, error, entryId),
  onProgressStart: updateWidget,
  onProgressChange: updateWidget,
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
  parallel: parallelLoopDispatcher,
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
    preserveAwaitingAfterInferenceInterruption,
    preserveAwaitingAfterTransientTransportFailure,
    handleSameSocketRecoverableTurnFailure,
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
  finalization: {
    completion: (session, state, text) => agentFinalization.completion(session, state, text),
    fallbackToDirect: (pi, session, state) => agentFinalization.fallbackToDirect(pi, session, state),
    release: (pi, session, state) => agentFinalization.release(pi, session, state),
  },
  termination: {
    failCast,
  },
  ui: {
    updateWidget,
  },
});

const castLifecycle = createCastLifecycle({
  artifacts: {
    initializeRun,
    appendEvent,
    writeUsage,
    shortMetadataLabel,
  },
  state: {
    loadActiveCastState,
    loadCastStateById,
    saveCastState,
    loadConfigFromState,
    resolvePersistedCastLoadoutIdentity,
  },
  eventing: {
    initializeCastEventBus,
    startHeartbeat,
    emitLifecycleEvent,
  },
  validation: {
    buildPipelineSocketDetails,
    validateAgentControllerMultiTurnSockets,
  },
  execution: {
    startSocket,
  },
  dispatch: {
    castStartInitialPromptDiagnostics,
    updateSocketToolScope,
    sendMateriaTurn,
  },
  agent: {
    startMultiTurnFinalizationTurn: agentLifecycle.startMultiTurnFinalizationTurn,
  },
  termination: {
    failCastAtStart,
    failCast,
  },
  parallel: parallelLoopDispatcher,
  ui: {
    updateWidget,
  },
});

export const continueNativeCast = castLifecycle.continueNativeCast;
export const handleAgentEnd = agentLifecycle.handleAgentEnd;
export const handleAgentSettled = agentLifecycle.handleAgentSettled;
export const prepareAgentStartSystemPrompt = agentLifecycle.prepareAgentStartSystemPrompt;

export async function handleAgentHandoffToolExecutionEnd(
  pi: ExtensionAPI,
  event: HandoffToolExecutionEndEvent,
  ctx: ExtensionContext,
): Promise<void> {
  await handleFinalizationToolExecutionEnd(loadActiveCastState(ctx), event, {
    appendEvent,
    saveState: (state) => saveCastState(pi, state),
  });
}
export const prepareMultiTurnRefinementTurn = agentLifecycle.prepareMultiTurnRefinementTurn;
export const reactivateQueuedNativeCast = castLifecycle.reactivateQueuedNativeCast;
export const recoverParallelNativeCast = castLifecycle.recoverParallelNativeCast;
export const resumeNativeCast = castLifecycle.resumeNativeCast;
export const reviveNativeCast = castLifecycle.reviveNativeCast;
export const startNativeCast = castLifecycle.startNativeCast;
export { persistCastBudget };

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
  extractParallelRuntimeProvenance,
  get castHeartbeats() { return nativeEventing.castHeartbeats; },
  get castEventBuses() { return nativeEventing.castEventBuses; },
};

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Resolve monitor identity from both current and artifact-shaped event data. */
function extractParallelRuntimeProvenance(payload: Record<string, unknown>): { loopId?: string; laneId?: string } {
  const provenance = isRecord(payload.provenance) ? payload.provenance : undefined;
  const loopId = nonEmptyString(payload.loopId) ?? nonEmptyString(provenance?.loopId);
  const laneId = nonEmptyString(payload.laneId) ?? nonEmptyString(provenance?.laneId);
  return {
    ...(loopId !== undefined ? { loopId } : {}),
    ...(laneId !== undefined ? { laneId } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


