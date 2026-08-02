import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  ParallelFanInArtifactPort,
  ParallelLaneArtifactIdentity,
  ParallelLaneArtifactPaths,
  ParallelLaneArtifactPort,
  ParallelLaneDiagnosticArtifact,
  ParallelLaneEventArtifact,
  ParallelLaneRevisionArtifact,
} from "../application/index.js";
import type { ChildCastTerminalResult, ChildCastUsage } from "../application/childCastRunner.js";
import type { MateriaParallelFanInProvenance } from "../domain/parallelRunTypes.js";
import { boundedMessage, clone, writeJsonAtomically } from "./piChildCastSupport.js";

const MAX_DIAGNOSTICS = 24;
const MAX_DIAGNOSTIC_MESSAGE = 1_000;
const MAX_DIAGNOSTIC_DETAILS_BYTES = 4_096;

/**
 * File-backed parent-cast lane telemetry. Child stdout/stderr, sessions, and
 * socket artifacts remain at child-runner-owned paths. Coordinator records use
 * their own attempt directory so resuming a retained child session cannot mix
 * or overwrite later-attempt provenance.
 */
export class FileParallelLaneArtifactStore implements ParallelLaneArtifactPort, ParallelFanInArtifactPort {
  readonly #eventTails = new Map<string, Promise<void>>();

  async initialize(input: ParallelLaneArtifactIdentity): Promise<ParallelLaneArtifactPaths> {
    const paths = artifactPaths(input.paths, input.attempt, input.coordinatorArtifactRoot);
    await mkdir(path.dirname(paths.laneManifestPath), { recursive: true });
    await writeJsonAtomically(paths.laneManifestPath, {
      version: 1,
      identity: {
        parentCastId: input.parentCastId,
        runId: input.runId,
        loopId: input.loopId,
        laneId: input.laneId,
        childCastId: input.childCastId,
        planId: input.planId,
        graphHash: input.graphHash,
        branchId: input.branchId,
        executionScopeId: input.executionScopeId,
        attempt: input.attempt,
        streamIndex: input.streamIndex,
        workItemIndexes: [...input.workItemIndexes],
      },
      workspace: clone(input.workspace),
      paths,
    });
    return paths;
  }

  async appendEvent(input: ParallelLaneArtifactIdentity & { event: ParallelLaneEventArtifact }): Promise<void> {
    const paths = artifactPaths(input.paths, input.attempt, input.coordinatorArtifactRoot);
    const line = `${JSON.stringify({ ...input.event, parentCastId: input.parentCastId, loopId: input.loopId, laneId: input.laneId, attempt: input.attempt })}\n`;
    await this.#appendOrdered(paths.eventStreamPath, line);
  }

  async writeTerminalResult(input: ParallelLaneArtifactIdentity & { result: ChildCastTerminalResult; usage?: ChildCastUsage }): Promise<void> {
    const paths = artifactPaths(input.paths, input.attempt, input.coordinatorArtifactRoot);
    await writeJsonAtomically(paths.terminalResultPath, {
      version: 1,
      identity: identityForArtifact(input),
      result: clone(input.result),
      ...(input.usage ? { usage: clone(input.usage) } : {}),
    });
  }

  async writeRevision(input: ParallelLaneArtifactIdentity & { revision: ParallelLaneRevisionArtifact }): Promise<void> {
    const paths = artifactPaths(input.paths, input.attempt, input.coordinatorArtifactRoot);
    await writeJsonAtomically(paths.revisionPath, {
      version: 1,
      identity: identityForArtifact(input),
      revision: clone(input.revision),
    });
  }

  async writeDiagnostics(input: ParallelLaneArtifactIdentity & { diagnostics: readonly ParallelLaneDiagnosticArtifact[] }): Promise<void> {
    const paths = artifactPaths(input.paths, input.attempt, input.coordinatorArtifactRoot);
    const diagnostics = input.diagnostics.slice(-MAX_DIAGNOSTICS).map(boundDiagnostic);
    await writeJsonAtomically(paths.diagnosticsPath, {
      version: 1,
      identity: identityForArtifact(input),
      diagnostics,
      truncated: input.diagnostics.length > diagnostics.length,
    });
  }

