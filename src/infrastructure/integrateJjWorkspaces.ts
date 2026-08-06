import path from "node:path";
import { createExecutionScope, type ExecutionScope, type ExecutionScopeExport } from "../domain/executionScope.js";
import type { IntrinsicParallelFanInResult } from "../domain/parallelFanIn.js";
import {
  createJjWorkspaceBackend,
  type JjFanInInput,
  type JjFanInResult,
  type JjRemovableWorkflowBoundary,
  type JjWorkspaceBackend,
  type JjWorkspaceOwner,
  type JjWorkspaceRecord,
} from "./jjWorkspaceBackend.js";
import {
  JJ_WORKSPACE_CLEANUP_EXPORT,
  JJ_WORKSPACE_INTEGRATION_EXPORT,
  SPAWN_JJ_WORKSPACE_PRODUCER,
} from "./spawnJjWorkspace.js";

export const INTEGRATE_JJ_WORKSPACES_PRODUCER = "Integrate-JJ-Workspaces";

const MAX_REVIEW_WORKSTREAMS = 64;
const MAX_REVIEW_CHANGES = 512;
const MAX_REVIEW_ID_LENGTH = 512;

interface SpawnedWorkspaceExport {
  version: 1;
  backend: "jj";
  owner: JjWorkspaceOwner;
  repositoryRoot: string;
  workspaceRoot: string;
  workspacePath: string;
  workspaceName: string;
  manifestPath: string;
  baseline: { commitId: string; changeId: string };
}

interface OrderedWorkspaceSource {
  laneId: string;
  streamIndex: number;
  queueIndex: number;
  workItemIndexes: number[];
  scopeId: string;
  scopeCwd: string;
  workspace: SpawnedWorkspaceExport;
}

export interface IntegrateJjWorkspacesInput {
  cwd: string;
  castId: string;
  socketId: string;
  executionScope: ExecutionScope;
  state: unknown;
}

export interface IntegrateJjWorkspacesDeps {
  createBackend?: (workspaceRoot: string, repositoryRoot: string) => Pick<JjWorkspaceBackend, "inspect" | "fanIn" | "createWorkspace">;
}

export interface IntegrateJjWorkspacesResult {
  scope: ExecutionScope;
  integration: JjFanInResult;
  workspace: JjWorkspaceRecord;
  sourceCount: number;
}

/**
 * Interpret only Spawn-JJ-Workspace's opaque exports at the VCS utility
 * boundary. Core fan-in remains repository-neutral and merely preserves their
 * normalized branch order.
 */
