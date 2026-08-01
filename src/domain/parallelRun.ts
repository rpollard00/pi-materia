import type {
  MateriaParallelChildSession,
  MateriaParallelConfigIdentity,
  MateriaParallelDiagnostic,
  MateriaParallelFanInPhase,
  MateriaParallelFanInProvenance,
  MateriaParallelFinalizationProvenance,
  MateriaParallelLaneState,
  MateriaParallelLaneStatus,
  MateriaParallelLastEvent,
  MateriaParallelPlanIdentity,
  MateriaParallelQueueEntry,
  MateriaParallelRevisionIdentity,
  MateriaParallelRunPhase,
  MateriaParallelRunState,
  MateriaParallelUsageTotals,
  MateriaParallelWorkspaceOwnership,
} from "./parallelRunTypes.js";

export const PARALLEL_RUN_STATE_VERSION = 1 as const;
export const PARALLEL_RUN_DIAGNOSTIC_LIMIT = 64 as const;

export type ParallelTransitionIgnoreReason =
  | "cast_mismatch"
  | "loop_mismatch"
  | "run_mismatch"
  | "lane_missing"
  | "attempt_mismatch"
  | "child_mismatch"
  | "terminal_lane"
  | "invalid_status_transition"
  | "accepted_head_required"
  | "run_terminal"
  | "phase_regression"
  | "fan_in_phase_regression"
  | "event_regression"
  | "fan_in_provenance_conflict";

export interface CreateParallelRunStateInput {
  parentCastId: string;
  loopId: string;
  /** Optional stable coordinator identity. The deterministic fallback is revival-safe. */
  runId?: string;
  planIdentity: MateriaParallelPlanIdentity;
  configIdentity: MateriaParallelConfigIdentity;
  baseline: MateriaParallelRevisionIdentity;
  queue: readonly MateriaParallelQueueEntry[];
  now?: number;
}

/**
 * Identity carried by every child callback. A callback without the current run,
 * lane, attempt, and (once assigned) child identity must not update durable state.
 */
export interface ParallelTransitionGuard {
  parentCastId?: string;
  castId?: string;
  loopId: string;
  runId: string;
  laneId: string;
  attempt: number;
  childCastId?: string;
}

export interface ParallelLaneTransitionInput extends ParallelTransitionGuard {
  status?: MateriaParallelLaneStatus;
  acceptedHead?: MateriaParallelRevisionIdentity;
  accepted?: boolean;
  workspace?: MateriaParallelWorkspaceOwnership;
  childSession?: MateriaParallelChildSession;
  usage?: MateriaParallelUsageTotals;
  lastEvent?: MateriaParallelLastEvent;
  diagnostic?: MateriaParallelDiagnostic;
  failureReason?: string;
  phase?: MateriaParallelRunPhase;
  fanInPhase?: MateriaParallelFanInPhase;
  timestamp?: number;
}

export interface ParallelRunTransitionResult {
  state: MateriaParallelRunState;
  applied: boolean;
  reason?: ParallelTransitionIgnoreReason;
}

export interface ParallelRunGuard {
  parentCastId?: string;
  castId?: string;
  loopId: string;
  runId: string;
}

export interface ParallelRunPhaseTransitionInput extends ParallelRunGuard {
  phase?: MateriaParallelRunPhase;
  fanInPhase?: MateriaParallelFanInPhase;
  timestamp?: number;
}

export interface ParallelFanInProvenanceTransitionInput extends ParallelRunGuard {
  provenance: MateriaParallelFanInProvenance;
  timestamp?: number;
}

export interface ParallelFinalizationTransitionInput extends ParallelRunGuard {
  provenance: MateriaParallelFinalizationProvenance;
  timestamp?: number;
}

/** A deterministic key for the cast's map of loop coordinator records. */
export function parallelRunKey(loopId: string): string {
  return loopId;
}

/** A stable diagnostic key for a nested loop/lane identity. */
export function parallelLaneKey(loopId: string, laneId: string): string {
  return `${loopId}/${laneId}`;
}

/**
 * Construct a durable coordinator record from one immutable normalized plan.
 * The queue is copied in authored stream order; completion order never enters
 * this record's identity or ordering.
 */
