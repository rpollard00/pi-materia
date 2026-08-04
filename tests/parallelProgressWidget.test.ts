import { describe, expect, test } from "bun:test";
import type { Component } from "@earendil-works/pi-tui";
import { createParallelRunState } from "../src/domain/parallelRun.js";
import type { MateriaParallelRunState } from "../src/types.js";
import {
  clearParallelProgressWidget,
  mountParallelProgressWidget,
  PARALLEL_PROGRESS_WIDGET_KEY,
  refreshParallelProgressWidget,
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

function harness() {
  let component: Component | undefined;
  let renders = 0;
  const calls: Array<{ key: string; content: unknown; options: unknown }> = [];
  const ctx = {
    ui: {
      setWidget: (key: string, content: unknown, options: unknown) => {
        calls.push({ key, content, options });
        if (typeof content === "function") {
          component = content(
            { requestRender: () => { renders += 1; } },
            { fg: (_color: string, text: string) => text },
          );
        } else if (content === undefined) component = undefined;
      },
    },
  } as any;
  return { ctx, calls, component: () => component, renders: () => renders };
}

describe("parallel progress widget lifecycle", () => {
  test("mounts below the editor and redraws immediately without capturing focus", () => {
    const ui = harness();
    const active = run("run-a");
    mountParallelProgressWidget(ui.ctx, active);

    expect(ui.calls[0]?.key).toBe(PARALLEL_PROGRESS_WIDGET_KEY);
    expect(ui.calls[0]?.options).toEqual({ placement: "belowEditor" });
    expect(ui.component()?.handleInput).toBeUndefined();

    active.lanes["lane-1"]!.progress.position = 3;
    expect(refreshParallelProgressWidget(active)).toBe(true);
    expect(ui.renders()).toBe(1);
    expect(ui.component()?.render(80)[0]).toContain("60% (3/5)");
    clearParallelProgressWidget(ui.ctx);
  });

  test("keeps a completed sibling visible while another lane runs", () => {
    const ui = harness();
    const active = run("run-siblings");
    mountParallelProgressWidget(ui.ctx, active);
    active.lanes["lane-1"]!.status = "accepted";
    active.lanes["lane-1"]!.progress.position = 5;
    active.lanes["lane-2"]!.status = "running";
    active.lanes["lane-2"]!.progress.position = 2;
    refreshParallelProgressWidget(active);

    const lines = ui.component()?.render(100) ?? [];
    expect(lines[0]).toContain("Completed");
    expect(lines[1]).toContain("20% (2/10) Running");
    clearParallelProgressWidget(ui.ctx);
  });

  test("clears on settlement and rejects stale ownership callbacks", () => {
    const ui = harness();
    const oldRun = run("run-old");
    const newRun = run("run-new");
    mountParallelProgressWidget(ui.ctx, oldRun);
    mountParallelProgressWidget(ui.ctx, newRun);

    oldRun.lanes["lane-1"]!.progress.position = 4;
    expect(refreshParallelProgressWidget(oldRun)).toBe(false);
    expect(ui.component()?.render(80)[0]).toContain("0% (0/5)");
    expect(clearParallelProgressWidget(ui.ctx, oldRun.runId)).toBe(false);

    newRun.phase = "completed";
    newRun.fanInPhase = "accepted";
    expect(refreshParallelProgressWidget(newRun)).toBe(true);
    expect(ui.component()).toBeUndefined();
    expect(ui.calls.at(-1)).toEqual({
      key: PARALLEL_PROGRESS_WIDGET_KEY,
      content: undefined,
      options: { placement: "belowEditor" },
    });
  });
});
