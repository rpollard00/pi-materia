import type {
  MateriaParallelConfigIdentity,
  MateriaParallelRevisionIdentity,
  MateriaParallelRunState,
  MateriaParallelWorkspaceOwnership,
} from "./parallelRunTypes.js";

/** Structural loop configuration needed by the recovery contract. */
export interface ParallelRecoveryConfig {
  planInput: string;
  maxConcurrency: number;
  workspaceMode: "jj";
  failurePolicy: "all_terminal";
  fanIn: "ordered";
}

/** The immutable plan shape pinned into a parallel run. */
export interface ParallelRecoveryPlan {
  version: number;
  planId: string;
  workItemCount: number;
  streams: readonly {
    laneId: string;
    name: string;
    streamIndex: number;
    workItemIndexes: readonly number[];
  }[];
}

export interface ParallelRecoveryValidationIssue {
  code: string;
  path: string;
  message: string;
  laneId?: string;
}

export interface ParallelRecoveryValidationResult {
  ok: boolean;
  issues: readonly ParallelRecoveryValidationIssue[];
}

export interface ParallelRecoveryValidationInput {
  parentCastId: string;
  loopId: string;
  configHash: string;
  config: ParallelRecoveryConfig;
  plan: ParallelRecoveryPlan;
  baseline: MateriaParallelRevisionIdentity;
  run: MateriaParallelRunState;
}

/**
 * Return whether a failed parent is specifically recoverable lane work.
 * Fan-in failures and budget failures are deliberately not folded into lane
 * revival: they have a different repair boundary and must not rerun accepted
 * work.
 */
export function isParallelLaneRevivalCandidate(run: MateriaParallelRunState | undefined): boolean {
  if (!run || run.phase !== "failed" || run.fanInPhase !== "skipped" || run.fanInProvenance || !isRecord(run.lanes)) return false;
  const lanes = Object.values(run.lanes);
  return lanes.length > 0
    && lanes.every((lane) => isRecord(lane) && (lane.status === "accepted" || lane.status === "failed" || lane.status === "interrupted"))
    && lanes.some((lane) => isRecord(lane) && (lane.status === "failed" || lane.status === "interrupted"));
}

/**
 * Validate every identity that makes a lane revival safe. This is intentionally
 * pure: filesystem, jj, and child-session observations are supplied by the
 * runtime adapter after this structural check. A different plan or config is
 * a new run, not something revival may silently repair.
 */
