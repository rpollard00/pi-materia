import {
  intrinsicParallelFanInHandoff,
  ParallelFanInValidationError,
  type IntrinsicParallelFanInResult,
} from "../domain/parallelFanIn.js";
import { resolveLoopExitRoute } from "../graph/loopExitRoutes.js";
import { getResolvedPipelineSocket } from "../loadout/loadoutAccessors.js";
import type { MateriaCastState } from "../types.js";

/** The route a parent follows after the barrier completes. */
export interface ParallelFanInRoute {
  targetSocketId: string;
}

/**
 * Apply an intrinsic parallel barrier result to the parent cast state and
 * resolve the loop's exit route.
 *
 * This is the single fan-in procedure shared by the dispatch path and the
 * lane recovery path: exit-route resolution, the handoff envelope, the
 * canonical output fields, and the item-field cleanup all live here. The
 * route and its target socket are validated before cast state is touched, so
 * a fan-in failure never leaves a partial mutation behind. Saving state and
 * advancing the parent stay with the caller.
 */
export function applyParallelFanIn(
  state: MateriaCastState,
  loopId: string,
  result: IntrinsicParallelFanInResult,
): ParallelFanInRoute {
  const loopConfig = state.pipeline.loops?.[loopId];
  const routeSource = loopConfig?.exit?.from ?? loopConfig?.exits?.[0]?.from;
  const route = resolveLoopExitRoute(loopConfig, { from: routeSource, satisfied: result.satisfied });
  if (!route) {
    throw new ParallelFanInValidationError(
      "fan_in_route_missing",
      `Parallel loop ${JSON.stringify(loopId)} has no symbolic ${result.satisfied ? "satisfied" : "not_satisfied"} fan-in route.`,
    );
  }
  if (!getResolvedPipelineSocket(state.pipeline, route.targetSocketId)) {
    throw new ParallelFanInValidationError(
      "fan_in_target_unknown",
      `Parallel fan-in route targets unknown socket ${JSON.stringify(route.targetSocketId)}.`,
    );
  }
  const handoff = intrinsicParallelFanInHandoff(result);
  const existingEnvelope = state.data.envelope && typeof state.data.envelope === "object" && !Array.isArray(state.data.envelope)
    ? state.data.envelope as Record<string, unknown>
    : {};
  // Make the barrier result available through canonical control
  // fields and a namespaced object for the next integration utility,
  // without leaking branch state into generic work-item fields.
  const nextData: Record<string, unknown> = {
    ...state.data,
    envelope: { ...existingEnvelope, satisfied: handoff.satisfied, context: handoff.context },
    parallelFanIn: handoff.parallelFanIn,
  };
  // The parent is leaving item-scoped lane execution. Do not let a
  // stale branch item masquerade as post-barrier current work.
  delete nextData.item;
  delete nextData.currentWorkItem;
  delete nextData.workItem;
  state.data = nextData;
  state.lastJson = handoff;
  state.lastOutput = JSON.stringify(handoff);
  state.lastAssistantText = state.lastOutput;
  state.currentItemKey = undefined;
  state.currentItemLabel = undefined;
  return { targetSocketId: route.targetSocketId };
}
