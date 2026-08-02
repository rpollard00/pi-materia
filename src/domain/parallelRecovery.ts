import type { MateriaParallelRunState } from "./parallelRunTypes.js";

/**
 * A failed run is recoverable only at the branch boundary. Accepted branches
 * are immutable results; only failed or interrupted branches may be reopened.
 * Plan, graph, branch, and execution-scope identity validation is performed by
 * the dispatcher against the current compiled program before any attempt is
 * changed.
 */
export function isParallelLaneRevivalCandidate(run: MateriaParallelRunState | undefined): boolean {
  if (!run || run.phase !== "failed" || run.fanInPhase !== "skipped" || !isRecord(run.lanes)) return false;
  const lanes = Object.values(run.lanes);
  return lanes.length > 0
    && lanes.every((lane) => isRecord(lane)
      && (lane.status === "accepted" || lane.status === "failed" || lane.status === "interrupted"))
    && lanes.some((lane) => isRecord(lane)
      && (lane.status === "failed" || lane.status === "interrupted"));
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
