import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createParallelRunState } from "../src/domain/parallelRun.js";
import { recoveryIdentityKey } from "../src/application/recoveryPolicy.js";
import { publishActiveLoadoutChange } from "../src/presentation/activeLoadoutEvents.js";
import { createMateriaSemanticTheme } from "../src/presentation/theme.js";
import { renderLoadoutListThemed, updateMateriaLoadoutWidget } from "../src/presentation/loadoutWidget.js";
import { clearWidgetTicker, formatCostLabel, formatParallelRunCompactStatus, formatUsage, renderCompactUsageWidget, renderConfiguredLoadoutWidget, renderMateriaCastStatusWidget, renderMateriaRunWidget, renderUsageSummary, showUsageSummary, syncConfiguredLoadoutWidget, updateWidget } from "../src/presentation/ui.js";
import type { ParallelRunMonitorSummary } from "../src/application/parallelMonitoring.js";
import type { MateriaCastState, MateriaRunState, UsageReport, UsageTotals } from "../src/types.js";
import { FakePiHarness } from "./fakePi.js";

function totals(tokens: number, cost: number): UsageTotals {
  return {
    tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens },
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function costFromLine(line: string): number {
  const match = line.match(/\$(\d+\.\d{4})/);
  if (!match) throw new Error(`missing cost in line: ${line}`);
  return Number(match[1]);
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

describe("persistent Materia widget formatting", () => {
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

  test("renders compact active cast details in at most four lines", () => {
    const state: MateriaRunState = {
      runId: "2026-05-07T14-53-49-729Z",
      startedAt: 1_000,
      runDir: "/tmp/cast",
      eventsFile: "/tmp/cast/events.jsonl",
      usageFile: "/tmp/cast/usage.json",
      currentSocketId: "planner",
      currentMateria: "Interactive Planning Consult With A Very Long Name",
      currentTask: "task-123 - Implement a very long task title that should not be allowed to wrap across the terminal widget",
      attempt: 2,
      lastMessage: "Multi-turn planner waiting for refinement; run /materia continue to finalize.",
      usage: { ...totals(0, 0), tokens: { input: 19381, output: 2100, cacheRead: 4000, cacheWrite: 10, total: 25491 } },
      budgetWarned: false,
    };

    const lines = renderMateriaRunWidget(state, 70_000);
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("✦ active");
    expect(lines[0]).not.toContain("2026-05-07");
    expect(lines[0]).toContain("⌘ - ◉ Interactive Planning");
    expect(lines[0]).toContain("↻ 2");
    expect(lines[0]).toContain("◷ 1m09s");
    expect(lines[0]).toContain("Σ 23k/2.1k");
    expect(lines[1]).toContain("◆ task-123");
    expect(lines[1]).toContain("⟲ -");
    expect(lines[2]).toContain("› Multi-turn Interactive Planning");
    expect(lines.every((line) => line.length <= 78)).toBe(true);
  });

  test("renders persisted loadout metadata when available", () => {
    const state = runState({ loadoutName: "Yolo", currentMateria: "Build" });

    const lines = renderMateriaRunWidget(state, 2_000);
    expect(lines[0]).toContain("⌘ Yolo");
  });

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
      updateWidget(harness.ctx, state, { replaceOwner: true });
      const themed = harness.renderWidget("materia", 78) ?? [];
      expect(themed.map(stripAnsi)).toEqual(plain);
      expect(tokens).toEqual(expect.arrayContaining(["success", "warning", "muted", "dim", "text"]));
    } finally {
      clearWidgetTicker(harness.ctx);
    }
  });

  test("themes the persistent loadout widget while preserving its plain list", () => {
    const calls: Array<[string, string]> = [];
    const harness = new FakePiHarness(process.cwd(), {
      theme: {
        fg: (token, text) => {
          calls.push([token, text]);
          return `\u001b[35m${text}\u001b[0m`;
        },
      },
    });
    const config = {
      activeLoadout: "Build",
      materia: {},
      loadouts: {
        Build: {} as never,
        Review: {} as never,
        Maintain: {} as never,
      },
    };
    const plain = ["⌘ Build (Build*, Review, Maintain)"];

    updateMateriaLoadoutWidget(harness.ctx, config, "test");
    const themed = harness.renderWidget("materia-loadouts", 200) ?? [];

    expect(themed.map(stripAnsi)).toEqual(plain);
    expect(renderLoadoutListThemed(config, createMateriaSemanticTheme(undefined))).toEqual(plain);
    expect(themed.every((line) => visibleWidth(line) <= 200)).toBe(true);
    expect(calls).toEqual(expect.arrayContaining([
      ["accent", "⌘"],
      ["accent", "Build"],
      ["success", "Build"],
      ["success", "*"],
      ["muted", "Review"],
    ]));
  });

  test("themes command and WebUI loadout changes without changing event payloads", () => {
    for (const source of ["command", "webui"] as const) {
      const calls: string[] = [];
      const harness = new FakePiHarness(process.cwd(), {
        theme: {
          fg: (token, text) => {
            calls.push(token);
            return `\u001b[35m${text}\u001b[0m`;
          },
        },
      });
      const config = {
        activeLoadout: "Build",
        materia: {},
        loadouts: {
          Build: {} as never,
          Review: {} as never,
        },
      };
      const result = publishActiveLoadoutChange(harness.pi, harness.ctx, {
        source,
        loaded: { config, source: "test-config" },
      });

      expect(result.event).toMatchObject({ source, activeLoadout: "Build", loadouts: ["Build", "Review"] });
      expect(harness.renderWidget("materia-loadouts", 200)?.map(stripAnsi)).toEqual(result.lines);
      expect(harness.appendedEntries.at(-1)).toMatchObject({
        customType: "pi-materia-active-loadout-changed",
        data: { source, activeLoadout: "Build" },
      });
      expect(calls).toEqual(expect.arrayContaining(["accent", "success", "muted"]));
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
      updateWidget(harness.ctx, state, { replaceOwner: true });
      const themed = harness.renderWidget("materia", 78) ?? [];
      expect(themed.map(stripAnsi)).toEqual(plain);
      expect(themed.every((line) => visibleWidth(line) <= 78)).toBe(true);
      expect(tokens).toEqual(expect.arrayContaining(["accent", "success", "muted", "dim", "error"]));
    } finally {
      clearWidgetTicker(harness.ctx);
    }
  });

  test("renders configured loadout when no cast widget is active", () => {
    const lines = renderConfiguredLoadoutWidget("Review");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("⌘ Review");
    expect(lines.join("\n")).toContain("no active cast");
    // Intentional omissions: the permanent widget already communicates the configured
    // loadout compactly, so do not re-add duplicate Loadout or Available lines here.
    expect(lines.join("\n")).not.toContain("Loadout:");
    expect(lines.join("\n")).not.toContain("Available:");
  });

  test("renders active single-materia cast details without permanent-panel duplication", () => {
    const run = runState({
      loadoutName: "Hojo-Consult",
      currentSocketId: "Socket-5",
      currentMateria: "Maintain",
      currentTask: "Remove unused WebUI unsocket drop panel",
      attempt: 2,
      usage: { ...totals(0, 0), tokens: { input: 205_000, output: 9_700, cacheRead: 0, cacheWrite: 0, total: 214_700 } },
    });
    const state = {
      active: true,
      phase: "Socket-5",
      currentSocketId: "Socket-5",
      currentMateria: "Maintain",
      currentItemLabel: "Remove unused WebUI unsocket drop panel",
      awaitingResponse: true,
      runState: run,
    } as MateriaCastState;

    const lines = renderMateriaCastStatusWidget(state, 9_638_000);
    const text = lines.join("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("✦ active");
    expect(lines[0]).toContain("⌘ Hojo-Consult ◉ Maintain");
    expect(lines[0]).toContain("↻ 2");
    expect(lines[0]).toContain("◷ 2h40m");
    expect(lines[0]).toContain("Σ 205k/9.7k");
    expect(lines[1]).toContain("◆ Remove unused WebUI");
    expect(lines[1]).toContain("⟲ -");
    expect(text).not.toContain("Loadout:");
    expect(text).not.toContain("Available:");
    expect(text.match(/Maintain/g)?.length ?? 0).toBeLessThanOrEqual(3);
  });

  test("prefers work item titles over legacy model-authored ids in cast labels", () => {
    const run = runState({
      loadoutName: "Hojo-Consult",
      currentSocketId: "Socket-5",
      currentMateria: "Build",
      currentTask: "WI-7 - legacy fallback label",
    });
    const state = {
      active: true,
      phase: "Socket-5",
      currentSocketId: "Socket-5",
      currentMateria: "Build",
      currentItemKey: "WI-1",
      currentItemLabel: "Implement title/context validation",
      awaitingResponse: true,
      runState: run,
    } as MateriaCastState;

    const text = renderMateriaCastStatusWidget(state, 2_000).join("\n");
    expect(text).toContain("Implement title/context");
    expect(text).not.toContain("WI-7");
    expect(text).not.toContain("WI-1");
  });

  test("renders legacy run state without loadout or endedAt metadata sensibly", () => {
    const legacyState = runState({ currentMateria: "Build", currentTask: "legacy task" });
    delete (legacyState as Partial<MateriaRunState>).loadoutName;
    delete (legacyState as Partial<MateriaRunState>).endedAt;

    const lines = renderMateriaRunWidget(legacyState, 2_000);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("⌘ -");
    expect(lines[0]).toContain("◷ 1s");
    expect(lines.join("\n")).toContain("legacy task");
  });

  test("keeps stable first-line field positions when work item and status text are long", () => {
    const stableState = runState({
      loadoutName: "BuildLoadout",
      currentMateria: "Build",
      currentTask: "short task",
      lastMessage: "short status",
      attempt: 3,
    });
    const dynamicState = runState({
      ...stableState,
      currentTask: "work item ".repeat(40),
      lastMessage: "status update ".repeat(40),
    });

    const stableLines = renderMateriaRunWidget(stableState, 2_000);
    const dynamicLines = renderMateriaRunWidget(dynamicState, 2_000);
    for (const marker of ["✦", "⌘", "↻", "⟳", "◷", "Σ"]) {
      expect(dynamicLines[0].indexOf(marker)).toBe(stableLines[0].indexOf(marker));
    }
    expect(dynamicLines).toHaveLength(stableLines.length);
    expect(dynamicLines.every((line) => line.length <= 78)).toBe(true);
  });

  test("keeps stable first-line field positions when cast status text is long", () => {
    const run = runState({ loadoutName: "Review", currentMateria: "Build", currentTask: "task", attempt: 1 });
    const shortStatus = { active: true, phase: "Build", currentMateria: "Build", awaitingResponse: true, runState: run } as MateriaCastState;
    const longStatus = { ...shortStatus, failedReason: "very long terminal status ".repeat(30) } as MateriaCastState;

    const shortLines = renderMateriaCastStatusWidget(shortStatus, 2_000);
    const longLines = renderMateriaCastStatusWidget(longStatus, 2_000);
    for (const marker of ["✦", "⌘", "↻", "⟳", "◷", "Σ"]) {
      expect(longLines[0].indexOf(marker)).toBe(shortLines[0].indexOf(marker));
    }
    expect(longLines).toHaveLength(3);
    expect(longLines.every((line) => line.length <= 78)).toBe(true);
  });

  test("freezes elapsed time when terminal endedAt metadata is present", () => {
    const state = runState({ endedAt: 11_000 });

    const lines = renderMateriaRunWidget(state, 999_000);
    expect(lines[0]).toContain("◷ 10s");
  });

  test("prefers Materia names over Socket IDs in user-facing status values", () => {
    const state = runState({
      currentSocketId: "Socket-3",
      currentMateria: "Build",
      currentTask: "Socket-3",
      attempt: 1,
      lastMessage: "Socket-3",
    });

    const lines = renderMateriaRunWidget(state, 2_000);
    expect(lines[0]).toContain("◉ Build");
    expect(lines[1]).toContain("◆ Build");
    expect(lines[2]).toContain("› Build");
    expect(lines.join("\n")).not.toContain("Socket-3");
  });

  test("falls back to Socket IDs when current Materia is unavailable", () => {
    const state = runState({
      currentSocketId: "Socket-3",
      currentTask: "Socket-3",
      attempt: 1,
      lastMessage: "Socket-3",
    });

    const lines = renderMateriaRunWidget(state, 2_000);
    expect(lines[0]).toContain("◉ Socket-3");
    expect(lines[1]).toContain("◆ Socket-3");
    expect(lines[2]).toContain("› Socket-3");
  });

  test("renders cast status third line with status icon and Materia wording", () => {
    const run = runState({ currentSocketId: "Socket-4", currentMateria: "Build", lastMessage: "Socket-4" });
    const state = {
      active: true,
      phase: "Socket-4",
      currentSocketId: "Socket-4",
      currentMateria: "Build",
      awaitingResponse: true,
      runState: run,
    } as MateriaCastState;

    const lines = renderMateriaCastStatusWidget(state, 2_000);
    expect(lines[0]).toContain("⌘ - ◉ Build");
    expect(lines[2]).toBe("› Build active");
    expect(lines[2]).not.toContain("Last");
    expect(lines[2]).not.toContain("Socket-4");
  });

  test("renders loop turn and active loop path when loop metadata is available", () => {
    const lines = renderMateriaCastStatusWidget(loopCastState(), 2_000);
    expect(lines[0]).toContain("⌘ Hojo-Consult ◉ Auto-Eval");
    expect(lines[0]).toContain("↻ 2/3");
    expect(lines[1]).toContain("◆ Implement status layout");
    expect(lines[1]).toContain("⟲ Build -> [Auto-Eval] -> Maintain");
    expect(lines.join("\n")).not.toContain("2026-05-07");
  });

  test("renders loop turn with unknown total when loop items cannot be resolved", () => {
    const state = loopCastState({ data: {}, cursors: { workItemsIndex: 0 } });
    const lines = renderMateriaCastStatusWidget(state, 2_000);
    expect(lines[0]).toContain("↻ 1/?");
    expect(lines[1]).toContain("⟲ Build -> [Auto-Eval] -> Maintain");
  });

  test("renders rich cast status with partial metadata through the shared widget shape", () => {
    const run = runState({ loadoutName: "Review", currentTask: undefined, currentMateria: undefined, lastMessage: undefined });
    const state = {
      active: false,
      phase: "complete",
      awaitingResponse: false,
      socketState: "complete",
      runState: run,
    } as MateriaCastState;

    const lines = renderMateriaCastStatusWidget(state, 2_000);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("⌘ Review");
    expect(lines[1]).toContain("◆ -");
    expect(lines[1]).toContain("⟲ -");
    expect(lines[2]).toBe("› complete");
    expect(lines.every((line) => line.length <= 78)).toBe(true);
  });

  test("renders resumed cast state with the same compact ordering as basic run state", () => {
    const run = runState({ loadoutName: "Review", currentSocketId: "Socket-7", currentMateria: "Build", currentTask: "Validate resumed cast", attempt: 4 });
    const resumed = {
      active: true,
      phase: "Socket-7",
      currentSocketId: "Socket-7",
      currentMateria: "Build",
      currentItemLabel: "Validate resumed cast",
      awaitingResponse: false,
      socketState: "idle",
      runState: run,
    } as MateriaCastState;

    const basicLines = renderMateriaRunWidget(run, 2_000);
    const richLines = renderMateriaCastStatusWidget(resumed, 2_000);
    for (const marker of ["✦", "⌘", "↻", "⟳", "◷", "Σ"]) {
      expect(richLines[0].indexOf(marker)).toBe(basicLines[0].indexOf(marker));
    }
    expect(richLines[0]).toContain("⌘ Review ◉ Build");
    expect(richLines[1]).toContain("◆ Validate resumed cast");
    expect(richLines[1]).toContain("⟲ -");
    expect(richLines[2]).toBe("› Build active");
  });

  test("keeps missing current materia fallback understandable in rich cast status", () => {
    const run = runState({ loadoutName: "Review", currentSocketId: "Socket-9", currentMateria: undefined, currentTask: undefined, lastMessage: undefined });
    const state = {
      active: true,
      phase: "Socket-9",
      currentSocketId: "Socket-9",
      awaitingResponse: true,
      runState: run,
    } as MateriaCastState;

    const lines = renderMateriaCastStatusWidget(state, 2_000);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("⌘ Review ◉ Socket-9");
    expect(lines[1]).toContain("◆ -");
    expect(lines[1]).toContain("⟲ -");
    expect(lines[2]).toBe("› Socket-9 active");
    expect(lines.join("\n")).not.toContain("undefined");
  });

  test("appends live parallel rows to the shared Materia panel in schedule order", () => {
    const { state, run } = parallelCastState(3);
    run.queueOrder.reverse();
    run.lanes["lane-0"]!.status = "running";
    run.lanes["lane-0"]!.progress.position = 2;
    run.lanes["lane-0"]!.activeStage = { socketId: "Socket-1", label: "Spawn-JJ-Workspace", transitionedAt: 2 };
    run.lanes["lane-1"]!.status = "accepted";
    run.lanes["lane-1"]!.progress.position = 5;

    const lines = renderMateriaCastStatusWidget(state, 2_000);
    expect(lines).toHaveLength(7);
    expect(lines[3]).toContain("Parallel slots: 1/3 running");
    expect(lines[4]).toContain("Stream 0");
    expect(lines[4]).toContain("Spawn-JJ-Workspace");
    expect(lines[5]).toContain("Stream 1");
    expect(lines[5]).toContain("Completed");
    expect(lines[6]).toContain("Stream 2");
    expect(lines.every((line) => visibleWidth(line) <= 78)).toBe(true);
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
        updateWidget(harness.ctx, state, { replaceOwner: true });
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

  test("hides parallel detail rows once fan-in starts", () => {
    const { state, run } = parallelCastState(2);
    run.phase = "awaiting_lanes";
    run.fanInPhase = "accepted";

    expect(renderMateriaCastStatusWidget(state, 2_000)).toHaveLength(3);
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
      updateWidget(ctx, state, { replaceOwner: true });
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
      expect(materiaWidget()?.[2]).toContain("Auto-Eval");
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
      updateWidget(ctx, current.state, { replaceOwner: true });
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

  test("caps the shared panel at ten lines with a deterministic overflow row", () => {
    const { state, run } = parallelCastState(8);
    run.queueOrder.reverse();

    const first = renderMateriaCastStatusWidget(state, 2_000);
    const second = renderMateriaCastStatusWidget(state, 2_000);
    expect(first).toEqual(second);
    expect(first).toHaveLength(10);
    expect(first.at(-1)).toBe("… 3 more parallel lanes");
    expect(first.every((line) => visibleWidth(line) <= 78)).toBe(true);
  });

  test("renders all aggregate parallel lane counters in compact status", () => {
    const summary = {
      version: 1,
      loopId: "build",
      runId: "run-1",
      phase: "awaiting_lanes",
      fanInPhase: "not_started",
      planId: "plan-1",
      maxConcurrency: 2,
      counts: { total: 5, queued: 1, running: 1, accepted: 1, failed: 1, interrupted: 1, completed: 3, barrierReached: 3 },
      barrier: { phase: "waiting", reached: 3, total: 5 },
      lanes: [],
      updatedAt: 1,
    } satisfies ParallelRunMonitorSummary;
    expect(formatParallelRunCompactStatus(summary)).toBe("parallel build q1 r1 a1 f1 i1 barrier:waiting 3/5");
  });

  test("renders compact completion usage without billing disclaimers", () => {
    const lines = renderCompactUsageWidget(totals(19381, 0.0497));
    expect(lines).toEqual(["Usage total 19k tokens"]);
    expect(lines.join("\n")).not.toContain("estimated token value");
    expect(lines.join("\n")).not.toContain("billing");
    expect(lines.join("\n")).not.toContain("\u001b[");
  });

  test("themes the persistent usage widget without changing wording or placement", () => {
    const calls: Array<[string, string]> = [];
    const harness = new FakePiHarness(process.cwd(), {
      theme: {
        fg: (token, text) => {
          calls.push([token, text]);
          return `\u001b[35m${text}\u001b[0m`;
        },
      },
    });
    const usage = totals(19381, 0.0497) as UsageReport;
    const state = runState({ usage });

    showUsageSummary(harness.ctx, state);

    const themed = harness.renderWidget("materia-usage", 200) ?? [];
    expect(themed.map(stripAnsi)).toEqual(renderCompactUsageWidget(usage));
    expect(harness.widgets.get("materia-usage")?.options).toEqual({ placement: "belowEditor" });
    expect(calls).toEqual([
      ["muted", "Usage total"],
      ["accent", "19k"],
      ["dim", "tokens"],
    ]);

    const narrow = harness.renderWidget("materia-usage", 8) ?? [];
    expect(narrow).toHaveLength(1);
    expect(visibleWidth(narrow[0] ?? "")).toBeLessThanOrEqual(8);
  });

  test("truncates long persistent widget values instead of emitting extra lines", () => {
    const state: MateriaRunState = {
      runId: "2026-05-07T14-53-49-729Z-extra-long-cast-id-that-keeps-going",
      startedAt: 0,
      runDir: "/tmp/cast",
      eventsFile: "/tmp/cast/events.jsonl",
      usageFile: "/tmp/cast/usage.json",
      currentMateria: "M".repeat(200),
      currentTask: "T".repeat(200),
      attempt: 1,
      lastMessage: "L".repeat(300),
      usage: { ...totals(0, 0), tokens: { input: 1_234_567, output: 98_765, cacheRead: 0, cacheWrite: 0, total: 1_333_332 } },
      budgetWarned: false,
    };

    const lines = renderMateriaRunWidget(state, 1_000);
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.length <= 78)).toBe(true);
    expect(lines.join("\n")).not.toContain("estimated token value");
  });
});

describe("persistent Materia widget retry budget", () => {
  function recoveryLoopCastState(
    allowance: { effectiveMax: number; originalMax?: number; reviveCount?: number },
    attempts: number,
  ): MateriaCastState {
    const base = loopCastState();
    const key = recoveryIdentityKey(base);
    return {
      ...base,
      recoveryAllowances: {
        [key]: {
          originalMaxAttempts: allowance.originalMax ?? allowance.effectiveMax,
          effectiveMaxAttempts: allowance.effectiveMax,
          reviveCount: allowance.reviveCount ?? 0,
        },
      },
      recoveryAttempts: { [key]: attempts },
    };
  }

  test("renders same-socket recovery budget as ⟳ current/max on the compact first line", () => {
    const first = renderMateriaCastStatusWidget(recoveryLoopCastState({ effectiveMax: 3 }, 0), 2_000);
    const second = renderMateriaCastStatusWidget(recoveryLoopCastState({ effectiveMax: 3 }, 1), 2_000);
    const third = renderMateriaCastStatusWidget(recoveryLoopCastState({ effectiveMax: 3 }, 2), 2_000);

    expect(first[0]).toContain("⟳ 1/3");
    expect(second[0]).toContain("⟳ 2/3");
    expect(third[0]).toContain("⟳ 3/3");
    for (const lines of [first, second, third]) {
      expect(lines.every((line) => line.length <= 78)).toBe(true);
    }
  });

  test("reflects a revived effective max in the retry budget denominator", () => {
    // Original 3-attempt budget exhausted, then /materia revive raised the effective max to 6.
    const lines = renderMateriaCastStatusWidget(
      recoveryLoopCastState({ effectiveMax: 6, originalMax: 3, reviveCount: 1 }, 3),
      2_000,
    );
    expect(lines[0]).toContain("⟳ 4/6");
    expect(lines[0]).not.toContain("⟳ 4/3");
    expect(lines.every((line) => line.length <= 78)).toBe(true);
  });

  test("shows ⟳ - on the first line when no retry budget is available", () => {
    const lines = renderMateriaCastStatusWidget(loopCastState(), 2_000);
    expect(lines[0]).toContain("⟳ -");
    expect(lines.every((line) => line.length <= 78)).toBe(true);
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
      updateWidget(firstCtx, earlier, { replaceOwner: true });
      const staleTick = intervals[0].fn;
      expect(widgets.at(-1)?.value?.join("\n")).toContain("Interactive-Plan");

      const secondCtx = makeCtx();
      updateWidget(secondCtx, later, { replaceOwner: true });
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
      updateWidget(makeCtx(), runState({ runId: "stable-run", currentMateria: "Build", lastMessage: "first context" }), { replaceOwner: true });
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
      updateWidget(ctx, newer, { replaceOwner: true });
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
      updateWidget(ctx, current, { replaceOwner: true });
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
      updateWidget(ctx, timestamped, { replaceOwner: true });
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
      updateWidget(ctx, runState({ runId: "old-cast", endedAt: 11_000, currentMateria: "Build", lastMessage: "old terminal status" }), { replaceOwner: true });
      expect(widgets.at(-1)?.value?.join("\n")).toContain("old terminal status");
      expect(intervals.filter((interval) => !interval.cleared)).toHaveLength(0);

      updateWidget(ctx, runState({ runId: "new-cast", currentMateria: "Review", lastMessage: "new active status" }), { replaceOwner: true });
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

    updateWidget(ctx, loopCastState(), { replaceOwner: true });
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
      updateWidget(ctx, first, { replaceOwner: true });
      updateWidget(ctx, { ...first, lastMessage: "still running a" });
      expect(intervals.filter((interval) => !interval.cleared)).toHaveLength(1);

      updateWidget(ctx, runState({ runId: "cast-b", currentMateria: "Build", lastMessage: "stale b" }));
      expect(widgets.at(-1)?.value?.join("\n")).toContain("still running a");

      const second = runState({ runId: "cast-b", currentMateria: "Review", lastMessage: "running b" });
      updateWidget(ctx, second, { replaceOwner: true });
      expect(intervals.filter((interval) => !interval.cleared)).toHaveLength(1);
      expect(widgets.at(-1)?.value?.join("\n")).toContain("running b");

      const terminal = { ...second, endedAt: 11_000, lastMessage: "done b" };
      updateWidget(ctx, terminal);
      expect(intervals.filter((interval) => !interval.cleared)).toHaveLength(0);
      expect(widgets.at(-1)?.value?.join("\n")).toContain("◷ 10s");

      updateWidget(ctx, { ...first, lastMessage: "late a" });
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

    updateWidget(ctx, runState({ runId: "cast-a", loadoutName: "Build", endedAt: 11_000, currentMateria: "Build", lastMessage: "done" }), { replaceOwner: true });
    expect(syncConfiguredLoadoutWidget(ctx, "Review")).toBe(true);
    expect(widgets.at(-1)?.value?.[0]).toContain("⌘ Review");

    updateWidget(ctx, runState({ runId: "cast-b", loadoutName: "Build", currentMateria: "Build", lastMessage: "running" }), { replaceOwner: true });
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

describe("usage UI formatting", () => {
  test("labels actual costs as billed cost", () => {
    expect(formatUsage(totals(10, 0.1234), "actual")).toBe("10 tokens, billed cost: $0.1234");
    expect(formatCostLabel(0.1234, "actual")).toBe("billed cost: $0.1234");
  });

  test("labels estimated costs as estimated USD value", () => {
    expect(formatUsage(totals(20, 0.2345), "estimated")).toBe("20 tokens, estimated USD value: $0.2345");
  });

  test("labels subscription costs as no per-token billing", () => {
    expect(formatUsage(totals(30, 0), "subscription")).toBe("30 tokens, no per-token billing (subscription)");
    expect(formatUsage(totals(30, 0.3456), "subscription")).toBe("30 tokens, estimated token value: $0.3456 (subscription; no per-token billing implied)");
  });

  test("renders Codex subscription summaries without implying token charges", () => {
    const usage: UsageReport = {
      ...totals(100, 0.4567),
      provider: "openai-codex",
      model: "openai-codex/gpt-5.5",
      costKind: "subscription",
      byMateria: { Build: totals(100, 0.4567) },
      bySocket: {},
      byTask: {},
      byAttempt: {},
    };

    expect(renderUsageSummary(usage)).toEqual([
      "Materia Usage Summary",
      "Cost display: estimated token value only; subscription usage is not billed per token.",
      "total: 100 tokens, estimated token value: $0.4567 (subscription; no per-token billing implied)",
      "",
      "By materia:",
      "- Build: 100 tokens, estimated token value: $0.4567 (subscription; no per-token billing implied)",
      "",
      "By socket:",
      "- none observed",
      "",
      "By task:",
      "- none observed",
    ]);
  });

  test("renders aggregation breakdowns consistently with the displayed total", () => {
    const usage: UsageReport = {
      tokens: { input: 312737, output: 0, cacheRead: 0, cacheWrite: 0, total: 312737 },
      cost: { input: 0.5316, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5316 },
      costKind: "actual",
      byMateria: {
        Maintain: totals(167153, 0.1287),
        Build: totals(97629, 0.2148),
        "Auto-Eval": totals(45545, 0.1537),
        planner: totals(2410, 0.0344),
      },
      bySocket: {
        Maintain: totals(167153, 0.1287),
        Build: totals(97629, 0.2148),
        "Auto-Eval": totals(45545, 0.1537),
        planner: totals(2410, 0.0344),
      },
      byTask: {
        "task-1": totals(167153, 0.1287),
        "task-4": totals(143174, 0.3685),
        "task-0": totals(2410, 0.0344),
      },
      byAttempt: {},
    };

    const lines = renderUsageSummary(usage);
    expect(lines).toContain("total: 312737 tokens, billed cost: $0.5316");
    expect(lines).toContain("- Maintain: 167153 tokens, billed cost: $0.1287");
    expect(lines).toContain("- Build: 97629 tokens, billed cost: $0.2148");
    expect(lines).toContain("- Auto-Eval: 45545 tokens, billed cost: $0.1537");
    expect(lines).toContain("- planner: 2410 tokens, billed cost: $0.0344");
    expect(lines).toContain("- task-4: 143174 tokens, billed cost: $0.3685");

    const total = costFromLine(lines.find((line) => line.startsWith("total:")) ?? "");
    const materiaLines = lines.slice(lines.indexOf("By materia:") + 1, lines.indexOf("By socket:"));
    const socketLines = lines.slice(lines.indexOf("By socket:") + 1, lines.indexOf("By task:"));
    const taskLines = lines.slice(lines.indexOf("By task:") + 1);
    expect(materiaLines.filter((line) => line.startsWith("-")).reduce((sum, line) => sum + costFromLine(line), 0)).toBeCloseTo(total, 10);
    expect(socketLines.filter((line) => line.startsWith("-")).reduce((sum, line) => sum + costFromLine(line), 0)).toBeCloseTo(total, 10);
    expect(taskLines.filter((line) => line.startsWith("-")).reduce((sum, line) => sum + costFromLine(line), 0)).toBeCloseTo(total, 10);
  });

  test("renders an empty by-socket breakdown without hiding total or materia costs", () => {
    const usage: UsageReport = {
      ...totals(42, 0.1234),
      costKind: "actual",
      byMateria: { Build: totals(42, 0.1234) },
      bySocket: {},
      byTask: { "task-4": totals(42, 0.1234) },
      byAttempt: {},
    };

    expect(renderUsageSummary(usage)).toEqual([
      "Materia Usage Summary",
      "Cost display: billed USD cost.",
      "total: 42 tokens, billed cost: $0.1234",
      "",
      "By materia:",
      "- Build: 42 tokens, billed cost: $0.1234",
      "",
      "By socket:",
      "- none observed",
      "",
      "By task:",
      "- task-4: 42 tokens, billed cost: $0.1234",
    ]);
  });
});