export function validateParallelRecovery(input: ParallelRecoveryValidationInput): ParallelRecoveryValidationResult {
  const issues: ParallelRecoveryValidationIssue[] = [];
  const { run, plan, config } = input;
  const lanes = isRecord(run.lanes) ? run.lanes : {};
  const issue = (code: string, path: string, message: string, laneId?: string) => {
    issues.push({ code, path, message, ...(laneId ? { laneId } : {}) });
  };

  if (run.version !== 1) issue("run_version", "run.version", "only parallel run version 1 can be revived");
  if (run.parentCastId !== input.parentCastId) issue("cast_mismatch", "run.parentCastId", "the persisted run belongs to a different parent cast");
  if (run.loopId !== input.loopId) issue("loop_mismatch", "run.loopId", "the persisted run belongs to a different loop");
  if (run.phase !== "failed") issue("run_not_failed", "run.phase", `the parallel run is ${JSON.stringify(run.phase)}, not failed`);
  if (run.fanInPhase !== "skipped") issue("fan_in_not_skipped", "run.fanInPhase", "lane revival requires fan-in to have been skipped");
  if (run.fanInProvenance) issue("fan_in_already_materialized", "run.fanInProvenance", "a run with materialized fan-in cannot be revived as lane work");

  if (!isRecord(run.configIdentity)) {
    issue("config_identity_missing", "configIdentity", "the persisted run has no usable config identity");
  } else {
    if (run.configIdentity.configHash !== input.configHash) issue("config_hash_mismatch", "configIdentity.configHash", "the current config hash differs from the pinned run config");
    if (run.configIdentity.loopId !== input.loopId) issue("config_loop_mismatch", "configIdentity.loopId", "the persisted config identity belongs to a different loop");
    compareConfigIdentity(run.configIdentity, config, issue);
  }

  if (!isRecord(run.planIdentity)) {
    issue("plan_identity_missing", "planIdentity", "the persisted run has no usable plan identity");
  } else {
    if (run.planIdentity.version !== plan.version) issue("plan_version_mismatch", "planIdentity.version", "the normalized plan version differs from the pinned run plan");
    if (run.planIdentity.planId !== plan.planId) issue("plan_id_mismatch", "planIdentity.planId", "the normalized plan id differs from the pinned run plan");
    if (run.planIdentity.workItemCount !== plan.workItemCount) issue("plan_count_mismatch", "planIdentity.workItemCount", "the normalized work-item count differs from the pinned run plan");
  }
  if (!sameRevision(run.baseline, input.baseline)) issue("baseline_mismatch", "baseline", "the parent repository no longer points at the pinned immutable baseline");
  if (!Array.isArray(plan.streams)) {
    issue("plan_streams_invalid", "plan.streams", "the normalized plan streams must be an array");
    return { ok: issues.length === 0, issues };
  }

  if (!Array.isArray(run.queueOrder) || run.queueOrder.length !== plan.streams.length) {
    issue("queue_mismatch", "queueOrder", "the persisted lane queue does not cover the normalized plan exactly");
  }

  const seenLanes = new Set<string>();
  for (const [queueIndex, stream] of plan.streams.entries()) {
    const laneId = stream.laneId;
    if (seenLanes.has(laneId)) issue("plan_lane_duplicate", `plan.streams[${queueIndex}].laneId`, "the normalized plan contains a duplicate lane id", laneId);
    seenLanes.add(laneId);
    const queuedLaneId = run.queueOrder?.[queueIndex];
    if (queuedLaneId !== laneId) issue("queue_order_mismatch", `queueOrder[${queueIndex}]`, `expected lane ${JSON.stringify(laneId)} in its original queue position`, laneId);

    const lane = lanes[laneId];
    if (!lane) {
      issue("lane_missing", `lanes.${laneId}`, "the persisted lane is missing from the run", laneId);
      continue;
    }
    if (lane.queueIndex !== queueIndex) issue("queue_index_mismatch", `lanes.${laneId}.queueIndex`, "the lane queue index changed", laneId);
    if (lane.name !== stream.name) issue("stream_name_mismatch", `lanes.${laneId}.name`, "the lane stream name changed", laneId);
    if (lane.streamIndex !== stream.streamIndex) issue("stream_index_mismatch", `lanes.${laneId}.streamIndex`, "the lane stream index changed", laneId);
    if (!sameIndexes(lane.workItemIndexes, stream.workItemIndexes)) issue("stream_membership_mismatch", `lanes.${laneId}.workItemIndexes`, "the lane work-item membership changed", laneId);
    validateLaneIdentity(run, laneId, lane, input.baseline, issue);
  }

  for (const laneId of Object.keys(lanes)) {
    if (!seenLanes.has(laneId)) issue("unexpected_lane", `lanes.${laneId}`, "the run contains a lane that is not in the original normalized plan", laneId);
  }

  return { ok: issues.length === 0, issues };
}

function compareConfigIdentity(
  identity: MateriaParallelConfigIdentity,
  config: ParallelRecoveryConfig,
  issue: (code: string, path: string, message: string) => void,
): void {
  const expected: Record<string, unknown> = {
    planInput: config.planInput,
    maxConcurrency: config.maxConcurrency,
    workspaceMode: config.workspaceMode,
    failurePolicy: config.failurePolicy,
    fanIn: config.fanIn,
  };
  const actual: Record<string, unknown> = {
    planInput: identity.planInput,
    maxConcurrency: identity.maxConcurrency,
    workspaceMode: identity.workspaceMode,
    failurePolicy: identity.failurePolicy,
    fanIn: identity.fanIn,
  };
  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key]) issue("config_mismatch", `config.${key}`, `current config ${JSON.stringify(expected[key])} differs from pinned value ${JSON.stringify(actual[key])}`);
  }
}

