import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  activeMateriaSystemPrompt,
  buildMultiTurnFinalizationPrompt,
  buildSocketPrompt,
  buildSyntheticCastContext,
  isPausedMultiTurnRefinement,
  materiaPrompt,
  multiTurnRefinementGuidance,
} from "../application/promptAssembly.js";
import { classifyTurnFailure } from "../application/recoveryPolicy.js";
import type {
  AppliedMateriaModelSettings,
  MateriaModelSettings,
} from "../config/modelSettings.js";
import type { ModelPolicyDocument } from "../domain/modelPolicy.js";
import type {
  MateriaCastState,
  MateriaManifestEntry,
  MateriaModelSelection,
  MateriaRunState,
  ResolvedMateriaSocket,
  UsageReport,
} from "../types.js";
import { safeTimestamp } from "../utilities/artifacts.js";
import {
  agentEndFailureMessage,
  assistantErrorMessage,
  assistantText,
  captureUsage,
  describeStaleCompletion,
  findLatestAssistantEntry,
  type StaleCompletionReason,
} from "./agentTurnState.js";
import type {
  AdvancementLifecycleDiagnostics,
  SendMateriaTurnOptions,
} from "./agentPromptDispatch.js";
import type { AgentFinalizationCompletion } from "./agentFinalizationRuntime.js";
import type { LifecycleEventOverrides } from "./nativeEventing.js";
import {
  resolvedMateriaDisplayName,
  resolvedMateriaId,
} from "./resolvedMateria.js";
import {
  activeResolvedSocket,
  currentMateria,
  currentRefinementTurn,
  currentSocketId,
  currentSocketOrThrow,
  currentSocketState,
  currentSocketVisit,
  isAgentResolvedSocket,
  isMultiTurnResolvedAgentSocket,
  materiaStatusLabel,
  resolvedSocketConfig,
  setCurrentSocketState,
  socketMateriaName,
  socketVisit,
} from "./sessionState.js";
import type { SocketOutputCommitOptions } from "./socketOutputCommit.js";
import type { TurnRecoveryOptions } from "./turnRecovery.js";

export interface AgentLifecycleDependencies {
  artifacts: {
    appendEvent(runState: MateriaRunState, type: string, data: unknown): Promise<void>;
    appendManifest(
      state: MateriaCastState,
      entry: Omit<MateriaManifestEntry, "timestamp">,
    ): Promise<void>;
    recordMultiTurnRefinement(
      state: MateriaCastState,
      socket: ResolvedMateriaSocket,
      text: string,
      entryId: string,
    ): Promise<{ artifact: string; turn: number }>;
    writeContextArtifact(
      pi: ExtensionAPI,
      state: MateriaCastState,
      prompt: string,
      suffix?: string,
    ): Promise<string>;
    writeUsage(runState: MateriaRunState): Promise<void>;
    shortMetadataLabel(value: string | undefined): string | undefined;
  };
  state: {
    loadActiveCastState(ctx: ExtensionContext): MateriaCastState | undefined;
    saveCastState(pi: ExtensionAPI, state: MateriaCastState): void;
    recordActiveTurnProvenance(state: MateriaCastState): void;
  };
  models: {
    applyMateriaModelSettings(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      settings: MateriaModelSettings,
    ): Promise<AppliedMateriaModelSettings>;
    resolveActiveModelPolicy(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
    ): Promise<ModelPolicyDocument | undefined>;
    materiaModelSelection(applied: AppliedMateriaModelSettings): MateriaModelSelection;
    recordUsageModelSelection(
      report: UsageReport,
      key: {
        socket: string;
        materia: string;
        taskId?: string;
        attempt?: number;
        materiaModel: MateriaModelSelection;
      },
    ): void;
  };
  eventing: {
    emitLifecycleEvent(
      state: MateriaCastState,
      type: string,
      overrides?: LifecycleEventOverrides,
    ): Promise<void>;
  };
  recovery: {
    preserveAwaitingAfterTransientTransportFailure(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      state: MateriaCastState,
      error: unknown,
      options?: Pick<TurnRecoveryOptions, "entryId">,
    ): Promise<void>;
    handleSameSocketRecoverableTurnFailure(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      state: MateriaCastState,
      error: unknown,
      options?: TurnRecoveryOptions,
    ): Promise<boolean>;
    shouldRetryGenericTurnFailure(error: unknown): boolean;
  };
  dispatch: {
    agentEndAdvancementDiagnostics(
      state: MateriaCastState,
      socket: ResolvedMateriaSocket,
      options?: { finalizedMultiTurn?: boolean },
    ): AdvancementLifecycleDiagnostics;
    appendAdvancementDiagnostic(
      ctx: ExtensionContext,
      state: MateriaCastState,
      stage: string,
      diagnostics?: AdvancementLifecycleDiagnostics,
      details?: Record<string, unknown>,
    ): Promise<void>;
    sendMateriaTurn(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      state: MateriaCastState,
      prompt: string,
      options?: SendMateriaTurnOptions,
    ): Promise<void>;
    updateSocketToolScope(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      state: MateriaCastState,
      socket: ResolvedMateriaSocket,
    ): Promise<void>;
  };
  completion: {
    completeSocket(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      state: MateriaCastState,
      text: string,
      entryId: string,
      options?: SocketOutputCommitOptions,
    ): Promise<void>;
  };
  finalization: {
    completion(session: object, state: MateriaCastState, assistantText: string): AgentFinalizationCompletion;
    fallbackToDirect(pi: ExtensionAPI, session: object, state: MateriaCastState): boolean;
    release(pi: ExtensionAPI, session: object, state: MateriaCastState): void;
  };
  termination: {
    failCast(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      state: MateriaCastState,
      error: unknown,
      entryId?: string,
      options?: { preserveRecoveryExhaustion?: boolean },
    ): Promise<void>;
  };
  ui: {
    updateWidget(ctx: ExtensionContext, state: MateriaCastState): unknown;
  };
}