export async function integrateJjWorkspaceExports(
  input: IntegrateJjWorkspacesInput,
  deps: IntegrateJjWorkspacesDeps = {},
): Promise<IntegrateJjWorkspacesResult> {
  assertInput(input);
  const sources = orderedSources(input.state, input.executionScope);
  if (sources.length === 0) throw new Error("Integrate-JJ-Workspaces requires at least one exported workspace.");

  const first = sources[0]!.workspace;
  for (const source of sources) {
    const workspace = source.workspace;
    if (path.resolve(workspace.repositoryRoot) !== path.resolve(first.repositoryRoot)) {
      throw new Error("Integrate-JJ-Workspaces cannot combine workspaces from different repositories.");
    }
    if (path.resolve(workspace.workspaceRoot) !== path.resolve(first.workspaceRoot)) {
      throw new Error("Integrate-JJ-Workspaces requires all workspaces to use the same owned workspace root.");
    }
    if (workspace.baseline.commitId !== first.baseline.commitId || workspace.baseline.changeId !== first.baseline.changeId) {
      throw new Error("Integrate-JJ-Workspaces requires all workspaces to share one stable baseline.");
    }
  }

  const backend = (deps.createBackend ?? ((workspaceRoot, repositoryRoot) => createJjWorkspaceBackend({ workspaceRoot, repositoryRoot })))(
    first.workspaceRoot,
    first.repositoryRoot,
  );
  const lanes: Array<JjFanInInput["lanes"][number]> = [];
  for (const source of sources) {
    const inspection = await backend.inspect({
      workspaceRoot: source.workspace.workspaceRoot,
      workspacePath: source.workspace.workspacePath,
      workspaceName: source.workspace.workspaceName,
      ...source.workspace.owner,
    });
    if (!inspection || !inspection.exists || !inspection.tracked || !inspection.currentRevision) {
      throw new Error(`Integrate-JJ-Workspaces source ${JSON.stringify(source.laneId)} is missing or no longer tracked.`);
    }
    assertExportMatchesInspection(source, inspection);
    lanes.push({
      laneId: source.laneId,
      owner: { ...source.workspace.owner },
      streamIndex: source.streamIndex,
      queueIndex: source.queueIndex,
      workItemIndexes: [...source.workItemIndexes],
      status: "accepted",
      acceptedHead: { ...inspection.currentRevision },
      workspace: {
        workspaceRoot: source.workspace.workspaceRoot,
        workspacePath: source.workspace.workspacePath,
        workspaceName: source.workspace.workspaceName,
        ...source.workspace.owner,
      },
    });
  }

  const fanInIdentity = intrinsicIdentity(input.state, input);
  const rawIntegration = await backend.fanIn({
    ...fanInIdentity,
    cwd: first.repositoryRoot,
    repositoryRoot: first.repositoryRoot,
    baseline: { ...first.baseline },
    queueOrder: sources.map(({ laneId }) => laneId),
    lanes,
  });
  const integration = boundJjFanInResult(rawIntegration);
  if (!isRevision(integration.effectiveBase) || !isRevision(integration.finalTip)) {
    throw new Error("Integrate-JJ-Workspaces did not return linear integration provenance.");
  }
  const reviewProvenance = boundedReviewProvenance(integration);

  const integrationScopeId = `${input.executionScope.id}:jj-integration:${encodeURIComponent(input.socketId)}`;
  const workspace = await backend.createWorkspace({
    cwd: first.repositoryRoot,
    repositoryRoot: first.repositoryRoot,
    workspaceRoot: first.workspaceRoot,
    parentCastId: input.castId,
    loopId: input.socketId,
    laneId: integrationScopeId,
    baseline: integration.finalTip,
  });
  // `jj workspace add --revision <final-tip>` materializes a fresh empty
  // working commit whose direct parent is the requested linear tip. The
  // ownership record's pinned baseline represents that relationship; the
  // workspace's own revision is intentionally a distinct child revision.
  if (workspace.baseline.commitId !== integration.finalTip.commitId
    || workspace.baseline.changeId !== integration.finalTip.changeId) {
    throw new Error("Integrate-JJ-Workspaces materialized workspace does not descend directly from the stable final linear tip.");
  }

  const sourceCleanup = sources.map(({ laneId, workspace: source }) => ({
    laneId,
    owner: { ...source.owner },
    workspaceRoot: source.workspaceRoot,
    workspacePath: source.workspacePath,
    workspaceName: source.workspaceName,
    manifestPath: source.manifestPath,
  }));
  const integrationValue = {
    version: 1,
    backend: "jj",
    outcome: integration.outcome,
    integrationRevision: { ...integration.finalTip },
    ...structuredClone(reviewProvenance),
    repositoryRoot: workspace.repositoryRoot,
    workspaceRoot: workspace.workspaceRoot,
    workspacePath: workspace.workspacePath,
    workspaceName: workspace.workspaceName,
    manifestPath: workspace.manifestPath,
    owner: { ...workspace.owner },
    sourceCount: sources.length,
    conflictedPaths: [...integration.conflictedPaths],
    conflictDetails: structuredClone(integration.conflictDetails),
  };
  const cleanupValue = {
    version: 1,
    backend: "jj",
    integration: {
      owner: { ...workspace.owner },
      workspaceRoot: workspace.workspaceRoot,
      workspacePath: workspace.workspacePath,
      workspaceName: workspace.workspaceName,
      manifestPath: workspace.manifestPath,
    },
    sources: sourceCleanup,
  };
  const exports: Record<string, ExecutionScopeExport> = {
    ...structuredClone(input.executionScope.exports),
    [JJ_WORKSPACE_INTEGRATION_EXPORT]: { producer: INTEGRATE_JJ_WORKSPACES_PRODUCER, value: integrationValue },
    [JJ_WORKSPACE_CLEANUP_EXPORT]: { producer: INTEGRATE_JJ_WORKSPACES_PRODUCER, value: cleanupValue },
  };
  const summary = {
    version: 1,
    outcome: integration.outcome,
    sourceCount: sources.length,
    integrationRevision: { ...integration.finalTip },
    ...structuredClone(reviewProvenance),
    conflictedPaths: [...integration.conflictedPaths],
    conflictDetails: structuredClone(integration.conflictDetails),
  };
  return {
    integration,
    workspace,
    sourceCount: sources.length,
    scope: createExecutionScope({
      id: integrationScopeId,
      cwd: workspace.cwd,
      state: { ...structuredClone(input.executionScope.state), jjWorkspaceIntegration: summary },
      exports,
    }),
  };
}

