import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createParallelRunState } from "../src/domain/parallelRun.js";
import {
  renderMateriaCastStatusWidget,
  renderMateriaRunWidget,
} from "../src/presentation/materiaStatus.js";
import {
  clearWidgetTicker,
  syncConfiguredLoadoutWidget,
  updateWidget,
} from "../src/presentation/materiaWidget.js";
import type {
  MateriaCastState,
  MateriaRunState,
  UsageReport,
  UsageTotals,
} from "../src/types.js";
import { FakePiHarness } from "./fakePi.js";

function totals(tokens: number, cost: number): UsageTotals {
  return {
    tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens },
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function runState(overrides: Partial<MateriaRunState> = {}): MateriaRunState {
  return {
    runId: "2026-05-07T14-53-49-729Z",
    startedAt: 1_000,
    runDir: "/tmp/cast",
    eventsFile: "/tmp/cast/events.jsonl",
    usageFile: "/tmp/cast/usage.json",
    usage: totals(0, 0) as UsageReport,
    budgetWarned: false,
    ...overrides,
  };
}

function loopCastState(overrides: Partial<MateriaCastState> = {}): MateriaCastState {
  const run = runState({ loadoutName: "Hojo-Consult", currentSocketId: "Socket-2", currentMateria: "Auto-Eval", currentTask: "Implement status layout" });
  return {
    active: true,
    phase: "Socket-2",
    currentSocketId: "Socket-2",
    currentMateria: "Auto-Eval",
    currentItemLabel: "Implement status layout",
    awaitingResponse: true,
    startedAt: 1_000,
    updatedAt: 2_000,
    data: { workItems: [{ title: "one" }, { title: "two" }, { title: "three" }] },
    cursors: { workItemsIndex: 1 },
    visits: {},
    taskAttempts: {},
    edgeTraversals: {},
    runState: run,
    pipeline: {
      entry: {} as never,
      sockets: {
        "Socket-1": { id: "Socket-1", socket: { materia: "Build" }, materia: { tools: "coding", prompt: "", label: "Build" } },
        "Socket-2": { id: "Socket-2", socket: { materia: "Auto-Eval" }, materia: { tools: "readOnly", prompt: "", label: "Auto-Eval" } },
        "Socket-3": { id: "Socket-3", socket: { materia: "Maintain" }, materia: { tools: "coding", prompt: "", label: "Maintain" } },
      },
      loops: { itemLoop: { sockets: ["Socket-1", "Socket-2", "Socket-3"], iterator: { items: "state.workItems", cursor: "workItemsIndex" } } },
    },
    ...overrides,
  } as MateriaCastState;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "");
}

function parallelCastState(laneCount: number): { state: MateriaCastState; run: ReturnType<typeof createParallelRunState> } {
  const run = createParallelRunState({
    runId: `parallel-${laneCount}`,
    parentCastId: "cast-parallel",
    loopId: "parallelWork",
    planIdentity: { version: 1, planId: `plan-${laneCount}`, workItemCount: laneCount },
    graphIdentity: { graphHash: "graph" },
    configIdentity: { configHash: "config", loopId: "parallelWork", maxConcurrency: 3 },
    queue: Array.from({ length: laneCount }, (_, streamIndex) => ({
      laneId: `lane-${streamIndex}`,
      name: `Stream ${streamIndex}`,
      streamIndex,
      workItemIndexes: [streamIndex],
      progressTotal: 5,
    })),
    now: 1,
  });
  return {
    state: loopCastState({ active: true, parallelRuns: { parallelWork: run } }),
    run,
  };
}

