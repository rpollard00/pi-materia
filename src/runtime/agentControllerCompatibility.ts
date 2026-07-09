import type { PiMateriaConfig, ResolvedMateriaPipeline } from "../types.js";
import { isAgentResolvedSocket, resolvedMateriaDisplayName } from "./resolvedMateria.js";

/**
 * Socket detail entry for cast artifact enrichment.
 *
 * Captures the resolved materia name and multiTurn flag per socket so that
 * misconfigurations (e.g. multiTurn agent socket under agent-controller
 * eventing) are diagnosable at a glance from the cast_start artifact.
 */
export interface PipelineSocketDetail {
  /** Socket id in the pipeline. */
  socketId: string;
  /** Resolved materia display name (label or id). */
  materiaName: string;
  /** Whether this is an agent socket (vs utility). */
  isAgent: boolean;
  /** Whether the resolved materia is configured for multi-turn refinement. */
  multiTurn: boolean;
}

/**
 * Build a list of per-socket detail entries from the resolved pipeline.
 *
 * Used to enrich the cast_start artifact and failure payloads so that
 * future misconfigurations of this kind are diagnosable at a glance.
 */
export function buildPipelineSocketDetails(pipeline: ResolvedMateriaPipeline): PipelineSocketDetail[] {
  const details: PipelineSocketDetail[] = [];
  for (const [socketId, socket] of Object.entries(pipeline.sockets)) {
    const isAgent = isAgentResolvedSocket(socket);
    details.push({
      socketId,
      materiaName: resolvedMateriaDisplayName(socket) ?? socketId,
      isAgent,
      multiTurn: isAgent && socket.materia.multiTurn === true,
    });
  }
  return details;
}

/**
 * Check whether the agent-controller eventing preset is active.
 *
 * The agent-controller preset is the sole autonomous eventing mode — the
 * controller only ever sends a single `/materia cast` prompt and never
 * sends `/materia continue`, so multiTurn agent sockets can never complete.
 */
export function isAgentControllerPresetActive(config: PiMateriaConfig): boolean {
  const presets = config.eventing?.presets;
  return Array.isArray(presets) && presets.includes("agent-controller");
}

/**
 * Find all agent sockets in the pipeline whose resolved materia has
 * `multiTurn: true`.
 *
 * Under the agent-controller eventing preset these sockets are guaranteed
 * to stall: the controller never sends `/materia continue` to finalize
 * a multi-turn refinement, so the socket can never complete.
 *
 * Returns an empty array when no multiTurn agent sockets are found.
 */
export function findMultiTurnAgentSockets(pipeline: ResolvedMateriaPipeline): PipelineSocketDetail[] {
  const multiTurnSockets: PipelineSocketDetail[] = [];
  for (const [socketId, socket] of Object.entries(pipeline.sockets)) {
    if (isAgentResolvedSocket(socket) && socket.materia.multiTurn === true) {
      multiTurnSockets.push({
        socketId,
        materiaName: resolvedMateriaDisplayName(socket) ?? socketId,
        isAgent: true,
        multiTurn: true,
      });
    }
  }
  return multiTurnSockets;
}

/**
 * Result of validating the pipeline for agent-controller compatibility.
 */
export interface AgentControllerValidationResult {
  /** Whether the pipeline is valid for agent-controller eventing. */
  ok: boolean;
  /** MultiTurn agent sockets that would stall under agent-controller eventing. */
  offendingSockets: PipelineSocketDetail[];
  /** Human-readable error message when validation fails. */
  errorMessage?: string;
}

/**
 * Validate the resolved pipeline for agent-controller eventing compatibility.
 *
 * If the agent-controller eventing preset is active AND the pipeline contains
 * any agent socket with `multiTurn: true`, the validation fails. The agent-
 * controller only ever sends a single `/materia cast` prompt and never sends
 * `/materia continue`, so a multiTurn agent socket can never complete and is
 * a guaranteed token sink.
 *
 * Returns `{ ok: true }` when the pipeline is safe to proceed.
 */
export function validateAgentControllerMultiTurnSockets(
  config: PiMateriaConfig,
  pipeline: ResolvedMateriaPipeline,
): AgentControllerValidationResult {
  if (!isAgentControllerPresetActive(config)) {
    return { ok: true, offendingSockets: [] };
  }

  const offending = findMultiTurnAgentSockets(pipeline);
  if (offending.length === 0) {
    return { ok: true, offendingSockets: [] };
  }

  const socketList = offending
    .map((s) => `${s.socketId} (materia: ${s.materiaName})`)
    .join(", ");

  return {
    ok: false,
    offendingSockets: offending,
    errorMessage:
      `Cast aborted: agent-controller eventing preset is active but the pipeline ` +
      `contains multiTurn agent socket(s) that cannot complete autonomously. ` +
      `The agent-controller never sends "/materia continue" to finalize ` +
      `multi-turn refinement. Offending socket(s): ${socketList}`,
  };
}
