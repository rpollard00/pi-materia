import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  assessContextPressureForCompaction,
  runSameSocketRecoveryCompaction,
} from "../application/compactionWorkflow.js";
import {
  buildJsonOutputRepairRetryPrompt,
  buildMultiTurnFinalizationPrompt,
  buildSocketPrompt,
  buildTimeoutRecoveryHint,
} from "../application/promptAssembly.js";
import {
  errorMessage,
  recoveryDiagnosticLabel,
  recoveryIdentityKey,
  recoveryTurnMode,
} from "../application/recoveryPolicy.js";
import {
  handleSameSocketRecoverableTurnFailureWorkflow,
  runSameSocketRecoveryActionWorkflow,
  type SameSocketRecoveryActionOptions,
} from "../application/recoveryWorkflow.js";
import type { ToolScopeRuntimeWarning, UpdateToolScopeOptions } from "./agentTurnState.js";
import type {
  MateriaAgentConfig,
  MateriaCastState,
  MateriaJsonOutputRepairContext,
  MateriaJsonOutputValidationKind,
  PiMateriaConfig,
  ResolvedMateriaSocket,
} from "../types.js";

const JSON_OUTPUT_REPAIR_EXCERPT_MAX_CHARS = 600;

export interface TurnRecoveryDependencies {
  artifacts: {
    appendEvent(
      runState: MateriaCastState["runState"],
      type: string,
      data: Record<string, unknown>,
    ): Promise<void>;
    writeUsage(runState: MateriaCastState["runState"]): Promise<void>;
  };
  state: {
    saveCastState(pi: ExtensionAPI, state: MateriaCastState): void;
    setCurrentSocketState(
      state: MateriaCastState,
      socketState: MateriaCastState["socketState"],
    ): void;
    currentSocketId(state: MateriaCastState): string | undefined;
    currentSocketVisit(state: MateriaCastState, fallback?: number): number;
    currentSocketOrThrow(state: MateriaCastState): ResolvedMateriaSocket;
    currentMateria(state: MateriaCastState): MateriaAgentConfig;
    shortMetadataLabel(value: string | undefined): string | undefined;
    loadConfigFromState(state: MateriaCastState): Promise<PiMateriaConfig>;
  };
  lifecycle: {
    emitLifecycleEvent(
      state: MateriaCastState,
      type: string,
      overrides?: {
        severity?: "debug" | "info" | "warning" | "error";
        socketId?: string;
        materia?: string;
        visit?: number;
        itemKey?: string;
        itemLabel?: string;
        payload?: Record<string, unknown>;
      },
    ): Promise<void>;
    failCast(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      state: MateriaCastState,
      error: unknown,
      entryId?: string,
      options?: { preserveRecoveryExhaustion?: boolean },
    ): Promise<void>;
    sendMateriaTurn(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      state: MateriaCastState,
      prompt: string,
      options?: { skipProactiveCompaction?: boolean },
    ): Promise<void>;
  };
  tools: {
    updateToolScope(
      pi: ExtensionAPI,
      materia: MateriaAgentConfig,
      options?: UpdateToolScopeOptions,
    ): unknown;
  };
  ui: {
    updateWidget(ctx: ExtensionContext, state: MateriaCastState): unknown;
    notifyWarning(ctx: ExtensionContext, message: string): void;
  };
}

export interface TurnRecoveryOptions {
  entryId?: string;
  allowGenericTurnFailure?: boolean;
}

/**
 * Creates the native turn-recovery coordinator. Runtime side effects are
 * supplied by the lifecycle composition root so recovery never imports it.
 */
