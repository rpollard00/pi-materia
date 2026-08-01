import path from "node:path";
import type { HandoffWorkItem } from "../domain/handoff.js";
import type {
  MateriaCastState,
  MateriaParallelRevisionIdentity,
  MateriaParallelRunState,
  MateriaParallelUsageTotals,
  MateriaParallelWorkspaceOwnership,
} from "../types.js";

/** The normalized plan consumed by a parallel loop coordinator. */
export interface NormalizedParallelPlan {
  version: 1;
  planId: string;
  workItemCount: number;
  streams: readonly NormalizedParallelStream[];
}

export interface NormalizedParallelStream {
  laneId: string;
  name: string;
  streamIndex: number;
  workItemIndexes: readonly number[];
}

/** A small revision DTO shared by the runtime and the jj adapter. */
export interface ParallelWorkspaceRevision extends MateriaParallelRevisionIdentity {}

/** The subset of the jj lifecycle adapter needed by dispatch. */
export interface ParallelWorkspaceRecord {
  repositoryRoot: string;
  workspaceRoot: string;
  workspacePath: string;
  workspaceName: string;
  baseline: ParallelWorkspaceRevision;
  revision: ParallelWorkspaceRevision;
  operationId?: string;
  manifestPath?: string;
  state?: "active" | "forgotten";
}

export interface ParallelWorkspaceInspection {
  currentRevision?: ParallelWorkspaceRevision;
}

export interface ParallelWorkspacePort {
  pinBaseline(cwd: string): Promise<{ repositoryRoot: string; baseline: ParallelWorkspaceRevision }>;
  create(input: {
    parentCastId: string;
    loopId: string;
    laneId: string;
    cwd: string;
    repositoryRoot: string;
    baseline: ParallelWorkspaceRevision;
  }): Promise<ParallelWorkspaceRecord>;
  inspect?(reference: { workspacePath: string; workspaceRoot: string; workspaceName: string }): Promise<ParallelWorkspaceInspection | undefined>;
}

export function readNormalizedParallelPlan(state: MateriaCastState, pathValue: string): NormalizedParallelPlan {
  const raw = readStatePath(state, pathValue);
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.planId !== "string" || raw.planId.trim().length === 0 || !Number.isSafeInteger(raw.workItemCount) || raw.workItemCount < 0 || !Array.isArray(raw.streams)) {
    throw new Error(`Parallel loop plan at ${JSON.stringify(pathValue)} is missing version 1, planId, workItemCount, or streams.`);
  }
  const laneIds = new Set<string>();
  const names = new Set<string>();
  const streamIndexes = new Set<number>();
  const streams: NormalizedParallelStream[] = raw.streams.map((value, index) => {
    if (!isRecord(value) || typeof value.laneId !== "string" || value.laneId.trim().length === 0 || typeof value.name !== "string" || value.name.trim().length === 0 || !Number.isSafeInteger(value.streamIndex) || value.streamIndex < 0 || !Array.isArray(value.workItemIndexes) || value.workItemIndexes.length === 0 || !value.workItemIndexes.every((item) => Number.isSafeInteger(item) && item >= 0)) {
      throw new Error(`Parallel loop plan stream ${index} is malformed.`);
    }
    if (laneIds.has(value.laneId)) throw new Error(`Parallel loop plan contains duplicate laneId ${JSON.stringify(value.laneId)}.`);
    if (names.has(value.name)) throw new Error(`Parallel loop plan contains duplicate stream name ${JSON.stringify(value.name)}.`);
    if (streamIndexes.has(value.streamIndex)) throw new Error(`Parallel loop plan contains duplicate streamIndex ${value.streamIndex}.`);
    laneIds.add(value.laneId);
    names.add(value.name);
    streamIndexes.add(value.streamIndex);
    return {
      laneId: value.laneId,
      name: value.name,
      streamIndex: value.streamIndex,
      workItemIndexes: [...value.workItemIndexes] as number[],
    };
  });
  return { version: 1, planId: raw.planId, workItemCount: raw.workItemCount, streams };
}

