import type { DomainResult } from "./result.js";
import { err, ok } from "./result.js";
import type { MateriaParallelLaneState, MateriaParallelRunState } from "./parallelRunTypes.js";

export type ParallelRecoveryOperation = "revive" | "recast";

/**
 * The command grammar deliberately keeps the old bulk forms intact:
 * `undefined` lane means revive/recast the whole failed cast, while a lane
 * number opts into selective parallel recovery.
 */
export type ParsedParallelRecoveryTarget =
  | { kind: "bulk"; castId?: string }
  | { kind: "lane"; castId?: string; laneNumber: number };

/** Minimal cast shape needed by this pure resolver. */
export interface ParallelRecoveryCastState {
  castId: string;
  active: boolean;
  updatedAt?: number;
  startedAt?: number;
  parallelRuns?: Record<string, MateriaParallelRunState>;
}

export interface ResolvedParallelLaneTarget<TState extends ParallelRecoveryCastState = ParallelRecoveryCastState> {
  kind: "lane";
  castId: string;
  loopId: string;
  runId: string;
  laneId: string;
  laneNumber: number;
  lane: MateriaParallelLaneState;
  run: MateriaParallelRunState;
  state: TState;
}

export type ResolvedParallelRecoveryTarget<TState extends ParallelRecoveryCastState = ParallelRecoveryCastState> =
  | { kind: "bulk"; castId?: string }
  | ResolvedParallelLaneTarget<TState>;

/**
 * Parse the arguments after `/materia revive` or `/materia recast`.
 *
 * A lone positive integer is intentionally not treated as a cast id: it is
 * the stable, one-based lane number of the newest failed parallel parent.
 * Cast ids remain the one-token non-numeric form, and the explicit
 * `<cast-id> <number>` form disambiguates a lane on a particular cast.
 */
export function parseParallelRecoveryTarget(argumentsText: string | undefined): DomainResult<ParsedParallelRecoveryTarget> {
  const normalized = (argumentsText ?? "").trim();
  if (!normalized) return ok({ kind: "bulk" });

  const tokens = normalized.split(/\s+/);
  if (tokens.length > 2) {
    return err("arguments", "Expected no arguments, a cast id, a lane number, or '<cast-id> <lane-number>'.");
  }

  if (tokens.length === 1) {
    const token = tokens[0]!;
    if (isIntegerToken(token)) return parseLaneNumber(token);
    if (looksLikeLaneNumber(token)) {
      return err("laneNumber", "Lane number must be a positive 1-based safe integer (for example, 1).");
    }
    return ok({ kind: "bulk", castId: token });
  }

  const castId = tokens[0]!;
  if (!castId) return err("castId", "Cast id must be non-empty.");
  const laneToken = tokens[1]!;
  if (!isIntegerToken(laneToken)) {
    return err("laneNumber", "Lane number must be a positive 1-based safe integer (for example, 1).");
  }
  const parsed = parseLaneNumber(laneToken);
  return parsed.ok ? ok({ ...parsed.value, castId }) : parsed;
}

/** Compatibility spelling for callers that include `Command` in the name. */
export const parseParallelRecoveryCommandTarget = parseParallelRecoveryTarget;

/**
 * Resolve a parsed target against immutable persisted cast/run state.
 *
 * Lane positions are obtained only from `run.queueOrder`; lane status and
 * object insertion order never renumber the queue. Consequently an accepted
 * lane remains at its original number after one or more sibling recoveries.
 */
export interface ParallelRecoveryResolverInput<TState extends ParallelRecoveryCastState = ParallelRecoveryCastState> {
  target: ParsedParallelRecoveryTarget;
  states: readonly TState[];
  operation?: ParallelRecoveryOperation;
}

