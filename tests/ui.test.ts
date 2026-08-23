import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  formatCostLabel,
  formatUsage,
  renderCompactUsageWidget,
  renderUsageSummary,
  showUsageSummary,
} from "../src/presentation/ui.js";
import type {
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

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "");
}

describe("usage UI formatting", () => {
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
