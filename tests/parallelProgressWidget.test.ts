import { describe, expect, test } from "bun:test";
import { createParallelRunState } from "../src/domain/parallelRun.js";
import type { MateriaParallelRunState } from "../src/types.js";
import {
  clearParallelProgressWidget,
  mountParallelProgressWidget,
  PARALLEL_PROGRESS_WIDGET_KEY,
  refreshParallelProgressWidget,
  syncParallelProgressWidgetFromCast,
} from "../src/presentation/parallelProgressWidget.js";

function run(runId: string): MateriaParallelRunState {
  return createParallelRunState({
    runId,
    parentCastId: `cast-${runId}`,
    loopId: "parallelWork",
    planIdentity: { version: 1, planId: `plan-${runId}`, workItemCount: 2 },
    graphIdentity: { graphHash: "graph" },
    configIdentity: { configHash: "config", loopId: "parallelWork", maxConcurrency: 2 },
    queue: [
      { laneId: "lane-1", name: "Stream 1", streamIndex: 0, workItemIndexes: [0], progressTotal: 5 },
      { laneId: "lane-2", name: "Stream 2", streamIndex: 1, workItemIndexes: [1], progressTotal: 10 },
    ],
    now: 1,
  });
}

let nextSessionFile = 1;

function harness() {
  const calls: Array<{ key: string; content: string[] | undefined; options: unknown }> = [];
  const sessionFile = `/tmp/parallel-progress-${nextSessionFile++}.jsonl`;
  const ctx = {
    sessionManager: { getSessionFile: () => sessionFile },
    ui: {
      setWidget: (key: string, content: string[] | undefined, options: unknown) => {
        calls.push({ key, content, options });
      },
    },
  } as any;
  return { ctx, calls, rows: () => calls.at(-1)?.content };
}

