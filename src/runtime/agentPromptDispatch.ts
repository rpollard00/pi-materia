import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  maybeRunProactiveCompactionWorkflow,
  type ContextProjectionInput,
} from "../application/compactionWorkflow.js";
import type { CastStartOptions } from "../application/ports.js";
import {
  activeMateriaSystemPrompt,
  buildSocketPrompt,
  buildSyntheticCastContext,
} from "../application/promptAssembly.js";
import { errorMessage } from "../application/recoveryPolicy.js";
import {
  formatMateriaCastContent,
  formatMateriaNotificationDisplay,
} from "../presentation/notificationFormatting.js";
import type {
  MateriaAgentConfig,
  MateriaCastState,
  MateriaManifestEntry,
  MateriaRunState,
  PiMateriaConfig,
  ResolvedMateriaSocket,
} from "../types.js";
import type {
  ToolScopeRuntimeWarning,
  UpdateToolScopeOptions,
} from "./agentTurnState.js";
import type { AgentFinalizationActivation } from "./agentFinalizationRuntime.js";
import type { LifecycleEventOverrides } from "./nativeEventing.js";
import { resolvedMateriaDisplayName, resolvedMateriaId } from "./resolvedMateria.js";
import {
  activeResolvedSocket,
  currentMateria,
  currentSocketId,
  currentSocketState,
  currentSocketVisit,
  isAgentResolvedSocket,
  socketMateriaName,
  socketVisit,
} from "./sessionState.js";

export type AdvancementOrigin = "initial" | "command" | "agent_end";
export type PromptDispatchMode = "immediate" | "defer-agent-trigger";

export interface AdvancementLifecycleDiagnostics {
  finalizedMultiTurn?: boolean;
  origin?: AdvancementOrigin;
  promptDispatch?: PromptDispatchMode;
  sourceSocketId?: string;
  sourceSocketVisit?: number;
  sourceMateriaName?: string;
  nextSocketTarget?: string;
  dispatchTriggerMode?: string;
}

export interface SendMateriaTurnOptions {
  skipProactiveCompaction?: boolean;
  diagnostics?: AdvancementLifecycleDiagnostics;
}

export interface AgentPromptDispatchDependencies {
  artifacts: {
    appendEvent(runState: MateriaRunState, type: string, data: unknown): Promise<void>;
    appendManifest(
      state: MateriaCastState,
      entry: Omit<MateriaManifestEntry, "timestamp">,
    ): Promise<void>;
    writeContextArtifact(
      pi: ExtensionAPI,
      state: MateriaCastState,
      prompt: string,
      suffix?: string,
    ): Promise<string>;
    writeUsage(runState: MateriaRunState): Promise<void>;
  };
  state: {
    loadActiveCastState(ctx: ExtensionContext): MateriaCastState | undefined;
    loadConfigFromState(state: MateriaCastState): Promise<PiMateriaConfig>;
    saveCastState(pi: ExtensionAPI, state: MateriaCastState): void;
    recordActiveTurnProvenance(state: MateriaCastState): void;
    shortMetadataLabel(value: string | undefined): string | undefined;
  };
  tools: {
    updateToolScope(
      pi: ExtensionAPI,
      materia: MateriaAgentConfig,
      options?: UpdateToolScopeOptions,
    ): unknown;
    configureAgentFinalization(
      pi: ExtensionAPI,
      session: object,
      state: MateriaCastState,
      socket: ResolvedMateriaSocket,
      config: Pick<PiMateriaConfig, "finalization">,
    ): AgentFinalizationActivation;
  };
  lifecycle: {
    emitLifecycleEvent(
      state: MateriaCastState,
      type: string,
      overrides?: LifecycleEventOverrides,
    ): Promise<void>;
    failCast(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      state: MateriaCastState,
      error: unknown,
      entryId?: string,
      options?: { preserveRecoveryExhaustion?: boolean },
    ): Promise<void>;
  };
}

/**
 * Creates the coordinator for preparing and dispatching native agent prompts.
 * Terminal transitions are callback dependencies so this module never imports
 * the native lifecycle orchestrator.
 */
