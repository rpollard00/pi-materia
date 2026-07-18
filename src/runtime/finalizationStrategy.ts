import { canonicalGeneratorConfigFor } from "../graph/generator.js";
import { deriveSocketOutputRequirements } from "../handoff/socketOutputRequirements.js";
import type {
  MateriaAgentFinalizationReason,
  MateriaAgentFinalizationState,
  MateriaAgentFinalizationStrategy,
  MateriaModelSelection,
  MateriaToolBackedModelQualification,
  PiMateriaConfig,
  ResolvedMateriaSocket,
} from "../types.js";
import { AgentHandoffBuilder } from "./agentHandoffBuilder.js";
import { effectiveResolvedSocketConfig } from "./resolvedMateria.js";
import {
  isAgentResolvedSocket,
  isMultiTurnResolvedAgentSocket,
} from "./sessionState.js";

export interface AgentFinalizationStrategySelection {
  readonly strategy: MateriaAgentFinalizationStrategy;
  readonly configuredStrategy: MateriaAgentFinalizationStrategy;
  readonly reason: MateriaAgentFinalizationReason;
}

export interface SelectAgentFinalizationStrategyInput {
  readonly config: Pick<PiMateriaConfig, "finalization">;
  readonly socket: ResolvedMateriaSocket;
  readonly model?: MateriaModelSelection;
  /** False for conversational turns of a multi-turn agent socket. */
  readonly finalizationTurn?: boolean;
}

/**
 * Select a finalization protocol without changing producer output or tool state.
 *
 * Direct JSON is deliberately the fallback for every absent or unsupported
 * capability. A tool-backed configuration is effective only for an agent JSON
 * socket that the runtime builder can represent and an explicitly qualified
 * effective model/provider cohort. Utility and script producers always remain
 * direct and deterministic.
 */
export function selectAgentFinalizationStrategy(
  input: SelectAgentFinalizationStrategyInput,
): AgentFinalizationStrategySelection {
  const configuredStrategy = input.config.finalization?.agentJson?.strategy ?? "direct_json";
  if (!isAgentResolvedSocket(input.socket)) {
    return direct(configuredStrategy, "deterministic_producer");
  }
  if (effectiveResolvedSocketConfig(input.socket).parse !== "json") {
    return direct(configuredStrategy, "non_json_socket");
  }
  if (isMultiTurnResolvedAgentSocket(input.socket) && input.finalizationTurn !== true) {
    return direct(configuredStrategy, "not_finalization_turn");
  }
  if (configuredStrategy !== "tool_backed") {
    return direct(configuredStrategy, configuredStrategy === "direct_json" && input.config.finalization?.agentJson?.strategy
      ? "configured_direct_json"
      : "default_direct_json");
  }

  const qualification = input.config.finalization?.agentJson?.qualifiedModels?.find((candidate) =>
    qualificationMatches(candidate, input.socket, input.model),
  );
  if (!qualification) return direct(configuredStrategy, "unqualified_model");
  if (!supportsToolBackedFinalization(input.socket)) {
    return direct(configuredStrategy, "unsupported_socket");
  }
  return {
    strategy: "tool_backed",
    configuredStrategy,
    reason: "qualified_tool_model",
  };
}

/** True only while prompts and completion handling must use the tool protocol. */
export function isToolBackedFinalizationActive(
  state: { readonly agentFinalization?: MateriaAgentFinalizationState },
  socket?: ResolvedMateriaSocket,
): boolean {
  const active = state.agentFinalization;
  if (!active || active.strategy !== "tool_backed" || active.phase !== "active") return false;
  return socket === undefined || active.socketId === socket.id;
}

/**
 * Ask the authoritative builder constructor whether a socket's complete
 * required/consumed shape is representable by the narrow tool protocol.
 */
export function supportsToolBackedFinalization(socket: ResolvedMateriaSocket): boolean {
  if (!isAgentResolvedSocket(socket)) return false;
  const workItemsProducer = Boolean(canonicalGeneratorConfigFor(socket.materia));
  try {
    new AgentHandoffBuilder({
      scope: {
        castId: "strategy-probe",
        socketId: socket.id,
        socketVisit: 1,
        finalizationAttempt: 1,
      },
      requirements: deriveSocketOutputRequirements({
        socket: effectiveResolvedSocketConfig(socket),
        socketId: socket.id,
        workItemsProducer,
      }),
      workItemsProducer,
      allowEventSideChannel: true,
    });
    return true;
  } catch {
    return false;
  }
}

function qualificationMatches(
  qualification: MateriaToolBackedModelQualification,
  socket: ResolvedMateriaSocket,
  model: MateriaModelSelection | undefined,
): boolean {
  if (!model || typeof qualification.model !== "string") return false;
  if (qualification.provider !== undefined && qualification.provider !== model.provider) return false;
  if (qualification.api !== undefined && qualification.api !== model.api) return false;
  if (qualification.socketIds !== undefined && !qualification.socketIds.includes(socket.id)) return false;
  if (qualification.materiaIds !== undefined && !qualification.materiaIds.includes(socket.socket.materia)) return false;

  if (qualification.model === "*") return true;
  const modelIds = new Set<string>();
  for (const value of [model.model, model.effectiveModel]) {
    if (value) modelIds.add(value);
  }
  if (model.provider && model.model) modelIds.add(`${model.provider}/${model.model}`);
  return modelIds.has(qualification.model);
}

function direct(
  configuredStrategy: MateriaAgentFinalizationStrategy,
  reason: Exclude<MateriaAgentFinalizationReason, "qualified_tool_model" | "direct_json_fallback">,
): AgentFinalizationStrategySelection {
  return { strategy: "direct_json", configuredStrategy, reason };
}
