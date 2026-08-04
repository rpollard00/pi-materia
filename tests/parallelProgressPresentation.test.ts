import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ParallelLaneMonitorSummary } from "../src/application/parallelMonitoring.js";
import {
  formatParallelProgress,
  ParallelProgressComponent,
} from "../src/presentation/parallelProgress.js";

type Lane = Pick<ParallelLaneMonitorSummary, "laneId" | "name" | "streamIndex" | "queueIndex" | "status" | "progress">;

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
      expect(visibleWidth(line ?? "")).toBeLessThanOrEqual(width);
    }

    const [moderate] = formatParallelProgress(input, 42);
    expect(moderate).toContain("…");
    expect(moderate).toContain("60% (3/5) Failed");
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
    const component = new ParallelProgressComponent([
      lane({ progress: { position: 0, total: 0 }, status: "queued" }),
    ]);
    expect(component.render(80)[0]).toContain("0% (0/0) Queued");

    component.setLanes([lane({ progress: { position: 4, total: 5 } })]);
    expect(component.render(80)[0]).toContain("80% (4/5)");
    component.setLanes([lane({ progress: { position: 1, total: 5 } })]);
    expect(component.render(80)[0]).toContain("20% (1/5)");
  });
});
