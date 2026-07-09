import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyGenericHandoffEnvelope } from "../application/handoff.js";
import { captureReworkFeedbackForRoute } from "../application/reworkFeedback.js";
import {
  errorMessage,
  nonRecoverableTurnError,
} from "../application/recoveryPolicy.js";
import {
  applyAdvance,
  applyAssignments,
  enforceEdgeLimit,
  MateriaEdgeTraversalExhaustionError,
  selectNextEdge,
} from "../application/workflowTransitions.js";
import { canonicalGeneratorConfigFor } from "../graph/generator.js";
import {
  handoffValidationIssues,
  validateHandoffJsonOutput,
} from "../handoff/handoffValidation.js";
import type { SocketParsedJsonArtifactInput } from "../infrastructure/castArtifacts.js";
import { formatMateriaNotificationDisplay } from "../presentation/notificationFormatting.js";
import { buildMateriaTextOutputMessage } from "../presentation/textOutput.js";
import type {
  MateriaCastState,
  MateriaJsonOutputRepairContext,
  MateriaJsonOutputValidationKind,
  MateriaRunState,
  PiMateriaConfig,
  ResolvedMateriaSocket,
} from "../types.js";
import { parseSocketJson } from "../utilities/json.js";
import type { AdvancementLifecycleDiagnostics } from "./agentPromptDispatch.js";
import type { LifecycleEventOverrides } from "./nativeEventing.js";
import {
  effectiveResolvedSocketConfig,
  resolvedMateriaDisplayName,
  resolvedMateriaId,
} from "./resolvedMateria.js";
import {
  currentRefinementTurn,
  currentSocketOrThrow,
  isAgentResolvedSocket,
  isMultiTurnResolvedAgentSocket,
  socketMateriaName,
  socketVisit,
} from "./sessionState.js";

export interface SocketOutputCommitOptions {
  finalizedMultiTurn?: boolean;
  diagnostics?: AdvancementLifecycleDiagnostics;
}

/** The lifecycle action that remains after a socket output has been committed. */
export type SocketOutputRoutingOutcome =
  | {
      kind: "route";
      targetId: string;
      diagnostics?: AdvancementLifecycleDiagnostics;
    }
  | { kind: "recovery_started" }
  | { kind: "cast_failed"; reason: "edge_traversal_exhausted" };

export interface SocketOutputCommitDependencies {
  artifacts: {
    appendEvent(runState: MateriaRunState, type: string, data: unknown): Promise<void>;
    recordSocketOutput(
      state: MateriaCastState,
      socket: ResolvedMateriaSocket,
      text: string,
      entryId: string,
    ): Promise<string>;
    recordSocketParsedJson(input: SocketParsedJsonArtifactInput): Promise<string>;
    shortMetadataLabel(value: string | undefined): string | undefined;
  };
  state: {
    loadConfigFromState(state: MateriaCastState): Promise<PiMateriaConfig>;
  };
  eventing: {
    processSocketEvents(
      state: MateriaCastState,
      parsed: unknown,
      rawText: string,
      socket: ResolvedMateriaSocket,
    ): Promise<void>;
    emitLifecycleEvent(
      state: MateriaCastState,
      type: string,
      overrides?: LifecycleEventOverrides,
    ): Promise<void>;
  };
  recovery: {
    buildJsonOutputRepairContext(
      text: string,
      error: Error,
      validationKind: MateriaJsonOutputValidationKind,
      validationIssues?: MateriaJsonOutputRepairContext["validationIssues"],
    ): MateriaJsonOutputRepairContext;
    classifyJsonOutputValidationKind(error: unknown): MateriaJsonOutputValidationKind;
    handleSameSocketRecoverableTurnFailure(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      state: MateriaCastState,
      error: unknown,
      options?: { entryId?: string; allowGenericTurnFailure?: boolean },
    ): Promise<boolean>;
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
  };
  diagnostics: {
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
  };
  budget: {
    assertBudget(
      config: PiMateriaConfig,
      state: MateriaRunState,
      ctx: ExtensionContext,
    ): Promise<void>;
  };
}

