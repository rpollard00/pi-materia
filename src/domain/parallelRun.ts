import type {
  MateriaParallelChildSession,
  MateriaParallelConfigIdentity,
  MateriaParallelDiagnostic,
  MateriaParallelFanInPhase,
  MateriaParallelGraphIdentity,
  MateriaParallelLaneState,
  MateriaParallelLaneStatus,
  MateriaParallelLastEvent,
  MateriaParallelPlanIdentity,
  MateriaParallelQueueEntry,
  MateriaParallelRunPhase,
  MateriaParallelRunState,
  MateriaParallelUsageTotals,
} from "./parallelRunTypes.js";
import type { ExecutionScope } from "./executionScope.js";
import type { ParallelLaneProgress } from "./parallelProgress.js";

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
  | "run_terminal"
  | "phase_regression"
  | "fan_in_phase_regression"
  | "event_regression"
  | "progress_unchanged";

export interface CreateParallelRunStateInput {
  parentCastId: string;
  loopId: string;
  /** Optional stable coordinator identity. The deterministic fallback is revival-safe. */
  runId?: string;
  planIdentity: MateriaParallelPlanIdentity;
  graphIdentity: MateriaParallelGraphIdentity;
  configIdentity: MateriaParallelConfigIdentity;
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
  accepted?: boolean;
  executionScope?: ExecutionScope;
  terminalOutput?: unknown;
  childSession?: MateriaParallelChildSession;
  usage?: MateriaParallelUsageTotals;
  lastEvent?: MateriaParallelLastEvent;
  /** Progress checkpoints require a newer lastEvent sequence. */
  progress?: ParallelLaneProgress;
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
  if (!input.graphIdentity || typeof input.graphIdentity !== "object") throw new Error("parallel graphIdentity is required");
  if (!input.configIdentity || typeof input.configIdentity !== "object") throw new Error("parallel configIdentity is required");
  assertNonEmpty(input.planIdentity.planId, "planIdentity.planId");
  assertNonEmpty(input.graphIdentity.graphHash, "graphIdentity.graphHash");
  assertNonEmpty(input.configIdentity.configHash, "configIdentity.configHash");
  if (input.configIdentity.loopId !== input.loopId) throw new Error("parallel configIdentity.loopId must match loopId");
  if (input.planIdentity.workItemCount < 0 || !Number.isSafeInteger(input.planIdentity.workItemCount)) {
    throw new Error("parallel plan workItemCount must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(input.configIdentity.maxConcurrency) || input.configIdentity.maxConcurrency < 1) {
    throw new Error("parallel maxConcurrency must be a positive safe integer");
  }
  const queue = input.queue.map((entry, queueIndex) => {
    assertQueueEntry(entry, queueIndex);
    return {
      laneId: entry.laneId,
      name: entry.name,
      streamIndex: entry.streamIndex,
      workItemIndexes: [...entry.workItemIndexes],
      ...(entry.progressTotal !== undefined ? { progressTotal: entry.progressTotal } : {}),
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
      branchId: `${input.runId?.trim() || `parallel:${input.parentCastId}:${input.loopId}:${input.planIdentity.planId}`}:branch:${encodeURIComponent(entry.laneId)}`,
      laneId: entry.laneId,
      name: entry.name,
      streamIndex: entry.streamIndex,
      queueIndex,
      workItemIndexes: [...entry.workItemIndexes],
      status: "queued",
      attempt: 1,
      progress: { position: 0, total: normalizedProgressTotal(entry.progressTotal) },
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
    graphIdentity: clone(input.graphIdentity),
    configIdentity: clone(input.configIdentity),
    queueOrder: queue.map((entry) => entry.laneId),
    maxConcurrency: input.configIdentity.maxConcurrency,
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
  const laneProgress = normalizeStoredProgress(lane.progress, input.progress?.total);
  if (input.lastEvent && lane.lastEvent && input.lastEvent.sequence <= lane.lastEvent.sequence) return ignored(state, "event_regression");
  const progress = input.progress === undefined ? undefined : normalizeLaneProgress(input.progress, laneProgress.total);
  if (progress && progress.position === laneProgress.position) return ignored(state, "progress_unchanged");
  if (isTerminalLaneStatus(lane.status) && input.status === undefined && hasTerminalLaneMutation(input)) {
    return ignored(state, "terminal_lane");
  }
  const timestamp = finiteTimestamp(input.timestamp, state.updatedAt);
  let nextLane = { ...clone(lane), progress: clone(laneProgress) };
  let nextState = clone(state);
  let changed = lane.progress === undefined;

  if (input.status !== undefined) {
    if (isTerminalLaneStatus(lane.status)) return ignored(state, "terminal_lane");
    if (!isValidLaneTransition(lane.status, input.status)) return ignored(state, "invalid_status_transition");
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
      if (input.status === "accepted") nextLane.progress.position = nextLane.progress.total;
      changed = true;
    }
  }

  if (progress !== undefined) {
    nextLane.progress = progress;
    changed = true;
  }

  if (input.executionScope !== undefined) {
    nextLane.executionScope = clone(input.executionScope);
    changed = true;
  }
  if (input.terminalOutput !== undefined) {
    nextLane.terminalOutput = clone(input.terminalOutput);
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

export interface RestartParallelLaneInput extends ParallelTransitionGuard {
  timestamp?: number;
  diagnostic?: MateriaParallelDiagnostic;
  /** Keep a verifiable child identity/session when the runner can resume it. */
  preserveChildSession?: boolean;
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
    ...(input.preserveChildSession
      ? {
          ...(lane.childCastId !== undefined ? { childCastId: lane.childCastId } : {}),
          ...(lane.childSession !== undefined ? { childSession: clone(lane.childSession) } : {}),
        }
      : {
          childCastId: undefined,
          childSession: undefined,
        }),
    startedAt: undefined,
    endedAt: undefined,
    failureReason: undefined,
    lastEvent: undefined,
    progress: input.preserveChildSession ? normalizeStoredProgress(lane.progress) : { position: 0, total: normalizeStoredProgress(lane.progress).total },
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

function hasTerminalLaneMutation(input: ParallelLaneTransitionInput): boolean {
  return input.childCastId !== undefined
    || input.executionScope !== undefined
    || input.terminalOutput !== undefined
    || input.childSession !== undefined
    || input.usage !== undefined
    || input.progress !== undefined
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
  return ({ dispatching: 0, awaiting_lanes: 1, completed: 2, failed: 2 } satisfies Record<MateriaParallelRunPhase, number>)[phase];
}

function isTerminalFanInPhase(phase: MateriaParallelFanInPhase): boolean {
  return phase === "accepted" || phase === "skipped" || phase === "failed";
}

function fanInPhaseRank(phase: MateriaParallelFanInPhase): number {
  return ({ not_started: 0, accepted: 1, skipped: 1, failed: 1 } satisfies Record<MateriaParallelFanInPhase, number>)[phase];
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

function normalizedProgressTotal(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeLaneProgress(value: ParallelLaneProgress, compiledTotal: number): ParallelLaneProgress {
  const position = typeof value.position === "number" && Number.isFinite(value.position)
    ? Math.floor(value.position)
    : 0;
  return { position: Math.min(compiledTotal, Math.max(0, position)), total: compiledTotal };
}

function normalizeStoredProgress(value: ParallelLaneProgress | undefined, fallbackTotal?: number): ParallelLaneProgress {
  const total = normalizedProgressTotal(value?.total ?? fallbackTotal);
  return normalizeLaneProgress(value ?? { position: 0, total }, total);
}

function ignored(state: MateriaParallelRunState, reason: ParallelTransitionIgnoreReason): ParallelRunTransitionResult {
  return { state, applied: false, reason };
}

function clone<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, clone(child)])) as T;
}