export function resolveParallelRecoveryTarget<TState extends ParallelRecoveryCastState = ParallelRecoveryCastState>(input: ParallelRecoveryResolverInput<TState>): DomainResult<ResolvedParallelRecoveryTarget<TState>>;
export function resolveParallelRecoveryTarget<TState extends ParallelRecoveryCastState = ParallelRecoveryCastState>(target: ParsedParallelRecoveryTarget, states: readonly TState[], operation?: ParallelRecoveryOperation): DomainResult<ResolvedParallelRecoveryTarget<TState>>;
export function resolveParallelRecoveryTarget<TState extends ParallelRecoveryCastState = ParallelRecoveryCastState>(states: readonly TState[], target: ParsedParallelRecoveryTarget, operation?: ParallelRecoveryOperation): DomainResult<ResolvedParallelRecoveryTarget<TState>>;
export function resolveParallelRecoveryTarget<TState extends ParallelRecoveryCastState = ParallelRecoveryCastState>(
  inputOrTarget: ParallelRecoveryResolverInput<TState> | ParsedParallelRecoveryTarget | readonly TState[],
  statesOrTarget?: readonly TState[] | ParsedParallelRecoveryTarget,
  requestedOperation?: ParallelRecoveryOperation,
): DomainResult<ResolvedParallelRecoveryTarget<TState>> {
  const input: ParallelRecoveryResolverInput<TState> = Array.isArray(inputOrTarget)
    ? { states: inputOrTarget, target: statesOrTarget as ParsedParallelRecoveryTarget, ...(requestedOperation ? { operation: requestedOperation } : {}) }
    : statesOrTarget && Array.isArray(statesOrTarget)
      ? { target: inputOrTarget as ParsedParallelRecoveryTarget, states: statesOrTarget, ...(requestedOperation ? { operation: requestedOperation } : {}) }
      : inputOrTarget as ParallelRecoveryResolverInput<TState>;
  if (input.target.kind === "bulk") return ok(input.target);

  const operation = input.operation ?? "revive";
  const stateResult = selectParallelParent(input.states, input.target.castId, input.target.laneNumber, operation);
  if (!stateResult.ok) return stateResult;

  const runResult = selectRecoveryRun(stateResult.value, input.target.laneNumber, operation);
  if (!runResult.ok) return runResult;

  const { loopId, run } = runResult.value;
  const laneId = run.queueOrder[input.target.laneNumber - 1];
  if (typeof laneId !== "string" || laneId.length === 0) {
    return err("laneNumber", `Lane number ${input.target.laneNumber} is out of range for parallel run ${JSON.stringify(run.runId)}; valid lane numbers are 1-${run.queueOrder.length}.`);
  }

  const lane = run.lanes[laneId];
  if (!lane) {
    return err("laneNumber", `Parallel run ${JSON.stringify(run.runId)} has no persisted lane for queue position ${input.target.laneNumber}.`);
  }
  if (lane.status === "accepted") {
    return err("laneNumber", `Parallel lane #${input.target.laneNumber} (${JSON.stringify(lane.name)}) is accepted and cannot be recovered.`);
  }
  if (lane.status === "running" || lane.status === "queued") {
    return err("laneNumber", `Parallel lane #${input.target.laneNumber} (${JSON.stringify(lane.name)}) is ${lane.status === "queued" ? "queued" : "running"} and cannot be recovered.`);
  }
  if (lane.status !== "failed" && lane.status !== "interrupted") {
    return err("laneNumber", `Parallel lane #${input.target.laneNumber} (${JSON.stringify(lane.name)}) is not failed or interrupted and cannot be recovered.`);
  }

  return ok({
    kind: "lane",
    castId: stateResult.value.castId,
    loopId,
    runId: run.runId,
    laneId,
    laneNumber: input.target.laneNumber,
    lane,
    run,
    state: stateResult.value,
  });
}

/** Compatibility spelling for callers that include `Command` in the name. */
export const resolveParallelRecoveryCommandTarget = resolveParallelRecoveryTarget;

/**
 * A failed run is recoverable only at the branch boundary. Accepted branches
 * are immutable results; only failed or interrupted branches may be reopened.
 * Plan, graph, branch, and execution-scope identity validation is performed by
 * the dispatcher against the current compiled program before any attempt is
 * changed.
 */
export function isParallelLaneRevivalCandidate(run: MateriaParallelRunState | undefined): boolean {
  if (!run || run.phase !== "failed" || run.fanInPhase !== "skipped" || !isRecord(run.lanes)) return false;
  const lanes = Object.values(run.lanes);
  return lanes.length > 0
    && lanes.every((lane) => isRecord(lane)
      && (lane.status === "accepted" || lane.status === "failed" || lane.status === "interrupted"))
    && lanes.some((lane) => isRecord(lane)
      && (lane.status === "failed" || lane.status === "interrupted"));
}

