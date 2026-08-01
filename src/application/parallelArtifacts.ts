import type {
  ChildCastPaths,
  ChildCastStreamEvent,
  ChildCastTerminalResult,
  ChildCastUsage,
} from "./childCastRunner.js";

/** Stable artifact paths owned by one parent-cast lane attempt. */
export interface ParallelLaneArtifactPaths {
  laneManifestPath: string;
  eventStreamPath: string;
  terminalResultPath: string;
  revisionPath: string;
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
  attempt: number;
  streamIndex: number;
  workItemIndexes: readonly number[];
  paths: ChildCastPaths;
  workspace?: unknown;
}

export interface ParallelLaneEventArtifact {
  provenance: Readonly<Record<string, unknown>>;
  event: ChildCastStreamEvent;
}

export interface ParallelLaneRevisionArtifact {
  baseline?: unknown;
  workspace?: unknown;
  acceptedHead?: unknown;
}

export interface ParallelLaneDiagnosticArtifact {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  occurredAt: number;
  details?: Readonly<Record<string, unknown>>;
}

/**
 * Application port for parent-owned lane telemetry. Implementations may write
 * files, object storage, or a test journal; runtime scheduling only exchanges
 * DTOs and never depends on a filesystem.
 */
export interface ParallelLaneArtifactPort {
  initialize(input: ParallelLaneArtifactIdentity): Promise<ParallelLaneArtifactPaths>;
  appendEvent(input: ParallelLaneArtifactIdentity & { event: ParallelLaneEventArtifact }): Promise<void>;
  writeTerminalResult(input: ParallelLaneArtifactIdentity & { result: ChildCastTerminalResult; usage?: ChildCastUsage }): Promise<void>;
  writeRevision(input: ParallelLaneArtifactIdentity & { revision: ParallelLaneRevisionArtifact }): Promise<void>;
  writeDiagnostics(input: ParallelLaneArtifactIdentity & { diagnostics: readonly ParallelLaneDiagnosticArtifact[] }): Promise<void>;
  writeUsage(input: ParallelLaneArtifactIdentity & { usage: ChildCastUsage }): Promise<void>;
}