export function createParallelRunState(input: CreateParallelRunStateInput): MateriaParallelRunState {
  assertNonEmpty(input.parentCastId, "parentCastId");
  assertNonEmpty(input.loopId, "loopId");
  if (!input.planIdentity || typeof input.planIdentity !== "object") throw new Error("parallel planIdentity is required");
  if (!input.configIdentity || typeof input.configIdentity !== "object") throw new Error("parallel configIdentity is required");
  if (!input.baseline || typeof input.baseline !== "object") throw new Error("parallel baseline is required");
  assertNonEmpty(input.planIdentity.planId, "planIdentity.planId");
  assertNonEmpty(input.configIdentity.configHash, "configIdentity.configHash");
  if (input.configIdentity.loopId !== input.loopId) throw new Error("parallel configIdentity.loopId must match loopId");
  if (input.planIdentity.workItemCount < 0 || !Number.isSafeInteger(input.planIdentity.workItemCount)) {
    throw new Error("parallel plan workItemCount must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(input.configIdentity.maxConcurrency) || input.configIdentity.maxConcurrency < 1) {
    throw new Error("parallel maxConcurrency must be a positive safe integer");
  }
  if (typeof input.baseline.commitId !== "string" || typeof input.baseline.changeId !== "string" || input.baseline.commitId.trim().length === 0 || input.baseline.changeId.trim().length === 0) {
    throw new Error("parallel baseline must contain commitId and changeId");
  }

  const queue = input.queue.map((entry, queueIndex) => {
    assertQueueEntry(entry, queueIndex);
    return {
      laneId: entry.laneId,
      name: entry.name,
      streamIndex: entry.streamIndex,
      workItemIndexes: [...entry.workItemIndexes],
    };
  });
  const laneIds = new Set<string>();
  const streamIndexes = new Set<number>();
  const workItemIndexes = new Set<number>();
  for (const entry of queue) {
    if (laneIds.has(entry.laneId)) throw new Error(`parallel queue contains duplicate lane ${JSON.stringify(entry.laneId)}`);
    if (streamIndexes.has(entry.streamIndex)) throw new Error(`parallel queue contains duplicate streamIndex ${entry.streamIndex}`);
    laneIds.add(entry.laneId);
    streamIndexes.add(entry.streamIndex);
    for (const index of entry.workItemIndexes) {
      if (index >= input.planIdentity.workItemCount) throw new Error(`parallel queue work-item index ${index} is outside the normalized plan`);
      if (workItemIndexes.has(index)) throw new Error(`parallel queue assigns work-item index ${index} more than once`);
      workItemIndexes.add(index);
    }
  }
  if (workItemIndexes.size !== input.planIdentity.workItemCount) throw new Error("parallel queue must assign every normalized work item exactly once");

  const now = finiteTimestamp(input.now, Date.now());
  const lanes: Record<string, MateriaParallelLaneState> = {};
  for (const [queueIndex, entry] of queue.entries()) {
    lanes[entry.laneId] = {
      laneId: entry.laneId,
      name: entry.name,
      streamIndex: entry.streamIndex,
      queueIndex,
      workItemIndexes: [...entry.workItemIndexes],
      status: "queued",
      attempt: 1,
      updatedAt: now,
      diagnostics: [],
    };
  }

  const noLanes = queue.length === 0;
  return {
    version: PARALLEL_RUN_STATE_VERSION,
    parentCastId: input.parentCastId,
    loopId: input.loopId,
    runId: input.runId?.trim() || `parallel:${input.parentCastId}:${input.loopId}:${input.planIdentity.planId}`,
    planIdentity: clone(input.planIdentity),
    configIdentity: clone(input.configIdentity),
    baseline: clone(input.baseline),
    queueOrder: queue.map((entry) => entry.laneId),
    maxConcurrency: input.configIdentity.maxConcurrency,
    workspaceMode: input.configIdentity.workspaceMode,
    failurePolicy: input.configIdentity.failurePolicy,
    fanIn: input.configIdentity.fanIn,
    phase: noLanes ? "completed" : "dispatching",
    fanInPhase: noLanes ? "skipped" : "not_started",
    lanes,
    diagnostics: [],
    createdAt: now,
    updatedAt: now,
    ...(noLanes ? { endedAt: now } : {}),
  };
}

/** Alias used by runtime callers that call this a coordinator record. */
export const createParallelCoordinatorState = createParallelRunState;
export const createParallelRun = createParallelRunState;
export const initializeParallelRunState = createParallelRunState;

/** Return a clone so callers cannot mutate the persisted record behind the reducer. */
export function cloneParallelRunState(state: MateriaParallelRunState): MateriaParallelRunState {
  return clone(state);
}

/**
 * Apply one guarded lane callback without mutating the input record.
 *
 * Guards are checked before any callback data is copied. Terminal lane states
 * are sticky, and accepted requires a recorded head, so late subprocess events
 * can never turn a newer attempt or terminal lane back into running work.
 */
export function transitionParallelRun(
  state: MateriaParallelRunState,
  input: ParallelLaneTransitionInput,
): ParallelRunTransitionResult {
  const guardFailure = guardFailureFor(state, input);
  if (guardFailure) return ignored(state, guardFailure);

  const lane = state.lanes[input.laneId]!;
  if (input.lastEvent && lane.lastEvent && input.lastEvent.sequence <= lane.lastEvent.sequence) return ignored(state, "event_regression");
  if (isTerminalLaneStatus(lane.status) && input.status === undefined && hasTerminalLaneMutation(input)) {
    return ignored(state, "terminal_lane");
  }
  const timestamp = finiteTimestamp(input.timestamp, state.updatedAt);
  let nextLane = clone(lane);
  let nextState = clone(state);
  let changed = false;

  if (input.status !== undefined) {
    if (isTerminalLaneStatus(lane.status)) return ignored(state, "terminal_lane");
    if (!isValidLaneTransition(lane.status, input.status)) return ignored(state, "invalid_status_transition");
    const acceptedHead = input.acceptedHead ?? lane.acceptedHead;
    if (input.status === "accepted" && !isRevisionIdentity(acceptedHead)) {
      return ignored(state, "accepted_head_required");
    }
    if (input.status === "accepted" && input.accepted === false) {
      return ignored(state, "invalid_status_transition");
    }
    if (input.status !== lane.status) {
      nextLane.status = input.status;
      changed = true;
    }
    if (input.status === "running" && nextLane.startedAt === undefined) {
      nextLane.startedAt = timestamp;
      changed = true;
    }
    if (isTerminalLaneStatus(input.status)) {
      nextLane.endedAt = timestamp;
      changed = true;
    }
  }

  if (input.workspace !== undefined) {
    nextLane.workspace = clone(input.workspace);
    changed = true;
  }
  if (input.childCastId !== undefined && input.childSession !== undefined && input.childCastId !== input.childSession.childCastId) {
    return ignored(state, "child_mismatch");
  }
  if (input.childCastId !== undefined && lane.childCastId === undefined) {
    nextLane.childCastId = input.childCastId;
    changed = true;
  }
  if (input.childSession !== undefined) {
    nextLane.childSession = clone(input.childSession);
    nextLane.childCastId = input.childSession.childCastId;
    changed = true;
  }
  if (input.acceptedHead !== undefined) {
    nextLane.acceptedHead = clone(input.acceptedHead);
    changed = true;
  }
  if (input.usage !== undefined) {
    nextLane.usage = clone(input.usage);
    changed = true;
  }
  if (input.lastEvent !== undefined) {
    if (!lane.lastEvent || input.lastEvent.sequence > lane.lastEvent.sequence) {
      nextLane.lastEvent = clone(input.lastEvent);
      changed = true;
    }
  }
  if (input.failureReason !== undefined) {
    nextLane.failureReason = input.failureReason;
    changed = true;
  }
  if (input.diagnostic !== undefined) {
    nextLane.diagnostics = appendDiagnostic(lane.diagnostics, input.diagnostic);
    nextState.diagnostics = appendDiagnostic(state.diagnostics, input.diagnostic);
    changed = true;
  }

  const phaseResult = applyRunPhase(nextState, input.phase, input.fanInPhase);
  if (!phaseResult.applied && phaseResult.reason) return ignored(state, phaseResult.reason);
  if (phaseResult.applied) {
    nextState = phaseResult.state;
    if (isTerminalRunPhase(nextState.phase)) nextState.endedAt = timestamp;
    changed = true;
  }

  if (!changed) return ignored(state, "invalid_status_transition");
  nextLane.updatedAt = Math.max(lane.updatedAt, timestamp);
  nextState.lanes[input.laneId] = nextLane;
  nextState.updatedAt = Math.max(state.updatedAt, timestamp);
  if (isTerminalLaneStatus(nextLane.status)) {
    const allTerminal = Object.values(nextState.lanes).every((candidate) => isTerminalLaneStatus(candidate.status));
    if (allTerminal && nextState.phase === "dispatching") nextState.phase = "awaiting_lanes";
  }
  return { state: nextState, applied: true };
}

/** Explicitly named alias for callers handling child callbacks. */
export const applyParallelLaneTransition = transitionParallelRun;
export const applyParallelRunTransition = transitionParallelRun;
export const guardedParallelLaneTransition = transitionParallelRun;
export const transitionParallelLane = transitionParallelRun;
export const transitionParallelLaneState = transitionParallelRun;
export const updateParallelRunState = transitionParallelRun;

/** Advance coordinator/fan-in phase independently of a lane callback. */
export function transitionParallelRunPhase(
  state: MateriaParallelRunState,
  input: ParallelRunPhaseTransitionInput,
): ParallelRunTransitionResult {
  const guardFailure = runGuardFailureFor(state, input);
  if (guardFailure) return ignored(state, guardFailure);
  const phaseResult = applyRunPhase(state, input.phase, input.fanInPhase);
  if (!phaseResult.applied) return { state, applied: false, reason: phaseResult.reason ?? "invalid_status_transition" };
  const timestamp = finiteTimestamp(input.timestamp, state.updatedAt);
  const next = phaseResult.state;
  next.updatedAt = Math.max(state.updatedAt, timestamp);
  if (isTerminalRunPhase(next.phase)) next.endedAt = timestamp;
  return { state: next, applied: true };
}

export const applyParallelRunPhaseTransition = transitionParallelRunPhase;
export const guardedParallelRunPhaseTransition = transitionParallelRunPhase;

/** Persist one guarded fan-in result without allowing a second result to replace it. */
export function recordParallelFanInProvenance(
  state: MateriaParallelRunState,
  input: ParallelFanInProvenanceTransitionInput,
): ParallelRunTransitionResult {
  const guardFailure = runGuardFailureFor(state, input);
  if (guardFailure) return ignored(state, guardFailure);
  if (state.fanInProvenance !== undefined) {
    return JSON.stringify(state.fanInProvenance) === JSON.stringify(input.provenance)
      ? { state, applied: false, reason: "fan_in_provenance_conflict" }
      : ignored(state, "fan_in_provenance_conflict");
  }
  const timestamp = finiteTimestamp(input.timestamp, state.updatedAt);
  const next = clone(state);
  next.fanInProvenance = clone(input.provenance);
  next.updatedAt = Math.max(state.updatedAt, timestamp);
  return { state: next, applied: true };
}

export const applyParallelFanInProvenance = recordParallelFanInProvenance;

/**
 * Record the final evaluation/VCS boundary exactly once. A rejected
 * evaluation remains retryable and deliberately leaves the coordinator in its
 * evaluating/resolving phase; an accepted result closes the run.
 */
export function recordParallelFinalization(
  state: MateriaParallelRunState,
  input: ParallelFinalizationTransitionInput,
): ParallelRunTransitionResult {
  const guardFailure = runGuardFailureFor(state, input);
  if (guardFailure) return ignored(state, guardFailure);
  if (input.provenance.status === "completed" && (!input.provenance.evaluationAccepted || !input.provenance.conflictFree)) {
    return ignored(state, "invalid_status_transition");
  }
  if (state.finalizationProvenance !== undefined) {
    if (state.finalizationProvenance.status === "completed") return ignored(state, "fan_in_provenance_conflict");
    if (input.provenance.status === "preserved" && JSON.stringify(state.finalizationProvenance) === JSON.stringify(input.provenance)) {
      return { state, applied: false, reason: "fan_in_provenance_conflict" };
    }
  }
  const timestamp = finiteTimestamp(input.timestamp, state.updatedAt);
  const next = clone(state);
  next.finalizationProvenance = clone(input.provenance);
  next.updatedAt = Math.max(state.updatedAt, timestamp);
  if (input.provenance.status === "completed") {
    next.phase = "completed";
    next.fanInPhase = "accepted";
    next.endedAt = timestamp;
  }
  return { state: next, applied: true };
}

export const applyParallelFinalizationProvenance = recordParallelFinalization;

export interface RestartParallelLaneInput extends ParallelTransitionGuard {
  timestamp?: number;
  diagnostic?: MateriaParallelDiagnostic;
}

/**
 * Start an explicit revival attempt for a failed/interrupted lane. This is the
 * only transition that reopens a terminal lane; ordinary child callbacks can
 * never do so. The lane identity and stream membership remain unchanged.
 */
export function restartParallelLaneAttempt(
  state: MateriaParallelRunState,
  input: RestartParallelLaneInput,
): ParallelRunTransitionResult {
  const guardFailure = guardFailureFor(state, input);
  if (guardFailure) return ignored(state, guardFailure);
  const lane = state.lanes[input.laneId]!;
  if (lane.status !== "failed" && lane.status !== "interrupted") return ignored(state, "terminal_lane");

  const timestamp = finiteTimestamp(input.timestamp, state.updatedAt);
  const next = clone(state);
  const diagnostics = input.diagnostic ? appendDiagnostic(lane.diagnostics, input.diagnostic) : [...lane.diagnostics];
  next.lanes[input.laneId] = {
    ...clone(lane),
    status: "queued",
    attempt: lane.attempt + 1,
    childCastId: undefined,
    childSession: undefined,
    acceptedHead: undefined,
    startedAt: undefined,
    endedAt: undefined,
    failureReason: undefined,
    lastEvent: undefined,
    updatedAt: timestamp,
    diagnostics,
  };
  if (input.diagnostic) next.diagnostics = appendDiagnostic(state.diagnostics, input.diagnostic);
  next.phase = "dispatching";
  next.fanInPhase = "not_started";
  next.endedAt = undefined;
  next.updatedAt = Math.max(state.updatedAt, timestamp);
  return { state: next, applied: true };
}

export const beginParallelLaneAttempt = restartParallelLaneAttempt;
export const reviveParallelLane = restartParallelLaneAttempt;
export const restartParallelLane = restartParallelLaneAttempt;

/**
 * Append a diagnostic through the same identity/attempt guard, including after
 * a lane is terminal. This is intentionally separate from status transitions:
 * late telemetry can be retained without reopening or changing the lane.
 */
export function appendParallelLaneDiagnostic(
  state: MateriaParallelRunState,
  input: ParallelTransitionGuard & { diagnostic: MateriaParallelDiagnostic; timestamp?: number },
): ParallelRunTransitionResult {
  const guardFailure = guardFailureFor(state, input);
  if (guardFailure) return ignored(state, guardFailure);
  const lane = state.lanes[input.laneId]!;
  const next = clone(state);
  const timestamp = finiteTimestamp(input.timestamp, state.updatedAt);
  next.lanes[input.laneId] = {
    ...clone(lane),
    diagnostics: appendDiagnostic(lane.diagnostics, input.diagnostic),
    updatedAt: Math.max(lane.updatedAt, timestamp),
  };
  next.diagnostics = appendDiagnostic(state.diagnostics, input.diagnostic);
  next.updatedAt = Math.max(state.updatedAt, timestamp);
  return { state: next, applied: true };
}

function runGuardFailureFor(state: MateriaParallelRunState, input: ParallelRunGuard): ParallelTransitionIgnoreReason | undefined {
  const callbackCast = input.parentCastId ?? input.castId;
  if (callbackCast !== undefined && callbackCast !== state.parentCastId) return "cast_mismatch";
  if (input.loopId !== state.loopId) return "loop_mismatch";
  if (input.runId !== state.runId) return "run_mismatch";
  return undefined;
}

function guardFailureFor(state: MateriaParallelRunState, input: ParallelTransitionGuard): ParallelTransitionIgnoreReason | undefined {
  const runFailure = runGuardFailureFor(state, input);
  if (runFailure) return runFailure;
  const callbackCast = input.parentCastId ?? input.castId;
  if (callbackCast !== undefined && callbackCast !== state.parentCastId) return "cast_mismatch";
  if (input.loopId !== state.loopId) return "loop_mismatch";
  if (input.runId !== state.runId) return "run_mismatch";
  const lane = state.lanes[input.laneId];
  if (!lane) return "lane_missing";
  if (input.attempt !== lane.attempt) return "attempt_mismatch";
  if (lane.childCastId !== undefined && input.childCastId !== lane.childCastId) return "child_mismatch";
  return undefined;
}

function applyRunPhase(
  state: MateriaParallelRunState,
  phase: MateriaParallelRunPhase | undefined,
  fanInPhase: MateriaParallelFanInPhase | undefined,
): ParallelRunTransitionResult {
  if (phase === undefined && fanInPhase === undefined) return { state, applied: false };
  if (isTerminalRunPhase(state.phase)) return ignored(state, "run_terminal");
  const next = clone(state);
  if (phase !== undefined) {
    if (phaseRank(phase) < phaseRank(state.phase)) return ignored(state, "phase_regression");
    if (phase !== state.phase) next.phase = phase;
  }
  if (fanInPhase !== undefined) {
    if (isTerminalFanInPhase(state.fanInPhase) && fanInPhase !== state.fanInPhase) return ignored(state, "fan_in_phase_regression");
    if (fanInPhaseRank(fanInPhase) < fanInPhaseRank(state.fanInPhase)) return ignored(state, "fan_in_phase_regression");
    if (fanInPhase !== state.fanInPhase) next.fanInPhase = fanInPhase;
  }
  return { state: next, applied: next.phase !== state.phase || next.fanInPhase !== state.fanInPhase };
}

function isRevisionIdentity(value: MateriaParallelRevisionIdentity | undefined): boolean {
  return Boolean(
    value &&
    typeof value.commitId === "string" && value.commitId.trim().length > 0 &&
    typeof value.changeId === "string" && value.changeId.trim().length > 0,
  );
}

function hasTerminalLaneMutation(input: ParallelLaneTransitionInput): boolean {
  return input.childCastId !== undefined
    || input.workspace !== undefined
    || input.childSession !== undefined
    || input.acceptedHead !== undefined
    || input.usage !== undefined
    || input.failureReason !== undefined
    || input.phase !== undefined
    || input.fanInPhase !== undefined;
}

function isValidLaneTransition(current: MateriaParallelLaneStatus, next: MateriaParallelLaneStatus): boolean {
  if (current === next) return true;
  if (current === "queued") return next === "running" || next === "failed" || next === "interrupted";
  if (current === "running") return next === "accepted" || next === "failed" || next === "interrupted";
  return false;
}

function isTerminalLaneStatus(status: MateriaParallelLaneStatus): boolean {
  return status === "accepted" || status === "failed" || status === "interrupted";
}

function isTerminalRunPhase(phase: MateriaParallelRunPhase): boolean {
  return phase === "completed" || phase === "failed";
}

function phaseRank(phase: MateriaParallelRunPhase): number {
  return ({ dispatching: 0, awaiting_lanes: 1, fan_in: 2, conflict: 3, resolving: 4, evaluating: 5, completed: 6, failed: 6 } satisfies Record<MateriaParallelRunPhase, number>)[phase];
}

function isTerminalFanInPhase(phase: MateriaParallelFanInPhase): boolean {
  return phase === "accepted" || phase === "skipped" || phase === "failed";
}

function fanInPhaseRank(phase: MateriaParallelFanInPhase): number {
  return ({ not_started: 0, ready: 1, running: 2, conflict: 3, resolved: 4, accepted: 5, skipped: 5, failed: 5 } satisfies Record<MateriaParallelFanInPhase, number>)[phase];
}

function appendDiagnostic(existing: readonly MateriaParallelDiagnostic[], diagnostic: MateriaParallelDiagnostic): MateriaParallelDiagnostic[] {
  const next = [...existing, clone(diagnostic)];
  return next.length > PARALLEL_RUN_DIAGNOSTIC_LIMIT ? next.slice(-PARALLEL_RUN_DIAGNOSTIC_LIMIT) : next;
}

function assertQueueEntry(entry: MateriaParallelQueueEntry, index: number): void {
  if (!entry || typeof entry !== "object") throw new Error(`parallel queue entry ${index} must be an object`);
  assertNonEmpty(entry.laneId, `queue[${index}].laneId`);
  assertNonEmpty(entry.name, `queue[${index}].name`);
  if (!Number.isSafeInteger(entry.streamIndex) || entry.streamIndex < 0) throw new Error(`parallel queue entry ${index} streamIndex must be a non-negative safe integer`);
  if (!Array.isArray(entry.workItemIndexes) || entry.workItemIndexes.length === 0) throw new Error(`parallel queue entry ${index} workItemIndexes must be a non-empty array`);
  if (!entry.workItemIndexes.every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error(`parallel queue entry ${index} workItemIndexes must contain non-negative safe integers`);
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`parallel ${label} must be a non-empty string`);
}

function finiteTimestamp(value: number | undefined, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function ignored(state: MateriaParallelRunState, reason: ParallelTransitionIgnoreReason): ParallelRunTransitionResult {
  return { state, applied: false, reason };
}

function clone<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, clone(child)])) as T;
}
