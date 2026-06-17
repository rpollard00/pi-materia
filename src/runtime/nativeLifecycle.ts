import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { safeTimestamp } from "../utilities/artifacts.js";
import { resolveArtifactRoot } from "../config/config.js";
import { getEffectivePipelineConfig, loopIteratorForSocket } from "./pipeline.js";
import { getResolvedPipelineSocket } from "../loadout/loadoutAccessors.js";
import { parseSocketJson } from "../utilities/json.js";
import { applyGenericHandoffEnvelope } from "../application/handoff.js";
import {
  EVENT_SIDECHANNEL_FIELD,
  ResultAccumulator,
  SequenceCounter,
  createSequenceCounter,
  enrichEvents,
  validateMateriaEventArray,
  type EnrichedEvent,
  type EnrichmentContext,
  type EventSeverity,
  type MateriaEventObject,
} from "../domain/eventing.js";
import { createEventBus, EventBus, flushBusOutcomes } from "./eventBus.js";
import { WebhookSink } from "./webhookSink.js";
import type { EventingConfig, EventingWebhookSinkConfig } from "../types.js";
import { activeMateriaSystemPrompt, buildJsonOutputRepairRetryPrompt, buildMultiTurnFinalizationPrompt, buildSocketPrompt, buildSyntheticCastContext, buildTimeoutRecoveryHint, isPausedMultiTurnRefinement, materiaPrompt, multiTurnRefinementGuidance, renderTemplate } from "../application/promptAssembly.js";
import type { CastStartOptions } from "../application/ports.js";
export { activeMateriaSystemPrompt, buildIsolatedMateriaContext } from "../application/promptAssembly.js";
export { currentMateria, materiaStatusLabel } from "./sessionState.js";
export { classifyTurnFailure, extendEdgeTraversalAllowanceForRevive, extendSameSocketRecoveryAllowanceForRevive } from "../application/recoveryPolicy.js";
import { captureReworkFeedbackForRoute } from "../application/reworkFeedback.js";
import { applyAdvance, applyAssignments, currentItem, enforceEdgeLimit, evaluateCondition, getPath, MateriaEdgeTraversalExhaustionError, resolveEmptyLoopExhaustionTarget, resolveValue, selectNextEdge, selectNextTarget, setCurrentItem, setPath } from "../application/workflowTransitions.js";
import { executeUtilitySocketWithDeps } from "../application/utilityExecution.js";
import { classifyTurnFailure, errorMessage, extendEdgeTraversalAllowanceForRevive, extendSameSocketRecoveryAllowanceForRevive, nonRecoverableTurnError, recoveryDiagnosticLabel, recoveryIdentityKey, recoveryTurnMode, type TurnFailureClassification } from "../application/recoveryPolicy.js";
import { assessContextPressureForCompaction, maybeRunProactiveCompactionWorkflow, runSameSocketRecoveryCompaction, type ContextProjectionInput } from "../application/compactionWorkflow.js";
import { handleSameSocketRecoverableTurnFailureWorkflow, runSameSocketRecoveryActionWorkflow, type SameSocketRecoveryActionOptions } from "../application/recoveryWorkflow.js";
import { handoffValidationIssues, validateHandoffJsonOutput } from "../handoff/handoffValidation.js";
import { canonicalGeneratorConfigFor } from "../graph/generator.js";
import { applyMateriaModelSettings } from "../config/modelSettings.js";
import { formatMateriaCastContent, formatMateriaNotificationDisplay } from "../presentation/notificationFormatting.js";
import type { LoadedConfig, MateriaCastState, MateriaJsonOutputValidationKind, PiMateriaConfig, ResolvedMateriaSocket, ResolvedMateriaPipeline, ResolvedMateriaUtilitySocket } from "../types.js";
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
import { assistantErrorMessage, assistantText, agentEndFailureMessage, captureUsage, findLatestAssistantEntry, updateToolScope, type ToolScopeRuntimeWarning } from "./agentTurnState.js";
import { activeResolvedSocket, currentMateria, currentRefinementTurn, currentSocketId, currentSocketOrThrow, currentSocketState, currentSocketVisit, isAgentResolvedSocket, isMultiTurnResolvedAgentSocket, materiaStatusLabel, nextRefinementTurn, resolvedSocketConfig, setCurrentSocketId, setCurrentSocketState, socketMateriaName, socketVisit, startTaskAttempt } from "./sessionState.js";
import { effectiveResolvedSocketConfig, resolvedMateriaDisplayName, resolvedMateriaId } from "./resolvedMateria.js";
export { clearCastState, listLatestCastStates, listResumableCastStates, listRevivableCastStates, loadActiveCastState, loadCastStateById, saveCastState } from "../infrastructure/castStateRepository.js";


