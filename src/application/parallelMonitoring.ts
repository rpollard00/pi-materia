import type {
  MateriaParallelLaneStage,
  MateriaParallelLaneState,
  MateriaParallelRunState,
} from "../domain/parallelRunTypes.js";

/**
 * Secret-free, monitor-facing view of one parallel lane. The paths are
 * intentionally retained so an operator can move from a symbolic graph
 * region to the durable child session without exposing the mutable
 * coordinator record itself.
 */
export interface ParallelLaneMonitorSummary {
  laneId: string;
  name: string;
  streamIndex: number;
  /** Immutable zero-based queue position; use {@link parallelLaneNumber} for display. */
  queueIndex: number;
  workItemIndexes: number[];
  status: MateriaParallelLaneState["status"];
  attempt: number;
  progress: { position: number; total: number };
  activeStage?: MateriaParallelLaneStage;
  childCastId?: string;
  childSession?: {
    sessionPath: string;
    artifactRoot: string;
    runDirectory: string;
  };
  /** Active terminal scope for this branch. Exports remain opaque. */
  scope?: {
    id: string;
    cwd: string;
    exportNames: string[];
  };
  /** Bounded JSON-safe rendering of the branch's terminal handoff. */
  output?: string;
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
  /** Number of branches that have reached the intrinsic barrier. */
  barrierReached: number;
}

export interface ParallelRunMonitorSummary {
  version: 1;
  loopId: string;
  runId: string;
  phase: MateriaParallelRunState["phase"];
  fanInPhase: MateriaParallelRunState["fanInPhase"];
  planId: string;
  maxConcurrency: number;
  counts: ParallelRunMonitorCounts;
  barrier: {
    phase: "waiting" | "accepted" | "failed";
    reached: number;
    total: number;
  };
  lanes: ParallelLaneMonitorSummary[];
  updatedAt: number;
  endedAt?: number;
}

/** Convert the persisted zero-based queue position to the operator-facing number. */
export function parallelLaneNumber(queueIndex: number): number | undefined {
  return Number.isSafeInteger(queueIndex) && queueIndex >= 0 && queueIndex < Number.MAX_SAFE_INTEGER
    ? queueIndex + 1
    : undefined;
}

export function formatParallelLaneNumber(queueIndex: number): string {
  const number = parallelLaneNumber(queueIndex);
  return number === undefined ? "Lane ?" : `Lane ${number}`;
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
    barrierReached: lanes.filter((lane) => isTerminalLaneStatus(lane.status)).length,
  } satisfies ParallelRunMonitorCounts;

  return {
    version: 1,
    loopId: run.loopId,
    runId: run.runId,
    phase: run.phase,
    fanInPhase: run.fanInPhase,
    planId: run.planIdentity.planId,
    maxConcurrency: run.maxConcurrency,
    counts,
    barrier: {
      phase: run.phase === "completed" && run.fanInPhase === "accepted"
        ? "accepted"
        : run.phase === "failed" ? "failed" : "waiting",
      reached: counts.barrierReached,
      total: counts.total,
    },
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
  const activeStage = boundedStage(lane.activeStage);
  return {
    laneId: lane.laneId,
    name: lane.name,
    streamIndex: lane.streamIndex,
    queueIndex: lane.queueIndex,
    workItemIndexes: [...lane.workItemIndexes],
    status: lane.status,
    attempt: lane.attempt,
    progress: boundedProgress(lane.progress),
    ...(activeStage ? { activeStage } : {}),
    ...(lane.childCastId !== undefined ? { childCastId: lane.childCastId } : {}),
    ...(lane.childSession ? { childSession: { ...lane.childSession } } : {}),
    ...(lane.executionScope ? {
      scope: {
        id: lane.executionScope.id,
        cwd: lane.executionScope.cwd,
        exportNames: Object.keys(lane.executionScope.exports).sort(),
      },
    } : {}),
    ...(lane.terminalOutput !== undefined ? { output: boundedOutput(lane.terminalOutput) } : {}),
    ...(lane.failureReason !== undefined ? { failureReason: lane.failureReason } : {}),
    ...(lane.startedAt !== undefined ? { startedAt: lane.startedAt } : {}),
    ...(lane.endedAt !== undefined ? { endedAt: lane.endedAt } : {}),
    updatedAt: lane.updatedAt,
  };
}

function boundedProgress(value: MateriaParallelLaneState["progress"] | undefined): { position: number; total: number } {
  const total = value && Number.isSafeInteger(value.total) && value.total >= 0 ? value.total : 0;
  const position = value && Number.isFinite(value.position) ? Math.floor(value.position) : 0;
  return { position: Math.min(total, Math.max(0, position)), total };
}

function boundedStage(value: MateriaParallelLaneStage | undefined): MateriaParallelLaneStage | undefined {
  if (!value || typeof value.socketId !== "string" || value.socketId.length === 0 || value.socketId.length > 512) return undefined;
  if (typeof value.label !== "string" || value.label.length === 0 || value.label.length > 80) return undefined;
  if (typeof value.transitionedAt !== "number" || !Number.isFinite(value.transitionedAt)) return undefined;
  return { socketId: value.socketId, label: value.label, transitionedAt: value.transitionedAt };
}

function countStatus(lanes: readonly ParallelLaneMonitorSummary[], status: ParallelLaneMonitorSummary["status"]): number {
  return lanes.filter((lane) => lane.status === status).length;
}

function isTerminalLaneStatus(status: ParallelLaneMonitorSummary["status"]): boolean {
  return status === "accepted" || status === "failed" || status === "interrupted";
}

function boundedOutput(value: unknown): string {
  let rendered: string;
  try { rendered = JSON.stringify(value) ?? String(value); }
  catch { rendered = "[unrenderable output]"; }
  return rendered.length <= 500 ? rendered : `${rendered.slice(0, 499)}…`;
}

function isMonitorableRun(value: unknown): value is MateriaParallelRunState {
  if (!isRecord(value)) return false;
  return typeof value.loopId === "string"
    && typeof value.runId === "string"
    && Array.isArray(value.queueOrder)
    && isRecord(value.lanes)
    && isRecord(value.planIdentity);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
