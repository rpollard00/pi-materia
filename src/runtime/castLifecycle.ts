import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import type { CastStartOptions } from "../application/ports.js";
import {
  extendEdgeTraversalAllowanceForRevive,
  extendSameSocketRecoveryAllowanceForRevive,
} from "../application/recoveryPolicy.js";
import { resolveArtifactRoot } from "../config/config.js";
import { getResolvedPipelineSocket } from "../loadout/loadoutAccessors.js";
import type {
  LoadedConfig,
  MateriaCastState,
  MateriaManifest,
  MateriaRunState,
  PiMateriaConfig,
  ResolvedMateriaPipeline,
  ResolvedMateriaSocket,
} from "../types.js";
import { createRunState } from "../telemetry/usage.js";
import { safeTimestamp } from "../utilities/artifacts.js";
import type { AgentControllerValidationResult, PipelineSocketDetail } from "./agentControllerCompatibility.js";
import type { AdvancementLifecycleDiagnostics } from "./agentPromptDispatch.js";
import type { CastStartFailure } from "./castTermination.js";
import type { EventBus } from "./eventBus.js";
import type { LifecycleEventOverrides } from "./nativeEventing.js";
import { getEffectivePipelineConfig } from "./pipeline.js";
import {
  castLoadoutIdentity,
  hashConfig,
  type PersistedCastLoadoutIdentity,
} from "./configPersistence.js";
import {
  currentSocketId,
  currentSocketOrThrow,
  currentSocketState,
  isAgentResolvedSocket,
  materiaStatusLabel,
  setCurrentSocketId,
  setCurrentSocketState,
  socketMateriaName,
  socketVisit,
} from "./sessionState.js";

export interface CastLifecycleDependencies {
  artifacts: {
    initializeRun(runDir: string, config: PiMateriaConfig, manifest: MateriaManifest): Promise<void>;
    appendEvent(runState: MateriaRunState, type: string, data: unknown): Promise<void>;
    writeUsage(runState: MateriaRunState): Promise<void>;
    shortMetadataLabel(value: unknown): string | undefined;
  };
  state: {
    loadActiveCastState(ctx: ExtensionContext): MateriaCastState | undefined;
    loadCastStateById(ctx: ExtensionContext, castId: string): MateriaCastState | undefined;
    saveCastState(pi: ExtensionAPI, state: MateriaCastState): void;
    loadConfigFromState(state: MateriaCastState): Promise<PiMateriaConfig>;
    resolvePersistedCastLoadoutIdentity(
      state: MateriaCastState,
    ): Promise<PersistedCastLoadoutIdentity | undefined>;
  };
  eventing: {
    initializeCastEventBus(config: PiMateriaConfig, state: MateriaCastState): EventBus | undefined;
    startHeartbeat(state: MateriaCastState, config: PiMateriaConfig): void;
    emitLifecycleEvent(
      state: MateriaCastState,
      type: string,
      overrides?: LifecycleEventOverrides,
    ): Promise<void>;
  };
  validation: {
    buildPipelineSocketDetails(pipeline: ResolvedMateriaPipeline): PipelineSocketDetail[];
    validateAgentControllerMultiTurnSockets(
      config: PiMateriaConfig,
      pipeline: ResolvedMateriaPipeline,
    ): AgentControllerValidationResult;
  };
  execution: {
    startSocket(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      state: MateriaCastState,
      socket: ResolvedMateriaSocket,
      diagnostics?: AdvancementLifecycleDiagnostics,
    ): Promise<void>;
  };
  dispatch: {
    castStartInitialPromptDiagnostics(
      state: MateriaCastState,
      entry: ResolvedMateriaSocket,
      options?: CastStartOptions,
    ): AdvancementLifecycleDiagnostics | undefined;
    updateSocketToolScope(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      state: MateriaCastState,
      socket: ResolvedMateriaSocket,
    ): Promise<void>;
    sendMateriaTurn(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      state: MateriaCastState,
      prompt: string,
    ): Promise<void>;
  };
  agent: {
    startMultiTurnFinalizationTurn(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      state: MateriaCastState,
    ): Promise<void>;
  };
  termination: {
    failCastAtStart(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      state: MateriaCastState,
      eventBus: EventBus | undefined,
      failure: CastStartFailure,
    ): Promise<void>;
  };
  ui: {
    updateWidget(
      ctx: ExtensionContext,
      state: MateriaCastState,
      options?: { replaceOwner?: boolean },
    ): unknown;
  };
}