function orderedSources(state: unknown, activeScope: ExecutionScope): OrderedWorkspaceSource[] {
  const fanIn = isRecord(state) ? state.parallelFanIn : undefined;
  if (fanIn !== undefined) {
    if (!isIntrinsicFanIn(fanIn)) throw new Error("Integrate-JJ-Workspaces state.parallelFanIn is malformed.");
    return fanIn.orderedBranches.map((branch, queueIndex) => ({
      laneId: branch.laneId,
      streamIndex: branch.streamIndex,
      queueIndex,
      workItemIndexes: [...branch.workItemIndexes],
      scopeId: branch.scope.id,
      scopeCwd: branch.scope.cwd,
      workspace: parseWorkspaceExport(branch.scopeExports[JJ_WORKSPACE_INTEGRATION_EXPORT], branch.laneId),
    }));
  }
  return [{
    laneId: "single-workspace",
    streamIndex: 0,
    queueIndex: 0,
    workItemIndexes: [],
    scopeId: activeScope.id,
    scopeCwd: activeScope.cwd,
    workspace: parseWorkspaceExport(activeScope.exports[JJ_WORKSPACE_INTEGRATION_EXPORT], "single-workspace"),
  }];
}

function parseWorkspaceExport(value: ExecutionScopeExport | undefined, laneId: string): SpawnedWorkspaceExport {
  if (!value || value.producer !== SPAWN_JJ_WORKSPACE_PRODUCER || !isRecord(value.value)) {
    throw new Error(`Integrate-JJ-Workspaces source ${JSON.stringify(laneId)} has no trusted Spawn-JJ-Workspace integration export.`);
  }
  const raw = value.value;
  if (raw.version !== 1 || raw.backend !== "jj" || !isOwner(raw.owner) || !isRevision(raw.baseline)) {
    throw new Error(`Integrate-JJ-Workspaces source ${JSON.stringify(laneId)} has a malformed workspace export.`);
  }
  const required = ["repositoryRoot", "workspacePath", "workspaceName", "manifestPath"] as const;
  if (required.some((key) => typeof raw[key] !== "string" || (raw[key] as string).trim().length === 0)) {
    throw new Error(`Integrate-JJ-Workspaces source ${JSON.stringify(laneId)} has an incomplete workspace export.`);
  }
  const workspaceRoot = typeof raw.workspaceRoot === "string" && raw.workspaceRoot.trim()
    ? raw.workspaceRoot
    : path.dirname(path.dirname(raw.manifestPath as string));
  return {
    version: 1,
    backend: "jj",
    owner: { ...raw.owner },
    repositoryRoot: raw.repositoryRoot as string,
    workspaceRoot,
    workspacePath: raw.workspacePath as string,
    workspaceName: raw.workspaceName as string,
    manifestPath: raw.manifestPath as string,
    baseline: { ...raw.baseline },
  };
}

