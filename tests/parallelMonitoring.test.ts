import { describe, expect, test } from "bun:test";
import { createParallelRunState } from "../src/domain/parallelRun.js";
import { summarizeParallelRun } from "../src/application/parallelMonitoring.js";

function run() {
  return createParallelRunState({
    parentCastId: "cast-1",
    loopId: "build",
    runId: "parallel-run-1",
    planIdentity: { version: 1, planId: "plan-1", workItemCount: 3 },
    configIdentity: {
      configHash: "config-1",
      loopId: "build",
      planInput: "state.parallelPlan",
      maxConcurrency: 2,
      workspaceMode: "jj",
      failurePolicy: "all_terminal",
      fanIn: "ordered",
    },
    baseline: { commitId: "base", changeId: "base-change" },
    queue: [
      { laneId: "lane-api", name: "api", streamIndex: 0, workItemIndexes: [0, 2] },
      { laneId: "lane-ui", name: "ui", streamIndex: 1, workItemIndexes: [1] },
    ],
    now: 10,
  });
}

describe("parallel monitor summaries", () => {
  test("preserves ordered lane identity and exposes artifact/workspace pointers", () => {
    const state = run();
    state.lanes["lane-api"] = {
      ...state.lanes["lane-api"]!,
      status: "accepted",
      attempt: 2,
      childCastId: "child-api",
      childSession: {
        childCastId: "child-api",
        sessionPath: "/tmp/child-api/session.jsonl",
        artifactRoot: "/tmp/child-api/artifacts",
        runDirectory: "/tmp/child-api/run",
      },
      workspace: {
        backend: "jj",
        parentCastId: "cast-1",
        loopId: "build",
        laneId: "lane-api",
        repositoryRoot: "/repo",
        workspaceRoot: "/tmp/materia",
        workspacePath: "/tmp/materia/lane-api",
        workspaceName: "materia-cast-1-build-lane-api",
        revision: { commitId: "head-api", changeId: "change-api" },
      },
      acceptedHead: { commitId: "head-api", changeId: "change-api" },
      updatedAt: 20,
    };
    state.lanes["lane-ui"] = { ...state.lanes["lane-ui"]!, status: "running", updatedAt: 21 };
    state.phase = "awaiting_lanes";
    state.updatedAt = 21;

    const summary = summarizeParallelRun(state);
    expect(summary.counts).toEqual({ total: 2, queued: 0, running: 1, accepted: 1, failed: 0, interrupted: 0, completed: 1, fanIn: 0, conflict: 0 });
    expect(summary.lanes.map((lane) => lane.laneId)).toEqual(["lane-api", "lane-ui"]);
    expect(summary.lanes[0]).toMatchObject({
      attempt: 2,
      childCastId: "child-api",
      childSession: { artifactRoot: "/tmp/child-api/artifacts" },
      workspace: { workspacePath: "/tmp/materia/lane-api" },
      acceptedHead: { commitId: "head-api" },
    });
  });

  test("marks fan-in and conflicts without changing lane completion counts", () => {
    const state = run();
    for (const lane of Object.values(state.lanes)) lane.status = "accepted";
    state.phase = "resolving";
    state.fanInPhase = "conflict";
    state.fanInProvenance = {
      version: 1,
      parentCastId: "cast-1",
      loopId: "build",
      runId: "parallel-run-1",
      baseline: state.baseline,
      parentRevisionBefore: state.baseline,
      parentRevisionAfter: state.baseline,
      orderedHeads: [],
      outcome: "conflict",
      conflictedPaths: ["src/file.ts"],
      conflictDetails: [],
      operationId: "op-1",
      startedAt: 20,
      completedAt: 21,
    };

    expect(summarizeParallelRun(state).counts).toMatchObject({ accepted: 2, completed: 2, fanIn: 1, conflict: 1 });
  });
});
