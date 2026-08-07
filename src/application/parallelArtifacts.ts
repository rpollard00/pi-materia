import type {
  ChildCastPaths,
  ChildCastTerminalResult,
  ChildCastUsage,
} from "./childCastRunner.js";

/** Stable artifact paths owned by one parent-cast lane attempt. */
export interface ParallelLaneArtifactPaths {
  laneManifestPath: string;
  eventStreamPath: string;
  terminalResultPath: string;
  diagnosticsPath: string;
  usagePath: string;
  launchSpecPath: string;
  sessionPath: string;
  stdoutPath: string;
  stderrPath: string;
  socketArtifactsPath: string;
}

export interface ParallelLaneArtifactIdentity {
  parentCastId: string;
  runId: string;
  loopId: string;
  laneId: string;
  childCastId: string;
  /** Immutable revival identities copied into every attempt manifest. */
  planId: string;
  graphHash: string;
  branchId: string;
  executionScopeId: string;
  attempt: number;
  streamIndex: number;
  workItemIndexes: readonly number[];
  /** Parent-owned directory for this exact lane attempt. It must not follow a resumed child session. */
  coordinatorArtifactRoot: string;
  /** Actual child-owned paths, which may be retained across resumed attempts. */
  paths: ChildCastPaths;
}

export interface ParallelLaneEventArtifact {
  provenance: Readonly<Record<string, unknown>>;
  /** Coordinator-owned durable lifecycle record; never a raw child event. */
  event: {
    type: "parallel_lane_started" | "parallel_lane_resumed" | "usage_checkpoint" | "parallel_lane_terminal" | "parallel_lane_cancelled" | "parallel_lane_budget_exceeded";
    occurredAt: number;
    /** Recovery verb, present on recovery lifecycle evidence. */
    operation?: "revive" | "recast";
    status?: string;
    usage?: ChildCastUsage;
    error?: string;
  };
}

export interface ParallelLaneDiagnosticArtifact {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  occurredAt: number;
  details?: Readonly<Record<string, unknown>>;
}

/** Parent-owned lane telemetry, independent of repository or workspace state. */
export interface ParallelLaneArtifactPort {
  initialize(input: ParallelLaneArtifactIdentity): Promise<ParallelLaneArtifactPaths>;
  /** Validate the durable manifest before a retained lane is reopened. */
  validateProvenance?(input: ParallelLaneArtifactIdentity): Promise<void>;
  appendEvent(input: ParallelLaneArtifactIdentity & { event: ParallelLaneEventArtifact }): Promise<void>;
  writeTerminalResult(input: ParallelLaneArtifactIdentity & { result: ChildCastTerminalResult; usage?: ChildCastUsage }): Promise<void>;
  writeDiagnostics(input: ParallelLaneArtifactIdentity & { diagnostics: readonly ParallelLaneDiagnosticArtifact[] }): Promise<void>;
  writeUsage(input: ParallelLaneArtifactIdentity & { usage: ChildCastUsage }): Promise<void>;
}