const DEFAULT_MAX_SOCKET_VISITS = 25;
export { defaultProactiveCompactionThresholdPercent } from "./compaction.js";

// ── Event Bus Registry ──────────────────────────────────────────────────

/** Per-cast event bus instances keyed by castId. */
const castEventBuses = new Map<string, EventBus>();

/** Per-cast sequence counter keyed by castId. */
const castSequenceCounters = new Map<string, ReturnType<typeof createSequenceCounter>>();

/** Per-cast result accumulators keyed by castId. */
const castResultAccumulators = new Map<string, ResultAccumulator>();

function getEventBus(state: MateriaCastState): EventBus | undefined {
  return castEventBuses.get(state.castId);
}

/**
 * Get the result accumulator for a cast, if eventing is enabled.
 *
 * Returns undefined when eventing is disabled. Callers should handle
 * that gracefully (e.g., skip outcome derivation for lifecycle events).
 */
function getResultAccumulator(state: MateriaCastState): ResultAccumulator | undefined {
  return castResultAccumulators.get(state.castId);
}

// ── Lifecycle Event Emission ────────────────────────────────────────────

/**
 * Emit a runtime-owned lifecycle event through the event bus.
 *
 * Lifecycle events use a `lifecycle.` prefix (docs/runtime-eventing.md §7)
 * and flow through the same bus, filters, artifacts, and sinks as
 * materia-emitted events. If eventing is disabled (no bus), the call is a
 * silent no-op.
 *
 * Each lifecycle event is enriched with runtime metadata (eventId,
 * occurredAt, monotonic sequence, castId, and available socket/materia/item
 * context) before dispatch.
 */
async function emitLifecycleEvent(
  state: MateriaCastState,
  type: string,
  overrides: {
    severity?: EventSeverity;
    message?: string;
    payload?: Record<string, unknown>;
    socketId?: string;
    materia?: string;
    materiaLabel?: string;
    visit?: number;
    itemKey?: string;
    itemLabel?: string;
  } = {},
): Promise<void> {
  const bus = getEventBus(state);
  if (!bus) return; // eventing disabled — silent no-op

  const seq = castSequenceCounters.get(state.castId);
  if (!seq) return;

  const materiaEvent: MateriaEventObject = {
    type,
    severity: overrides.severity ?? "info",
    ...(overrides.message !== undefined ? { message: overrides.message } : {}),
    ...(overrides.payload !== undefined ? { payload: overrides.payload } : {}),
  };

  // Build enrichment context using caller-supplied overrides, falling back
  // to generic lifecycle placeholders for cast-level events.
  const enrichmentCtx: EnrichmentContext = {
    castId: state.castId,
    socketId: overrides.socketId ?? "lifecycle",
    materia: overrides.materia ?? "pi-materia",
    ...(overrides.materiaLabel !== undefined ? { materiaLabel: overrides.materiaLabel } : {}),
    visit: overrides.visit ?? 0,
    ...(overrides.itemKey !== undefined ? { itemKey: overrides.itemKey } : {}),
    ...(overrides.itemLabel !== undefined ? { itemLabel: overrides.itemLabel } : {}),
  };

  const enrichedEvents = enrichEvents([materiaEvent], enrichmentCtx, seq, () => randomUUID());
  for (const event of enrichedEvents) {
    await bus.dispatch(event);
  }
}

function removeEventBus(castId: string): void {
  castEventBuses.delete(castId);
  castSequenceCounters.delete(castId);
  castResultAccumulators.delete(castId);
}

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
  // Emit lifecycle.cast.cancelled before flushing/cleanup.
  await emitLifecycleEvent(state, "lifecycle.cast.cancelled", {
    severity: "warning",
    message: reason,
    payload: { reason },
  });

  // Flush event bus before terminal artifacts.
  const bus = getEventBus(state);
  if (bus) {
    try { await bus.flush(); } catch { /* best-effort */ }
    try { await flushBusOutcomes(bus, state.runDir); } catch { /* best-effort */ }
  }

  // Mark the run ended so clearCastState doesn't set endedAt again.
  state.runState.endedAt ??= Date.now();

  const cleared = clearCastState(pi, state, reason);
  removeEventBus(state.castId);
  return cleared;
}