function validateLaneIdentity(
  run: MateriaParallelRunState,
  laneId: string,
  lane: MateriaParallelRunState["lanes"][string],
  baseline: MateriaParallelRevisionIdentity,
  issue: (code: string, path: string, message: string, laneId?: string) => void,
): void {
  if (!isRecord(lane)) {
    issue("lane_invalid", `lanes.${laneId}`, "the persisted lane is not an object", laneId);
    return;
  }
  if (lane.status !== "accepted" && lane.status !== "failed" && lane.status !== "interrupted") {
    issue("lane_not_terminal", `lanes.${laneId}.status`, "revival refuses to reinterpret a queued or running lane", laneId);
    return;
  }

  if (lane.workspace) {
    if (!isRecord(lane.workspace)) issue("workspace_invalid", `lanes.${laneId}.workspace`, "workspace ownership is not an object", laneId);
    else validateWorkspaceOwnership(run, laneId, lane.workspace, baseline, issue);
  }
  if (lane.childSession) {
    if (!isRecord(lane.childSession)) {
      issue("child_session_invalid", `lanes.${laneId}.childSession`, "child session provenance is not an object", laneId);
      return;
    }
    if (!lane.childCastId) issue("child_identity_missing", `lanes.${laneId}.childCastId`, "a persisted child session requires childCastId", laneId);
    if (lane.childSession.childCastId !== lane.childCastId) issue("child_identity_mismatch", `lanes.${laneId}.childSession.childCastId`, "child session identity does not match childCastId", laneId);
    for (const [key, value] of Object.entries({ sessionPath: lane.childSession.sessionPath, artifactRoot: lane.childSession.artifactRoot, runDirectory: lane.childSession.runDirectory })) {
      if (typeof value !== "string" || value.trim().length === 0) issue("child_session_invalid", `lanes.${laneId}.childSession.${key}`, "child session paths must be non-empty strings", laneId);
    }
  } else if (lane.status === "accepted") {
    issue("child_session_missing", `lanes.${laneId}.childSession`, "an accepted lane must retain its child session provenance", laneId);
  }

  if (lane.status === "accepted") {
    if (!isRevision(lane.acceptedHead)) issue("accepted_head_missing", `lanes.${laneId}.acceptedHead`, "an accepted lane must retain its immutable accepted head", laneId);
    if (!lane.workspace) issue("workspace_missing", `lanes.${laneId}.workspace`, "an accepted lane must retain owned workspace provenance", laneId);
  }
}

function validateWorkspaceOwnership(
  run: MateriaParallelRunState,
  laneId: string,
  workspace: MateriaParallelWorkspaceOwnership,
  baseline: MateriaParallelRevisionIdentity,
  issue: (code: string, path: string, message: string, laneId?: string) => void,
): void {
  const prefix = `lanes.${laneId}.workspace`;
  if (workspace.backend !== "jj") issue("workspace_backend", `${prefix}.backend`, "only jj workspaces can be revived", laneId);
  if (workspace.state === "forgotten") issue("workspace_forgotten", `${prefix}.state`, "a forgotten lane workspace cannot be revived", laneId);
  if (workspace.parentCastId !== run.parentCastId || workspace.loopId !== run.loopId || workspace.laneId !== laneId) {
    issue("workspace_owner_mismatch", prefix, "workspace ownership does not match the parent cast, loop, and lane", laneId);
  }
  if (!sameRevision(workspace.baseline, baseline)) issue("workspace_baseline_mismatch", `${prefix}.baseline`, "workspace baseline differs from the pinned run baseline", laneId);
  for (const [key, value] of Object.entries({ repositoryRoot: workspace.repositoryRoot, workspaceRoot: workspace.workspaceRoot, workspacePath: workspace.workspacePath, workspaceName: workspace.workspaceName })) {
    if (typeof value !== "string" || value.trim().length === 0) issue("workspace_invalid", `${prefix}.${key}`, "workspace ownership fields must be non-empty strings", laneId);
  }
}

function sameIndexes(left: readonly number[], right: readonly number[]): boolean {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRevision(value: MateriaParallelRevisionIdentity | undefined): value is MateriaParallelRevisionIdentity {
  return Boolean(value && typeof value.commitId === "string" && value.commitId.trim().length > 0 && typeof value.changeId === "string" && value.changeId.trim().length > 0);
}

function sameRevision(left: MateriaParallelRevisionIdentity | undefined, right: MateriaParallelRevisionIdentity | undefined): boolean {
  return isRevision(left) && isRevision(right) && left.commitId === right.commitId && left.changeId === right.changeId;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
