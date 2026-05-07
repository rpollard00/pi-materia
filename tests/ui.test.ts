import { describe, expect, test } from "bun:test";
import { formatCostLabel, formatUsage, renderCompactUsageWidget, renderMateriaRunWidget, renderUsageSummary } from "../src/ui.js";
import type { MateriaRunState, UsageReport, UsageTotals } from "../src/types.js";

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

describe("persistent Materia widget formatting", () => {
  test("renders compact active cast details in at most four lines", () => {
    const state: MateriaRunState = {
      runId: "2026-05-07T14-53-49-729Z",
      startedAt: 1_000,
      runDir: "/tmp/cast",
      eventsFile: "/tmp/cast/events.jsonl",
      usageFile: "/tmp/cast/usage.json",
      currentNode: "planner",
      currentMateria: "Interactive Planning Consult With A Very Long Name",
      currentTask: "task-123 - Implement a very long task title that should not be allowed to wrap across the terminal widget",
      attempt: 2,
      lastMessage: "Multi-turn node planner waiting for refinement; run /materia continue to finalize.",
      usage: { ...totals(0, 0), tokens: { input: 19381, output: 2100, cacheRead: 4000, cacheWrite: 10, total: 25491 } },
      budgetWarned: false,
    };

    const lines = renderMateriaRunWidget(state, 70_000);
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("Cast 2026-05-07 14:53:49.729Z");
    expect(lines[0]).toContain("Interactive Planning");
    expect(lines[0]).toContain("attempt 2");
    expect(lines[1]).toContain("Task task-123");
    expect(lines[1]).toContain("1m09s");
    expect(lines[1]).toContain("tok 23k/2.1k");
    expect(lines[2]).toContain("Last Multi-turn node planner waiting");
    expect(lines.every((line) => line.length <= 78)).toBe(true);
  });

  test("renders compact completion usage without billing disclaimers", () => {
    const lines = renderCompactUsageWidget(totals(19381, 0.0497));
    expect(lines).toEqual(["Usage total 19k tokens"]);
    expect(lines.join("\n")).not.toContain("estimated token value");
    expect(lines.join("\n")).not.toContain("billing");
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
      byNode: {},
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
      "By node:",
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
      byNode: {
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
    const materiaLines = lines.slice(lines.indexOf("By materia:") + 1, lines.indexOf("By node:"));
    const nodeLines = lines.slice(lines.indexOf("By node:") + 1, lines.indexOf("By task:"));
    const taskLines = lines.slice(lines.indexOf("By task:") + 1);
    expect(materiaLines.filter((line) => line.startsWith("-")).reduce((sum, line) => sum + costFromLine(line), 0)).toBeCloseTo(total, 10);
    expect(nodeLines.filter((line) => line.startsWith("-")).reduce((sum, line) => sum + costFromLine(line), 0)).toBeCloseTo(total, 10);
    expect(taskLines.filter((line) => line.startsWith("-")).reduce((sum, line) => sum + costFromLine(line), 0)).toBeCloseTo(total, 10);
  });

  test("renders an empty by-node breakdown without hiding total or materia costs", () => {
    const usage: UsageReport = {
      ...totals(42, 0.1234),
      costKind: "actual",
      byMateria: { Build: totals(42, 0.1234) },
      byNode: {},
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
      "By node:",
      "- none observed",
      "",
      "By task:",
      "- task-4: 42 tokens, billed cost: $0.1234",
    ]);
  });
});