/**
 * Create and register the event bus for a cast when eventing is enabled.
 *
 * Registers the built-in local recording sink and any configured webhook sinks.
 * The bus is stored in the module-level registry keyed by castId.
 */
function initializeCastEventBus(config: PiMateriaConfig, state: MateriaCastState): EventBus | undefined {
  const eventing = config.eventing;
  if (!eventing?.enabled) return undefined;

  const bus = createEventBus(state.runDir);
  const seq = createSequenceCounter();
  const accumulator = new ResultAccumulator();

  // Register configured webhook sinks.
  if (eventing.sinks) {
    for (const [sinkId, sinkConfig] of Object.entries(eventing.sinks)) {
      if (!isEnabledWebhookSinkConfig(sinkConfig)) continue;
      try {
        bus.register(new WebhookSink(sinkConfig));
      } catch {
        // Sink creation failures are non-fatal — they are logged and skipped.
        // The cast continues without this sink.
      }
    }
  }

  castEventBuses.set(state.castId, bus);
  castSequenceCounters.set(state.castId, seq);
  castResultAccumulators.set(state.castId, accumulator);
  return bus;
}

function isEnabledWebhookSinkConfig(
  config: unknown,
): config is EventingWebhookSinkConfig {
  if (typeof config !== "object" || config === null) return false;
  const c = config as Record<string, unknown>;
  if (c.enabled === false) return false;
  // Must have a URL to be a webhook sink.
  return typeof c.url === "string" && c.url.trim().length > 0;
}

/**
 * Process the `event` side-channel from parsed JSON output.
 *
 * Per docs/runtime-eventing.md §3, events are extracted immediately after JSON
 * parse, validated, enriched (when eventing enabled), dispatched, and then
 * stripped from the parsed object before handoff semantics run.
 *
 * Extraction, validation, and stripping always occur when the `event` field is
 * present, regardless of whether eventing is enabled. Dispatch is skipped when
 * eventing is disabled or no EventBus is registered.
 *
 * - Agent sockets: invalid event shape triggers existing JSON repair/retry
 *   flow (same as any other invalid JSON output field).
 * - Utility sockets: invalid event shape is a hard failure — the utility
 *   produced invalid structured output.
 */
