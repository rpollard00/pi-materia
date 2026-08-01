/**
 * Runtime-facing entrypoint for the pure parallel coordinator state machine.
 * The lane transitions remain domain data transformations; this small adapter
 * only knows how to attach them to a persisted cast snapshot.
 */
export * from "../domain/parallelRun.js";
export * from "../domain/parallelRecovery.js";

import type { MateriaCastState, MateriaParallelRunState } from "../types.js";
import {
  cloneParallelRunState,
  parallelRunKey,
  recordParallelFanInProvenance,
  recordParallelFinalization,
  transitionParallelRun,
  type ParallelFanInProvenanceTransitionInput,
  type ParallelLaneTransitionInput,
  type ParallelTransitionIgnoreReason,
} from "../domain/parallelRun.js";

/** Attach a coordinator record and mark the parent socket as running_parallel. */
export function attachParallelRunToCastState(state: MateriaCastState, run: MateriaParallelRunState): MateriaCastState {
  if (state.castId !== run.parentCastId) throw new Error(`parallel run ${JSON.stringify(run.runId)} belongs to cast ${JSON.stringify(run.parentCastId)}, not ${JSON.stringify(state.castId)}`);
  return {
    ...state,
    parallelRuns: {
      ...(state.parallelRuns ?? {}),
      [parallelRunKey(run.loopId)]: cloneParallelRunState(run),
    },
    awaitingResponse: false,
    socketState: "running_parallel",
    updatedAt: Math.max(state.updatedAt, run.updatedAt),
  };
}

/** Alias matching the parent-coordinator terminology. */
export const beginParallelCoordinator = attachParallelRunToCastState;

export interface CastParallelTransitionResult {
  state: MateriaCastState;
  applied: boolean;
  reason?: ParallelTransitionIgnoreReason;
}

/** Apply a guarded child transition to the corresponding cast snapshot. */
export function applyParallelTransitionToCastState(
  state: MateriaCastState,
  input: ParallelLaneTransitionInput,
): CastParallelTransitionResult {
  const expectedCast = input.parentCastId ?? input.castId;
  if (expectedCast !== undefined && expectedCast !== state.castId) return { state, applied: false, reason: "cast_mismatch" };
  const run = state.parallelRuns?.[parallelRunKey(input.loopId)];
  if (!run) return { state, applied: false, reason: "run_mismatch" };
  const result = transitionParallelRun(run, { ...input, parentCastId: state.castId });
  if (!result.applied) return { state, applied: false, reason: result.reason };
  return {
    state: {
      ...state,
      parallelRuns: { ...(state.parallelRuns ?? {}), [parallelRunKey(input.loopId)]: result.state },
      awaitingResponse: false,
      socketState: "running_parallel",
      updatedAt: Math.max(state.updatedAt, result.state.updatedAt),
    },
    applied: true,
  };
}

/** Short alias for runtime adapters that already have a cast snapshot. */
export const applyParallelLaneTransitionToCast = applyParallelTransitionToCastState;

/** Apply one guarded fan-in provenance record to a persisted cast snapshot. */
export function applyParallelFanInProvenanceToCastState(
  state: MateriaCastState,
  input: ParallelFanInProvenanceTransitionInput,
): CastParallelTransitionResult {
  const expectedCast = input.parentCastId ?? input.castId;
  if (expectedCast !== undefined && expectedCast !== state.castId) return { state, applied: false, reason: "cast_mismatch" };
  const run = state.parallelRuns?.[parallelRunKey(input.loopId)];
  if (!run) return { state, applied: false, reason: "run_mismatch" };
  const result = recordParallelFanInProvenance(run, { ...input, parentCastId: state.castId });
  if (!result.applied) return { state, applied: false, reason: result.reason };
  return {
    state: {
      ...state,
      parallelRuns: { ...(state.parallelRuns ?? {}), [parallelRunKey(input.loopId)]: result.state },
      updatedAt: Math.max(state.updatedAt, result.state.updatedAt),
    },
    applied: true,
  };
}

export const applyParallelFanInResultToCastState = applyParallelFanInProvenanceToCastState;

/** Apply the post-integration finalization result to a persisted cast snapshot. */
export function applyParallelFinalizationToCastState(
  state: MateriaCastState,
  input: import("../domain/parallelRun.js").ParallelFinalizationTransitionInput,
): CastParallelTransitionResult {
  const expectedCast = input.parentCastId ?? input.castId;
  if (expectedCast !== undefined && expectedCast !== state.castId) return { state, applied: false, reason: "cast_mismatch" };
  const run = state.parallelRuns?.[parallelRunKey(input.loopId)];
  if (!run) return { state, applied: false, reason: "run_mismatch" };
  const result = recordParallelFinalization(run, { ...input, parentCastId: state.castId });
  if (!result.applied) return { state, applied: false, reason: result.reason };
  return {
    state: {
      ...state,
      parallelRuns: { ...(state.parallelRuns ?? {}), [parallelRunKey(input.loopId)]: result.state },
      awaitingResponse: false,
      updatedAt: Math.max(state.updatedAt, result.state.updatedAt),
    },
    applied: true,
  };
}

export const applyParallelFinalizationProvenanceToCastState = applyParallelFinalizationToCastState;
export type { ParallelFanInProvenanceTransitionInput, ParallelFinalizationTransitionInput } from "../domain/parallelRun.js";
