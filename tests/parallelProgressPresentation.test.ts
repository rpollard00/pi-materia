import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ParallelLaneMonitorSummary } from "../src/application/parallelMonitoring.js";
import { createMateriaSemanticTheme } from "../src/presentation/theme.js";
import {
  formatParallelProgress,
  formatParallelProgressRows,
} from "../src/presentation/parallelProgress.js";

type Lane = Pick<ParallelLaneMonitorSummary, "laneId" | "name" | "streamIndex" | "queueIndex" | "status" | "progress" | "activeStage">;

function lane(overrides: Partial<Lane> = {}): Lane {
  return {
    laneId: "lane-1",
    name: "Stream 1",
    streamIndex: 0,
    queueIndex: 0,
    status: "running",
    progress: { position: 3, total: 5 },
    ...overrides,
  };
}

describe("parallel progress presentation", () => {
  test("renders normalized schedule order with bounded proportional bars", () => {
    const lines = formatParallelProgress([
      lane({ laneId: "late", name: "Stream 3", streamIndex: 2, queueIndex: 0, progress: { position: 2, total: 10 } }),
      lane({ laneId: "first", name: "Stream 1", streamIndex: 0, queueIndex: 2, progress: { position: 3, total: 5 } }),
      lane({ laneId: "middle", name: "Stream 2", streamIndex: 1, queueIndex: 1, progress: { position: 1, total: 3 } }),
    ], 80);

    expect(lines.map((line) => line.match(/Stream \d/)?.[0])).toEqual(["Stream 1", "Stream 2", "Stream 3"]);
    expect(lines[0]).toContain("60% (3/5) Running");
    expect(lines[1]).toContain("33% (1/3) Running");
    expect(lines[2]).toContain("20% (2/10) Running");
    expect(lines[0]?.match(/^\[([^\]]*)\]/)?.[1]).toBe("||||||||||||        ");
  });

  test("truncates long stream names and keeps every ANSI-styled line within terminal width", () => {
    const widths = [1, 8, 24, 42, 100];
    const input = [lane({ name: "A very long named stream with 日本語 output", status: "failed" })];
    const style = (text: string) => `\u001b[35m${text}\u001b[0m`;

    for (const width of widths) {
      const [line] = formatParallelProgress(input, width, { style });
      expect(line).not.toBe("");
      expect(visibleWidth(line ?? "")).toBeLessThanOrEqual(width);
    }

    const [moderate] = formatParallelProgress(input, 42);
    expect(moderate).toContain("…");
    expect(moderate).toContain("60% (3/5) Failed");
  });

  test("publishes visible, sanitized string rows for the host widget path", () => {
    const rows = formatParallelProgressRows([
      lane({ name: "Unsafe\n\u001b[31m stream", status: "interrupted" }),
    ], 64);

    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toBe("");
    expect(visibleWidth(rows[0] ?? "")).toBeGreaterThan(0);
    expect(visibleWidth(rows[0] ?? "")).toBeLessThanOrEqual(64);
    expect(rows[0]).not.toContain("\u001b[31m");
    expect(rows[0]).toContain("Interrupted");
  });

  test("shows queued, running, and terminal labels while retaining completed siblings", () => {
    const lines = formatParallelProgress([
      lane({ laneId: "done", name: "Done", streamIndex: 0, status: "accepted", progress: { position: 5, total: 5 } }),
      lane({ laneId: "active", name: "Active", streamIndex: 1, status: "running", progress: { position: 2, total: 5 } }),
      lane({ laneId: "queued", name: "Waiting", streamIndex: 2, status: "queued", progress: { position: 0, total: 5 } }),
      lane({ laneId: "failed", name: "Broken", streamIndex: 3, status: "failed" }),
      lane({ laneId: "stopped", name: "Stopped", streamIndex: 4, status: "interrupted" }),
    ], 100);

    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("100% (5/5) Completed");
    expect(lines[1]).toContain("40% (2/5) Running");
    expect(lines[2]).toContain("0% (0/5) Queued");
    expect(lines[3]).toContain("Failed");
    expect(lines[4]).toContain("Interrupted");
  });

  test("renders zero totals and reflects rewinds without monotonic presentation state", () => {
    const zero = lane({ progress: { position: 0, total: 0 }, status: "queued" });
    expect(formatParallelProgressRows([zero], 80)[0]).toContain("0% (0/0) Queued");

    const forward = lane({ progress: { position: 4, total: 5 } });
    expect(formatParallelProgressRows([forward], 80)[0]).toContain("80% (4/5)");
    const rewind = lane({ progress: { position: 1, total: 5 } });
    expect(formatParallelProgressRows([rewind], 80)[0]).toContain("20% (1/5)");
  });

  test("shows running slots and validated stages without labeling completion as active", () => {
    const prelude = lane({
      status: "running",
      activeStage: { socketId: "Socket-1", label: "Spawn-JJ-Workspace", transitionedAt: 1 },
    });
    const build = lane({
      laneId: "lane-2",
      name: "Stream 2",
      streamIndex: 1,
      status: "running",
      activeStage: { socketId: "Socket-2", label: "Build", transitionedAt: 2 },
    });
    const failed = lane({
      laneId: "lane-3",
      name: "Stream 3",
      streamIndex: 2,
      status: "failed",
      activeStage: { socketId: "Socket-3", label: "Auto-Eval", transitionedAt: 3 },
    });
    const completed = lane({
      laneId: "lane-4",
      name: "Stream 4",
      streamIndex: 3,
      status: "accepted",
      activeStage: { socketId: "Socket-4", label: "Blackbelt-Maintain", transitionedAt: 4 },
    });

    const rows = formatParallelProgressRows({ lanes: [build, prelude, failed, completed], maxConcurrency: 2 }, 100);
    expect(rows[0]).toContain("Parallel slots: 2/2 running");
    expect(rows[1]).toContain("Spawn-JJ-Workspace");
    expect(rows[2]).toContain("Build");
    expect(rows[3]).toContain("Auto-Eval");
    expect(rows[4]).toContain("Completed");
    expect(rows[4]).not.toContain("Blackbelt-Maintain");
  });

  test("keeps aggregate and stage rows within narrow ANSI-safe widths", () => {
    const stage = lane({
      activeStage: { socketId: "Socket-2", label: "Build\n\u001b[31m with a long label", transitionedAt: 1 },
    });
    const style = (text: string) => `\u001b[35m${text}\u001b[0m`;
    for (const width of [1, 8, 18, 32]) {
      const rows = formatParallelProgressRows([stage], width, { maxConcurrency: 1, style });
      expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
      expect(rows.every((row) => row.length > 0)).toBe(true);
    }
  });

  test("maps every lane state and bar segment to semantic theme roles", () => {
    const calls: Array<[string, string]> = [];
    const theme = createMateriaSemanticTheme({
      fg: (token, text) => {
        calls.push([token, text]);
        return `\u001b[35m${text}\u001b[0m`;
      },
    });
    const states = ["queued", "running", "accepted", "failed", "interrupted"] as const;
    const rows = formatParallelProgress(
      states.map((status, streamIndex) => lane({
        laneId: `lane-${streamIndex}`,
        name: `日本語 stream ${streamIndex}`,
        streamIndex,
        queueIndex: streamIndex,
        status,
        progress: { position: 2, total: 5 },
        activeStage: { socketId: `Socket-${streamIndex}`, label: "Build", transitionedAt: streamIndex },
      })),
      80,
      { maxConcurrency: 3, theme },
    );

    expect(rows).toHaveLength(6);
    expect(calls).toContainEqual(["accent", "Parallel slots: 1/3 running"]);
    expect(calls).toContainEqual(["accent", "||||||||"]);
    expect(calls).toContainEqual(["dim", "            "]);
    expect(calls).toContainEqual(["muted", "日本語 stream 0"]);
    expect(calls).toContainEqual(["success", "Completed"]);
    expect(calls).toContainEqual(["error", "Failed"]);
    expect(calls).toContainEqual(["error", "Interrupted"]);

    for (const width of [1, 8, 18, 32]) {
      const narrowRows = formatParallelProgress(
        [lane({ name: "日本語 stream with a long label", status: "interrupted", activeStage: { socketId: "Socket-1", label: "Build", transitionedAt: 1 } })],
        width,
        { theme, maxConcurrency: 1 },
      );
      expect(narrowRows.every((row) => row.length > 0 && visibleWidth(row) <= width)).toBe(true);
    }
  });
});
