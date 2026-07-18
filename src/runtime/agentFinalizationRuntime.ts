import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canonicalGeneratorConfigFor } from "../graph/generator.js";
import { deriveSocketOutputRequirements } from "../handoff/socketOutputRequirements.js";
import type {
  MateriaAgentFinalizationState,
  MateriaCastState,
  PiMateriaConfig,
  ResolvedMateriaAgentSocket,
  ResolvedMateriaSocket,
} from "../types.js";
import {
  AgentHandoffBuilderRegistry,
  createAgentHandoffBuilderRegistry,
} from "./agentHandoffBuilderRegistry.js";
import type { AgentHandoffCommit } from "./agentHandoffBuilder.js";
import {
  exposeAgentHandoffTools,
  hideAgentHandoffTools,
} from "./agentHandoffTools.js";
import {
  selectAgentFinalizationStrategy,
  type AgentFinalizationStrategySelection,
} from "./finalizationStrategy.js";
import { effectiveResolvedSocketConfig } from "./resolvedMateria.js";
import {
  isMultiTurnResolvedAgentSocket,
  socketVisit,
} from "./sessionState.js";

export interface AgentFinalizationActivation extends AgentFinalizationStrategySelection {
  readonly scope: MateriaAgentFinalizationState;
  readonly toolNames: readonly string[];
}

export type AgentFinalizationCompletion =
  | { readonly kind: "direct_json" }
  | {
      readonly kind: "tool_commit";
      readonly commit: AgentHandoffCommit;
      /** Tool output is authoritative; assistant text is ignored, never merged. */
      readonly ignoredText: boolean;
      readonly ignoredTextBytes: number;
    }
  | { readonly kind: "missing_tool_commit" };

/**
 * Session-scoped bridge between strategy selection, generated Pi tools, and the
 * normal socket completion boundary. It owns no routing or handoff state.
 */
export class AgentFinalizationRuntime<Session extends object = object> {
  constructor(
    private readonly registry: AgentHandoffBuilderRegistry<Session> = createAgentHandoffBuilderRegistry<Session>(),
  ) {}

  configure(
    pi: ExtensionAPI,
    session: Session,
    state: MateriaCastState,
    socket: ResolvedMateriaSocket,
    config: Pick<PiMateriaConfig, "finalization">,
  ): AgentFinalizationActivation {
    const selection = selectAgentFinalizationStrategy({
      config,
      socket,
      model: state.currentMateriaModel,
      finalizationTurn: !isMultiTurnResolvedAgentSocket(socket) || state.multiTurnFinalizing === true,
    });
    const finalizationAttempt = nextFinalizationAttempt(state, socket);
    const scope: MateriaAgentFinalizationState = {
      ...selection,
      phase: "active",
      socketId: socket.id,
      socketVisit: socketVisit(state, socket.id),
      finalizationAttempt,
    };
    state.agentFinalization = scope;

    if (selection.strategy !== "tool_backed") {
      this.registry.clearSession(session);
      hideAgentHandoffTools(pi);
      return { ...selection, scope: { ...scope }, toolNames: [] };
    }

    const agentSocket = socket as ResolvedMateriaAgentSocket;
    const workItemsProducer = Boolean(canonicalGeneratorConfigFor(agentSocket.materia));
    const builder = this.registry.begin(session, {
      scope: {
        castId: state.castId,
        socketId: socket.id,
        socketVisit: scope.socketVisit,
        finalizationAttempt,
      },
      requirements: deriveSocketOutputRequirements({
        socket: effectiveResolvedSocketConfig(agentSocket),
        socketId: agentSocket.id,
        workItemsProducer,
      }),
      workItemsProducer,
      allowEventSideChannel: true,
    });
    const tools = exposeAgentHandoffTools(pi, { builder });
    return { ...selection, scope: { ...scope }, toolNames: [...tools.names] };
  }

  completion(
    session: Session,
    state: MateriaCastState,
    assistantText: string,
  ): AgentFinalizationCompletion {
    const active = state.agentFinalization;
    if (!active || active.strategy !== "tool_backed" || active.phase !== "active") {
      return { kind: "direct_json" };
    }
    const builder = this.registry.get(session, {
      castId: state.castId,
      socketId: active.socketId,
      socketVisit: active.socketVisit,
      finalizationAttempt: active.finalizationAttempt,
    });
    const commit = builder?.committedValue();
    if (!commit) return { kind: "missing_tool_commit" };

    active.phase = "committed";
    const ignoredText = assistantText.trim().length > 0;
    return {
      kind: "tool_commit",
      commit,
      ignoredText,
      ignoredTextBytes: ignoredText ? new TextEncoder().encode(assistantText).byteLength : 0,
    };
  }

  /**
   * Discard partial tool state and select a clean direct-JSON retry. Text from
   * the failed tool attempt is never interpreted as a handoff.
   */
  fallbackToDirect(pi: ExtensionAPI, session: Session, state: MateriaCastState): boolean {
    const active = state.agentFinalization;
    if (!active || active.strategy !== "tool_backed" || active.phase !== "active") return false;
    this.registry.discard(session, {
      castId: state.castId,
      socketId: active.socketId,
      socketVisit: active.socketVisit,
      finalizationAttempt: active.finalizationAttempt,
    });
    state.agentFinalization = {
      ...active,
      strategy: "direct_json",
      reason: "direct_json_fallback",
      phase: "fallback",
      fallbackFrom: "tool_backed",
    };
    hideAgentHandoffTools(pi);
    return true;
  }

  release(pi: ExtensionAPI, session: Session, state: MateriaCastState): void {
    const active = state.agentFinalization;
    if (active) {
      this.registry.discard(session, {
        castId: state.castId,
        socketId: active.socketId,
        socketVisit: active.socketVisit,
        finalizationAttempt: active.finalizationAttempt,
      });
    }
    hideAgentHandoffTools(pi);
  }

  deactivate(pi: ExtensionAPI): void {
    const candidate = pi as Partial<Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">>;
    if (typeof candidate.getActiveTools === "function" && typeof candidate.setActiveTools === "function") {
      hideAgentHandoffTools(candidate as Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">);
    }
  }
}

export function createAgentFinalizationRuntime<Session extends object = object>(): AgentFinalizationRuntime<Session> {
  return new AgentFinalizationRuntime<Session>();
}

function nextFinalizationAttempt(state: MateriaCastState, socket: ResolvedMateriaSocket): number {
  const previous = state.agentFinalization;
  const visit = socketVisit(state, socket.id);
  return previous
    && previous.reason !== "not_finalization_turn"
    && previous.socketId === socket.id
    && previous.socketVisit === visit
    ? previous.finalizationAttempt + 1
    : 1;
}
