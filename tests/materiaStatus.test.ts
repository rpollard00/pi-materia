import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createParallelRunState } from "../src/domain/parallelRun.js";
import { recoveryIdentityKey } from "../src/application/recoveryPolicy.js";
import {
  formatParallelRunCompactStatus,
  renderConfiguredLoadoutWidget,
  renderMateriaCastStatusWidget,
  renderMateriaRunWidget,
} from "../src/presentation/materiaStatus.js";
import {
  summarizeParallelRun,
  type ParallelRunMonitorSummary,
} from "../src/application/parallelMonitoring.js";
import type { MateriaCastState, MateriaRunState, UsageReport, UsageTotals } from "../src/types.js";

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

describe("Materia status widget formatting", () => {
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

  test("hides parallel detail rows once fan-in starts", () => {
    const { state, run } = parallelCastState(2);
    run.phase = "awaiting_lanes";
    run.fanInPhase = "accepted";

    expect(renderMateriaCastStatusWidget(state, 2_000)).toHaveLength(3);
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

  test("includes stable lane numbers in the compact status after acceptance and revival attempts", () => {
    const { run } = parallelCastState(2);
    run.lanes["lane-0"]!.status = "accepted";
    run.lanes["lane-1"]!.status = "failed";
    run.lanes["lane-1"]!.attempt = 3;
    const summary = summarizeParallelRun(run);

    expect(formatParallelRunCompactStatus(summary)).toContain("lanes:1,2");
    expect(formatParallelRunCompactStatus(summary)).not.toContain("lane-0");
    expect(summary.lanes.map((lane) => [lane.queueIndex, lane.attempt])).toEqual([[0, 1], [1, 3]]);
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

describe("Materia status widget retry budget", () => {
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
