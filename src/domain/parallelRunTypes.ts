import type { ExecutionScope } from "./executionScope.js";
import type { ParallelLaneProgress } from "./parallelProgress.js";

/** The normalized plan identity pinned for one parallel run. */
export interface MateriaParallelPlanIdentity {
  version: number;
  planId: string;
  workItemCount: number;
}

/** Immutable compiled branch-program identity pinned for one parallel run. */
export interface MateriaParallelGraphIdentity {
  graphHash: string;
}

/** The loop/config identity pinned for one parallel run. */
export interface MateriaParallelConfigIdentity {
  configHash: string;
  loopId: string;
  maxConcurrency: number;
}

/** Ordered stream membership copied from the immutable normalized plan. */
export interface MateriaParallelQueueEntry {
  laneId: string;
  name: string;
  streamIndex: number;
  workItemIndexes: number[];
  /** Compiled nominal step count for this lane. */
  progressTotal?: number;
}

/** Process-independent identity for a persistent child session. */
export interface MateriaParallelChildSession {
  childCastId: string;
  sessionPath: string;
  artifactRoot: string;
  runDirectory: string;
}

export interface MateriaParallelUsageTotals {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export type MateriaParallelLaneStatus = "queued" | "running" | "accepted" | "failed" | "interrupted";

export type MateriaParallelRunPhase = "dispatching" | "awaiting_lanes" | "completed" | "failed";

export type MateriaParallelFanInPhase = "not_started" | "accepted" | "skipped" | "failed";

export type MateriaParallelDiagnosticSeverity = "info" | "warning" | "error";

/** Bounded, secret-free diagnostic retained in the parent cast state. */
export interface MateriaParallelDiagnostic {
  code: string;
  message: string;
  severity: MateriaParallelDiagnosticSeverity;
  occurredAt: number;
  details?: Record<string, unknown>;
}

export interface MateriaParallelLastEvent {
  sequence: number;
  type: string;
  occurredAt: number;
}

/** Durable state for one normalized stream/lane. */
export interface MateriaParallelLaneState {
  /** Stable identity of this branch across attempts and process restarts. */
  branchId: string;
  laneId: string;
  name: string;
  streamIndex: number;
  queueIndex: number;
  workItemIndexes: number[];
  status: MateriaParallelLaneStatus;
  attempt: number;
  /** Bounded nominal progress; graph rewinds may lower position. */
  progress: ParallelLaneProgress;
  childCastId?: string;
  /** Detached branch scope used by this child. Core does not interpret exports. */
  executionScope?: ExecutionScope;
  /** Opaque terminal child output retained for intrinsic ordered fan-in. */
  terminalOutput?: unknown;
  childSession?: MateriaParallelChildSession;
  usage?: MateriaParallelUsageTotals;
  startedAt?: number;
  endedAt?: number;
  updatedAt: number;
  lastEvent?: MateriaParallelLastEvent;
  failureReason?: string;
  diagnostics: MateriaParallelDiagnostic[];
}

/** Durable coordinator state for one parent cast and loop region. */
export interface MateriaParallelRunState {
  version: 1;
  parentCastId: string;
  loopId: string;
  runId: string;
  planIdentity: MateriaParallelPlanIdentity;
  graphIdentity: MateriaParallelGraphIdentity;
  configIdentity: MateriaParallelConfigIdentity;
  queueOrder: string[];
  maxConcurrency: number;
  phase: MateriaParallelRunPhase;
  fanInPhase: MateriaParallelFanInPhase;
  lanes: Record<string, MateriaParallelLaneState>;
  diagnostics: MateriaParallelDiagnostic[];
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
}

export type MateriaParallelRunRecord = MateriaParallelRunState;
export type MateriaParallelLaneRecord = MateriaParallelLaneState;
