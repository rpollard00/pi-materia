import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  parseParallelRecoveryTarget,
  resolveParallelRecoveryTarget,
  type ParallelRecoveryOperation,
  type ResolvedParallelRecoveryTarget,
} from "../domain/parallelRecovery.js";
import { ParallelRecoveryTargetError } from "../application/useCases.js";
import { intrinsicParallelFanInHandoff } from "../domain/parallelFanIn.js";
import { resolveLoopExitRoute } from "../graph/loopExitRoutes.js";
import { getResolvedPipelineSocket } from "../loadout/loadoutAccessors.js";
import type {
  MateriaCastState,
  MateriaRunState,
  PiMateriaConfig,
  ResolvedMateriaSocket,
} from "../types.js";
import type { PersistedCastLoadoutIdentity } from "./configPersistence.js";
import type { EventBus } from "./eventBus.js";
import type { ParallelLoopDispatcher } from "./parallelDispatcher.js";
import type { LifecycleEventOverrides } from "./nativeEventing.js";
import {
  currentSocketOrThrow,
  materiaStatusLabel,
  setCurrentSocketId,
  socketMateriaName,
} from "./sessionState.js";

export interface ParallelLaneRecoveryTargetInput {
  session: ExtensionContext;
  operation: ParallelRecoveryOperation;
  argumentsText?: string;
}

export interface ParallelLaneRecoveryRequest {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  operation: ParallelRecoveryOperation;
  castId: string;
  loopId: string;
  /** Omit to recover every failed/interrupted lane in queue order (bulk form). */
  laneIds?: readonly string[];
  /** Stable 1-based command position for lifecycle diagnostics. */
  laneNumber?: number;
}

export interface ParallelLaneRecovery {
  /**
   * Parse and resolve a recovery target without dispatching lifecycle work.
   * No-argument and cast-only forms resolve to `bulk`.
   */
  resolveTarget(input: ParallelLaneRecoveryTargetInput): ResolvedParallelRecoveryTarget;
  /**
   * Recover a selected parallel run: restores coordinator services, relaunches
   * the requested (or all failed) lanes through the dispatcher, and routes the
   * parent socket onward when the run reaches its fan-in barrier.
   */
  recover(input: ParallelLaneRecoveryRequest): Promise<MateriaCastState>;
}

export interface ParallelLaneRecoveryDependencies {
  state: {
    listLatest(ctx: ExtensionContext): MateriaCastState[];
    loadActiveCastState(ctx: ExtensionContext): MateriaCastState | undefined;
    loadCastStateById(ctx: ExtensionContext, castId: string): MateriaCastState | undefined;
    saveCastState(pi: ExtensionAPI, state: MateriaCastState): void;
    loadConfigFromState(state: MateriaCastState): Promise<PiMateriaConfig>;
    resolvePersistedCastLoadoutIdentity(
      state: MateriaCastState,
    ): Promise<PersistedCastLoadoutIdentity | undefined>;
  };
  parallel: Pick<ParallelLoopDispatcher, "recover">;
  eventing: {
    initializeCastEventBus(config: PiMateriaConfig, state: MateriaCastState): Promise<EventBus | undefined>;
    startHeartbeat(state: MateriaCastState, config: PiMateriaConfig): void;
    emitLifecycleEvent(
      state: MateriaCastState,
      type: string,
      overrides?: LifecycleEventOverrides,
    ): Promise<void>;
  };
  artifacts: {
    writeUsage(runState: MateriaRunState): Promise<void>;
  };
  ui: {
    updateWidget(ctx: ExtensionContext, state: MateriaCastState, options?: { replaceOwner?: boolean }): unknown;
  };
  execution: {
    startSocket(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      state: MateriaCastState,
      socket: ResolvedMateriaSocket,
    ): Promise<void>;
  };
  termination: {
    failCast(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, error: unknown, entryId?: string): Promise<void>;
  };
}

/**
 * The lane recovery module: the single deep interface for recovering failed
 * or interrupted lanes of a parallel run, for both numbered-lane and bulk
 * command forms. Owns target resolution (one parse per command), coordinator
 * service restoration (event bus, heartbeat, widget, usage, lifecycle event),
 * fan-in routing, and run failure handling. The passive/exhaustion revive
 * branches of a cast remain in the cast lifecycle, which decides *whether* a
 * cast has recoverable parallel work and hands the selected run to this module.
 */