/**
 * Creates the four-phase socket-output commit pipeline. Routing and terminal
 * transitions remain explicit outcomes/callbacks, so this collaborator owns
 * commit ordering without importing the native lifecycle orchestrator.
 */
export function createSocketOutputCommit(deps: SocketOutputCommitDependencies) {
  async function commitSocketOutput(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: MateriaCastState,
    text: string,
    entryId: string,
    options: SocketOutputCommitOptions = {},
  ): Promise<SocketOutputRoutingOutcome> {
    const config = await deps.state.loadConfigFromState(state);
    const socket = currentSocketOrThrow(state);
    const diagnostics = options.diagnostics
      ?? (options.finalizedMultiTurn
        ? deps.diagnostics.agentEndAdvancementDiagnostics(state, socket, { finalizedMultiTurn: true })
        : undefined);
    await deps.diagnostics.appendAdvancementDiagnostic(
      ctx,
      state,
      "socket_completion_entry",
      diagnostics,
      { boundary: "sync_state_advancement", entryId },
    );
    if (isMultiTurnResolvedAgentSocket(socket) && !options.finalizedMultiTurn) {
      throw new Error(`Internal multi-turn state error for socket "${socket.id}": completion requires explicit /materia continue finalization.`);
    }

    const artifact = await deps.artifacts.recordSocketOutput(state, socket, text, entryId);
    state.lastOutput = text;

    let parsed: unknown = text;
    if (effectiveResolvedSocketConfig(socket).parse === "json") {
      // Phase 1: parse JSON before mutating authoritative handoff state.
      try {
        parsed = parseSocketJson<unknown>(socket.id, text);
      } catch (error) {
        const validationError = new Error(`Pre-commit output validation failed for socket "${socket.id}": ${errorMessage(error)}`);
        if (isAgentResolvedSocket(socket)) {
          if (options.finalizedMultiTurn) state.multiTurnFinalizing = true;
          state.jsonOutputRepair = deps.recovery.buildJsonOutputRepairContext(
            text,
            validationError,
            deps.recovery.classifyJsonOutputValidationKind(error),
            handoffValidationIssues(error),
          );
          const recovered = await deps.recovery.handleSameSocketRecoverableTurnFailure(
            pi,
            ctx,
            state,
            validationError,
            { entryId, allowGenericTurnFailure: true },
          );
          if (recovered) return { kind: "recovery_started" };
          throw nonRecoverableTurnError(state, validationError);
        }
        throw validationError;
      }

      // Phase 2: validate, dispatch, and strip the event side-channel before
      // handoff validation so reserved event data cannot enter cast state.
      try {
        await deps.eventing.processSocketEvents(state, parsed, text, socket);
      } catch (eventError) {
        if (isAgentResolvedSocket(socket)) {
          const validationError = eventError instanceof Error
            ? eventError
            : new Error(String(eventError));
          if (options.finalizedMultiTurn) state.multiTurnFinalizing = true;
          const recovered = await deps.recovery.handleSameSocketRecoverableTurnFailure(
            pi,
            ctx,
            state,
            validationError,
            { entryId, allowGenericTurnFailure: true },
          );
          if (recovered) return { kind: "recovery_started" };
          throw nonRecoverableTurnError(state, validationError);
        }
        throw eventError;
      }

      // Rewrite state text from the stripped object before validating handoff.
      if (isPlainObject(parsed)) {
        text = JSON.stringify(parsed);
        state.lastOutput = text;
        if (state.lastAssistantText) state.lastAssistantText = text;
      }

      // Phase 3: validate the clean handoff envelope.
      try {
        parsed = validateHandoffJsonOutput(parsed, {
          socketId: socket.id,
          socket: effectiveResolvedSocketConfig(socket),
          agentOutput: isAgentResolvedSocket(socket),
          workItemsProducer: Boolean(canonicalGeneratorConfigFor(socket.materia)),
        });
      } catch (error) {
        const validationError = new Error(`Pre-commit output validation failed for socket "${socket.id}": ${errorMessage(error)}`);
        if (isAgentResolvedSocket(socket)) {
          if (options.finalizedMultiTurn) state.multiTurnFinalizing = true;
          state.jsonOutputRepair = deps.recovery.buildJsonOutputRepairContext(
            text,
            validationError,
            deps.recovery.classifyJsonOutputValidationKind(error),
            handoffValidationIssues(error),
          );
          const recovered = await deps.recovery.handleSameSocketRecoverableTurnFailure(
            pi,
            ctx,
            state,
            validationError,
            { entryId, allowGenericTurnFailure: true },
          );
          if (recovered) return { kind: "recovery_started" };
          throw nonRecoverableTurnError(state, validationError);
        }
        throw validationError;
      }

      // Phase 4: commit and record clean parsed output.
      state.jsonOutputRepair = undefined;
      state.lastJson = parsed;
      await deps.artifacts.recordSocketParsedJson({
        state,
        socketId: socket.id,
        visit: socketVisit(state, socket.id),
        parsed,
      });
    }

    applyGenericHandoffEnvelope(state, parsed, socket);
    emitMateriaTextOutput(pi, state, socket, parsed);
    applyAssignments(state, socket, parsed);
    const advanceTarget = applyAdvance(state, socket, parsed);
    const finalizedRefinement = isMultiTurnResolvedAgentSocket(socket);
    await deps.artifacts.appendEvent(state.runState, "socket_complete", {
      socket: socket.id,
      materia: socketMateriaName(socket),
      materiaLabel: resolvedMateriaDisplayName(socket),
      artifact,
      parsed: effectiveResolvedSocketConfig(socket).parse === "json",
      entryId,
      finalizedRefinement: finalizedRefinement || undefined,
      refinementTurn: finalizedRefinement ? currentRefinementTurn(state, socket.id) : undefined,
      itemKey: state.currentItemKey,
      itemLabel: state.currentItemLabel,
      itemLabelShort: deps.artifacts.shortMetadataLabel(state.currentItemLabel),
      materiaModel: state.currentMateriaModel,
    });

    await deps.eventing.emitLifecycleEvent(state, "lifecycle.socket.completed", {
      severity: "debug",
      socketId: socket.id,
      materia: resolvedMateriaId(socket) ?? socket.id,
      materiaLabel: resolvedMateriaDisplayName(socket),
      visit: socketVisit(state, socket.id),
      ...(state.currentItemKey !== undefined ? { itemKey: state.currentItemKey } : {}),
      ...(state.currentItemLabel !== undefined ? { itemLabel: state.currentItemLabel } : {}),
      payload: { finalizedRefinement: finalizedRefinement || undefined },
    });

    await deps.eventing.emitLifecycleEvent(state, "lifecycle.status", {
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

    await deps.budget.assertBudget(config, state.runState, ctx);

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
            await deps.artifacts.appendEvent(state.runState, "edge_traversal_exhausted", {
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
            await deps.lifecycle.failCast(pi, ctx, state, error, entryId, {
              preserveRecoveryExhaustion: true,
            });
            return { kind: "cast_failed", reason: "edge_traversal_exhausted" };
          }
          throw error;
        }
        nextTarget = nextEdge.to;
        captureReworkFeedbackForRoute(state, {
          sourceSocket: socket,
          targetSocketId: nextEdge.to,
          edge: nextEdge,
          parsed,
          rawOutput: text,
        });
      } else {
        nextTarget = "end";
      }
    }

    if (diagnostics) diagnostics.nextSocketTarget = nextTarget ?? "end";
    const nextDiagnostics = diagnostics ? { ...diagnostics } : undefined;
    await deps.diagnostics.appendAdvancementDiagnostic(
      ctx,
      state,
      "socket_completion_exit",
      nextDiagnostics,
      { boundary: "sync_state_advancement", entryId },
    );
    return {
      kind: "route",
      targetId: nextTarget ?? "end",
      diagnostics: nextDiagnostics,
    };
  }

  return { commitSocketOutput };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Surface canonical renderable text as presentation-only TUI prose. */
function emitMateriaTextOutput(
  pi: ExtensionAPI,
  state: MateriaCastState,
  socket: ResolvedMateriaSocket,
  parsed: unknown,
): void {
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