/**
 * Coordinates native cast entry points while delegating socket, agent,
 * eventing, terminal, persistence, and UI work through explicit seams.
 */
export function createCastLifecycle(deps: CastLifecycleDependencies) {
  async function startNativeCast(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    loaded: LoadedConfig,
    pipeline: ResolvedMateriaPipeline,
    request: string,
    options?: CastStartOptions,
  ): Promise<MateriaCastState> {
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
    await deps.artifacts.initializeRun(runDir, config, { castId, request, configSource: loaded.source, sessionFile: ctx.sessionManager.getSessionFile(), entries: [] });
    await deps.artifacts.writeUsage(runState);
    // Enrich cast_start artifact with resolved per-socket materia names and
    // multiTurn flags so future misconfigurations are diagnosable at a glance.
    const socketDetails = deps.validation.buildPipelineSocketDetails(pipeline);
    await deps.artifacts.appendEvent(runState, "cast_start", { request, configSource: loaded.source, artifactRoot, pipeline: effectivePipeline.pipeline, loadout: effectivePipeline.loadoutName, ...(loadoutIdentity.loadoutId ? { loadoutId: loadoutIdentity.loadoutId } : {}), nativeSession: true, isolatedMateriaContext: true, socketDetails, ...(options?.startEventDetails ?? {}) });

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
    const eventBus = deps.eventing.initializeCastEventBus(config, state);

    // Start heartbeat only when eventing is enabled and the bus is registered.
    // (docs/runtime-eventing.md §7.3: heartbeat is opt-in, default off).
    if (eventBus) {
      deps.eventing.startHeartbeat(state, config);
    }

    // Fail-fast: agent-controller eventing preset + multiTurn agent sockets
    // is a guaranteed stall (controller never sends /materia continue).
    const validation = deps.validation.validateAgentControllerMultiTurnSockets(config, pipeline);
    if (!validation.ok) {
      await deps.termination.failCastAtStart(pi, ctx, state, eventBus, {
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
    await deps.eventing.emitLifecycleEvent(state, "lifecycle.cast.started", {
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
    deps.state.saveCastState(pi, state);
    deps.ui.updateWidget(ctx, state, { replaceOwner: true });
    ctx.ui.notify(`pi-materia cast started. Artifacts: ${runDir}`, "info");
    await deps.execution.startSocket(
      pi,
      ctx,
      state,
      pipeline.entry,
      deps.dispatch.castStartInitialPromptDiagnostics(state, pipeline.entry, options),
    );
    return state;
  }

  async function continueNativeCast(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: MateriaCastState,
  ): Promise<void> {
    if (!state.active) throw new Error("No active pi-materia cast to continue.");
    if (state.awaitingResponse) throw new Error("Materia is already awaiting a Pi agent response.");

    if (currentSocketState(state) === "awaiting_user_refinement") {
      await deps.agent.startMultiTurnFinalizationTurn(pi, ctx, state);
      return;
    }

    await deps.execution.startSocket(pi, ctx, state, currentSocketOrThrow(state));
  }

  async function reviveNativeCast(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    castId: string,
  ): Promise<MateriaCastState> {
    const state = deps.state.loadCastStateById(ctx, castId);
    if (!state) throw new Error(`Unknown pi-materia cast id "${castId}" in this session.`);
    assertNoActiveNativeCast(ctx, state, "reviving");

    const exhaustion = state.recoveryExhaustion;
    if (!exhaustion) {
      throw new Error(`pi-materia cast ${state.castId} is not revivable: missing structured exhaustion metadata. Use /materia recast instead.`);
    }

    if (exhaustion.kind === "edge_traversal_exhausted") {
      const result = extendEdgeTraversalAllowanceForRevive(state);
      await deps.artifacts.appendEvent(state.runState, "cast_revive", {
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
      const persistedLoadoutIdentity = await deps.state.resolvePersistedCastLoadoutIdentity(state);
      state.runState.loadoutId ||= persistedLoadoutIdentity?.loadoutId;
      state.runState.loadoutName ||= persistedLoadoutIdentity?.loadoutName;
      state.runState.lastMessage = `Reviving cast ${state.castId} to blocked target ${exhaustion.to}.`;
      await deps.artifacts.writeUsage(state.runState);
      deps.state.saveCastState(pi, state);

      const targetSocket = getResolvedPipelineSocket(state.pipeline, exhaustion.to);
      if (!targetSocket) throw new Error(`Revive target socket "${exhaustion.to}" is not in the pipeline.`);
      await deps.execution.startSocket(pi, ctx, state, targetSocket);
      ctx.ui.notify(`pi-materia cast ${state.castId} revived to blocked target socket "${exhaustion.to}".`, "info");
      return state;
    }

    // same_socket_recovery_exhausted
    const result = extendSameSocketRecoveryAllowanceForRevive(state);
    const sameSocketExhaustion = exhaustion as { kind: "same_socket_recovery_exhausted"; socket?: string; mode?: string };
    await deps.artifacts.appendEvent(state.runState, "cast_revive", {
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
    deps.state.saveCastState(pi, state);
    return resumeValidatedNativeCast(pi, ctx, state);
  }

  async function resumeNativeCast(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    castId: string,
  ): Promise<MateriaCastState> {
    const state = deps.state.loadCastStateById(ctx, castId);
    if (!state) throw new Error(`Unknown pi-materia cast id "${castId}" in this session.`);
    assertNoActiveNativeCast(ctx, state, "recasting");
    assertRecastableNativeCast(state);
    return resumeValidatedNativeCast(pi, ctx, state);
  }

  function assertNoActiveNativeCast(
    ctx: ExtensionContext,
    state: MateriaCastState,
    action: "recasting" | "reviving",
  ): void {
    const active = deps.state.loadActiveCastState(ctx);
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

  async function resumeValidatedNativeCast(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: MateriaCastState,
  ): Promise<MateriaCastState> {
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
    const persistedLoadoutIdentity = await deps.state.resolvePersistedCastLoadoutIdentity(state);
    state.runState.loadoutId ||= persistedLoadoutIdentity?.loadoutId;
    state.runState.loadoutName ||= persistedLoadoutIdentity?.loadoutName;
    state.runState.currentSocketId = socket.id;
    state.runState.currentMateria = socketMateriaName(socket);
    state.runState.lastMessage = `Recasting from socket ${socket.id}.`;
    await deps.artifacts.appendEvent(state.runState, "cast_recast", { socket: socket.id, materia: socketMateriaName(socket), previousFailure, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: deps.artifacts.shortMetadataLabel(state.currentItemLabel), visit: socketVisit(state, socket.id), reusedActivePrompt: isAgentResolvedSocket(socket) && Boolean(state.activeTurnPrompt) });
    await deps.artifacts.writeUsage(state.runState);

    // Re-initialize the event bus for the resumed/revived cast.
    // The previous bus was cleaned up by failCast, but the castId is the same.
    // Restart heartbeat when eventing is enabled (docs/runtime-eventing.md §7.3).
    try {
      const config = await deps.state.loadConfigFromState(state);
      const eventBus = deps.eventing.initializeCastEventBus(config, state);
      if (eventBus) {
        deps.eventing.startHeartbeat(state, config);
      }
    } catch {
      // Config load or bus init failure is non-fatal for recast.
    }

    deps.state.saveCastState(pi, state);
    ctx.ui.setStatus("materia", materiaStatusLabel(state, socket));
    deps.ui.updateWidget(ctx, state, { replaceOwner: true });

    if (isAgentResolvedSocket(socket) && state.activeTurnPrompt) {
      await deps.dispatch.updateSocketToolScope(pi, ctx, state, socket);
      await deps.dispatch.sendMateriaTurn(pi, ctx, state, state.activeTurnPrompt);
    } else {
      await deps.execution.startSocket(pi, ctx, state, socket);
    }
    ctx.ui.notify(`pi-materia cast ${state.castId} recast from socket "${socket.id}".`, "info");
    return state;
  }

  return {
    continueNativeCast,
    resumeNativeCast,
    reviveNativeCast,
    startNativeCast,
  };
}