function assertExportMatchesInspection(source: OrderedWorkspaceSource, inspection: JjWorkspaceRecord): void {
  const exported = source.workspace;
  if (path.resolve(source.scopeCwd) !== path.resolve(exported.workspacePath)
    || path.resolve(inspection.workspacePath) !== path.resolve(exported.workspacePath)
    || path.resolve(inspection.repositoryRoot) !== path.resolve(exported.repositoryRoot)
    || inspection.workspaceName !== exported.workspaceName
    || inspection.manifestPath !== exported.manifestPath
    || inspection.owner.parentCastId !== exported.owner.parentCastId
    || inspection.owner.loopId !== exported.owner.loopId
    || inspection.owner.laneId !== exported.owner.laneId
    || inspection.baseline.commitId !== exported.baseline.commitId
    || inspection.baseline.changeId !== exported.baseline.changeId) {
    throw new Error(`Integrate-JJ-Workspaces source ${JSON.stringify(source.laneId)} failed ownership or baseline verification.`);
  }
}

function intrinsicIdentity(state: unknown, input: IntegrateJjWorkspacesInput): Pick<JjFanInInput, "parentCastId" | "loopId" | "runId"> {
  const fanIn = isRecord(state) ? state.parallelFanIn : undefined;
  if (isIntrinsicFanIn(fanIn)) return { parentCastId: fanIn.parentCastId, loopId: fanIn.loopId, runId: fanIn.runId };
  return { parentCastId: input.castId, loopId: input.socketId, runId: `${input.castId}:${input.socketId}:single` };
}

function boundJjFanInResult(result: JjFanInResult): JjFanInResult {
  const removableWorkflowBoundary = result.removableWorkflowBoundary === undefined
    ? undefined
    : boundedRemovableWorkflowBoundary(result.removableWorkflowBoundary, result);
  const boundedText = (value: string, max: number) => {
    const normalized = String(value).replace(/\s+/g, " ").trim();
    return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
  };
  return {
    ...structuredClone(result),
    ...(removableWorkflowBoundary ? { removableWorkflowBoundary } : {}),
    satisfied: result.outcome === "clean",
    conflictedPaths: result.conflictedPaths.slice(0, 64).map((value) => boundedText(value, 512)),
    conflictDetails: result.conflictDetails.slice(0, 64).map((detail) => ({
      path: boundedText(detail.path, 512),
      message: boundedText(detail.message, 1_000),
    })),
  };
}

function boundedReviewProvenance(integration: JjFanInResult) {
  const orderedWorkstreams = [] as Array<{
    laneId: string;
    streamIndex: number;
    workItemIndexes: number[];
    changeIds: string[];
    rewrittenTip?: { commitId: string; changeId: string };
  }>;
  let retainedChanges = 0;
  for (const head of integration.orderedHeads.slice(0, MAX_REVIEW_WORKSTREAMS)) {
    const changeIds = head.commits
      .map(({ changeId }) => boundedReviewId(changeId))
      .slice(0, Math.max(0, MAX_REVIEW_CHANGES - retainedChanges));
    retainedChanges += changeIds.length;
    const rewrittenTip = integration.rewrittenLaneTips.find(({ laneId }) => laneId === head.laneId)?.revision;
    orderedWorkstreams.push({
      laneId: boundedReviewId(head.laneId),
      streamIndex: head.streamIndex,
      workItemIndexes: head.workItemIndexes.slice(0, MAX_REVIEW_CHANGES),
      changeIds,
      ...(rewrittenTip ? { rewrittenTip: boundedRevision(rewrittenTip) } : {}),
    });
  }
  const totalChangeCount = integration.orderedChangeIds.length;
  const removableWorkflowBoundary = integration.removableWorkflowBoundary
    ? boundedRemovableWorkflowBoundary(integration.removableWorkflowBoundary, integration)
    : undefined;
  return {
    effectiveBase: boundedRevision(integration.effectiveBase),
    ...(removableWorkflowBoundary ? { removableWorkflowBoundary } : {}),
    orderedWorkstreams,
    orderedChangeIds: integration.orderedChangeIds.slice(0, MAX_REVIEW_CHANGES).map(boundedReviewId),
    finalTip: boundedRevision(integration.finalTip),
    totalWorkstreamCount: integration.orderedHeads.length,
    totalChangeCount,
    provenanceTruncated: integration.orderedHeads.length > orderedWorkstreams.length
      || totalChangeCount > retainedChanges
      || totalChangeCount > MAX_REVIEW_CHANGES,
  };
}