export function readParallelWorkItems(state: MateriaCastState): HandoffWorkItem[] {
  const value = state.data.workItems;
  if (!Array.isArray(value)) throw new Error("Parallel loop requires canonical state.workItems.");
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.title !== "string" || typeof item.context !== "string") {
      throw new Error(`Parallel loop work item ${index} must contain title and context strings.`);
    }
    return { title: item.title, context: item.context };
  });
}

export function boundedParallelContext(run: MateriaParallelRunState, stream: NormalizedParallelStream): Record<string, unknown> {
  return {
    planId: run.planIdentity.planId,
    planVersion: run.planIdentity.version,
    loopId: run.loopId,
    laneId: stream.laneId,
    streamName: stream.name,
    streamIndex: stream.streamIndex,
    workItemIndexes: [...stream.workItemIndexes],
    workItemCount: run.planIdentity.workItemCount,
  };
}

export function workspaceOwnership(
  state: MateriaCastState,
  loopId: string,
  laneId: string,
  workspace: ParallelWorkspaceRecord,
): MateriaParallelWorkspaceOwnership {
  return {
    backend: "jj",
    parentCastId: state.castId,
    loopId,
    laneId,
    repositoryRoot: workspace.repositoryRoot,
    workspaceRoot: workspace.workspaceRoot,
    workspacePath: workspace.workspacePath,
    workspaceName: workspace.workspaceName,
    baseline: workspace.baseline,
    revision: workspace.revision,
    ...(workspace.operationId !== undefined ? { operationId: workspace.operationId } : {}),
    ...(workspace.manifestPath !== undefined ? { manifestPath: workspace.manifestPath } : {}),
    ...(workspace.state !== undefined ? { state: workspace.state } : {}),
  };
}

export function childCastIdentity(parentCastId: string, loopId: string, laneId: string, attempt: number): string {
  return ["parallel", parentCastId, loopId, laneId, `attempt-${attempt}`].map(safePart).join(":");
}

export function lanePaths(state: MateriaCastState, loopId: string, laneId: string, attempt: number): { sessionPath: string; artifactRoot: string; runDirectory: string } {
  const root = path.join(state.artifactRoot, "parallel", safePart(loopId), "lanes", safePart(laneId), `attempt-${attempt}`);
  return {
    sessionPath: path.join(root, "session.jsonl"),
    artifactRoot: path.join(root, "artifacts"),
    runDirectory: path.join(root, "run"),
  };
}

export function revisionInValue(value: unknown): ParallelWorkspaceRevision | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.commitId === "string" && value.commitId.trim().length > 0 && typeof value.changeId === "string" && value.changeId.trim().length > 0) {
    return { commitId: value.commitId, changeId: value.changeId };
  }
  for (const key of ["state", "parallelLaneCheckpoint", "latestMeaningfulHead", "head", "output"]) {
    const nested = revisionInValue(value[key]);
    if (nested) return nested;
  }
  return undefined;
}

export function isParallelUsage(value: unknown): value is MateriaParallelUsageTotals {
  if (!isRecord(value) || !isRecord(value.tokens) || !isRecord(value.cost)) return false;
  return ["input", "output", "cacheRead", "cacheWrite", "total"].every((key) =>
    typeof value.tokens[key] === "number" && Number.isFinite(value.tokens[key]) && value.tokens[key] >= 0 &&
    typeof value.cost[key] === "number" && Number.isFinite(value.cost[key]) && value.cost[key] >= 0,
  );
}

export function replaceParallelState(target: MateriaCastState, source: MateriaCastState): void {
  Object.assign(target, source);
}

export function parallelErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readStatePath(state: MateriaCastState, pathValue: string): unknown {
  const normalized = pathValue.startsWith("state.") ? pathValue.slice("state.".length) : pathValue;
  return normalized.split(".").filter(Boolean).reduce<unknown>((current, part) => {
    if (!isRecord(current)) return undefined;
    return current[part];
  }, state.data);
}

function safePart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "lane";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