  async writeFanIn(input: { artifactRoot: string; provenance: MateriaParallelFanInProvenance; satisfied: boolean }): Promise<void> {
    const directory = path.join(input.artifactRoot, "parallel", safeArtifactPart(input.provenance.loopId));
    await mkdir(directory, { recursive: true });
    await writeJsonAtomically(path.join(directory, "fan-in.json"), {
      version: 1,
      satisfied: input.satisfied,
      provenance: clone(input.provenance),
    });
  }

  async write(input: { artifactRoot: string; provenance: MateriaParallelFanInProvenance; satisfied: boolean }): Promise<void> {
    return this.writeFanIn(input);
  }

  async writeUsage(input: ParallelLaneArtifactIdentity & { usage: ChildCastUsage }): Promise<void> {
    const paths = artifactPaths(input.paths, input.attempt, input.coordinatorArtifactRoot);
    await writeJsonAtomically(paths.usagePath, {
      version: 1,
      identity: identityForArtifact(input),
      usage: clone(input.usage),
    });
  }

  async #appendOrdered(file: string, content: string): Promise<void> {
    const previous = this.#eventTails.get(file) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, content);
    });
    this.#eventTails.set(file, next);
    await next;
    if (this.#eventTails.get(file) === next) this.#eventTails.delete(file);
  }
}

export type ParallelLaneArtifactStore = FileParallelLaneArtifactStore;

export function createParallelLaneArtifactStore(): FileParallelLaneArtifactStore {
  return new FileParallelLaneArtifactStore();
}

export function parallelLaneArtifactPaths(paths: { sessionPath: string; artifactRoot: string; runDirectory: string }, attempt: number, coordinatorArtifactRoot: string): ParallelLaneArtifactPaths {
  return artifactPaths(paths, attempt, coordinatorArtifactRoot);
}

function artifactPaths(paths: { sessionPath: string; artifactRoot: string; runDirectory: string }, attempt: number, coordinatorArtifactRoot: string): ParallelLaneArtifactPaths {
  const suffix = attempt === 1 ? "" : `-attempt-${attempt}`;
  const attemptRoot = coordinatorArtifactRoot;
  return {
    laneManifestPath: path.join(attemptRoot, "lane.json"),
    eventStreamPath: path.join(attemptRoot, "events.jsonl"),
    terminalResultPath: path.join(attemptRoot, "terminal-result.json"),
    revisionPath: path.join(attemptRoot, "revision.json"),
    diagnosticsPath: path.join(attemptRoot, "diagnostics.json"),
    usagePath: path.join(attemptRoot, "usage.json"),
    launchSpecPath: path.join(paths.runDirectory, `child-launch${suffix}.json`),
    sessionPath: paths.sessionPath,
    stdoutPath: path.join(paths.artifactRoot, `child-stdout${suffix}.jsonl`),
    stderrPath: path.join(paths.artifactRoot, `child-stderr${suffix}.log`),
    socketArtifactsPath: paths.artifactRoot,
  };
}

function safeArtifactPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "parallel";
}

function identityForArtifact(input: ParallelLaneArtifactIdentity): Record<string, unknown> {
  return {
    parentCastId: input.parentCastId,
    runId: input.runId,
    loopId: input.loopId,
    laneId: input.laneId,
    childCastId: input.childCastId,
    planId: input.planId,
    graphHash: input.graphHash,
    branchId: input.branchId,
    executionScopeId: input.executionScopeId,
    attempt: input.attempt,
  };
}

function boundDiagnostic(diagnostic: ParallelLaneDiagnosticArtifact): ParallelLaneDiagnosticArtifact {
  const details = diagnostic.details ? boundDetails(diagnostic.details) : undefined;
  return {
    code: boundedMessage(diagnostic.code, 119),
    message: boundedMessage(diagnostic.message, MAX_DIAGNOSTIC_MESSAGE - 1),
    severity: diagnostic.severity,
    occurredAt: diagnostic.occurredAt,
    ...(details ? { details } : {}),
  };
}

function boundDetails(details: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const cloned = clone(details);
  let serialized: string;
  try {
    serialized = JSON.stringify(cloned);
  } catch {
    return { note: "diagnostic details were not JSON serializable" };
  }
  if (Buffer.byteLength(serialized, "utf8") <= MAX_DIAGNOSTIC_DETAILS_BYTES) return cloned as Record<string, unknown>;
  return { excerpt: boundedMessage(serialized, MAX_DIAGNOSTIC_DETAILS_BYTES - 1) };
}