export function createParallelLaneRecovery(deps: ParallelLaneRecoveryDependencies): ParallelLaneRecovery {
  function resolveTarget(input: ParallelLaneRecoveryTargetInput): ResolvedParallelRecoveryTarget {
    const parsed = parseParallelRecoveryTarget(input.argumentsText);
    if (!parsed.ok) throw new ParallelRecoveryTargetError(parsed.issues);
    const resolved = resolveParallelRecoveryTarget({
      target: parsed.value,
      states: deps.state.listLatest(input.session),
      operation: input.operation,
    });
    if (!resolved.ok) throw new ParallelRecoveryTargetError(resolved.issues);
    return resolved.value;
  }

  function assertNoActiveRecovery(ctx: ExtensionContext, state: MateriaCastState, operation: ParallelRecoveryOperation): void {
    const active = deps.state.loadActiveCastState(ctx);
    if (active?.active) {
      if (active.castId === state.castId) throw new Error(`pi-materia cast ${state.castId} is already running.`);
      throw new Error(`A pi-materia cast is already active (${active.castId}). Abort it before ${operation === "recast" ? "recasting" : "reviving"} ${state.castId}.`);
    }
  }

  async function recover(input: ParallelLaneRecoveryRequest): Promise<MateriaCastState> {
    const state = deps.state.loadCastStateById(input.ctx, input.castId);
    if (!state) throw new Error(`Unknown pi-materia cast id "${input.castId}" in this session.`);
    assertNoActiveRecovery(input.ctx, state, input.operation);
    const run = state.parallelRuns?.[input.loopId];
    if (!run) {
      throw new Error(`Cast ${state.castId} has no persisted parallel run for loop "${input.loopId}".`);
    }
    const socket = currentSocketOrThrow(state);
    const operationPast = input.operation === "recast" ? "recast" : "revived";

    await deps.parallel.recover({
      pi: input.pi,
      ctx: input.ctx,
      state,
      loopId: input.loopId,
      operation: input.operation,
      config: { maxConcurrency: run.maxConcurrency },
      ...(input.laneIds !== undefined ? { laneIds: input.laneIds } : {}),
      ...(input.laneNumber !== undefined ? { laneNumber: input.laneNumber } : {}),
      onPrepared: async () => {
        const persistedLoadoutIdentity = await deps.state.resolvePersistedCastLoadoutIdentity(state);
        state.runState.loadoutId ||= persistedLoadoutIdentity?.loadoutId;
        state.runState.loadoutName ||= persistedLoadoutIdentity?.loadoutName;
        state.runState.currentSocketId = socket.id;
        state.runState.currentMateria = socketMateriaName(socket);
        state.runState.lastMessage = `${operationPast === "recast" ? "Recast" : "Revived"} parallel lanes for cast ${state.castId}.`;
        try {
          const configFromState = await deps.state.loadConfigFromState(state);
          const eventBus = await deps.eventing.initializeCastEventBus(configFromState, state);
          if (eventBus) deps.eventing.startHeartbeat(state, configFromState);
        } catch {
          // Event-bus restoration is best effort; lane/session state is durable.
        }
        await deps.artifacts.writeUsage(state.runState);
        deps.state.saveCastState(input.pi, state);
        input.ctx.ui.setStatus("materia", materiaStatusLabel(state, socket));
        deps.ui.updateWidget(input.ctx, state, { replaceOwner: true });
        await deps.eventing.emitLifecycleEvent(state, "lifecycle.cast.revived", {
          severity: "info",
          message: `Cast ${state.castId} ${operationPast} failed parallel lanes.`,
          payload: {
            kind: "parallel_lanes",
            operation: input.operation,
            castId: state.castId,
            loopId: input.loopId,
            runId: state.parallelRuns?.[input.loopId]?.runId,
            ...(input.laneIds !== undefined ? { laneIds: [...input.laneIds] } : {}),
            ...(input.laneNumber !== undefined ? { laneNumber: input.laneNumber } : {}),
            preservedLaneIds: Object.values(state.parallelRuns?.[input.loopId]?.lanes ?? {}).filter((lane) => lane.status === "accepted").map((lane) => lane.laneId),
          },
        });
      },
      onFanIn: async ({ loopId: completedLoopId, result }) => {
        const completedLoop = state.pipeline.loops?.[completedLoopId];
        const routeSource = completedLoop?.exit?.from ?? completedLoop?.exits?.[0]?.from;
        const route = resolveLoopExitRoute(completedLoop, { from: routeSource, satisfied: result.satisfied });
        if (!route) throw new Error(`Parallel loop ${JSON.stringify(completedLoopId)} has no symbolic ${result.satisfied ? "satisfied" : "not_satisfied"} fan-in route.`);
        const handoff = intrinsicParallelFanInHandoff(result);
        const existingEnvelope = state.data.envelope && typeof state.data.envelope === "object" && !Array.isArray(state.data.envelope)
          ? state.data.envelope as Record<string, unknown>
          : {};
        state.data = {
          ...state.data,
          envelope: { ...existingEnvelope, satisfied: handoff.satisfied, context: handoff.context },
          parallelFanIn: handoff.parallelFanIn,
        };
        delete state.data.item;
        delete state.data.currentWorkItem;
        delete state.data.workItem;
        state.lastJson = handoff;
        state.lastOutput = JSON.stringify(handoff);
        state.lastAssistantText = state.lastOutput;
        state.currentItemKey = undefined;
        state.currentItemLabel = undefined;
        deps.state.saveCastState(input.pi, state);
        const target = getResolvedPipelineSocket(state.pipeline, route.targetSocketId);
        if (!target) throw new Error(`Parallel fan-in route targets unknown socket ${JSON.stringify(route.targetSocketId)}.`);
        await deps.execution.startSocket(input.pi, input.ctx, state, target);
      },
      onFailure: async ({ loopId: failedLoopId, reason }) => {
        await deps.termination.failCast(input.pi, input.ctx, state, new Error(reason), `parallel:${failedLoopId}`);
      },
    });

    input.ctx.ui.notify(
      `pi-materia cast ${state.castId} ${operationPast} failed parallel lanes${input.laneIds ? ` (${[...input.laneIds].join(", ")})` : ""} without rerunning accepted lanes.`,
      "info",
    );
    return state;
  }

  return { resolveTarget, recover };
}