export function createAgentPromptDispatch(deps: AgentPromptDispatchDependencies) {
  const deferredPromptDispatchKeys = new Set<string>();

  function advancementDiagnosticsEnabled(diagnostics?: AdvancementLifecycleDiagnostics): boolean {
    return Boolean(diagnostics?.finalizedMultiTurn || diagnostics?.origin === "agent_end" || process.env.PI_MATERIA_ADVANCEMENT_DEBUG?.trim());
  }

  function agentEndAdvancementDiagnostics(
    state: MateriaCastState,
    socket: ResolvedMateriaSocket,
    options: { finalizedMultiTurn?: boolean } = {},
  ): AdvancementLifecycleDiagnostics {
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

  function castStartInitialPromptDiagnostics(
    state: MateriaCastState,
    entry: ResolvedMateriaSocket,
    options?: CastStartOptions,
  ): AdvancementLifecycleDiagnostics | undefined {
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

  function contextIdleState(ctx: ExtensionContext): boolean | string {
    const maybeCtx = ctx as ExtensionContext & { isIdle?: unknown };
    if (typeof maybeCtx.isIdle !== "function") return "unavailable";
    try {
      return maybeCtx.isIdle();
    } catch (error) {
      return `error:${errorMessage(error)}`;
    }
  }

  async function appendAdvancementDiagnostic(
    ctx: ExtensionContext,
    state: MateriaCastState,
    stage: string,
    diagnostics?: AdvancementLifecycleDiagnostics,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    if (!advancementDiagnosticsEnabled(diagnostics)) return;
    await deps.artifacts.appendEvent(state.runState, "advancement_lifecycle", {
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

  async function updateSocketToolScope(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: MateriaCastState,
    socket: ResolvedMateriaSocket,
  ): Promise<void> {
    if (!isAgentResolvedSocket(socket)) return;
    const emittedWarnings: ToolScopeRuntimeWarning[] = [];
    deps.tools.updateToolScope(pi, socket.materia, {
      context: {
        socket: socket.id,
        materia: socketMateriaName(socket),
        itemKey: state.currentItemKey,
        visit: socketVisit(state, socket.id),
      },
      onWarning: (warning) => { emittedWarnings.push(warning); },
    });
    for (const warning of emittedWarnings) {
      await deps.artifacts.appendEvent(state.runState, "tool_scope_warning", {
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
      ctx.ui.notify(warning.message, "warning");
    }

    const finalization = deps.tools.configureAgentFinalization(
      pi,
      ctx.sessionManager,
      state,
      socket,
      await deps.state.loadConfigFromState(state),
    );
    await deps.artifacts.appendEvent(state.runState, "agent_finalization_strategy", {
      strategy: finalization.strategy,
      configuredStrategy: finalization.configuredStrategy,
      reason: finalization.reason,
      socket: socket.id,
      materia: socketMateriaName(socket),
      visit: finalization.scope.socketVisit,
      finalizationAttempt: finalization.scope.finalizationAttempt,
      toolCount: finalization.toolNames.length,
      model: state.currentMateriaModel?.model,
      provider: state.currentMateriaModel?.provider,
      api: state.currentMateriaModel?.api,
    });
  }

  async function maybeRunProactiveCompaction(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: MateriaCastState,
  ): Promise<void> {
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
      loadConfigFromState: deps.state.loadConfigFromState,
      appendEvent: deps.artifacts.appendEvent,
      writeUsage: deps.artifacts.writeUsage,
      saveState: (nextState) => deps.state.saveCastState(pi, nextState),
      notifyWarning: (message) => ctx.ui.notify(message, "warning"),
      currentSocketId,
      currentSocketVisit,
      shortMetadataLabel: deps.state.shortMetadataLabel,
    }, projection);
  }

  async function sendMateriaTurn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: MateriaCastState,
    prompt: string,
    options: SendMateriaTurnOptions = {},
  ): Promise<void> {
    const diagnostics = options.diagnostics
      ? {
          ...options.diagnostics,
          dispatchTriggerMode: options.diagnostics.dispatchTriggerMode ?? "immediate-triggerTurn",
        }
      : undefined;
    await appendAdvancementDiagnostic(ctx, state, "dispatch_execution_entry", diagnostics, {
      boundary: "async_prompt_dispatch_attempt",
      promptLength: prompt.length,
    });
    state.activeTurnPrompt = prompt;
    deps.state.recordActiveTurnProvenance(state);
    deps.state.saveCastState(pi, state);
    if (!options.skipProactiveCompaction) await maybeRunProactiveCompaction(pi, ctx, state);
    const contextArtifact = await deps.artifacts.writeContextArtifact(pi, state, prompt);
    await deps.artifacts.appendManifest(state, {
      phase: state.phase,
      socket: currentSocketId(state),
      materia: state.currentMateria,
      itemKey: state.currentItemKey,
      visit: currentSocketVisit(state, undefined),
      artifact: contextArtifact,
      kind: "context",
      materiaModel: state.currentMateriaModel,
    });

    const notificationMateria = resolvedMateriaDisplayName(activeResolvedSocket(state)) ?? state.currentMateria;
    const display = formatMateriaNotificationDisplay(notificationMateria, currentSocketId(state));
    // Display-only orchestration card. The hidden prompt below is the actual
    // agent context and intentionally remains untagged as orchestration.
    pi.sendMessage({
      customType: "pi-materia",
      content: formatMateriaCastContent(notificationMateria, currentSocketId(state), state.currentItemLabel),
      display: true,
      details: {
        orchestration: true,
        prefix: "materia",
        socketId: currentSocketId(state),
        materiaName: display.materiaName,
        socketOrdinal: display.socketOrdinal,
        itemKey: state.currentItemKey,
        itemLabel: state.currentItemLabel,
        eventType: "materia_prompt",
        materiaModel: state.currentMateriaModel,
      },
    });

    pi.appendEntry("pi-materia-context", {
      phase: state.phase,
      socketId: currentSocketId(state),
      materiaName: state.currentMateria,
      itemKey: state.currentItemKey,
      itemLabel: state.currentItemLabel,
      itemLabelShort: deps.state.shortMetadataLabel(state.currentItemLabel),
      artifact: contextArtifact,
      materiaModel: state.currentMateriaModel,
    });
    pi.sendMessage({
      customType: "pi-materia-prompt",
      content: prompt,
      display: false,
      details: {
        phase: state.phase,
        socketId: currentSocketId(state),
        materiaName: state.currentMateria,
        itemKey: state.currentItemKey,
        itemLabel: state.currentItemLabel,
        materiaModel: state.currentMateriaModel,
      },
    }, { triggerTurn: true });
    await appendAdvancementDiagnostic(ctx, state, "dispatch_execution_exit", diagnostics, {
      boundary: "async_prompt_dispatch_attempt",
      dispatchTriggerMode: diagnostics?.dispatchTriggerMode ?? "immediate-triggerTurn",
    });
  }

  function deferredPromptDispatchKey(
    state: MateriaCastState,
    socket: ResolvedMateriaSocket,
    diagnostics?: AdvancementLifecycleDiagnostics,
  ): string {
    const sourceSocket = diagnostics?.sourceSocketId ?? currentSocketId(state) ?? state.phase;
    const sourceVisit = diagnostics?.sourceSocketVisit ?? socketVisit(state, sourceSocket);
    return [state.castId, sourceSocket, sourceVisit, socket.id].join(":");
  }

  function isCurrentDeferredDispatchTarget(
    ctx: ExtensionContext,
    state: MateriaCastState,
    socket: ResolvedMateriaSocket,
  ): boolean {
    const activeState = deps.state.loadActiveCastState(ctx);
    return activeState?.active === true
      && activeState.castId === state.castId
      && currentSocketId(activeState) === socket.id
      && activeState.awaitingResponse === true
      && currentSocketState(activeState) === "awaiting_agent_response";
  }

  async function scheduleDeferredPromptDispatch(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: MateriaCastState,
    socket: ResolvedMateriaSocket,
    dispatch: () => Promise<void>,
    diagnostics?: AdvancementLifecycleDiagnostics,
  ): Promise<boolean> {
    const idempotencyKey = deferredPromptDispatchKey(state, socket, diagnostics);
    if (deferredPromptDispatchKeys.has(idempotencyKey)) {
      await appendAdvancementDiagnostic(ctx, state, "deferred_dispatch_duplicate_skipped", diagnostics, {
        boundary: "deferred_prompt_dispatch",
        targetSocketId: socket.id,
        targetMateriaName: socketMateriaName(socket),
        idempotencyKey,
      });
      await deps.artifacts.appendEvent(state.runState, "deferred_dispatch_duplicate_skipped", {
        diagnostic: true,
        castId: state.castId,
        socket: socket.id,
        materia: socketMateriaName(socket),
        sourceSocketId: diagnostics?.sourceSocketId,
        sourceSocketVisit: diagnostics?.sourceSocketVisit,
        origin: diagnostics?.origin,
        promptDispatch: diagnostics?.promptDispatch,
        idempotencyKey,
      });
      return false;
    }
    deferredPromptDispatchKeys.add(idempotencyKey);
    // Pi ignores/rejects triggerTurn work started inside the prior agent_end
    // stack; defer only prompt dispatch until durable state has been committed.
    setTimeout(() => {
      void (async () => {
        try {
          if (!isCurrentDeferredDispatchTarget(ctx, state, socket)) {
            await appendAdvancementDiagnostic(ctx, state, "deferred_dispatch_stale_skipped", diagnostics, {
              boundary: "deferred_prompt_dispatch",
              targetSocketId: socket.id,
              targetMateriaName: socketMateriaName(socket),
              idempotencyKey,
            });
            await deps.artifacts.appendEvent(state.runState, "deferred_dispatch_stale_skipped", {
              diagnostic: true,
              castId: state.castId,
              socket: socket.id,
              materia: socketMateriaName(socket),
              sourceSocketId: diagnostics?.sourceSocketId,
              sourceSocketVisit: diagnostics?.sourceSocketVisit,
              origin: diagnostics?.origin,
              promptDispatch: diagnostics?.promptDispatch,
              idempotencyKey,
            });
            return;
          }
          await appendAdvancementDiagnostic(ctx, state, "deferred_dispatch_execution", diagnostics, {
            boundary: "deferred_prompt_dispatch",
            targetSocketId: socket.id,
            targetMateriaName: socketMateriaName(socket),
            idempotencyKey,
          });
          await dispatch();
        } catch (error) {
          const message = `Deferred pi-materia prompt dispatch failed for socket "${socket.id}": ${errorMessage(error)}`;
          console.error(message, error);
          try {
            await deps.artifacts.appendEvent(state.runState, "deferred_dispatch_failure", {
              error: errorMessage(error),
              socket: socket.id,
              materia: socketMateriaName(socket),
              castId: state.castId,
              diagnostic: true,
            });
            await deps.lifecycle.emitLifecycleEvent(state, "lifecycle.socket.failed", {
              severity: "error",
              socketId: socket.id,
              materia: resolvedMateriaId(socket) ?? socket.id,
              materiaLabel: resolvedMateriaDisplayName(socket),
              visit: socketVisit(state, socket.id),
              ...(state.currentItemKey !== undefined ? { itemKey: state.currentItemKey } : {}),
              ...(state.currentItemLabel !== undefined ? { itemLabel: state.currentItemLabel } : {}),
              payload: { error: errorMessage(error) },
            });
            await deps.lifecycle.failCast(pi, ctx, state, new Error(message), `deferred-dispatch:${socket.id}`);
          } catch (failError) {
            console.error(`Failed to persist deferred dispatch failure for socket "${socket.id}": ${errorMessage(failError)}`, failError);
            ctx.ui.notify(message, "error");
          }
        }
      })();
    }, 0);
    return true;
  }

  async function dispatchSocketPrompt(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: MateriaCastState,
    socket: ResolvedMateriaSocket,
    options: SendMateriaTurnOptions = {},
  ): Promise<void> {
    const diagnostics = options.diagnostics;
    const dispatch = () => sendMateriaTurn(pi, ctx, state, buildSocketPrompt(state, socket), options);
    if (diagnostics?.origin === "agent_end" && diagnostics.promptDispatch === "defer-agent-trigger") {
      const scheduled = await scheduleDeferredPromptDispatch(pi, ctx, state, socket, dispatch, diagnostics);
      if (scheduled) {
        await appendAdvancementDiagnostic(ctx, state, "dispatch_scheduling", diagnostics, {
          boundary: "async_prompt_dispatch_attempt",
          targetSocketId: socket.id,
          targetMateriaName: socketMateriaName(socket),
          dispatchTriggerMode: "deferred-triggerTurn",
          idempotencyKey: deferredPromptDispatchKey(state, socket, diagnostics),
        });
      }
      return;
    }

    await appendAdvancementDiagnostic(ctx, state, "dispatch_scheduling", diagnostics, {
      boundary: "async_prompt_dispatch_attempt",
      targetSocketId: socket.id,
      targetMateriaName: socketMateriaName(socket),
      dispatchTriggerMode: diagnostics?.dispatchTriggerMode ?? "immediate-triggerTurn",
    });
    try {
      await dispatch();
    } catch (error) {
      await deps.lifecycle.emitLifecycleEvent(state, "lifecycle.socket.failed", {
        severity: "error",
        socketId: socket.id,
        materia: resolvedMateriaId(socket) ?? socket.id,
        materiaLabel: resolvedMateriaDisplayName(socket),
        visit: socketVisit(state, socket.id),
        ...(state.currentItemKey !== undefined ? { itemKey: state.currentItemKey } : {}),
        ...(state.currentItemLabel !== undefined ? { itemLabel: state.currentItemLabel } : {}),
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
      await deps.lifecycle.failCast(pi, ctx, state, error, `dispatch:${socket.id}`);
    }
  }

  return {
    agentEndAdvancementDiagnostics,
    appendAdvancementDiagnostic,
    castStartInitialPromptDiagnostics,
    dispatchSocketPrompt,
    sendMateriaTurn,
    updateSocketToolScope,
  };
}
