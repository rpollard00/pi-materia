import { describe, expect, test } from "bun:test";
import {
  appendParallelLaneDiagnostic,
  applyParallelTransitionToCastState,
  attachParallelRunToCastState,
  createParallelRunState,
  restartParallelLaneAttempt,
  transitionParallelRun,
} from "../src/runtime/parallelCoordinatorState.js";
import { listLatestCastStates, saveCastState } from "../src/infrastructure/castStateRepository.js";
import type { MateriaCastState, MateriaParallelConfigIdentity, MateriaParallelPlanIdentity, MateriaParallelQueueEntry } from "../src/types.js";

const planIdentity: MateriaParallelPlanIdentity = { version: 1, planId: "plan-1", workItemCount: 3 };
const configIdentity: MateriaParallelConfigIdentity = {
  configHash: "config-1",
  loopId: "build",
  maxConcurrency: 2,
};
const queue: MateriaParallelQueueEntry[] = [
  { laneId: "lane-api", name: "api", streamIndex: 0, workItemIndexes: [0, 2] },
  { laneId: "lane-ui", name: "ui", streamIndex: 1, workItemIndexes: [1] },
];

function run() {
  return createParallelRunState({
    parentCastId: "cast-1",
    loopId: "build",
    runId: "run-1",
    planIdentity,
    graphIdentity: { graphHash: "graph-1" },
    configIdentity,
    baseline: { commitId: "commit-0", changeId: "change-0" },
    queue,
    now: 100,
  });
}

