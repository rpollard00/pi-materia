import { describe, expect, test } from "bun:test";
import { formatCostLabel, formatUsage, renderUsageSummary } from "../src/ui.js";
import type { UsageReport, UsageTotals } from "../src/types.js";

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
    const roleLines = lines.slice(lines.indexOf("By materia:") + 1, lines.indexOf("By node:"));
    const nodeLines = lines.slice(lines.indexOf("By node:") + 1, lines.indexOf("By task:"));
    const taskLines = lines.slice(lines.indexOf("By task:") + 1);
    expect(roleLines.filter((line) => line.startsWith("-")).reduce((sum, line) => sum + costFromLine(line), 0)).toBeCloseTo(total, 10);
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
