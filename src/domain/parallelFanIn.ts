import type {
  MateriaParallelFanInProvenance,
  MateriaParallelLaneState,
  MateriaParallelRevisionIdentity,
  MateriaParallelRunState,
  MateriaParallelWorkspaceOwnership,
} from "./parallelRunTypes.js";

/** A lane snapshot supplied to the deterministic fan-in boundary. */
export interface ParallelFanInLaneInput {
  laneId: string;
  streamIndex: number;
  status: MateriaParallelLaneState["status"];
  acceptedHead?: MateriaParallelRevisionIdentity;
  workspace?: MateriaParallelWorkspaceOwnership;
}

export interface OrderedParallelFanInLane {
  laneId: string;
  streamIndex: number;
  queueIndex: number;
  workItemIndexes: number[];
  head: MateriaParallelRevisionIdentity;
  workspace: MateriaParallelWorkspaceOwnership;
}

export class ParallelFanInValidationError extends Error {
  readonly code: string;
  readonly laneId?: string;

  constructor(code: string, message: string, laneId?: string) {
    super(message);
    this.name = "ParallelFanInValidationError";
    this.code = code;
    this.laneId = laneId;
  }
}

/**
 * Validate the all-terminal fan-in precondition and produce the only ordering
 * accepted by the workflow: normalized queue order. Completion order is never
 * consulted.
 */
export function orderAcceptedParallelLaneHeads(
  run: Pick<MateriaParallelRunState, "queueOrder" | "lanes" | "baseline">,
): OrderedParallelFanInLane[] {
  if (!Array.isArray(run.queueOrder) || run.queueOrder.length === 0) {
    throw new ParallelFanInValidationError("fan_in_no_lanes", "Parallel fan-in requires at least one normalized lane.");
  }

  const seen = new Set<string>();
  const streamIndexes = new Set<number>();
  const ordered: OrderedParallelFanInLane[] = [];
  for (const [queueIndex, laneId] of run.queueOrder.entries()) {
    if (typeof laneId !== "string" || laneId.trim().length === 0 || seen.has(laneId)) {
      throw new ParallelFanInValidationError("fan_in_order_invalid", "Parallel queue order contains a missing or duplicate lane identity.", laneId);
    }
    seen.add(laneId);
    const lane = run.lanes[laneId];
    if (!lane) throw new ParallelFanInValidationError("fan_in_lane_missing", `Parallel lane ${JSON.stringify(laneId)} is missing from durable run state.`, laneId);
    if (!Number.isSafeInteger(lane.streamIndex) || lane.streamIndex < 0 || streamIndexes.has(lane.streamIndex)) {
      throw new ParallelFanInValidationError("fan_in_order_invalid", `Parallel lane ${JSON.stringify(laneId)} has an invalid or duplicate normalized stream index.`, laneId);
    }
    streamIndexes.add(lane.streamIndex);
    if (lane.status !== "accepted") {
      throw new ParallelFanInValidationError("fan_in_lane_not_accepted", `Parallel lane ${JSON.stringify(laneId)} is ${JSON.stringify(lane.status)}; all lanes must be accepted before fan-in.`, laneId);
    }
    if (!isRevisionIdentity(lane.acceptedHead)) {
      throw new ParallelFanInValidationError("fan_in_head_missing", `Parallel lane ${JSON.stringify(laneId)} has no verifiable accepted head.`, laneId);
    }
    if (!lane.workspace) {
      throw new ParallelFanInValidationError("fan_in_workspace_missing", `Parallel lane ${JSON.stringify(laneId)} has no owned workspace record.`, laneId);
    }
    if (!isRevisionIdentity(lane.workspace.baseline) || !sameRevision(lane.workspace.baseline, run.baseline)) {
      throw new ParallelFanInValidationError("fan_in_baseline_mismatch", `Parallel lane ${JSON.stringify(laneId)} is pinned to a different baseline.`, laneId);
    }
    ordered.push({
      laneId,
      streamIndex: lane.streamIndex,
      queueIndex,
      workItemIndexes: [...lane.workItemIndexes],
      head: { ...lane.acceptedHead },
      workspace: clone(lane.workspace),
    });
  }

  if (seen.size !== Object.keys(run.lanes).length) {
    throw new ParallelFanInValidationError("fan_in_order_incomplete", "Parallel queue order does not cover every durable lane.");
  }
  return ordered;
}

export interface ParallelFanInResult extends MateriaParallelFanInProvenance {
  /** True only for a structurally clean integration. */
  satisfied: boolean;
}

/** The synthetic parent handoff exposed after the successful-lanes barrier. */
export interface ParallelFanInHandoff {
  satisfied: boolean;
  context: string;
  parallelFanIn: MateriaParallelFanInProvenance;
}

/**
 * Keep VCS-provided conflict telemetry bounded before it enters durable cast
 * state or a resolver prompt. Infrastructure adapters should already apply the
 * same bounds, but the runtime boundary is intentionally defensive for fakes,
 * alternate backends, and persisted data from older versions.
 */
export function boundParallelFanInResult(result: ParallelFanInResult): ParallelFanInResult {
  return {
    ...clone(result),
    // Outcome is the structural VCS truth. Do not allow an inconsistent
    // adapter boolean to route a conflicted revision through the clean join.
    satisfied: result.outcome === "clean",
    conflictedPaths: result.conflictedPaths.slice(0, 64).map((value) => boundedText(value, 512)),
    conflictDetails: result.conflictDetails.slice(0, 64).map((detail) => ({
      path: boundedText(detail.path, 512),
      message: boundedText(detail.message, 1_000),
    })),
  };
}

/**
 * Convert a structural fan-in result into the canonical control handoff used
 * by the parent resolver/evaluator sockets. The provenance remains under one
 * namespaced field so it cannot be confused with ordinary work-item data.
 */
export function parallelFanInHandoff(result: ParallelFanInResult): ParallelFanInHandoff {
  const bounded = boundParallelFanInResult(result);
  const details = bounded.conflictDetails.length > 0
    ? bounded.conflictDetails.map((detail) => `${detail.path}: ${detail.message}`).join("; ")
    : bounded.conflictedPaths.map((pathValue) => `${pathValue}: jj reported a merge conflict`).join("; ");
  const context = bounded.outcome === "conflict"
    ? `Parallel fan-in materialized a conflicted integration revision${bounded.integrationRevision ? ` ${bounded.integrationRevision.commitId}` : ""}. Resolve the integration revision without rerunning accepted lanes. Conflicted paths: ${details || "(jj did not report paths)"}.`
    : `Parallel fan-in cleanly integrated ${bounded.orderedHeads.length} accepted lane(s)${bounded.integrationRevision ? ` at ${bounded.integrationRevision.commitId}` : ""}. Continue with post-integration evaluation.`;
  return {
    satisfied: bounded.satisfied,
    context: boundedText(context, 4_000),
    parallelFanIn: bounded,
  };
}

export function isRevisionIdentity(value: unknown): value is MateriaParallelRevisionIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.commitId === "string" && record.commitId.trim().length > 0
    && typeof record.changeId === "string" && record.changeId.trim().length > 0;
}

export function sameRevision(left: MateriaParallelRevisionIdentity, right: MateriaParallelRevisionIdentity): boolean {
  return left.commitId === right.commitId && left.changeId === right.changeId;
}

function boundedText(value: string, max: number): string {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : String(value);
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function clone<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, clone(child)])) as T;
}
