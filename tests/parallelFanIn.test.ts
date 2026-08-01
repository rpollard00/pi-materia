import { describe, expect, test } from "bun:test";
import {
  boundParallelFanInResult,
  orderAcceptedParallelLaneHeads,
  parallelFanInHandoff,
  ParallelFanInValidationError,
} from "../src/domain/parallelFanIn.js";
import { resolveLoopExitRoute } from "../src/graph/loopExitRoutes.js";
import { createParallelRunState } from "../src/domain/parallelRun.js";

const configIdentity = {
  configHash: "config",
  loopId: "build",
  planInput: "state.parallelPlan",
  maxConcurrency: 2,
  workspaceMode: "jj" as const,
  failurePolicy: "all_terminal" as const,
  fanIn: "ordered" as const,
};

function run(overrides: Record<string, unknown> = {}) {
  return createParallelRunState({
    parentCastId: "cast",
    loopId: "build",
    runId: "run",
    planIdentity: { version: 1, planId: "plan", workItemCount: 2 },
    configIdentity,
    baseline: { commitId: "base", changeId: "base-change" },
    queue: [
      { laneId: "lane-a", name: "a", streamIndex: 0, workItemIndexes: [0] },
      { laneId: "lane-b", name: "b", streamIndex: 1, workItemIndexes: [1] },
    ],
    now: 1,
    ...overrides,
  });
}

function acceptedLane(laneId: string, streamIndex: number, queueIndex: number, commitId: string) {
  return {
    laneId,
    name: laneId,
    streamIndex,
    queueIndex,
    workItemIndexes: [queueIndex],
    status: "accepted" as const,
    attempt: 1,
    acceptedHead: { commitId, changeId: `${commitId}-change` },
    workspace: {
      backend: "jj" as const,
      parentCastId: "cast",
      loopId: "build",
      laneId,
      repositoryRoot: "/repo",
      workspaceRoot: "/tmp/materia",
      workspacePath: `/tmp/materia/${laneId}`,
      workspaceName: laneId,
      baseline: { commitId: "base", changeId: "base-change" },
      revision: { commitId: `${laneId}-workspace`, changeId: `${laneId}-workspace-change` },
    },
    updatedAt: 1,
    diagnostics: [],
  };
}

describe("parallel fan-in domain preconditions", () => {
  test("copies accepted heads in normalized queue order, not completion order", () => {
    const state = run();
    state.lanes["lane-a"] = acceptedLane("lane-a", 0, 0, "head-a");
    state.lanes["lane-b"] = acceptedLane("lane-b", 1, 1, "head-b");

    const ordered = orderAcceptedParallelLaneHeads(state);
    expect(ordered.map((lane) => lane.laneId)).toEqual(["lane-a", "lane-b"]);
    expect(ordered.map((lane) => lane.head.commitId)).toEqual(["head-a", "head-b"]);
    ordered[0]!.workItemIndexes.push(99);
    expect(state.lanes["lane-a"]?.workItemIndexes).toEqual([0]);
  });

  test("refuses any non-accepted lane before a VCS operation can begin", () => {
    const state = run();
    state.lanes["lane-a"] = acceptedLane("lane-a", 0, 0, "head-a");
    expect(() => orderAcceptedParallelLaneHeads(state)).toThrow(ParallelFanInValidationError);
    expect(() => orderAcceptedParallelLaneHeads(state)).toThrow(/all lanes must be accepted/);
  });

  test("refuses missing heads, workspaces, and baseline drift", () => {
    const state = run();
    state.lanes["lane-a"] = acceptedLane("lane-a", 0, 0, "head-a");
    state.lanes["lane-b"] = acceptedLane("lane-b", 1, 1, "head-b");
    state.lanes["lane-b"]!.workspace!.baseline.commitId = "other";
    expect(() => orderAcceptedParallelLaneHeads(state)).toThrow(/different baseline/);
  });

  test("bounds conflict telemetry and selects clean versus resolver symbolic routes", () => {
    const result = {
      version: 1,
      parentCastId: "cast",
      loopId: "build",
      runId: "run",
      baseline: { commitId: "base", changeId: "base-change" },
      parentRevisionBefore: { commitId: "base", changeId: "base-change" },
      parentRevisionAfter: { commitId: "base", changeId: "base-change" },
      orderedHeads: [],
      integrationRevision: { commitId: "integration", changeId: "integration-change" },
      outcome: "conflict" as const,
      conflictedPaths: ["a".repeat(600)],
      conflictDetails: [{ path: "a".repeat(600), message: "b".repeat(1_100) }],
      operationId: "operation",
      startedAt: 1,
      completedAt: 2,
      satisfied: true,
    };
    const bounded = boundParallelFanInResult(result);
    expect(bounded.satisfied).toBe(false);
    expect(bounded.conflictedPaths[0]?.length).toBe(512);
    expect(bounded.conflictDetails[0]?.message.length).toBe(1_000);
    const handoff = parallelFanInHandoff(result);
    expect(handoff.satisfied).toBe(false);
    expect(handoff.context).toContain("Resolve the integration revision");

    const loop = {
      exit: { from: "Socket-3" },
      exits: [
        { id: "clean", from: "Socket-3", condition: "satisfied" as const, targetSocketId: "Socket-4" },
        { id: "conflict", from: "Socket-3", condition: "not_satisfied" as const, targetSocketId: "Socket-5" },
      ],
    };
    expect(resolveLoopExitRoute(loop, { from: loop.exit.from, satisfied: true })?.targetSocketId).toBe("Socket-4");
    expect(resolveLoopExitRoute(loop, { from: loop.exit.from, satisfied: false })?.targetSocketId).toBe("Socket-5");
  });
});