function selectParallelParent<TState extends ParallelRecoveryCastState>(
  states: readonly TState[],
  requestedCastId: string | undefined,
  laneNumber: number,
  operation: ParallelRecoveryOperation,
): DomainResult<TState> {
  if (requestedCastId) {
    const state = states.find((candidate) => candidate.castId === requestedCastId);
    if (!state) return err("castId", `Unknown pi-materia cast id ${JSON.stringify(requestedCastId)} for lane #${laneNumber}.`);
    if (state.active || hasRunningParallelWork(state)) {
      return err("castId", `Cast ${JSON.stringify(state.castId)} is running; stop waiting for its parallel lanes before numbered ${operation}.`);
    }
    return ok(state);
  }

  const candidates = states
    .filter((state) => !state.active && Object.values(state.parallelRuns ?? {}).some(isParallelLaneRevivalCandidate))
    .slice()
    .sort(compareNewestState);
  const state = candidates[0];
  if (!state) {
    const running = states.find((candidate) => candidate.active && Object.keys(candidate.parallelRuns ?? {}).length > 0);
    if (running) return err("castId", `Cast ${JSON.stringify(running.castId)} is running; numbered ${operation} targets require a failed parallel parent.`);
    return err("castId", `No failed parallel parent with a recoverable lane is available for lane #${laneNumber}.`);
  }
  return ok(state);
}

function selectRecoveryRun(
  state: ParallelRecoveryCastState,
  laneNumber: number,
  operation: ParallelRecoveryOperation,
): DomainResult<{ loopId: string; run: MateriaParallelRunState }> {
  const entries = Object.entries(state.parallelRuns ?? {});
  if (entries.length === 0) {
    return err("castId", `Cast ${JSON.stringify(state.castId)} is not a parallel parent; numbered lane ${operation} requires a persisted parallel run.`);
  }

  const candidates = entries.filter(([, run]) => isParallelLaneRevivalCandidate(run));
  if (candidates.length > 1) {
    return err("parallelRun", `Cast ${JSON.stringify(state.castId)} has multiple failed parallel runs; lane #${laneNumber} is ambiguous. Recover one parallel run at a time.`);
  }
  const candidate = candidates[0];
  if (candidate) return ok({ loopId: candidate[0], run: candidate[1] });

  if (state.active || hasRunningParallelWork(state)) {
    return err("parallelRun", `Cast ${JSON.stringify(state.castId)} has running parallel work; lane #${laneNumber} cannot be recovered yet.`);
  }
  return err("parallelRun", `Cast ${JSON.stringify(state.castId)} has no failed or interrupted parallel lane available for lane #${laneNumber}.`);
}

function parseLaneNumber(token: string): DomainResult<{ kind: "lane"; laneNumber: number }> {
  const laneNumber = Number(token);
  if (laneNumber === 0) return err("laneNumber", "Lane number 0 is invalid; lane numbers are 1-based and must be positive.");
  if (!Number.isSafeInteger(laneNumber) || laneNumber < 1) {
    return err("laneNumber", "Lane number must be a positive 1-based safe integer (for example, 1).");
  }
  return ok({ kind: "lane", laneNumber });
}

function isIntegerToken(value: string): boolean {
  return /^\d+$/.test(value);
}

function looksLikeLaneNumber(value: string): boolean {
  // Cast ids are normally non-numeric, but safeTimestamp() produces ids such
  // as `2026-08-07T16-10-26-817Z` that legitimately begin with digits.
  return /^[+-]?\d/.test(value) && !isTimestampCastId(value);
}

function isTimestampCastId(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?$/.test(value);
}

function hasRunningParallelWork(state: ParallelRecoveryCastState): boolean {
  return Object.values(state.parallelRuns ?? {}).some((run) =>
    run.phase === "dispatching"
    || run.phase === "awaiting_lanes"
    || Object.values(run.lanes ?? {}).some((lane) => lane.status === "queued" || lane.status === "running"),
  );
}

function compareNewestState(left: ParallelRecoveryCastState, right: ParallelRecoveryCastState): number {
  return safeTime(right.updatedAt) - safeTime(left.updatedAt)
    || safeTime(right.startedAt) - safeTime(left.startedAt)
    || right.castId.localeCompare(left.castId);
}

function safeTime(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
