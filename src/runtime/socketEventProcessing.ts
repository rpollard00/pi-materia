import {
  EVENT_SIDECHANNEL_FIELD,
  validateMateriaEventArray,
  type EnrichmentContext,
  type MateriaEventObject,
} from "../domain/eventing.js";
import type {
  MateriaCastState,
  MateriaJsonOutputRepairContext,
  MateriaJsonOutputValidationKind,
  ResolvedMateriaSocket,
} from "../types.js";
import { resolvedMateriaDisplayName, resolvedMateriaId } from "./resolvedMateria.js";
import { isAgentResolvedSocket, socketVisit } from "./sessionState.js";

export interface SocketEventProcessingDependencies {
  eventing: {
    dispatchMateriaEvents(
      state: MateriaCastState,
      events: MateriaEventObject[],
      buildEnrichmentContext: () => EnrichmentContext,
    ): Promise<void>;
  };
  repair: {
    buildJsonOutputRepairContext(
      text: string,
      error: Error,
      validationKind: MateriaJsonOutputValidationKind,
      validationIssues?: MateriaJsonOutputRepairContext["validationIssues"],
    ): MateriaJsonOutputRepairContext;
  };
}

/**
 * Creates the processor for the reserved socket-output event side-channel.
 * Eventing and repair side effects are supplied by their owning collaborators,
 * keeping this module independent of the native lifecycle orchestrator.
 */
export function createSocketEventProcessing(deps: SocketEventProcessingDependencies) {
  /**
   * Validate and dispatch a parsed output's events, then remove the reserved
   * field before handoff processing. Invalid agent events retain the field so
   * the repair context captures the original output; utility errors propagate.
   */
  async function processSocketEvents(
    state: MateriaCastState,
    parsed: unknown,
    rawText: string,
    socket: ResolvedMateriaSocket,
  ): Promise<void> {
    if (!isPlainObject(parsed)) return;
    if (!Object.prototype.hasOwnProperty.call(parsed, EVENT_SIDECHANNEL_FIELD)) return;

    const validation = validateMateriaEventArray(parsed[EVENT_SIDECHANNEL_FIELD]);
    if (!validation.ok) {
      const validationError = new Error(
        `Invalid event side-channel for socket "${socket.id}": ${validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
      );

      if (isAgentResolvedSocket(socket)) {
        state.jsonOutputRepair = deps.repair.buildJsonOutputRepairContext(
          rawText,
          validationError,
          "handoff_validation",
          validation.issues.map((issue) => ({ path: issue.path, message: issue.message })),
        );
      }

      throw validationError;
    }

    if (validation.value.length > 0) {
      await deps.eventing.dispatchMateriaEvents(state, validation.value, () => ({
        castId: state.castId,
        socketId: socket.id,
        materia: resolvedMateriaId(socket) ?? socket.id,
        materiaLabel: resolvedMateriaDisplayName(socket),
        visit: socketVisit(state, socket.id),
        ...(state.currentItemKey !== undefined ? { itemKey: state.currentItemKey } : {}),
        ...(state.currentItemLabel !== undefined ? { itemLabel: state.currentItemLabel } : {}),
      }));
    }

    delete parsed[EVENT_SIDECHANNEL_FIELD];
  }

  return { processSocketEvents };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