describe("parallel coordinator durable state", () => {
  test("creates an ordered queued run with lane records", () => {
    const state = run();
    expect(state.queueOrder).toEqual(["lane-api", "lane-ui"]);
    expect(state.lanes["lane-api"]).toMatchObject({ status: "queued", queueIndex: 0, workItemIndexes: [0, 2], attempt: 1, updatedAt: 100 });
    expect(state.lanes["lane-ui"]).toMatchObject({ status: "queued", queueIndex: 1, workItemIndexes: [1] });
  });

  test("persists a child identity before the child session is available", () => {
    const started = transitionParallelRun(run(), {
      parentCastId: "cast-1", loopId: "build", runId: "run-1", laneId: "lane-api", attempt: 1,
      childCastId: "child-api", status: "running", timestamp: 110,
    });

    expect(started.applied).toBe(true);
    expect(started.state.lanes["lane-api"]?.childCastId).toBe("child-api");
    expect(transitionParallelRun(started.state, {
      parentCastId: "cast-1", loopId: "build", runId: "run-1", laneId: "lane-api", attempt: 1,
      childCastId: "child-other", lastEvent: { sequence: 1, type: "started", occurredAt: 111 },
    })).toMatchObject({ applied: false, reason: "child_mismatch" });
  });

  test("accepts a lane only with its current callback identity", () => {
    const state = run();
    const started = transitionParallelRun(state, {
      parentCastId: "cast-1", loopId: "build", runId: "run-1", laneId: "lane-api", attempt: 1,
      childCastId: "child-api", status: "running", timestamp: 110,
      childSession: { childCastId: "child-api", sessionPath: "/tmp/session", artifactRoot: "/tmp/artifacts", runDirectory: "/tmp/run" },
    });
    expect(started.applied).toBe(true);

    const accepted = transitionParallelRun(started.state, {
      parentCastId: "cast-1", loopId: "build", runId: "run-1", laneId: "lane-api", attempt: 1,
      childCastId: "child-api", status: "accepted", accepted: true, timestamp: 120,
    });
    expect(accepted.state.lanes["lane-api"]).toMatchObject({ status: "accepted" });
  });

  test("ignores stale callbacks after terminal state, newer attempts, or a newer cast", () => {
    const accepted = transitionParallelRun(transitionParallelRun(run(), {
      parentCastId: "cast-1", loopId: "build", runId: "run-1", laneId: "lane-api", attempt: 1,
      childCastId: "child-api", status: "running", timestamp: 110,
    }).state, {
      parentCastId: "cast-1", loopId: "build", runId: "run-1", laneId: "lane-api", attempt: 1,
      childCastId: "child-api", status: "accepted", timestamp: 120,
    }).state;

    expect(transitionParallelRun(accepted, {
      parentCastId: "cast-1", loopId: "build", runId: "run-1", laneId: "lane-api", attempt: 1,
      childCastId: "child-api", status: "running", timestamp: 130,
    })).toMatchObject({ applied: false, reason: "terminal_lane" });
    expect(transitionParallelRun(accepted, {
      parentCastId: "cast-1", loopId: "build", runId: "run-new", laneId: "lane-api", attempt: 1,
      childCastId: "child-api", status: "failed", timestamp: 130,
    })).toMatchObject({ applied: false, reason: "run_mismatch" });
  });

  test("attaches to a cast with running_parallel without mutating the source", () => {
    const runState = run();
    const cast = { castId: "cast-1", updatedAt: 1, awaitingResponse: true, socketState: "idle", parallelRuns: {} } as MateriaCastState;
    const attached = attachParallelRunToCastState(cast, runState);
    expect(cast.socketState).toBe("idle");
    expect(attached.socketState).toBe("running_parallel");
    expect(attached.parallelRuns?.build?.runId).toBe("run-1");
  });

  test("deduplicates progress by position and stage while retaining prelude transitions", () => {
    const started = transitionParallelRun(run(), {
      parentCastId: "cast-1", loopId: "build", runId: "run-1", laneId: "lane-api", attempt: 1,
      childCastId: "child-api", status: "running", timestamp: 110,
    });
    const prelude = transitionParallelRun(started.state, {
      parentCastId: "cast-1", loopId: "build", runId: "run-1", laneId: "lane-api", attempt: 1,
      childCastId: "child-api", progress: { position: 0, total: 4 },
      activeStage: { socketId: "Socket-1", label: "Spawn-JJ-Workspace", transitionedAt: 111 },
      lastEvent: { sequence: 1, type: "progress_checkpoint", occurredAt: 111 }, timestamp: 111,
    });
    expect(prelude.applied).toBe(true);
    const nextPrelude = transitionParallelRun(prelude.state, {
      parentCastId: "cast-1", loopId: "build", runId: "run-1", laneId: "lane-api", attempt: 1,
      childCastId: "child-api", progress: { position: 0, total: 4 },
      activeStage: { socketId: "Socket-2", label: "Build", transitionedAt: 112 },
      lastEvent: { sequence: 2, type: "progress_checkpoint", occurredAt: 112 }, timestamp: 112,
    });
    expect(nextPrelude).toMatchObject({ applied: true, state: { lanes: { "lane-api": { activeStage: { socketId: "Socket-2", label: "Build", transitionedAt: 112 } } } } });

    const duplicate = transitionParallelRun(nextPrelude.state, {
      parentCastId: "cast-1", loopId: "build", runId: "run-1", laneId: "lane-api", attempt: 1,
      childCastId: "child-api", progress: { position: 0, total: 4 },
      activeStage: { socketId: "Socket-2", label: "Build", transitionedAt: 113 },
      lastEvent: { sequence: 3, type: "progress_checkpoint", occurredAt: 113 }, timestamp: 113,
    });
    expect(duplicate).toMatchObject({ applied: false, reason: "progress_unchanged" });
    expect(nextPrelude.state.lanes["lane-api"]?.lastEvent?.sequence).toBe(2);
  });

  test("rejects malformed or stale stages and clears them for a new attempt", () => {
    const started = transitionParallelRun(run(), {
      parentCastId: "cast-1", loopId: "build", runId: "run-1", laneId: "lane-api", attempt: 1,
      childCastId: "child-api", status: "running", timestamp: 110,
    });
    const staged = transitionParallelRun(started.state, {
      parentCastId: "cast-1", loopId: "build", runId: "run-1", laneId: "lane-api", attempt: 1,
      childCastId: "child-api", progress: { position: 1, total: 4 },
      activeStage: { socketId: "Socket-2", label: "Build", transitionedAt: 120 },
      lastEvent: { sequence: 1, type: "progress_checkpoint", occurredAt: 120 }, timestamp: 120,
    });
    expect(transitionParallelRun(staged.state, {
      parentCastId: "cast-1", loopId: "build", runId: "run-1", laneId: "lane-api", attempt: 1,
      childCastId: "child-api", progress: { position: 2, total: 4 },
      activeStage: { socketId: "Socket-3", label: "Eval", transitionedAt: 119 },
      lastEvent: { sequence: 2, type: "progress_checkpoint", occurredAt: 119 }, timestamp: 119,
    })).toMatchObject({ applied: false, reason: "stage_regression" });
    expect(transitionParallelRun(staged.state, {
      parentCastId: "cast-1", loopId: "build", runId: "run-1", laneId: "lane-api", attempt: 1,
      childCastId: "child-api", activeStage: { socketId: "Socket-2", label: "x".repeat(81), transitionedAt: 121 },
      progress: { position: 2, total: 4 }, lastEvent: { sequence: 2, type: "progress_checkpoint", occurredAt: 121 }, timestamp: 121,
    })).toMatchObject({ applied: false, reason: "stage_invalid" });
    const failed = transitionParallelRun(staged.state, {
      parentCastId: "cast-1", loopId: "build", runId: "run-1", laneId: "lane-api", attempt: 1,
      childCastId: "child-api", status: "failed", timestamp: 130,
    });
    const restarted = restartParallelLaneAttempt(failed.state, {
      parentCastId: "cast-1", loopId: "build", runId: "run-1", laneId: "lane-api", attempt: 1,
      childCastId: "child-api", timestamp: 131,
    });
    expect(restarted.state.lanes["lane-api"]?.activeStage).toBeUndefined();
  });

  test("resets event sequencing when a failed lane starts a new attempt", () => {
    const failed = transitionParallelRun(run(), {
      parentCastId: "cast-1", loopId: "build", runId: "run-1", laneId: "lane-api", attempt: 1,
      childCastId: "child-api", status: "failed", lastEvent: { sequence: 9, type: "failed", occurredAt: 120 }, timestamp: 120,
    });
    expect(failed.applied).toBe(true);

    const restarted = restartParallelLaneAttempt(failed.state, {
      parentCastId: "cast-1", loopId: "build", runId: "run-1", laneId: "lane-api", attempt: 1,
      childCastId: "child-api", timestamp: 130,
    });
    expect(restarted.applied).toBe(true);
    expect(restarted.state.lanes["lane-api"]).toMatchObject({ status: "queued", attempt: 2 });
    expect(restarted.state.lanes["lane-api"]?.lastEvent).toBeUndefined();

    const firstNewAttemptEvent = transitionParallelRun(restarted.state, {
      parentCastId: "cast-1", loopId: "build", runId: "run-1", laneId: "lane-api", attempt: 2,
      childCastId: "child-api-retry", lastEvent: { sequence: 1, type: "started", occurredAt: 131 }, timestamp: 131,
    });
    expect(firstNewAttemptEvent).toMatchObject({ applied: true, state: { lanes: { "lane-api": { lastEvent: { sequence: 1 } } } } });
  });

  test("allows bounded late diagnostics without reopening a terminal lane", () => {
    const state = run();
    const updated = appendParallelLaneDiagnostic(state, {
      parentCastId: "cast-1", loopId: "build", runId: "run-1", laneId: "lane-api", attempt: 1,
      diagnostic: { code: "late", message: "child flushed telemetry", severity: "info", occurredAt: 130 },
    });
    expect(updated.applied).toBe(true);
    expect(updated.state.lanes["lane-api"]?.status).toBe("queued");
    expect(updated.state.lanes["lane-api"]?.diagnostics).toHaveLength(1);
    expect(updated.state.diagnostics).toHaveLength(1);
    expect(updated.state.diagnostics[0]?.code).toBe("late");
  });

  test("cast application rejects callbacks from a different cast", () => {
    const cast = { castId: "cast-new", updatedAt: 1, parallelRuns: { build: run() } } as MateriaCastState;
    const result = applyParallelTransitionToCastState(cast, {
      parentCastId: "cast-old", loopId: "build", runId: "run-1", laneId: "lane-api", attempt: 1,
      status: "running", timestamp: 2,
    });
    expect(result).toMatchObject({ applied: false, reason: "cast_mismatch" });
  });

  test("session persistence keeps parallel records and remains compatible with old casts", () => {
    const entries: unknown[] = [];
    const pi = { appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }) } as any;
    const ctx = { sessionManager: { getBranch: () => entries } } as any;
    const withParallel = { castId: "cast-1", version: 1, cwd: "/tmp", runDir: "/tmp/pi-materia-cast-1", updatedAt: 1, parallelRuns: { build: run() } } as unknown as MateriaCastState;
    saveCastState(pi, withParallel);
    saveCastState(pi, { castId: "old-cast", version: 1, cwd: "/tmp", runDir: "/tmp/pi-materia-old-cast", updatedAt: 2 } as unknown as MateriaCastState);

    const latest = listLatestCastStates(ctx);
    expect(latest.find((state) => state.castId === "cast-1")?.parallelRuns?.build?.lanes["lane-api"]?.workItemIndexes).toEqual([0, 2]);
    expect(latest.find((state) => state.castId === "old-cast")?.parallelRuns).toBeUndefined();
  });
});