/**
 * Coordinates native agent completion and multi-turn refinement lifecycle
 * behavior. Completion, recovery, prompt dispatch, and termination are explicit
 * dependencies so this module remains independent from the composition root.
 */
export function createAgentLifecycle(deps: AgentLifecycleDependencies) {
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

  async function startMultiTurnFinalizationTurn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: MateriaCastState,
  ): Promise<void> {
    if (!isPausedMultiTurnRefinement(state)) {
      throw new Error("Materia is awaiting user refinement, but the current socket's resolved materia is not multi-turn.");
    }
    const socket = currentSocketOrThrow(state);
    if (!isMultiTurnResolvedAgentSocket(socket)) {
      state.multiTurnFinalizing = false;
      throw new Error(`Cannot finalize refinement for socket "${socket.id}" because its resolved materia is not multi-turn.`);
    }
    const appliedModel = await deps.models.applyMateriaModelSettings(pi, ctx, {
      materiaName: resolvedSocketConfig(socket).materia,
      model: socket.materia.model,
      thinking: socket.materia.thinking,
      policy: await deps.models.resolveActiveModelPolicy(pi, ctx),
    });
    const materiaModel = deps.models.materiaModelSelection(appliedModel);
    state.currentMateria = socketMateriaName(socket);
    state.currentMateriaModel = materiaModel;
    state.runState.currentMateria = socketMateriaName(socket);
    state.runState.currentMateriaModel = materiaModel;
    state.awaitingResponse = true;
    setCurrentSocketState(state, "awaiting_agent_response");
    state.multiTurnFinalizing = true;
    state.updatedAt = Date.now();
    const refinementTurn = currentRefinementTurn(state, socket.id) + 1;
    deps.models.recordUsageModelSelection(state.runState.usage, {
      socket: socket.id,
      materia: resolvedSocketConfig(socket).materia,
      taskId: state.currentItemKey,
      attempt: state.runState.attempt,
      materiaModel,
    });
    await deps.artifacts.writeUsage(state.runState);
    await deps.artifacts.appendEvent(state.runState, "materia_model_settings", {
      socket: socket.id,
      materia: resolvedSocketConfig(socket).materia,
      visit: socketVisit(state, socket.id),
      itemKey: state.currentItemKey,
      itemLabel: state.currentItemLabel,
      itemLabelShort: deps.artifacts.shortMetadataLabel(state.currentItemLabel),
      materiaModel,
      refinementTurn,
      finalization: true,
    });
    await deps.dispatch.updateSocketToolScope(pi, ctx, state, socket);
    deps.state.saveCastState(pi, state);
    ctx.ui.setStatus("materia", materiaStatusLabel(state, socket));
    deps.ui.updateWidget(ctx, state);
    await deps.dispatch.sendMateriaTurn(pi, ctx, state, buildMultiTurnFinalizationPrompt(state, socket), {
      skipProactiveCompaction: appliedModel.modelSwitched,
    });
  }

  /** Record diagnostics for an agent completion that does not own the active turn. */
  async function recordIgnoredStaleCompletion(
    state: MateriaCastState,
    reason: StaleCompletionReason,
  ): Promise<void> {
    await deps.artifacts.appendEvent(state.runState, "stale_agent_end_ignored", {
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
    await deps.eventing.emitLifecycleEvent(state, "lifecycle.socket.stale_completion_ignored", {
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

  async function emitSocketFailure(state: MateriaCastState, error: unknown): Promise<void> {
    await deps.eventing.emitLifecycleEvent(state, "lifecycle.socket.failed", {
      severity: "error",
      socketId: currentSocketId(state),
      materia: state.currentMateria,
      visit: currentSocketVisit(state, undefined),
      ...(state.currentItemKey !== undefined ? { itemKey: state.currentItemKey } : {}),
      ...(state.currentItemLabel !== undefined ? { itemLabel: state.currentItemLabel } : {}),
      payload: { error: error instanceof Error ? error.message : String(error) },
    });
  }

  function prepareDirectFinalizationFallback(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: MateriaCastState,
  ): boolean {
    if (!deps.finalization.fallbackToDirect(pi, ctx.sessionManager, state)) return false;
    const socket = currentSocketOrThrow(state);
    state.lastAssistantText = undefined;
    state.activeTurnPrompt = isMultiTurnResolvedAgentSocket(socket) && state.multiTurnFinalizing === true
      ? buildMultiTurnFinalizationPrompt(state, socket)
      : buildSocketPrompt(state, socket);
    return true;
  }

  async function recoverMissingToolCommit(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: MateriaCastState,
    entryId: string,
  ): Promise<void> {
    prepareDirectFinalizationFallback(pi, ctx, state);
    const error = new Error(`Tool-backed finalization for socket "${currentSocketId(state) ?? state.phase}" ended without materia_handoff_commit; partial tool submissions were discarded and the bounded retry will use direct JSON.`);
    await deps.artifacts.appendEvent(state.runState, "agent_finalization_protocol_failure", {
      strategy: "tool_backed",
      failure: "missing_commit",
      fallback: "direct_json",
      socket: currentSocketId(state),
      visit: currentSocketVisit(state, undefined),
      entryId,
    });
    const recovered = await deps.recovery.handleSameSocketRecoverableTurnFailure(pi, ctx, state, error, {
      entryId,
      allowGenericTurnFailure: true,
    });
    if (!recovered) {
      await emitSocketFailure(state, error);
      await deps.termination.failCast(pi, ctx, state, error, entryId);
    }
  }

  async function handleAgentEnd(
    pi: ExtensionAPI,
    event: { messages: unknown[] },
    ctx: ExtensionContext,
  ): Promise<void> {
    const state = deps.state.loadActiveCastState(ctx);
    if (!state?.active) return;
    const socketAtEnd = currentSocketOrThrow(state);
    const clearedStaleFinalizing = clearStaleMultiTurnFinalizing(state);
    if (clearedStaleFinalizing) deps.state.saveCastState(pi, state);
    const acceptingRefinement = !state.awaitingResponse
      && currentSocketState(state) === "awaiting_user_refinement"
      && isMultiTurnResolvedAgentSocket(socketAtEnd);
    if (!state.awaitingResponse && !acceptingRefinement) return;

    const latest = findLatestAssistantEntry(ctx.sessionManager.getEntries(), state.lastProcessedEntryId);
    if (!latest || latest.entry.id === state.lastProcessedEntryId) {
      const eventFailure = agentEndFailureMessage(event);
      if (!eventFailure) return;
      const error = new Error(`Pi agent turn failed before producing an assistant response for socket "${currentSocketId(state) ?? state.phase}": ${eventFailure}`);
      if (classifyTurnFailure(error) === "transient_transport") {
        await deps.recovery.preserveAwaitingAfterTransientTransportFailure(pi, ctx, state, error);
        return;
      }
      const toolFallback = prepareDirectFinalizationFallback(pi, ctx, state);
      const recovered = await deps.recovery.handleSameSocketRecoverableTurnFailure(pi, ctx, state, error, {
        allowGenericTurnFailure: toolFallback || deps.recovery.shouldRetryGenericTurnFailure(error),
      });
      if (!recovered) {
        await emitSocketFailure(state, error);
        await deps.termination.failCast(pi, ctx, state, error);
      }
      return;
    }

    // Ignore duplicate or stale completions that do not own the active turn.
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
        await deps.recovery.preserveAwaitingAfterTransientTransportFailure(pi, ctx, state, error, {
          entryId: latest.entry.id,
        });
        return;
      }
      const toolFallback = prepareDirectFinalizationFallback(pi, ctx, state);
      const recovered = await deps.recovery.handleSameSocketRecoverableTurnFailure(pi, ctx, state, error, {
        entryId: latest.entry.id,
        allowGenericTurnFailure: toolFallback || deps.recovery.shouldRetryGenericTurnFailure(error),
      });
      if (!recovered) {
        await emitSocketFailure(state, error);
        await deps.termination.failCast(pi, ctx, state, error, latest.entry.id);
      }
      return;
    }

    state.awaitingResponse = false;
    setCurrentSocketState(state, "idle");
    state.updatedAt = Date.now();

    try {
      const socket = currentSocketOrThrow(state);
      const finalization = deps.finalization.completion(ctx.sessionManager, state, text);
      if (finalization.kind === "missing_tool_commit") {
        await recoverMissingToolCommit(pi, ctx, state, latest.entry.id);
        return;
      }
      let completionText = text;
      if (finalization.kind === "tool_commit") {
        completionText = finalization.commit.json;
        state.lastAssistantText = completionText;
        if (finalization.ignoredText) {
          await deps.artifacts.appendEvent(state.runState, "agent_finalization_protocol_conflict", {
            strategy: "tool_backed",
            resolution: "tool_commit_authoritative_text_ignored",
            ignoredTextBytes: finalization.ignoredTextBytes,
            socket: socket.id,
            visit: socketVisit(state, socket.id),
            entryId: latest.entry.id,
          });
        }
        deps.finalization.release(pi, ctx.sessionManager, state);
      }
      if (isMultiTurnResolvedAgentSocket(socket)) {
        if (wasAwaitingFinalization) {
          const diagnostics = deps.dispatch.agentEndAdvancementDiagnostics(state, socket, {
            finalizedMultiTurn: true,
          });
          await deps.dispatch.appendAdvancementDiagnostic(
            ctx,
            state,
            "finalized_multi_turn_handle_entry",
            diagnostics,
            { boundary: "sync_state_advancement" },
          );
          state.multiTurnFinalizing = false;
          setCurrentSocketState(state, "idle");
          deps.state.saveCastState(pi, state);
          await deps.completion.completeSocket(pi, ctx, state, completionText, latest.entry.id, {
            finalizedMultiTurn: true,
            diagnostics,
          });
          await deps.dispatch.appendAdvancementDiagnostic(
            ctx,
            state,
            "finalized_multi_turn_handle_exit",
            diagnostics,
            { boundary: "sync_state_advancement" },
          );
          return;
        }
        state.multiTurnFinalizing = false;
        const refinement = await deps.artifacts.recordMultiTurnRefinement(
          state,
          socket,
          text,
          latest.entry.id,
        );
        setCurrentSocketState(state, "awaiting_user_refinement");
        state.runState.lastMessage = `Multi-turn socket ${socket.id} waiting for refinement; run /materia continue to finalize.`;
        await deps.artifacts.writeUsage(state.runState);
        await deps.artifacts.appendEvent(state.runState, "socket_refinement", {
          socket: socket.id,
          materia: socketMateriaName(socket),
          artifact: refinement.artifact,
          entryId: latest.entry.id,
          refinementTurn: refinement.turn,
          itemKey: state.currentItemKey,
          itemLabel: state.currentItemLabel,
          itemLabelShort: deps.artifacts.shortMetadataLabel(state.currentItemLabel),
          materiaModel: state.currentMateriaModel,
        });
        await deps.eventing.emitLifecycleEvent(state, "lifecycle.refinement.waiting", {
          severity: "info",
          socketId: socket.id,
          materia: resolvedMateriaId(socket) ?? socket.id,
          materiaLabel: resolvedMateriaDisplayName(socket),
          visit: socketVisit(state, socket.id),
          ...(state.currentItemKey !== undefined ? { itemKey: state.currentItemKey } : {}),
          ...(state.currentItemLabel !== undefined ? { itemLabel: state.currentItemLabel } : {}),
          payload: { refinementTurn: refinement.turn },
        });

        deps.state.saveCastState(pi, state);
        ctx.ui.setStatus("materia", materiaStatusLabel(state, socket, {
          suffix: "refine",
          includeItem: false,
        }));
        deps.ui.updateWidget(ctx, state);
        ctx.ui.notify(`pi-materia multi-turn socket "${socket.id}" is waiting for refinement; run /materia continue to finalize.`, "info");
        return;
      }
      await deps.completion.completeSocket(pi, ctx, state, completionText, latest.entry.id, {
        diagnostics: deps.dispatch.agentEndAdvancementDiagnostics(state, socket),
      });
    } catch (error) {
      await emitSocketFailure(state, error);
      await deps.termination.failCast(pi, ctx, state, error, latest.entry.id);
    }
  }

  async function prepareAgentStartSystemPrompt(input: {
    pi: ExtensionAPI;
    session: ExtensionContext;
    state: MateriaCastState;
    systemPrompt: string;
  }): Promise<string | undefined> {
    const { pi, session: ctx, state, systemPrompt } = input;
    if (currentSocketState(state) === "awaiting_user_refinement") {
      await prepareMultiTurnRefinementTurn(pi, ctx, state);
    }
    if (!state.awaitingResponse) return undefined;
    const materia = currentMateria(state);
    if (!materia) return undefined;
    return `${systemPrompt}\n\nMateria active materia (${currentSocketId(state) ?? state.phase}):\n${activeMateriaSystemPrompt(state, materia)}`;
  }

  async function prepareMultiTurnRefinementTurn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: MateriaCastState,
  ): Promise<void> {
    if (!isPausedMultiTurnRefinement(state)) return;
    const socket = currentSocketOrThrow(state);
    if (!isAgentResolvedSocket(socket)) return;

    const appliedModel = await deps.models.applyMateriaModelSettings(pi, ctx, {
      materiaName: resolvedSocketConfig(socket).materia,
      model: socket.materia.model,
      thinking: socket.materia.thinking,
      policy: await deps.models.resolveActiveModelPolicy(pi, ctx),
    });
    const materiaModel = deps.models.materiaModelSelection(appliedModel);
    state.currentMateria = socketMateriaName(socket);
    state.currentMateriaModel = materiaModel;
    state.runState.currentMateria = socketMateriaName(socket);
    state.runState.currentMateriaModel = materiaModel;
    state.awaitingResponse = true;
    setCurrentSocketState(state, "awaiting_agent_response");
    state.multiTurnFinalizing = false;
    state.activeTurnPrompt = materiaPrompt(socket.materia, state, [
      buildSyntheticCastContext(state),
      multiTurnRefinementGuidance(),
    ]);
    deps.state.recordActiveTurnProvenance(state);
    state.updatedAt = Date.now();
    const refinementTurn = currentRefinementTurn(state, socket.id) + 1;
    deps.models.recordUsageModelSelection(state.runState.usage, {
      socket: socket.id,
      materia: resolvedSocketConfig(socket).materia,
      taskId: state.currentItemKey,
      attempt: state.runState.attempt,
      materiaModel,
    });
    await deps.artifacts.writeUsage(state.runState);
    await deps.artifacts.appendEvent(state.runState, "materia_model_settings", {
      socket: socket.id,
      materia: resolvedSocketConfig(socket).materia,
      visit: socketVisit(state, socket.id),
      itemKey: state.currentItemKey,
      itemLabel: state.currentItemLabel,
      itemLabelShort: deps.artifacts.shortMetadataLabel(state.currentItemLabel),
      materiaModel,
      refinementTurn,
    });
    const contextArtifact = await deps.artifacts.writeContextArtifact(
      pi,
      state,
      buildSyntheticCastContext(state),
      `refinement-${refinementTurn}-${safeTimestamp()}`,
    );
    await deps.artifacts.appendManifest(state, {
      phase: state.phase,
      socket: currentSocketId(state),
      materia: state.currentMateria,
      itemKey: state.currentItemKey,
      visit: socketVisit(state, socket.id),
      artifact: contextArtifact,
      kind: "context_refinement",
      refinementTurn,
      materiaModel: state.currentMateriaModel,
    });
    await deps.artifacts.appendEvent(state.runState, "context_refinement", {
      socket: socket.id,
      materia: socketMateriaName(socket),
      artifact: contextArtifact,
      refinementTurn,
      itemKey: state.currentItemKey,
      itemLabel: state.currentItemLabel,
      itemLabelShort: deps.artifacts.shortMetadataLabel(state.currentItemLabel),
      materiaModel,
    });
    await deps.dispatch.updateSocketToolScope(pi, ctx, state, socket);
    deps.state.saveCastState(pi, state);
    ctx.ui.setStatus("materia", materiaStatusLabel(state, socket));
    deps.ui.updateWidget(ctx, state);
  }

  return {
    handleAgentEnd,
    prepareAgentStartSystemPrompt,
    prepareMultiTurnRefinementTurn,
    startMultiTurnFinalizationTurn,
  };
}
