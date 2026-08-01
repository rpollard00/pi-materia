/** Stable jj revision identity retained by the parallel coordinator. */
export interface MateriaParallelRevisionIdentity {
  commitId: string;
  changeId: string;
}

/** One ordered lane head and its immutable workspace verification snapshot. */
export interface MateriaParallelFanInHead {
  laneId: string;
  streamIndex: number;
  queueIndex: number;
  workItemIndexes: number[];
  head: MateriaParallelRevisionIdentity;
  workspace: MateriaParallelWorkspaceOwnership;
  /** Revision observed at the lane workspace after its final snapshot. */
  workspaceRevision?: MateriaParallelRevisionIdentity;
}

/** Durable provenance for the explicit jj fan-in boundary. */
export interface MateriaParallelFanInProvenance {
  version: 1;
  parentCastId: string;
  loopId: string;
  runId: string;
  baseline: MateriaParallelRevisionIdentity;
  parentRevisionBefore: MateriaParallelRevisionIdentity;
  parentRevisionAfter: MateriaParallelRevisionIdentity;
  orderedHeads: MateriaParallelFanInHead[];
  integrationRevision?: MateriaParallelRevisionIdentity;
  outcome: "clean" | "conflict";
  conflictedPaths: string[];
  conflictDetails: Array<{ path: string; message: string }>;
  operationId: string;
  startedAt: number;
  completedAt: number;
}

/** The normalized plan identity pinned for one parallel run. */
export interface MateriaParallelPlanIdentity {
  version: number;
  planId: string;
  workItemCount: number;
}

/** The loop/config identity pinned for one parallel run. */
export interface MateriaParallelConfigIdentity {
  configHash: string;
  loopId: string;
  planInput: string;
  maxConcurrency: number;
  workspaceMode: MateriaParallelWorkspaceMode;
  failurePolicy: MateriaParallelFailurePolicy;
  fanIn: MateriaParallelFanInBehavior;
}

/** Ordered stream membership copied from the immutable normalized plan. */
export interface MateriaParallelQueueEntry {
  laneId: string;
  name: string;
  streamIndex: number;
  workItemIndexes: number[];
}

/** Runtime-owned jj workspace provenance for one lane. */
export interface MateriaParallelWorkspaceOwnership {
  backend: MateriaParallelWorkspaceMode;
  parentCastId: string;
  loopId: string;
  laneId: string;
  repositoryRoot: string;
  workspaceRoot: string;
  workspacePath: string;
  workspaceName: string;
  baseline: MateriaParallelRevisionIdentity;
  revision?: MateriaParallelRevisionIdentity;
  operationId?: string;
  manifestPath?: string;
  state?: "active" | "forgotten";
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

export type MateriaParallelRunPhase =
  | "dispatching"
  | "awaiting_lanes"
  | "fan_in"
  | "conflict"
  | "resolving"
  | "evaluating"
  | "completed"
  | "failed";

export type MateriaParallelFanInPhase = "not_started" | "ready" | "running" | "conflict" | "resolved" | "accepted" | "skipped" | "failed";

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
  laneId: string;
  name: string;
  streamIndex: number;
  queueIndex: number;
  workItemIndexes: number[];
  status: MateriaParallelLaneStatus;
  attempt: number;
  childCastId?: string;
  workspace?: MateriaParallelWorkspaceOwnership;
  childSession?: MateriaParallelChildSession;
  acceptedHead?: MateriaParallelRevisionIdentity;
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
  configIdentity: MateriaParallelConfigIdentity;
  baseline: MateriaParallelRevisionIdentity;
  queueOrder: string[];
  maxConcurrency: number;
  workspaceMode: MateriaParallelWorkspaceMode;
  failurePolicy: MateriaParallelFailurePolicy;
  fanIn: MateriaParallelFanInBehavior;
  /** Durable provenance from the explicit successful-lanes fan-in boundary. */
  fanInProvenance?: MateriaParallelFanInProvenance;
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

export type MateriaParallelWorkspaceMode = "jj";
export type MateriaParallelFailurePolicy = "all_terminal";
export type MateriaParallelFanInBehavior = "ordered";
