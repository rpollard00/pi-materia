import { describe, expect, test } from "bun:test";
import { createParallelRunState } from "../src/domain/parallelRun.js";
import { summarizeParallelRun } from "../src/application/parallelMonitoring.js";

function run() {
  return createParallelRunState({
    parentCastId: "cast-1",
    loopId: "build",
    runId: "parallel-run-1",
    planIdentity: { version: 1, planId: "plan-1", workItemCount: 3 },
    graphIdentity: { graphHash: "graph-1" },
    configIdentity: {
      configHash: "config-1",
      loopId: "build",
      maxConcurrency: 2,
    },
    queue: [
      { laneId: "lane-api", name: "api", streamIndex: 0, workItemIndexes: [0, 2] },
      { laneId: "lane-ui", name: "ui", streamIndex: 1, workItemIndexes: [1] },
    ],
    now: 10,
  });
}

describe("parallel monitor summaries", () => {
  test("preserves ordered branch identity and exposes scope-neutral status", () => {
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
      executionScope: {
        id: "scope-api",
        cwd: "/tmp/branch-api",
        state: {},
        exports: { integration: { producer: "test", value: { opaque: true } } },
      },
      terminalOutput: { satisfied: true },
      updatedAt: 20,
    };
    state.lanes["lane-api"]!.progress = { position: 99, total: 8 };
    state.lanes["lane-api"]!.activeStage = { socketId: "Socket-3", label: "Auto-Eval", transitionedAt: 19 };
    state.lanes["lane-ui"] = { ...state.lanes["lane-ui"]!, status: "running", progress: { position: -3, total: 4 }, updatedAt: 21 };
    state.phase = "awaiting_lanes";
    state.updatedAt = 21;

    const summary = summarizeParallelRun(state);
    expect(summary.counts).toEqual({ total: 2, queued: 0, running: 1, accepted: 1, failed: 0, interrupted: 0, completed: 1, barrierReached: 1 });
    expect(summary.barrier).toEqual({ phase: "waiting", reached: 1, total: 2 });
    expect(summary.lanes.map((lane) => lane.laneId)).toEqual(["lane-api", "lane-ui"]);
    expect(summary.lanes[0]).toMatchObject({
      attempt: 2,
      childCastId: "child-api",
      childSession: { artifactRoot: "/tmp/child-api/artifacts" },
      scope: { id: "scope-api", cwd: "/tmp/branch-api", exportNames: ["integration"] },
      output: '{"satisfied":true}',
      progress: { position: 8, total: 8 },
      activeStage: { socketId: "Socket-3", label: "Auto-Eval", transitionedAt: 19 },
    });
    expect(summary.lanes[1]!.progress).toEqual({ position: 0, total: 4 });
  });

  test("reports intrinsic barrier completion without exposing VCS conflict state", () => {
    const state = run();
    for (const lane of Object.values(state.lanes)) lane.status = "accepted";
    state.phase = "completed";
    state.fanInPhase = "accepted";

    const summary = summarizeParallelRun(state);
    expect(summary.counts).toMatchObject({ accepted: 2, completed: 2, barrierReached: 2 });
    expect(summary.barrier).toEqual({ phase: "accepted", reached: 2, total: 2 });
    expect(summary).not.toHaveProperty("baseline");
    expect(summary.counts).not.toHaveProperty("conflict");
  });
});