describe("Materia status widget controller", () => {
  test("themes the persistent panel while preserving its plain visible rows", () => {
    const tokens: string[] = [];
    const harness = new FakePiHarness(process.cwd(), {
      theme: {
        fg: (token, text) => {
          tokens.push(token);
          return `\u001b[35m${text}\u001b[0m`;
        },
      },
    });
    const state = runState({
      endedAt: 2_000,
      loadoutName: "Review",
      currentMateria: "Build",
      currentTask: "Finished task",
      lastMessage: "completed",
    });
    const plain = renderMateriaRunWidget(state, 2_000);

    try {
      updateWidget(harness.ctx, state);
      const themed = harness.renderWidget("materia", 78) ?? [];
      expect(themed.map(stripAnsi)).toEqual(plain);
      expect(tokens).toEqual(expect.arrayContaining(["success", "warning", "muted", "dim", "text"]));
    } finally {
      clearWidgetTicker(harness.ctx);
    }
  });

  test("themes parallel rows through the shared widget while preserving plain rows", () => {
    const tokens: string[] = [];
    const harness = new FakePiHarness(process.cwd(), {
      theme: {
        fg: (token, text) => {
          tokens.push(token);
          return `\u001b[35m${text}\u001b[0m`;
        },
      },
    });
    const { state, run } = parallelCastState(5);
    run.phase = "dispatching";
    const statuses = ["running", "accepted", "queued", "failed", "interrupted"] as const;
    statuses.forEach((status, index) => {
      const current = run.lanes[`lane-${index}`]!;
      current.status = status;
      current.progress.position = 2;
      if (status === "running" || status === "failed" || status === "interrupted") {
        current.activeStage = {
          socketId: `Socket-${index}`,
          label: "Build",
          transitionedAt: index + 1,
        };
      }
    });
    state.runState.endedAt = 2_000;
    const plain = renderMateriaCastStatusWidget(state, 2_000);

    try {
      updateWidget(harness.ctx, state);
      const themed = harness.renderWidget("materia", 78) ?? [];
      expect(themed.map(stripAnsi)).toEqual(plain);
      expect(themed.every((line) => visibleWidth(line) <= 78)).toBe(true);
      expect(tokens).toEqual(expect.arrayContaining(["accent", "success", "muted", "dim", "error"]));
    } finally {
      clearWidgetTicker(harness.ctx);
    }
  });

  test("blinks only a running lane's active bar edge through the persistent themed widget", () => {
    const harness = new FakePiHarness(process.cwd(), {
      theme: {
        fg: (_token, text) => `\u001b[35m${text}\u001b[0m`,
      },
    });
    const cases = [
      { status: "running" as const, position: 2, total: 5, blinks: 1 },
      { status: "running" as const, position: 1, total: 19, blinks: 1 },
      { status: "running" as const, position: 5, total: 5, blinks: 1 },
      { status: "running" as const, position: 0, total: 5, blinks: 0 },
      { status: "queued" as const, position: 2, total: 5, blinks: 0 },
      { status: "accepted" as const, position: 5, total: 5, blinks: 0 },
      { status: "failed" as const, position: 2, total: 5, blinks: 0 },
      { status: "interrupted" as const, position: 2, total: 5, blinks: 0 },
    ];

    try {
      for (const { status, position, total, blinks } of cases) {
        const { state, run } = parallelCastState(1);
        run.phase = "dispatching";
        run.lanes["lane-0"]!.status = status;
        run.lanes["lane-0"]!.progress = { position, total };

        const plainRow = renderMateriaCastStatusWidget(state, 2_000).find((line) => line.includes("Stream 0"));
        updateWidget(harness.ctx, state);
        const themedRow = harness.renderWidget("materia", 78)?.find((line) => stripAnsi(line).includes("Stream 0"));

        expect(themedRow).toBeDefined();
        expect(stripAnsi(themedRow ?? "")).toBe(plainRow);
        expect(visibleWidth(themedRow ?? "")).toBeLessThanOrEqual(78);
        expect((themedRow?.match(/\u001b\[5m/g) ?? []).length).toBe(blinks);
      }
    } finally {
      clearWidgetTicker(harness.ctx);
    }
  });

  test("shared widget updates remove parallel rows at fan-in and terminal states", () => {
    const { state, run } = parallelCastState(2);
    run.phase = "dispatching";
    run.lanes["lane-0"]!.status = "running";
    const widgets: Array<{ key: string; value: string[] | undefined }> = [];
    const ctx = { ui: { setWidget: (key: string, value: string[] | undefined) => widgets.push({ key, value }) } } as any;

    try {
      const materiaWidgets = () => widgets.filter(({ key }) => key === "materia");
      const materiaWidget = () => materiaWidgets().at(-1)?.value;
      updateWidget(ctx, state);
      expect(materiaWidgets()).toHaveLength(1);
      expect(materiaWidget()).toHaveLength(6);
      expect(materiaWidget()?.[0]).toContain("⌘ Hojo-Consult ◉ Auto-Eval");
      expect(materiaWidget()?.join("\n")).toContain("Parallel slots:");

      run.phase = "awaiting_lanes";
      run.fanInPhase = "accepted";
      updateWidget(ctx, state);
      expect(materiaWidget()).toHaveLength(3);
      expect(materiaWidget()?.join("\n")).not.toContain("Parallel slots:");
      expect(materiaWidget()?.[2]).toContain("parallel");

      state.active = false;
      state.phase = "complete";
      state.socketState = "complete";
      state.runState.endedAt = 3_000;
      updateWidget(ctx, state);
      expect(materiaWidget()).toHaveLength(3);
      expect(materiaWidget()?.[2]).toContain("lanes:1,2");
      expect(materiaWidget()?.[2]).toContain("Auto-E…");
      expect(materiaWidget()?.join("\n")).not.toContain("Parallel slots:");
    } finally {
      clearWidgetTicker(ctx);
    }
  });

  test("rejects stale parallel cast updates through the shared widget owner", () => {
    const current = parallelCastState(2);
    current.state.castId = "current-cast";
    current.state.runState = {
      ...current.state.runState,
      runId: "current-run",
      currentMateria: "Build",
      lastMessage: "current cast",
    };
    current.state.currentMateria = "Build";
    current.state.currentItemLabel = "current parallel work";
    current.run.phase = "dispatching";
    current.run.lanes["lane-0"]!.status = "running";

    const stale = parallelCastState(2);
    stale.state.castId = "stale-cast";
    stale.state.runState = {
      ...stale.state.runState,
      runId: "stale-run",
      endedAt: 1_000,
      currentMateria: "Interactive-Plan",
      lastMessage: "stale cast",
    };
    stale.state.currentMateria = "Interactive-Plan";
    stale.state.currentItemLabel = "stale parallel work";
    stale.run.phase = "dispatching";
    stale.run.lanes["lane-0"]!.status = "running";
    stale.run.lanes["lane-0"]!.progress.position = 5;

    const widgets: Array<{ key: string; value: string[] | undefined }> = [];
    const ctx = { ui: { setWidget: (key: string, value: string[] | undefined) => widgets.push({ key, value }) } } as any;

    try {
      updateWidget(ctx, current.state);
      const accepted = widgets.filter(({ key }) => key === "materia").at(-1)?.value;
      expect(accepted?.join("\n")).toContain("⌘ Hojo-Consult ◉ Build");
      expect(accepted?.join("\n")).toContain("current parallel work");
      expect(accepted?.join("\n")).toContain("Parallel slots:");

      updateWidget(ctx, stale.state);

      expect(widgets.filter(({ key }) => key === "materia")).toHaveLength(1);
      expect(widgets.filter(({ key }) => key === "materia").at(-1)?.value).toBe(accepted);
      expect(widgets.at(-1)?.value?.join("\n")).toContain("current parallel work");
      expect(widgets.at(-1)?.value?.join("\n")).not.toContain("stale parallel work");
    } finally {
      clearWidgetTicker(ctx);
    }
  });

  test("a live run from another cast takes over the widget owner", () => {
    const widgets: Array<{ key: string; value: string[] | undefined }> = [];
    const ctx = { ui: { setWidget: (key: string, value: string[] | undefined) => widgets.push({ key, value }) } } as any;

    try {
      const done = runState({ runId: "cast-a", endedAt: 11_000, currentMateria: "Build", lastMessage: "done a" });
      updateWidget(ctx, done);
      expect(widgets.at(-1)?.value?.join("\n")).toContain("done a");

      const next = runState({ runId: "cast-b", currentMateria: "Review", lastMessage: "running b" });
      updateWidget(ctx, next);
      const text = widgets.at(-1)?.value?.join("\n") ?? "";
      expect(text).toContain("running b");
      expect(text).not.toContain("done a");

      const staleTerminal = runState({ runId: "cast-a", endedAt: 12_000, currentMateria: "Build", lastMessage: "late a" });
      updateWidget(ctx, staleTerminal);
      expect(widgets.at(-1)?.value?.join("\n")).toContain("running b");
    } finally {
      clearWidgetTicker(ctx);
    }
  });
});

describe("persistent Materia widget ticker ownership", () => {
  test("stale ticker callbacks cannot restore an older same-session cast snapshot", () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const intervals: Array<{ handle: { id: number; unref: () => void }; cleared: boolean; fn: () => void }> = [];
    let nextId = 1;
    (globalThis as any).setInterval = (fn: () => void) => {
      const handle = { id: nextId++, unref: () => undefined };
      intervals.push({ handle, cleared: false, fn });
      return handle;
    };
    (globalThis as any).clearInterval = (handle: { id: number }) => {
      const interval = intervals.find((entry) => entry.handle.id === handle.id);
      if (interval) interval.cleared = true;
    };

    const widgets: Array<{ key: string; value: string[] | undefined }> = [];
    const makeCtx = () => ({
      sessionManager: { getSessionFile: () => "/tmp/stable-session.jsonl", getSessionId: () => "stable-session" },
      ui: { setWidget: (key: string, value: string[] | undefined) => widgets.push({ key, value }) },
    }) as any;
    const run = runState({ runId: "same-run", loadoutName: "Hojo", attempt: 1 });
    const earlier = loopCastState({
      castId: "cast-1",
      currentSocketId: "Socket-1",
      currentMateria: "Interactive-Plan",
      currentItemLabel: "FEATURE: More granular tool availability",
      phase: "Socket-1",
      updatedAt: 1_000,
      runState: { ...run, currentSocketId: "Socket-1", currentMateria: "Interactive-Plan", currentTask: "FEATURE: More granular tool availability" },
    });
    const later = loopCastState({
      castId: "cast-1",
      currentSocketId: "Socket-1",
      currentMateria: "Build",
      currentItemLabel: "Map and normalize current materia widget state",
      phase: "Socket-1",
      updatedAt: 2_000,
      runState: { ...run, currentSocketId: "Socket-1", currentMateria: "Build", currentTask: "Map and normalize current materia widget state" },
    });

    try {
      const firstCtx = makeCtx();
      updateWidget(firstCtx, earlier);
      const staleTick = intervals[0].fn;
      expect(widgets.at(-1)?.value?.join("\n")).toContain("Interactive-Plan");

      const secondCtx = makeCtx();
      updateWidget(secondCtx, later);
      expect(widgets.at(-1)?.value?.join("\n")).toContain("Build");

      staleTick();
      const text = widgets.at(-1)?.value?.join("\n") ?? "";
      expect(text).toContain("Build");
      expect(text).not.toContain("Interactive-Plan");
      expect(intervals.filter((interval) => !interval.cleared)).toHaveLength(1);
    } finally {
      clearWidgetTicker(makeCtx());
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  test("keys widget ownership by stable session id across context instances", () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const intervals: Array<{ handle: { id: number; unref: () => void }; cleared: boolean }> = [];
    let nextId = 1;
    (globalThis as any).setInterval = () => {
      const handle = { id: nextId++, unref: () => undefined };
      intervals.push({ handle, cleared: false });
      return handle;
    };
    (globalThis as any).clearInterval = (handle: { id: number }) => {
      const interval = intervals.find((entry) => entry.handle.id === handle.id);
      if (interval) interval.cleared = true;
    };

    const widgets: Array<{ key: string; value: string[] | undefined }> = [];
    const makeCtx = () => ({
      sessionManager: { getSessionId: () => "stable-session-id" },
      ui: { setWidget: (key: string, value: string[] | undefined) => widgets.push({ key, value }) },
    }) as any;

    try {
      updateWidget(makeCtx(), runState({ runId: "stable-run", currentMateria: "Build", lastMessage: "first context" }));
      updateWidget(makeCtx(), runState({ runId: "stable-run", currentMateria: "Review", lastMessage: "second context" }));

      expect(intervals.filter((interval) => !interval.cleared)).toHaveLength(1);
      expect(widgets.at(-1)?.value?.join("\n")).toContain("second context");

      updateWidget(makeCtx(), runState({ runId: "stable-run", endedAt: 11_000, currentMateria: "Review", lastMessage: "terminal" }));
      expect(intervals.filter((interval) => !interval.cleared)).toHaveLength(0);
    } finally {
      clearWidgetTicker(makeCtx());
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  test("ignores older same-run cast freshness updates", () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    (globalThis as any).setInterval = () => ({ unref: () => undefined });
    (globalThis as any).clearInterval = () => undefined;

    const widgets: Array<{ key: string; value: string[] | undefined }> = [];
    const ctx = {
      sessionManager: { getSessionFile: () => "/tmp/freshness-session.jsonl", getSessionId: () => "freshness-session" },
      ui: { setWidget: (key: string, value: string[] | undefined) => widgets.push({ key, value }) },
    } as any;
    const run = runState({ runId: "same-run", loadoutName: "Hojo", attempt: 1 });
    const newer = loopCastState({
      castId: "cast-1",
      currentMateria: "Build",
      currentItemLabel: "newer Build work",
      updatedAt: 5_000,
      runState: { ...run, currentMateria: "Build", currentTask: "newer Build work" },
    });
    const older = loopCastState({
      castId: "cast-1",
      currentMateria: "Interactive-Plan",
      currentItemLabel: "older planning work",
      updatedAt: 4_000,
      runState: { ...run, currentMateria: "Interactive-Plan", currentTask: "older planning work" },
    });

    try {
      updateWidget(ctx, newer);
      const acceptedText = widgets.at(-1)?.value?.join("\n") ?? "";
      expect(acceptedText).toContain("Build");

      updateWidget(ctx, older);
      expect(widgets.at(-1)?.value?.join("\n")).toBe(acceptedText);
      expect(widgets.at(-1)?.value?.join("\n")).not.toContain("Interactive-Plan");
    } finally {
      clearWidgetTicker(ctx);
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  test("uses run updatedAt freshness when cast updatedAt is unavailable", () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    (globalThis as any).setInterval = () => ({ unref: () => undefined });
    (globalThis as any).clearInterval = () => undefined;

    const widgets: Array<{ key: string; value: string[] | undefined }> = [];
    const ctx = {
      sessionManager: { getSessionId: () => "run-freshness-session" },
      ui: { setWidget: (key: string, value: string[] | undefined) => widgets.push({ key, value }) },
    } as any;
    const run = runState({ runId: "same-run", loadoutName: "Hojo", currentMateria: "Build", currentTask: "initial", attempt: 1 });
    const current = loopCastState({
      castId: "cast-without-updated-at",
      updatedAt: undefined as never,
      currentMateria: "Build",
      currentItemLabel: "newer run metadata",
      runState: { ...run, updatedAt: "1970-01-01T00:00:05.000Z", currentTask: "newer run metadata" } as MateriaRunState,
    });
    const stale = loopCastState({
      castId: "cast-without-updated-at",
      updatedAt: undefined as never,
      currentMateria: "Interactive-Plan",
      currentItemLabel: "older run metadata",
      runState: { ...run, updatedAt: 4_000, currentMateria: "Interactive-Plan", currentTask: "older run metadata" } as MateriaRunState,
    });
    const newer = loopCastState({
      castId: "cast-without-updated-at",
      updatedAt: undefined as never,
      currentMateria: "Maintain",
      currentItemLabel: "newest run metadata",
      runState: { ...run, updatedAt: new Date(6_000), currentMateria: "Maintain", currentTask: "newest run metadata" } as MateriaRunState,
    });

    try {
      updateWidget(ctx, current);
      const acceptedText = widgets.at(-1)?.value?.join("\n") ?? "";
      expect(acceptedText).toContain("newer run metadata");

      updateWidget(ctx, stale);
      expect(widgets.at(-1)?.value?.join("\n")).toBe(acceptedText);
      expect(widgets.at(-1)?.value?.join("\n")).not.toContain("older run metadata");

      updateWidget(ctx, newer);
      expect(widgets.at(-1)?.value?.join("\n")).toContain("newest run metadata");
    } finally {
      clearWidgetTicker(ctx);
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  test("does not let missing freshness overwrite a timestamped same-run widget", () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    (globalThis as any).setInterval = () => ({ unref: () => undefined });
    (globalThis as any).clearInterval = () => undefined;

    const widgets: Array<{ key: string; value: string[] | undefined }> = [];
    const ctx = {
      sessionManager: { getSessionId: () => "missing-freshness-session" },
      ui: { setWidget: (key: string, value: string[] | undefined) => widgets.push({ key, value }) },
    } as any;
    const timestamped = runState({ runId: "same-run", startedAt: 1_000, currentMateria: "Build", lastMessage: "timestamped current" });
    const missingFreshness = { ...timestamped, startedAt: Number.NaN, currentMateria: "Interactive-Plan", lastMessage: "missing freshness stale" };

    try {
      updateWidget(ctx, timestamped);
      const acceptedText = widgets.at(-1)?.value?.join("\n") ?? "";
      expect(acceptedText).toContain("timestamped current");

      updateWidget(ctx, missingFreshness);
      expect(widgets.at(-1)?.value?.join("\n")).toBe(acceptedText);
      expect(widgets.at(-1)?.value?.join("\n")).not.toContain("missing freshness stale");
    } finally {
      clearWidgetTicker(ctx);
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  test("replaces prior terminal status when a new active cast becomes current", () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const intervals: Array<{ handle: { id: number; unref: () => void }; cleared: boolean }> = [];
    let nextId = 1;
    (globalThis as any).setInterval = () => {
      const handle = { id: nextId++, unref: () => undefined };
      intervals.push({ handle, cleared: false });
      return handle;
    };
    (globalThis as any).clearInterval = (handle: { id: number }) => {
      const interval = intervals.find((entry) => entry.handle.id === handle.id);
      if (interval) interval.cleared = true;
    };

    const widgets: Array<{ key: string; value: string[] | undefined }> = [];
    const ctx = { ui: { setWidget: (key: string, value: string[] | undefined) => widgets.push({ key, value }) } } as any;

    try {
      updateWidget(ctx, runState({ runId: "old-cast", endedAt: 11_000, currentMateria: "Build", lastMessage: "old terminal status" }));
      expect(widgets.at(-1)?.value?.join("\n")).toContain("old terminal status");
      expect(intervals.filter((interval) => !interval.cleared)).toHaveLength(0);

      updateWidget(ctx, runState({ runId: "new-cast", currentMateria: "Review", lastMessage: "new active status" }));
      const activeWidget = widgets.at(-1)?.value?.join("\n") ?? "";
      expect(activeWidget).toContain("new active status");
      expect(activeWidget).not.toContain("old terminal status");
      expect(intervals.filter((interval) => !interval.cleared)).toHaveLength(1);

      updateWidget(ctx, runState({ runId: "old-cast", endedAt: 11_000, currentMateria: "Build", lastMessage: "late old terminal status" }));
      expect(widgets.at(-1)?.value?.join("\n")).toBe(activeWidget);
    } finally {
      clearWidgetTicker(ctx);
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  test("renders rich loop-aware cast state through the normal widget update path", () => {
    const widgets: Array<{ key: string; value: string[] | undefined }> = [];
    const ctx = { ui: { setWidget: (key: string, value: string[] | undefined) => widgets.push({ key, value }) } } as any;

    updateWidget(ctx, loopCastState());
    const text = widgets.at(-1)?.value?.join("\n") ?? "";
    expect(text).toContain("⌘ Hojo-Consult ◉ Auto-Eval");
    expect(text).toContain("↻ 2/3");
    expect(text).toContain("⟲ Build -> [Auto-Eval] -> Maintain");

    clearWidgetTicker(ctx);
  });

  test("uses one current-cast ticker, ignores stale updates, and stops on terminal render", () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const intervals: Array<{ handle: { id: number; unref: () => void }; cleared: boolean; fn: () => void }> = [];
    let nextId = 1;
    (globalThis as any).setInterval = (fn: () => void) => {
      const handle = { id: nextId++, unref: () => undefined };
      intervals.push({ handle, cleared: false, fn });
      return handle;
    };
    (globalThis as any).clearInterval = (handle: { id: number }) => {
      const interval = intervals.find((entry) => entry.handle.id === handle.id);
      if (interval) interval.cleared = true;
    };

    const widgets: Array<{ key: string; value: string[] | undefined }> = [];
    const ctx = { ui: { setWidget: (key: string, value: string[] | undefined) => widgets.push({ key, value }) } } as any;

    try {
      const first = runState({ runId: "cast-a", currentMateria: "Build", lastMessage: "running a" });
      updateWidget(ctx, first);
      updateWidget(ctx, { ...first, lastMessage: "still running a" });
      expect(intervals.filter((interval) => !interval.cleared)).toHaveLength(1);

      updateWidget(ctx, runState({ runId: "cast-b", endedAt: 9_000, currentMateria: "Build", lastMessage: "stale b" }));
      expect(widgets.at(-1)?.value?.join("\n")).toContain("still running a");

      const second = runState({ runId: "cast-b", currentMateria: "Review", lastMessage: "running b" });
      updateWidget(ctx, second);
      expect(intervals.filter((interval) => !interval.cleared)).toHaveLength(1);
      expect(widgets.at(-1)?.value?.join("\n")).toContain("running b");

      const terminal = { ...second, endedAt: 11_000, lastMessage: "done b" };
      updateWidget(ctx, terminal);
      expect(intervals.filter((interval) => !interval.cleared)).toHaveLength(0);
      expect(widgets.at(-1)?.value?.join("\n")).toContain("◷ 10s");

      updateWidget(ctx, { ...first, endedAt: 11_000, lastMessage: "late a" });
      expect(widgets.at(-1)?.value?.join("\n")).toContain("done b");
      updateWidget(ctx, terminal);
      expect(intervals.filter((interval) => !interval.cleared)).toHaveLength(0);
    } finally {
      clearWidgetTicker(ctx);
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  test("syncs configured loadout into terminal widget but not an active cast widget", () => {
    const widgets: Array<{ key: string; value: string[] | undefined }> = [];
    const ctx = { ui: { setWidget: (key: string, value: string[] | undefined) => widgets.push({ key, value }) } } as any;

    updateWidget(ctx, runState({ runId: "cast-a", loadoutName: "Build", endedAt: 11_000, currentMateria: "Build", lastMessage: "done" }));
    expect(syncConfiguredLoadoutWidget(ctx, "Review")).toBe(true);
    expect(widgets.at(-1)?.value?.[0]).toContain("⌘ Review");

    updateWidget(ctx, runState({ runId: "cast-b", loadoutName: "Build", currentMateria: "Build", lastMessage: "running" }));
    expect(syncConfiguredLoadoutWidget(ctx, "Review")).toBe(false);
    expect(widgets.at(-1)?.value?.[0]).toContain("⌘ Build");

    clearWidgetTicker(ctx);
  });

  test("syncs configured loadout into a fresh materia widget when no widget owner exists", () => {
    const widgets: Array<{ key: string; value: string[] | undefined }> = [];
    const ctx = { ui: { setWidget: (key: string, value: string[] | undefined) => widgets.push({ key, value }) } } as any;

    expect(syncConfiguredLoadoutWidget(ctx, "Audit")).toBe(true);
    expect(widgets.at(-1)).toMatchObject({ key: "materia" });
    expect(widgets.at(-1)?.value?.[0]).toContain("⌘ Audit");
  });
});
