import type {
  MateriaParallelLaneState,
  MateriaParallelRunState,
} from "../domain/parallelRunTypes.js";

/**
 * Secret-free, monitor-facing view of one parallel lane. The paths are
 * intentionally retained: they let an operator move from a symbolic graph
 * region to the durable child session and jj workspace without exposing the
 * mutable coordinator record itself.
 */
export interface ParallelLaneMonitorSummary {
  laneId: string;
  name: string;
  streamIndex: number;
  queueIndex: number;
  workItemIndexes: number[];
  status: MateriaParallelLaneState["status"];
  attempt: number;
  childCastId?: string;
  childSession?: {
    sessionPath: string;
    artifactRoot: string;
    runDirectory: string;
  };
  workspace?: {
    repositoryRoot: string;
    workspaceRoot: string;
    workspacePath: string;
    workspaceName: string;
    operationId?: string;
    state?: "active" | "forgotten";
    revision?: { commitId: string; changeId: string };
  };
  acceptedHead?: { commitId: string; changeId: string };
  failureReason?: string;
  startedAt?: number;
  endedAt?: number;
  updatedAt: number;
}

/** Aggregate counts used by the WebUI loop region and compact TUI status. */
export interface ParallelRunMonitorCounts {
  total: number;
  queued: number;
  running: number;
  accepted: number;
  failed: number;
  interrupted: number;
  /** Number of lanes in any terminal state. */
  completed: number;
  /** 1 after fan-in starts or has produced a durable outcome, otherwise 0. */
  fanIn: number;
  /** 1 when this run has produced or is handling a conflict, otherwise 0. */
  conflict: number;
}

export interface ParallelRunMonitorSummary {
  version: 1;
  loopId: string;
  runId: string;
  phase: MateriaParallelRunState["phase"];
  fanInPhase: MateriaParallelRunState["fanInPhase"];
  planId: string;
  /** Present only for legacy jj-coupled runs. */
  baseline?: { commitId: string; changeId: string };
  maxConcurrency: number;
  counts: ParallelRunMonitorCounts;
  lanes: ParallelLaneMonitorSummary[];
  updatedAt: number;
  endedAt?: number;
}

/** Build a bounded monitor DTO without exposing diagnostics or mutable state. */
export function summarizeParallelRun(run: MateriaParallelRunState): ParallelRunMonitorSummary {
  const lanes = run.queueOrder
    .map((laneId) => run.lanes[laneId])
    .filter((lane): lane is MateriaParallelLaneState => lane !== undefined)
    .map(summarizeParallelLane);
  // Load-compatible records may contain a lane not present in queueOrder. Keep
  // it visible, but sort it deterministically after the canonical queue.
  const queuedLaneIds = new Set(lanes.map((lane) => lane.laneId));
  for (const lane of Object.values(run.lanes).filter((candidate) => !queuedLaneIds.has(candidate.laneId)).sort((a, b) => a.laneId.localeCompare(b.laneId))) {
    lanes.push(summarizeParallelLane(lane));
  }

  const counts = {
    total: lanes.length,
    queued: countStatus(lanes, "queued"),
    running: countStatus(lanes, "running"),
    accepted: countStatus(lanes, "accepted"),
    failed: countStatus(lanes, "failed"),
    interrupted: countStatus(lanes, "interrupted"),
    completed: lanes.filter((lane) => isTerminalLaneStatus(lane.status)).length,
    fanIn: hasStartedFanIn(run) ? 1 : 0,
    conflict: hasConflict(run) ? 1 : 0,
  } satisfies ParallelRunMonitorCounts;

  return {
    version: 1,
    loopId: run.loopId,
    runId: run.runId,
    phase: run.phase,
    fanInPhase: run.fanInPhase,
    planId: run.planIdentity.planId,
    ...(run.baseline ? { baseline: { ...run.baseline } } : {}),
    maxConcurrency: run.maxConcurrency,
    counts,
    lanes,
    updatedAt: run.updatedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
  };
}

export function summarizeParallelRuns(
  runs: Record<string, MateriaParallelRunState> | undefined,
): Record<string, ParallelRunMonitorSummary> | undefined {
  if (!runs || typeof runs !== "object") return undefined;
  const entries = Object.entries(runs).sort(([left], [right]) => left.localeCompare(right));
  const summaries: Record<string, ParallelRunMonitorSummary> = {};
  for (const [loopId, value] of entries) {
    if (!isMonitorableRun(value)) continue;
    try {
      summaries[loopId] = summarizeParallelRun(value);
    } catch {
      // A malformed legacy record must not make the monitor endpoint fail for
      // an otherwise readable cast snapshot.
    }
  }
  return Object.keys(summaries).length > 0 ? summaries : undefined;
}

function summarizeParallelLane(lane: MateriaParallelLaneState): ParallelLaneMonitorSummary {
  return {
    laneId: lane.laneId,
    name: lane.name,
    streamIndex: lane.streamIndex,
    queueIndex: lane.queueIndex,
    workItemIndexes: [...lane.workItemIndexes],
    status: lane.status,
    attempt: lane.attempt,
    ...(lane.childCastId !== undefined ? { childCastId: lane.childCastId } : {}),
    ...(lane.childSession ? { childSession: { ...lane.childSession } } : {}),
    ...(lane.workspace ? {
      workspace: {
        repositoryRoot: lane.workspace.repositoryRoot,
        workspaceRoot: lane.workspace.workspaceRoot,
        workspacePath: lane.workspace.workspacePath,
        workspaceName: lane.workspace.workspaceName,
        ...(lane.workspace.operationId !== undefined ? { operationId: lane.workspace.operationId } : {}),
        ...(lane.workspace.state !== undefined ? { state: lane.workspace.state } : {}),
        ...(lane.workspace.revision ? { revision: { ...lane.workspace.revision } } : {}),
      },
    } : {}),
    ...(lane.acceptedHead ? { acceptedHead: { ...lane.acceptedHead } } : {}),
    ...(lane.failureReason !== undefined ? { failureReason: lane.failureReason } : {}),
    ...(lane.startedAt !== undefined ? { startedAt: lane.startedAt } : {}),
    ...(lane.endedAt !== undefined ? { endedAt: lane.endedAt } : {}),
    updatedAt: lane.updatedAt,
  };
}

function countStatus(lanes: readonly ParallelLaneMonitorSummary[], status: ParallelLaneMonitorSummary["status"]): number {
  return lanes.filter((lane) => lane.status === status).length;
}

function isTerminalLaneStatus(status: ParallelLaneMonitorSummary["status"]): boolean {
  return status === "accepted" || status === "failed" || status === "interrupted";
}

function hasStartedFanIn(run: MateriaParallelRunState): boolean {
  return run.phase === "fan_in"
    || run.phase === "resolving"
    || run.phase === "evaluating"
    || run.phase === "completed"
    || run.fanInPhase === "running"
    || run.fanInPhase === "conflict"
    || run.fanInPhase === "resolved"
    || run.fanInPhase === "accepted";
}

function hasConflict(run: MateriaParallelRunState): boolean {
  return run.phase === "conflict"
    || run.phase === "resolving"
    || run.fanInPhase === "conflict"
    || run.fanInProvenance?.outcome === "conflict";
}

function isMonitorableRun(value: unknown): value is MateriaParallelRunState {
  if (!isRecord(value)) return false;
  return typeof value.loopId === "string"
    && typeof value.runId === "string"
    && Array.isArray(value.queueOrder)
    && isRecord(value.lanes)
    && isRecord(value.planIdentity)
    && isRecord(value.baseline);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