describe("parallel progress widget lifecycle", () => {
  test("publishes initial visible rows below the editor and owns redraw through setWidget", () => {
    const ui = harness();
    const active = run("run-a");
    mountParallelProgressWidget(ui.ctx, active);

    expect(ui.calls[0]?.key).toBe(PARALLEL_PROGRESS_WIDGET_KEY);
    expect(ui.calls[0]?.options).toEqual({ placement: "belowEditor" });
    expect(ui.rows()).toHaveLength(3);
    expect(ui.rows()?.[0]).toContain("Parallel slots: 0/2 running");
    expect(ui.rows()?.[1]).toContain("0% (0/5) Queued");
    clearParallelProgressWidget(ui.ctx);
  });

  test("publishes live updates and rewinds as fresh rows", () => {
    const ui = harness();
    const active = run("run-rewind");
    mountParallelProgressWidget(ui.ctx, active);

    active.lanes["lane-1"]!.status = "running";
    active.lanes["lane-1"]!.progress.position = 3;
    expect(refreshParallelProgressWidget(active)).toBe(true);
    expect(ui.rows()?.[0]).toContain("Parallel slots: 1/2 running");
    expect(ui.rows()?.[1]).toContain("60% (3/5) Running");

    active.lanes["lane-1"]!.progress.position = 1;
    expect(refreshParallelProgressWidget(active)).toBe(true);
    expect(ui.rows()?.[0]).toContain("Parallel slots: 1/2 running");
    expect(ui.rows()?.[1]).toContain("20% (1/5) Running");
    expect(ui.calls).toHaveLength(3);
    clearParallelProgressWidget(ui.ctx);
  });

  test("refreshes concurrent lane stages while retaining the last failed stage", () => {
    const ui = harness();
    const active = run("run-stages");
    mountParallelProgressWidget(ui.ctx, active);

    active.lanes["lane-1"]!.status = "running";
    active.lanes["lane-1"]!.activeStage = { socketId: "Socket-1", label: "Spawn-JJ-Workspace", transitionedAt: 2 };
    active.lanes["lane-2"]!.status = "running";
    active.lanes["lane-2"]!.activeStage = { socketId: "Socket-2", label: "Build", transitionedAt: 3 };
    expect(refreshParallelProgressWidget(active)).toBe(true);
    expect(ui.rows()?.[0]).toContain("Parallel slots: 2/2 running");
    expect(ui.rows()?.[1]).toContain("Spawn-JJ-Workspace");
    expect(ui.rows()?.[2]).toContain("Build");

    active.lanes["lane-1"]!.status = "failed";
    active.lanes["lane-1"]!.failureReason = "fixture failure";
    active.lanes["lane-2"]!.activeStage = { socketId: "Socket-3", label: "Auto-Eval", transitionedAt: 4 };
    expect(refreshParallelProgressWidget(active)).toBe(true);
    expect(ui.rows()?.[0]).toContain("Parallel slots: 1/2 running");
    expect(ui.rows()?.[1]).toContain("Spawn-JJ-Workspace");
    expect(ui.rows()?.[1]).toContain("Failed");
    expect(ui.rows()?.[2]).toContain("Auto-Eval");
    clearParallelProgressWidget(ui.ctx);
  });

  test("retains completed siblings while another lane runs and remains visible in awaiting_lanes", () => {
    const ui = harness();
    const active = run("run-siblings");
    mountParallelProgressWidget(ui.ctx, active);
    active.lanes["lane-1"]!.status = "accepted";
    active.lanes["lane-1"]!.progress.position = 5;
    active.lanes["lane-2"]!.status = "running";
    active.lanes["lane-2"]!.progress.position = 2;
    expect(refreshParallelProgressWidget(active)).toBe(true);
    expect(ui.rows()?.[0]).toContain("Parallel slots: 1/2 running");
    expect(ui.rows()?.[1]).toContain("Completed");
    expect(ui.rows()?.[2]).toContain("20% (2/10) Running");

    active.phase = "awaiting_lanes";
    expect(refreshParallelProgressWidget(active)).toBe(true);
    expect(ui.rows()?.[0]).toContain("Parallel slots: 1/2 running");
    expect(ui.rows()?.[1]).toContain("Completed");
    expect(ui.rows()?.[2]).toContain("Running");
    clearParallelProgressWidget(ui.ctx);
  });

  test("restores a live run from cast state on session start", () => {
    const ui = harness();
    const active = run("run-restored");
    syncParallelProgressWidgetFromCast(ui.ctx, {
      active: true,
      socketState: "running_parallel",
      parallelRuns: { parallelWork: active },
    } as any);

    expect(ui.rows()).toHaveLength(3);
    expect(ui.rows()?.[0]).toContain("Parallel slots: 0/2 running");
    expect(ui.rows()?.[1]).toContain("Stream 1");

    syncParallelProgressWidgetFromCast(ui.ctx, {
      active: false,
      phase: "failed",
      socketState: "failed",
      parallelRuns: { parallelWork: active },
    } as any);
    expect(ui.rows()).toBeUndefined();
  });

  test("replaces ownership and rejects stale callbacks from superseded runs", () => {
    const ui = harness();
    const oldRun = run("run-old");
    const newRun = run("run-new");
    mountParallelProgressWidget(ui.ctx, oldRun);
    mountParallelProgressWidget(ui.ctx, newRun);

    oldRun.lanes["lane-1"]!.progress.position = 4;
    expect(refreshParallelProgressWidget(oldRun)).toBe(false);
    expect(ui.rows()?.[0]).toContain("Parallel slots: 0/2 running");
    expect(ui.rows()?.[1]).toContain("0% (0/5)");
    expect(clearParallelProgressWidget(ui.ctx, oldRun.runId)).toBe(false);

    newRun.phase = "completed";
    newRun.fanInPhase = "accepted";
    expect(refreshParallelProgressWidget(newRun)).toBe(true);
    expect(ui.rows()).toBeUndefined();
    expect(ui.calls.at(-1)).toEqual({
      key: PARALLEL_PROGRESS_WIDGET_KEY,
      content: undefined,
      options: { placement: "belowEditor" },
    });
  });
});