export function createTurnRecovery(deps: TurnRecoveryDependencies) {
  async function preserveAwaitingAfterTransientTransportFailure(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: MateriaCastState,
    error: unknown,
    options: Pick<TurnRecoveryOptions, "entryId"> = {},
  ): Promise<void> {
    state.active = true;
    state.awaitingResponse = true;
    deps.state.setCurrentSocketState(state, "awaiting_agent_response");
    state.updatedAt = Date.now();
    state.runState.lastMessage = `Transient transport failure while awaiting ${recoveryDiagnosticLabel(state)}; preserving active Pi turn: ${errorMessage(error)}`;
    await deps.artifacts.appendEvent(state.runState, "transient_transport_turn_failure", {
      warning: true,
      error: errorMessage(error),
      entryId: options.entryId,
      socket: deps.state.currentSocketId(state),
      itemKey: state.currentItemKey,
      itemLabel: state.currentItemLabel,
      itemLabelShort: deps.state.shortMetadataLabel(state.currentItemLabel),
      mode: recoveryTurnMode(state),
    });
    await deps.artifacts.writeUsage(state.runState);
    deps.state.saveCastState(pi, state);
    deps.ui.updateWidget(ctx, state);
    deps.ui.notifyWarning(ctx, `pi-materia warning: ${state.runState.lastMessage}`);
  }

  async function runSameSocketRecoveryAction(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: MateriaCastState,
    options: SameSocketRecoveryActionOptions,
  ): Promise<void> {
    return runSameSocketRecoveryActionWorkflow(state, options, {
      appendEvent: deps.artifacts.appendEvent,
      saveState: (nextState) => deps.state.saveCastState(pi, nextState),
      runCompaction: (nextState) => runSameSocketRecoveryCompaction(ctx, nextState),
      currentSocketId: deps.state.currentSocketId,
    });
  }

  async function updateRecoveryToolScope(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: MateriaCastState,
    materia: MateriaAgentConfig,
  ): Promise<void> {
    const emittedWarnings: ToolScopeRuntimeWarning[] = [];
    deps.tools.updateToolScope(pi, materia, {
      context: {
        socket: deps.state.currentSocketId(state),
        materia: state.currentMateria,
        itemKey: state.currentItemKey,
        visit: deps.state.currentSocketVisit(state, undefined),
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
      deps.ui.notifyWarning(ctx, warning.message);
    }
  }

  async function handleSameSocketRecoverableTurnFailure(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: MateriaCastState,
    error: unknown,
    options: TurnRecoveryOptions = {},
  ): Promise<boolean> {
    return handleSameSocketRecoverableTurnFailureWorkflow(state, error, {
      appendEvent: deps.artifacts.appendEvent,
      writeUsage: deps.artifacts.writeUsage,
      saveState: (nextState) => deps.state.saveCastState(pi, nextState),
      failCast: async (nextState, nextError, entryId, failOptions) => {
        // Recovery exhaustion emits the socket failure before the cast failure.
        await deps.lifecycle.emitLifecycleEvent(nextState, "lifecycle.socket.failed", {
          severity: "error",
          socketId: deps.state.currentSocketId(nextState),
          materia: nextState.currentMateria,
          visit: deps.state.currentSocketVisit(nextState, undefined),
          ...(nextState.currentItemKey !== undefined ? { itemKey: nextState.currentItemKey } : {}),
          ...(nextState.currentItemLabel !== undefined ? { itemLabel: nextState.currentItemLabel } : {}),
          payload: { error: nextError instanceof Error ? nextError.message : String(nextError) },
        });
        await deps.lifecycle.failCast(pi, ctx, nextState, nextError, entryId, failOptions);
      },
      updateToolScope: (materia) => updateRecoveryToolScope(pi, ctx, state, materia),
      sendMateriaTurn: (nextState, prompt, turnOptions) => deps.lifecycle.sendMateriaTurn(pi, ctx, nextState, prompt, turnOptions),
      buildRecoveryPrompt: (nextState) => buildSameSocketRecoveryPrompt(
        nextState,
        deps.state.currentSocketOrThrow(nextState),
      ),
      updateWidget: (nextState) => { deps.ui.updateWidget(ctx, nextState); },
      notifyWarning: (message) => deps.ui.notifyWarning(ctx, message),
      setCurrentSocketState: deps.state.setCurrentSocketState,
      currentSocketId: deps.state.currentSocketId,
      currentSocketVisit: deps.state.currentSocketVisit,
      shortMetadataLabel: deps.state.shortMetadataLabel,
      currentMateria: deps.state.currentMateria,
      runRecoveryAction: (nextState, actionOptions) => runSameSocketRecoveryAction(pi, ctx, nextState, actionOptions),
      assessContextPressure: (nextState) => assessContextPressureForCompaction(ctx, nextState, {
        loadConfigFromState: deps.state.loadConfigFromState,
      }),
    }, options);
  }

  return {
    preserveAwaitingAfterTransientTransportFailure,
    handleSameSocketRecoverableTurnFailure,
    buildJsonOutputRepairContext,
    classifyJsonOutputValidationKind,
    shouldRetryGenericTurnFailure,
  };
}

/** Build the exact same-socket retry prompt for JSON repair or turn recovery. */
export function buildSameSocketRecoveryPrompt(
  state: MateriaCastState,
  socket: ResolvedMateriaSocket,
): string {
  const jsonRepairPrompt = buildJsonOutputRepairRetryPrompt(state, socket);
  if (jsonRepairPrompt) return jsonRepairPrompt;
  const recoveryKey = recoveryIdentityKey(state);
  const timeoutHint = buildTimeoutRecoveryHint(state, recoveryKey);
  if (state.activeTurnPrompt) return appendRecoveryHint(state.activeTurnPrompt, timeoutHint);
  if (recoveryTurnMode(state) === "finalization") {
    return appendRecoveryHint(buildMultiTurnFinalizationPrompt(state, socket), timeoutHint);
  }
  return appendRecoveryHint(buildSocketPrompt(state, socket), timeoutHint);
}

function appendRecoveryHint(prompt: string, hint: string | undefined): string {
  if (!hint) return prompt;
  return `${prompt}\n\n${hint}`;
}

/** Capture bounded invalid output for a subsequent JSON repair prompt. */
export function buildJsonOutputRepairContext(
  text: string,
  error: Error,
  validationKind: MateriaJsonOutputValidationKind,
  validationIssues?: MateriaJsonOutputRepairContext["validationIssues"],
): MateriaJsonOutputRepairContext {
  const invalidOutputExcerpt = boundedInvalidOutputExcerpt(text, JSON_OUTPUT_REPAIR_EXCERPT_MAX_CHARS);
  return {
    validationKind,
    errorMessage: conciseJsonOutputRepairError(validationKind, validationIssues, error),
    validationIssues,
    invalidOutputExcerpt,
    excerptLength: invalidOutputExcerpt.length,
    truncated: text.length > invalidOutputExcerpt.length,
  };
}

/** Bound invalid output while recording exactly how much source text was omitted. */
export function boundedInvalidOutputExcerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} character(s)]`;
}

export function classifyJsonOutputValidationKind(error: unknown): MateriaJsonOutputValidationKind {
  return errorMessage(error).startsWith("Invalid JSON output") ? "json_parse" : "handoff_validation";
}

function conciseJsonOutputRepairError(
  validationKind: MateriaJsonOutputValidationKind,
  validationIssues: MateriaJsonOutputRepairContext["validationIssues"],
  error: Error,
): string {
  if (validationKind === "json_parse") return "Malformed JSON syntax at $.";
  if (validationIssues?.length) return "The handoff does not meet the active socket contract.";
  const message = error.message.replace(/\s+/g, " ").trim();
  return message.length <= 240 ? message : `${message.slice(0, 239).trimEnd()}…`;
}

export function shouldRetryGenericTurnFailure(error: unknown): boolean {
  const message = errorMessage(error);
  return /\b(?:auth|invalid[_ -]?request|provider rejected|different provider failure)\b/i.test(message);
}
