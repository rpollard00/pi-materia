import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  executeUtilitySocketWithDeps,
  type CommandUtilityRequest,
} from "../application/utilityExecution.js";
import {
  DEFAULT_MAX_NO_ADVANCE_CYCLES,
  MateriaNoAdvanceCycleExhaustionError,
  recordNoAdvanceSocketStart,
} from "../application/noAdvanceCycles.js";
import {
  resolveEmptyLoopExhaustionTarget,
  setCurrentItem,
} from "../application/workflowTransitions.js";
import type {
  AppliedMateriaModelSettings,
  MateriaModelSettings,
} from "../config/modelSettings.js";
import type { ModelPolicyDocument } from "../domain/modelPolicy.js";
import { getResolvedPipelineSocket, loopIteratorForSocket } from "../loadout/loadoutAccessors.js";
import type { UtilityInputArtifactInput } from "../infrastructure/castArtifacts.js";
import type {
  MateriaCastState,
  MateriaModelSelection,
  MateriaRunState,
  PiMateriaConfig,
  ResolvedMateriaSocket,
  ResolvedMateriaUtilitySocket,
  UsageReport,
} from "../types.js";
import type {
  AdvancementLifecycleDiagnostics,
  SendMateriaTurnOptions,
} from "./agentPromptDispatch.js";
import type { LifecycleEventOverrides } from "./nativeEventing.js";
import {
  resolvedMateriaDisplayName,
  resolvedMateriaId,
} from "./resolvedMateria.js";
import {
  isAgentResolvedSocket,
  materiaStatusLabel,
  resolvedSocketConfig,
  setCurrentSocketId,
  setCurrentSocketState,
  socketMateriaName,
  socketVisit,
  startTaskAttempt,
} from "./sessionState.js";
import type {
  SocketOutputCommitOptions,
  SocketOutputRoutingOutcome,
} from "./socketOutputCommit.js";

const DEFAULT_MAX_SOCKET_VISITS = 25;