async function processSocketEvents(
  state: MateriaCastState,
  parsed: unknown,
  rawText: string,
  socket: ResolvedMateriaSocket,
): Promise<void> {
  if (!isPlainObject(parsed)) return;
  const parsedObj = parsed as Record<string, unknown>;

  // Only process if the event field is present.
  if (!Object.prototype.hasOwnProperty.call(parsedObj, EVENT_SIDECHANNEL_FIELD)) return;

  const rawEvent = parsedObj[EVENT_SIDECHANNEL_FIELD];

  // Validate the event side-channel (always, regardless of eventing enabled/disabled).
  const validation = validateMateriaEventArray(rawEvent);

  if (!validation.ok) {
    const validationError = new Error(
      `Invalid event side-channel for socket "${socket.id}": ${validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    );

    if (isAgentResolvedSocket(socket)) {
      // Agent sockets: trigger JSON repair/retry flow.
      // Use the raw text so the repair prompt shows the original agent output.
      state.jsonOutputRepair = buildJsonOutputRepairContext(
        rawText,
        validationError,
        "handoff_validation",
        validation.issues.map((i) => ({ path: i.path, message: i.message })),
      );
      // The event field is left in parsed so the repair context captures it.
      // The caller (completeSocket) will detect jsonOutputRepair and retry.
      throw validationError;
    }

    // Utility sockets: hard failure.
    throw validationError;
  }

  const events = validation.value;

  // Dispatch enriched events only when eventing is enabled and bus is available.
  if (events.length > 0) {
    const bus = getEventBus(state);
    const seq = castSequenceCounters.get(state.castId);
    if (bus && seq) {
      const enrichmentCtx: EnrichmentContext = {
        castId: state.castId,
        socketId: socket.id,
        materia: resolvedMateriaId(socket) ?? socket.id,
        materiaLabel: resolvedMateriaDisplayName(socket),
        visit: socketVisit(state, socket.id),
        ...(state.currentItemKey !== undefined ? { itemKey: state.currentItemKey } : {}),
        ...(state.currentItemLabel !== undefined ? { itemLabel: state.currentItemLabel } : {}),
      };

      const enrichedEvents = enrichEvents(events, enrichmentCtx, seq, () => randomUUID());

      // Feed result.* events into the cast accumulator before dispatch.
      const accumulator = getResultAccumulator(state);
      if (accumulator) {
        for (const enriched of enrichedEvents) {
          accumulator.record(enriched);
        }
      }

      for (const enriched of enrichedEvents) {
        await bus.dispatch(enriched);
      }
    }
  }

  // Always strip the event field before handoff semantics (docs/runtime-eventing.md §3.5).
  // This happens regardless of whether eventing is enabled or dispatch occurred.
  delete parsedObj[EVENT_SIDECHANNEL_FIELD];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type AdvancementOrigin = "initial" | "command" | "agent_end";
type PromptDispatchMode = "immediate" | "defer-agent-trigger";

type AdvancementLifecycleDiagnostics = {
  finalizedMultiTurn?: boolean;
  origin?: AdvancementOrigin;
  promptDispatch?: PromptDispatchMode;
  sourceSocketId?: string;
  sourceSocketVisit?: number;
  sourceMateriaName?: string;
  nextSocketTarget?: string;
  dispatchTriggerMode?: string;
};

const deferredPromptDispatchKeys = new Set<string>();

function advancementDiagnosticsEnabled(diagnostics?: AdvancementLifecycleDiagnostics): boolean {
  return Boolean(diagnostics?.finalizedMultiTurn || diagnostics?.origin === "agent_end" || process.env.PI_MATERIA_ADVANCEMENT_DEBUG?.trim());
}

function agentEndAdvancementDiagnostics(state: MateriaCastState, socket: ResolvedMateriaSocket, options: { finalizedMultiTurn?: boolean } = {}): AdvancementLifecycleDiagnostics {
  return {
    finalizedMultiTurn: options.finalizedMultiTurn,
    origin: "agent_end",
    promptDispatch: "defer-agent-trigger",
    sourceSocketId: socket.id,
    sourceSocketVisit: socketVisit(state, socket.id),
    sourceMateriaName: socketMateriaName(socket),
    dispatchTriggerMode: "deferred-triggerTurn",
  };
}

function castStartInitialPromptDiagnostics(state: MateriaCastState, entry: ResolvedMateriaSocket, options?: CastStartOptions): AdvancementLifecycleDiagnostics | undefined {
  if (options?.initialPromptDispatch !== "defer-agent-trigger") return undefined;
  return {
    origin: "agent_end",
    promptDispatch: "defer-agent-trigger",
    sourceSocketId: "cast_start",
    sourceSocketVisit: 0,
    sourceMateriaName: socketMateriaName(entry),
    nextSocketTarget: entry.id,
    dispatchTriggerMode: "deferred-triggerTurn",
  };
}

function shouldDeferAgentPromptDispatch(diagnostics?: AdvancementLifecycleDiagnostics): boolean {
  return diagnostics?.origin === "agent_end" && diagnostics.promptDispatch === "defer-agent-trigger";
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
    sourceSocketVisit: diagnostics?.sourceSocketVisit,
    materiaName: state.currentMateria ?? diagnostics?.sourceMateriaName,
    sourceMateriaName: diagnostics?.sourceMateriaName,
    phase: state.phase,
    socketState: currentSocketState(state),
    active: state.active,
    awaitingResponse: state.awaitingResponse,
    multiTurnFinalizing: state.multiTurnFinalizing,
    nextSocketTarget: diagnostics?.nextSocketTarget,
    origin: diagnostics?.origin,
    promptDispatch: diagnostics?.promptDispatch,
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
  await appendEvent(runState, "cast_start", { request, configSource: loaded.source, artifactRoot, pipeline: effectivePipeline.pipeline, loadout: effectivePipeline.loadoutName, ...(loadoutIdentity.loadoutId ? { loadoutId: loadoutIdentity.loadoutId } : {}), nativeSession: true, isolatedMateriaContext: true, ...(options?.startEventDetails ?? {}) });

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
  initializeCastEventBus(config, state);

  // Emit lifecycle.cast.started through the event bus (no-op if eventing disabled).
  await emitLifecycleEvent(state, "lifecycle.cast.started", {
    severity: "info",
    message: request.slice(0, 200),
    payload: {
      request,
      ...(loadoutIdentity.loadoutId ? { loadoutId: loadoutIdentity.loadoutId } : {}),
      loadoutName: effectivePipeline.loadoutName,
      pipeline: effectivePipeline.pipeline,
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
  try {
    const config = await loadConfigFromState(state);
    initializeCastEventBus(config, state);
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
  const appliedModel = await applyMateriaModelSettings(pi, ctx, { materiaName: resolvedSocketConfig(socket).materia, model: socket.materia.model, thinking: socket.materia.thinking });
  const materiaModel = materiaModelSelection(appliedModel);
  state.currentMateriaModel = materiaModel;
  state.runState.currentMateriaModel = materiaModel;
  recordUsageModelSelection(state.runState.usage, { socket: socket.id, materia: resolvedSocketConfig(socket).materia, taskId: state.currentItemKey, attempt: state.runState.attempt, materiaModel });
  await writeUsage(state.runState);
  await appendEvent(state.runState, "materia_model_settings", { socket: socket.id, materia: resolvedSocketConfig(socket).materia, visit: socketVisit(state, socket.id), itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), materiaModel });
  saveCastState(pi, state);
  await updateSocketToolScope(pi, ctx, state, socket);
  const dispatch = () => sendMateriaTurn(pi, ctx, state, buildSocketPrompt(state, socket), { diagnostics: nextDiagnostics });
  if (shouldDeferAgentPromptDispatch(nextDiagnostics)) {
    const scheduled = await scheduleDeferredPromptDispatch(pi, ctx, state, socket, dispatch, nextDiagnostics);
    if (scheduled) {
      await appendAdvancementDiagnostic(ctx, state, "dispatch_scheduling", nextDiagnostics, { boundary: "async_prompt_dispatch_attempt", targetSocketId: socket.id, targetMateriaName: socketMateriaName(socket), dispatchTriggerMode: "deferred-triggerTurn", idempotencyKey: deferredPromptDispatchKey(state, socket, nextDiagnostics) });
    }
    return;
  }
  await appendAdvancementDiagnostic(ctx, state, "dispatch_scheduling", nextDiagnostics, { boundary: "async_prompt_dispatch_attempt", targetSocketId: socket.id, targetMateriaName: socketMateriaName(socket), dispatchTriggerMode: nextDiagnostics?.dispatchTriggerMode ?? "immediate-triggerTurn" });
  try {
    await dispatch();
  } catch (error) {
    // Emit lifecycle.socket.failed before cast-level failure so the event bus
    // sees the socket failure event even for prompt-dispatch failures.
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
    await failCast(pi, ctx, state, error, `dispatch:${socket.id}`);
    return;
  }
}

function deferredPromptDispatchKey(state: MateriaCastState, socket: ResolvedMateriaSocket, diagnostics?: AdvancementLifecycleDiagnostics): string {
  const sourceSocket = diagnostics?.sourceSocketId ?? currentSocketId(state) ?? state.phase;
  const sourceVisit = diagnostics?.sourceSocketVisit ?? socketVisit(state, sourceSocket);
  return [state.castId, sourceSocket, sourceVisit, socket.id].join(":");
}

async function scheduleDeferredPromptDispatch(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, socket: ResolvedMateriaSocket, dispatch: () => Promise<void>, diagnostics?: AdvancementLifecycleDiagnostics): Promise<boolean> {
  const idempotencyKey = deferredPromptDispatchKey(state, socket, diagnostics);
  if (deferredPromptDispatchKeys.has(idempotencyKey)) {
    await appendAdvancementDiagnostic(ctx, state, "deferred_dispatch_duplicate_skipped", diagnostics, { boundary: "deferred_prompt_dispatch", targetSocketId: socket.id, targetMateriaName: socketMateriaName(socket), idempotencyKey });
    await appendEvent(state.runState, "deferred_dispatch_duplicate_skipped", { diagnostic: true, castId: state.castId, socket: socket.id, materia: socketMateriaName(socket), sourceSocketId: diagnostics?.sourceSocketId, sourceSocketVisit: diagnostics?.sourceSocketVisit, origin: diagnostics?.origin, promptDispatch: diagnostics?.promptDispatch, idempotencyKey });
    return false;
  }
  deferredPromptDispatchKeys.add(idempotencyKey);
  // Pi ignores/rejects triggerTurn work started inside the prior agent_end stack;
  // defer only prompt dispatch so durable state/artifacts commit synchronously first.
  setTimeout(() => {
    void (async () => {
      try {
        if (!isCurrentDeferredDispatchTarget(ctx, state, socket)) {
          await appendAdvancementDiagnostic(ctx, state, "deferred_dispatch_stale_skipped", diagnostics, { boundary: "deferred_prompt_dispatch", targetSocketId: socket.id, targetMateriaName: socketMateriaName(socket), idempotencyKey });
          await appendEvent(state.runState, "deferred_dispatch_stale_skipped", { diagnostic: true, castId: state.castId, socket: socket.id, materia: socketMateriaName(socket), sourceSocketId: diagnostics?.sourceSocketId, sourceSocketVisit: diagnostics?.sourceSocketVisit, origin: diagnostics?.origin, promptDispatch: diagnostics?.promptDispatch, idempotencyKey });
          return;
        }
        await appendAdvancementDiagnostic(ctx, state, "deferred_dispatch_execution", diagnostics, { boundary: "deferred_prompt_dispatch", targetSocketId: socket.id, targetMateriaName: socketMateriaName(socket), idempotencyKey });
        await dispatch();
      } catch (error) {
        const message = `Deferred pi-materia prompt dispatch failed for socket "${socket.id}": ${errorMessage(error)}`;
        console.error(message, error);
        try {
          await appendEvent(state.runState, "deferred_dispatch_failure", { error: errorMessage(error), socket: socket.id, materia: socketMateriaName(socket), castId: state.castId, diagnostic: true });
          // Emit lifecycle.socket.failed before cast-level failure so the event
          // bus records the socket that failed to dispatch.
          await emitLifecycleEvent(state, "lifecycle.socket.failed", {
            severity: "error",
            socketId: socket.id,
            materia: resolvedMateriaId(socket) ?? socket.id,
            materiaLabel: resolvedMateriaDisplayName(socket),
            visit: socketVisit(state, socket.id),
            ...(state.currentItemKey !== undefined ? { itemKey: state.currentItemKey } : {}),
            ...(state.currentItemLabel !== undefined ? { itemLabel: state.currentItemLabel } : {}),
            payload: { error: errorMessage(error) },
          });
          await failCast(pi, ctx, state, new Error(message), `deferred-dispatch:${socket.id}`);
        } catch (failError) {
          console.error(`Failed to persist deferred dispatch failure for socket "${socket.id}": ${errorMessage(failError)}`, failError);
          ctx.ui.notify(message, "error");
        }
      }
    })();
  }, 0);
  return true;
}

function isCurrentDeferredDispatchTarget(ctx: ExtensionContext, state: MateriaCastState, socket: ResolvedMateriaSocket): boolean {
  const activeState = loadActiveCastState(ctx);
  return activeState?.active === true
    && activeState.castId === state.castId
    && currentSocketId(activeState) === socket.id
    && activeState.awaitingResponse === true
    && currentSocketState(activeState) === "awaiting_agent_response";
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
    failCast: async (nextState, nextError, entryId, failOptions) => {
      // Emit lifecycle.socket.failed before the cast-level failure event.
      // This covers agent socket failures where same-socket recovery is
      // exhausted and the workflow calls failCast internally.
      await emitLifecycleEvent(nextState, "lifecycle.socket.failed", {
        severity: "error",
        socketId: currentSocketId(nextState),
        materia: nextState.currentMateria,
        visit: currentSocketVisit(nextState, undefined),
        ...(nextState.currentItemKey !== undefined ? { itemKey: nextState.currentItemKey } : {}),
        ...(nextState.currentItemLabel !== undefined ? { itemLabel: nextState.currentItemLabel } : {}),
        payload: { error: nextError instanceof Error ? nextError.message : String(nextError) },
      });
      await failCast(pi, ctx, nextState, nextError, entryId, failOptions);
    },
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
    assessContextPressure: (nextState) => assessContextPressureForCompaction(ctx, nextState, { loadConfigFromState }),
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
  let projection: ContextProjectionInput | undefined;
  try {
    const materia = currentMateria(state);
    projection = {
      hiddenPromptContent: state.activeTurnPrompt ?? "",
      syntheticCastContext: buildSyntheticCastContext(state),
      systemPromptSuffix: activeMateriaSystemPrompt(state, materia),
    };
  } catch {
    // Utility socket or missing materia; proceed without projection.
  }

  await maybeRunProactiveCompactionWorkflow(ctx, state, {
    loadConfigFromState,
    appendEvent,
    writeUsage,
    saveState: (nextState) => saveCastState(pi, nextState),
    notifyWarning: (message) => ctx.ui.notify(message, "warning"),
    currentSocketId,
    currentSocketVisit,
    shortMetadataLabel,
  }, projection);
}

function buildSameSocketRecoveryPrompt(state: MateriaCastState): string {
  const socket = currentSocketOrThrow(state);
  const jsonRepairPrompt = buildJsonOutputRepairRetryPrompt(state, socket);
  if (jsonRepairPrompt) return jsonRepairPrompt;
  const recoveryKey = recoveryIdentityKey(state);
  const timeoutHint = buildTimeoutRecoveryHint(state, recoveryKey);
  if (state.activeTurnPrompt) return appendRecoveryHint(state.activeTurnPrompt, timeoutHint);
  if (recoveryTurnMode(state) === "finalization") return appendRecoveryHint(buildMultiTurnFinalizationPrompt(state, socket), timeoutHint);
  return appendRecoveryHint(buildSocketPrompt(state, socket), timeoutHint);
}

function appendRecoveryHint(prompt: string, hint: string | undefined): string {
  if (!hint) return prompt;
  return `${prompt}\n\n${hint}`;
}

const JSON_OUTPUT_REPAIR_EXCERPT_MAX_CHARS = 600;

function buildJsonOutputRepairContext(text: string, error: Error, validationKind: MateriaJsonOutputValidationKind, validationIssues?: NonNullable<MateriaCastState["jsonOutputRepair"]>["validationIssues"]): NonNullable<MateriaCastState["jsonOutputRepair"]> {
  const invalidOutputExcerpt = boundedInvalidOutputExcerpt(text, JSON_OUTPUT_REPAIR_EXCERPT_MAX_CHARS);
  return {
    validationKind,
    errorMessage: error.message,
    validationIssues,
    invalidOutputExcerpt,
    excerptLength: invalidOutputExcerpt.length,
    truncated: text.length > invalidOutputExcerpt.length,
  };
}

function boundedInvalidOutputExcerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} character(s)]`;
}

function classifyJsonOutputValidationKind(error: unknown): MateriaJsonOutputValidationKind {
  return errorMessage(error).startsWith("Invalid JSON output") ? "json_parse" : "handoff_validation";
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

  // Emit lifecycle.cast.failed before flushing the event bus.
  await emitLifecycleEvent(state, "lifecycle.cast.failed", {
    severity: "error",
    message: state.failedReason,
    payload: {
      error: state.failedReason,
      socketId: currentSocketId(state),
      materia: state.currentMateria,
      ...(state.currentItemKey !== undefined ? { itemKey: state.currentItemKey } : {}),
    },
  });

  // Flush event bus before terminal artifacts.
  const bus = getEventBus(state);
  if (bus) {
    try { await bus.flush(); } catch { /* best-effort */ }
    try { await flushBusOutcomes(bus, state.runDir); } catch { /* best-effort */ }
    removeEventBus(state.castId);
  }

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
  state.failedReason = undefined;
  state.updatedAt = Date.now();
  state.runState.lastMessage = message;
  markRunEnded(state);

  // Derive final outcome from accumulated result events and emit
  // lifecycle.cast.completed before flushing the event bus.
  const accumulator = getResultAccumulator(state);
  const outcome = accumulator?.deriveOutcome() ?? "patch_created";
  const resultEvents = accumulator?.getResultEvents() ?? [];
  await emitLifecycleEvent(state, "lifecycle.cast.completed", {
    severity: "info",
    message,
    payload: {
      outcome,
      resultCount: resultEvents.length,
      resultTypes: resultEvents.map((e) => e.type),
    },
  });

  // Flush event bus before terminal artifacts.
  const bus = getEventBus(state);
  if (bus) {
    try { await bus.flush(); } catch { /* best-effort */ }
    try { await flushBusOutcomes(bus, state.runDir); } catch { /* best-effort */ }
    removeEventBus(state.castId);
  }

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
  await appendAdvancementDiagnostic(ctx, state, "dispatch_execution_exit", diagnostics, { boundary: "async_prompt_dispatch_attempt", dispatchTriggerMode: diagnostics?.dispatchTriggerMode ?? "immediate-triggerTurn" });
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
  emitLifecycleEvent,
  cancelNativeCast,
  getEventBus,
  getResultAccumulator,
  removeEventBus,
};


