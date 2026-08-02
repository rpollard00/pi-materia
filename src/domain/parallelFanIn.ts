import { cloneExecutionScope, type ExecutionScopeExport } from "./executionScope.js";
import type { MateriaParallelRunState } from "./parallelRunTypes.js";

/** One accepted branch exposed by the intrinsic, repository-neutral barrier. */
export interface OrderedParallelBranchResult {
  laneId: string;
  name: string;
  streamIndex: number;
  queueIndex: number;
  workItemIndexes: number[];
  terminalOutput?: unknown;
  scope: { id: string; cwd: string };
  /** Producer-owned values are transported opaquely; branch state is omitted. */
  scopeExports: Record<string, ExecutionScopeExport>;
}

/** Deterministic result emitted once every branch has been accepted. */
export interface IntrinsicParallelFanInResult {
  version: 1;
  parentCastId: string;
  loopId: string;
  runId: string;
  satisfied: true;
  orderedBranches: OrderedParallelBranchResult[];
}

/**
 * Build the intrinsic barrier result in normalized stream order. This boundary
 * deliberately has no repository adapter and never combines branch state.
 */
export function collectAcceptedParallelBranches(
  run: Pick<MateriaParallelRunState, "parentCastId" | "loopId" | "runId" | "queueOrder" | "lanes">,
): IntrinsicParallelFanInResult {
  const seen = new Set<string>();
  const orderedBranches = run.queueOrder.map((laneId, queueIndex): OrderedParallelBranchResult => {
    if (seen.has(laneId)) throw new ParallelFanInValidationError("fan_in_order_invalid", "Parallel queue order contains a duplicate lane identity.", laneId);
    seen.add(laneId);
    const lane = run.lanes[laneId];
    if (!lane) throw new ParallelFanInValidationError("fan_in_lane_missing", `Parallel lane ${JSON.stringify(laneId)} is missing from durable run state.`, laneId);
    if (lane.status !== "accepted") throw new ParallelFanInValidationError("fan_in_lane_not_accepted", `Parallel lane ${JSON.stringify(laneId)} is ${JSON.stringify(lane.status)}; all branches must be accepted before fan-in.`, laneId);
    if (!lane.executionScope) throw new ParallelFanInValidationError("fan_in_scope_missing", `Parallel lane ${JSON.stringify(laneId)} has no terminal execution scope.`, laneId);
    const scope = cloneExecutionScope(lane.executionScope);
    return {
      laneId,
      name: lane.name,
      streamIndex: lane.streamIndex,
      queueIndex,
      workItemIndexes: [...lane.workItemIndexes],
      ...(lane.terminalOutput !== undefined ? { terminalOutput: structuredClone(lane.terminalOutput) } : {}),
      scope: { id: scope.id, cwd: scope.cwd },
      scopeExports: structuredClone(scope.exports),
    };
  });
  if (seen.size !== Object.keys(run.lanes).length) throw new ParallelFanInValidationError("fan_in_order_incomplete", "Parallel queue order does not cover every durable lane.");
  return { version: 1, parentCastId: run.parentCastId, loopId: run.loopId, runId: run.runId, satisfied: true, orderedBranches };
}

export function intrinsicParallelFanInHandoff(result: IntrinsicParallelFanInResult): {
  satisfied: true;
  context: string;
  parallelFanIn: IntrinsicParallelFanInResult;
} {
  const cloned = structuredClone(result);
  return {
    satisfied: true,
    context: `Parallel barrier accepted ${cloned.orderedBranches.length} branch(es) in normalized stream order. Terminal outputs and opaque scope exports are available in state.parallelFanIn.`,
    parallelFanIn: cloned,
  };
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