export interface SocketExecutionDependencies {
  artifacts: {
    appendEvent(runState: MateriaRunState, type: string, data: unknown): Promise<void>;
    recordUtilityInput(input: UtilityInputArtifactInput): Promise<string>;
    shortMetadataLabel(value: string | undefined): string | undefined;
    writeUsage(runState: MateriaRunState): Promise<void>;
  };
  state: {
    loadConfigFromState(state: MateriaCastState): Promise<PiMateriaConfig>;
    saveCastState(pi: ExtensionAPI, state: MateriaCastState): void;
  };
  eventing: {
    emitLifecycleEvent(
      state: MateriaCastState,
      type: string,
      overrides?: LifecycleEventOverrides,
    ): Promise<void>;
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
  utility: {
    executeCommand(input: CommandUtilityRequest): Promise<string>;
    executeBuiltInUtility(name: string, input: Record<string, unknown>): Promise<string> | string;
    hasBuiltInUtility(name: string): boolean;
  };
  prompts: {
    appendAdvancementDiagnostic(
      ctx: ExtensionContext,
      state: MateriaCastState,
      stage: string,
      diagnostics?: AdvancementLifecycleDiagnostics,
      details?: Record<string, unknown>,
    ): Promise<void>;
    dispatchSocketPrompt(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      state: MateriaCastState,
      socket: ResolvedMateriaSocket,
      options?: SendMateriaTurnOptions,
    ): Promise<void>;
    updateSocketToolScope(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      state: MateriaCastState,
      socket: ResolvedMateriaSocket,
    ): Promise<void>;
  };
  output: {
    commitSocketOutput(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      state: MateriaCastState,
      text: string,
      entryId: string,
      options?: SocketOutputCommitOptions,
    ): Promise<SocketOutputRoutingOutcome>;
  };
  lifecycle: {
    failCast(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      state: MateriaCastState,
      error: unknown,
      entryId?: string,
      options?: { preserveRecoveryExhaustion?: boolean },
    ): Promise<void>;
    finishCast(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      state: MateriaCastState,
      entryId: string,
      message: string,
    ): Promise<void>;
  };
  ui: {
    updateWidget(ctx: ExtensionContext, state: MateriaCastState): unknown;
  };
}

/**
 * Coordinates socket startup and graph advancement while delegating output
 * commits, prompt dispatch, and terminal transitions through explicit seams.
 * This keeps socket execution independent from the native lifecycle module.
 */
export function createSocketExecution(deps: SocketExecutionDependencies) {
  async function completeSocket(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: MateriaCastState,
    text: string,
    entryId: string,
    options: SocketOutputCommitOptions = {},
  ): Promise<void> {
    const outcome = await deps.output.commitSocketOutput(pi, ctx, state, text, entryId, options);
    if (outcome.kind === "route") {
      await advanceToSocket(pi, ctx, state, outcome.targetId, entryId, outcome.diagnostics);
    }
  }

  async function advanceToSocket(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: MateriaCastState,
    targetId: string | undefined,
    entryId: string,
    diagnostics?: AdvancementLifecycleDiagnostics,
  ): Promise<void> {
    const target = targetId ?? "end";
    const nextDiagnostics = diagnostics ? { ...diagnostics, nextSocketTarget: target } : undefined;
    await deps.prompts.appendAdvancementDiagnostic(
      ctx,
      state,
      "socket_advancement_entry",
      nextDiagnostics,
      { boundary: "sync_state_advancement", entryId },
    );
    if (target === "end") {
      await deps.lifecycle.finishCast(pi, ctx, state, entryId, "Cast complete.");
      await deps.prompts.appendAdvancementDiagnostic(
        ctx,
        state,
        "socket_advancement_exit",
        nextDiagnostics,
        { boundary: "sync_state_advancement", entryId },
      );
      return;
    }
    const socket = getResolvedPipelineSocket(state.pipeline, target);
    if (!socket) throw new Error(`Unknown graph target "${target}"`);
    await startSocket(pi, ctx, state, socket, nextDiagnostics);
    await deps.prompts.appendAdvancementDiagnostic(
      ctx,
      state,
      "socket_advancement_exit",
      nextDiagnostics,
      { boundary: "sync_state_advancement", entryId },
    );
  }

  async function startSocket(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: MateriaCastState,
    socket: ResolvedMateriaSocket,
    diagnostics?: AdvancementLifecycleDiagnostics,
  ): Promise<void> {
    const config = await deps.state.loadConfigFromState(state);
    const nextDiagnostics = diagnostics ? { ...diagnostics, nextSocketTarget: socket.id } : undefined;
    await deps.prompts.appendAdvancementDiagnostic(
      ctx,
      state,
      "next_socket_start_entry",
      nextDiagnostics,
      {
        boundary: "sync_state_advancement",
        targetSocketId: socket.id,
        targetMateriaName: socketMateriaName(socket),
      },
    );
    const hasItem = setCurrentItem(state, socket);
    const loop = loopIteratorForSocket(state.pipeline, socket.id);
    if (loop && !hasItem) {
      return await advanceToSocket(
        pi,
        ctx,
        state,
        resolveEmptyLoopExhaustionTarget(state, socket, loop.done),
        "foreach-empty",
        nextDiagnostics,
      );
    }
    try {
      recordNoAdvanceSocketStart(
        state,
        socket.id,
        config.limits?.maxNoAdvanceCycles ?? DEFAULT_MAX_NO_ADVANCE_CYCLES,
      );
    } catch (error) {
      if (!(error instanceof MateriaNoAdvanceCycleExhaustionError)) throw error;
      await deps.artifacts.appendEvent(state.runState, "no_advance_cycle_exhausted", {
        itemKey: error.itemKey,
        count: error.count,
        limit: error.limit,
        sockets: error.sockets,
        targetSocket: socket.id,
      });
      await deps.lifecycle.failCast(
        pi,
        ctx,
        state,
        error,
        `no-advance:${error.itemKey}:${error.count}`,
      );
      return;
    }
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
    await deps.artifacts.writeUsage(state.runState);
    await deps.artifacts.appendEvent(state.runState, "socket_start", {
      socket: socket.id,
      materia: socketMateriaName(socket),
      materiaLabel: resolvedMateriaDisplayName(socket),
      itemKey: state.currentItemKey,
      itemLabel: state.currentItemLabel,
      itemLabelShort: deps.artifacts.shortMetadataLabel(state.currentItemLabel),
      visit: socketVisit(state, socket.id),
    });

    await deps.eventing.emitLifecycleEvent(state, "lifecycle.socket.started", {
      severity: "debug",
      socketId: socket.id,
      materia: resolvedMateriaId(socket) ?? socket.id,
      materiaLabel: resolvedMateriaDisplayName(socket),
      visit: socketVisit(state, socket.id),
      ...(state.currentItemKey !== undefined ? { itemKey: state.currentItemKey } : {}),
      ...(state.currentItemLabel !== undefined ? { itemLabel: state.currentItemLabel } : {}),
    });

    deps.state.saveCastState(pi, state);
    deps.ui.updateWidget(ctx, state);
    ctx.ui.setStatus("materia", materiaStatusLabel(state, socket));
    await deps.prompts.appendAdvancementDiagnostic(
      ctx,
      state,
      "next_socket_start_exit",
      nextDiagnostics,
      {
        boundary: "sync_state_advancement",
        targetSocketId: socket.id,
        targetMateriaName: socketMateriaName(socket),
        agentSocket: isAgentResolvedSocket(socket),
      },
    );

    if (!isAgentResolvedSocket(socket)) {
      state.awaitingResponse = false;
      setCurrentSocketState(state, "running_utility");
      state.currentMateria = socketMateriaName(socket);
      state.currentMateriaModel = undefined;
      state.runState.currentMateria = socketMateriaName(socket);
      state.runState.currentMateriaModel = undefined;
      deps.state.saveCastState(pi, state);
      try {
        const result = await executeUtilitySocket(state, socket);
        await completeSocket(pi, ctx, state, result.output, result.entryId, {
          diagnostics: nextDiagnostics,
        });
      } catch (error) {
        await deps.eventing.emitLifecycleEvent(state, "lifecycle.socket.failed", {
          severity: "error",
          socketId: socket.id,
          materia: resolvedMateriaId(socket) ?? socket.id,
          materiaLabel: resolvedMateriaDisplayName(socket),
          visit: socketVisit(state, socket.id),
          ...(state.currentItemKey !== undefined ? { itemKey: state.currentItemKey } : {}),
          ...(state.currentItemLabel !== undefined ? { itemLabel: state.currentItemLabel } : {}),
          payload: { error: error instanceof Error ? error.message : String(error) },
        });
        await deps.lifecycle.failCast(
          pi,
          ctx,
          state,
          error,
          `utility:${socket.id}:${socketVisit(state, socket.id)}`,
        );
      }
      return;
    }

    state.awaitingResponse = true;
    setCurrentSocketState(state, "awaiting_agent_response");
    deps.state.saveCastState(pi, state);
    const appliedModel = await deps.models.applyMateriaModelSettings(pi, ctx, {
      materiaName: resolvedSocketConfig(socket).materia,
      model: socket.materia.model,
      thinking: socket.materia.thinking,
      policy: await deps.models.resolveActiveModelPolicy(pi, ctx),
    });
    const materiaModel = deps.models.materiaModelSelection(appliedModel);
    state.currentMateriaModel = materiaModel;
    state.runState.currentMateriaModel = materiaModel;
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
    });
    deps.state.saveCastState(pi, state);
    await deps.prompts.updateSocketToolScope(pi, ctx, state, socket);
    await deps.prompts.dispatchSocketPrompt(pi, ctx, state, socket, {
      diagnostics: nextDiagnostics,
      skipProactiveCompaction: appliedModel.modelSwitched === true,
    });
  }

  async function executeUtilitySocket(
    state: MateriaCastState,
    socket: ResolvedMateriaUtilitySocket,
  ): Promise<{ output: string; entryId: string }> {
    return executeUtilitySocketWithDeps(state, socket, {
      executeCommand: deps.utility.executeCommand,
      executeBuiltInUtility: deps.utility.executeBuiltInUtility,
      hasBuiltInUtility: deps.utility.hasBuiltInUtility,
      recordUtilityInput: (input) => deps.artifacts.recordUtilityInput({
        state,
        socketId: socket.id,
        materia: socketMateriaName(socket),
        materiaLabel: resolvedMateriaDisplayName(socket),
        visit: socketVisit(state, socket.id),
        input,
      }),
      appendUtilityInputEvent: (artifact, visit) => deps.artifacts.appendEvent(
        state.runState,
        "utility_input",
        {
          socket: socket.id,
          materia: socketMateriaName(socket),
          materiaLabel: resolvedMateriaDisplayName(socket),
          artifact,
          itemKey: state.currentItemKey,
          itemLabel: state.currentItemLabel,
          itemLabelShort: deps.artifacts.shortMetadataLabel(state.currentItemLabel),
          visit,
        },
      ),
    });
  }

  return {
    advanceToSocket,
    completeSocket,
    startSocket,
  };
}

function enforceSocketVisitLimit(
  state: MateriaCastState,
  socket: ResolvedMateriaSocket,
  config: PiMateriaConfig,
): void {
  const count = (state.visits[socket.id] ?? 0) + 1;
  const limit = resolvedSocketConfig(socket).limits?.maxVisits
    ?? config.limits?.maxSocketVisits
    ?? DEFAULT_MAX_SOCKET_VISITS;
  if (count > limit) {
    throw new Error(`Materia socket visit limit exceeded for ${socket.id} (${count}/${limit}).`);
  }
  state.visits[socket.id] = count;
}