function boundedRevision(revision: { commitId: string; changeId: string }) {
  return { commitId: boundedReviewId(revision.commitId), changeId: boundedReviewId(revision.changeId) };
}

function boundedRemovableWorkflowBoundary(
  boundary: JjRemovableWorkflowBoundary,
  integration: Pick<JjFanInResult, "baseline" | "effectiveBase" | "orderedChangeIds">,
): JjRemovableWorkflowBoundary {
  if (!isRemovableWorkflowBoundary(boundary)
    || integration.orderedChangeIds.length === 0
    || !isRevision(integration.baseline)
    || boundary.commitId !== integration.baseline.commitId
    || boundary.changeId !== integration.baseline.changeId
    || !isRevision(integration.effectiveBase)
    || boundary.expectedParent.commitId !== integration.effectiveBase.commitId
    || boundary.expectedParent.changeId !== integration.effectiveBase.changeId
    || integration.orderedChangeIds.includes(boundary.changeId)) {
    throw new Error("Integrate-JJ-Workspaces returned inconsistent removable workflow-boundary provenance.");
  }
  const bounded = {
    commitId: boundedReviewId(boundary.commitId),
    changeId: boundedReviewId(boundary.changeId),
    expectedParent: boundedRevision(boundary.expectedParent),
  } satisfies JjRemovableWorkflowBoundary;
  if (bounded.commitId !== boundary.commitId || bounded.changeId !== boundary.changeId
    || bounded.expectedParent.commitId !== boundary.expectedParent.commitId
    || bounded.expectedParent.changeId !== boundary.expectedParent.changeId) {
    throw new Error("Integrate-JJ-Workspaces removable workflow-boundary provenance exceeds the bounded identity limit.");
  }
  return bounded;
}

function boundedReviewId(value: string): string {
  const normalized = String(value).replace(/\s+/g, " ").trim();
  return normalized.length > MAX_REVIEW_ID_LENGTH ? `${normalized.slice(0, MAX_REVIEW_ID_LENGTH - 1)}…` : normalized;
}

function isIntrinsicFanIn(value: unknown): value is IntrinsicParallelFanInResult {
  if (!isRecord(value) || value.version !== 1 || value.satisfied !== true || typeof value.parentCastId !== "string" || typeof value.loopId !== "string" || typeof value.runId !== "string" || !Array.isArray(value.orderedBranches)) return false;
  return value.orderedBranches.every((branch) => isRecord(branch)
    && typeof branch.laneId === "string"
    && Number.isSafeInteger(branch.streamIndex) && (branch.streamIndex as number) >= 0
    && Array.isArray(branch.workItemIndexes) && branch.workItemIndexes.every((index) => Number.isSafeInteger(index) && index >= 0)
    && isRecord(branch.scope) && typeof branch.scope.id === "string" && typeof branch.scope.cwd === "string"
    && isRecord(branch.scopeExports));
}

function isOwner(value: unknown): value is JjWorkspaceOwner {
  return isRecord(value) && [value.parentCastId, value.loopId, value.laneId].every((entry) => typeof entry === "string" && entry.trim().length > 0);
}

function isRevision(value: unknown): value is { commitId: string; changeId: string } {
  return isRecord(value) && typeof value.commitId === "string" && value.commitId.trim().length > 0 && typeof value.changeId === "string" && value.changeId.trim().length > 0;
}

function isRemovableWorkflowBoundary(value: unknown): value is JjRemovableWorkflowBoundary {
  return isRecord(value)
    && typeof value.commitId === "string" && value.commitId.trim().length > 0
    && typeof value.changeId === "string" && value.changeId.trim().length > 0
    && isRevision(value.expectedParent);
}

function assertInput(input: IntegrateJjWorkspacesInput): void {
  for (const [label, value] of [["cwd", input.cwd], ["castId", input.castId], ["socketId", input.socketId]] as const) {
    if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Integrate-JJ-Workspaces ${label} must be a non-empty string.`);
  }
  if (path.resolve(input.cwd) !== path.resolve(input.executionScope.cwd)) throw new Error("Integrate-JJ-Workspaces cwd must match the active execution scope cwd.");
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
