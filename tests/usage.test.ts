import { describe, expect, test } from "bun:test";
import { addUsage, createRunState, extractUsage } from "../src/usage.js";
import type { UsageReport, UsageTotals } from "../src/types.js";

function usageTotals(tokens: number, cost: number): UsageTotals {
  return {
    tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens },
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function sumCosts(values: UsageTotals[]): number {
  return values.reduce((sum, value) => sum + value.cost.total, 0);
}

function values(record: Record<string, UsageTotals>): UsageTotals[] {
  return Object.values(record);
}

describe("usage aggregation", () => {
  test("aggregates total, role, node, and task costs from captured turn usage", () => {
    const state = createRunState("run", "/tmp/run", { id: "gpt-test", provider: "openai" });
    const turns = [
      { node: "Plan", role: "Maintain", taskId: "task-1", usage: usageTotals(100000, 0.05) },
      { node: "Plan", role: "Maintain", taskId: "task-1", usage: usageTotals(67153, 0.0787) },
      { node: "Build", role: "Build", taskId: "task-4", usage: usageTotals(97629, 0.2148) },
      { node: "Eval", role: "Auto-Eval", taskId: "task-4", usage: usageTotals(45545, 0.1537) },
      { node: "Plan", role: "planner", taskId: "task-0", usage: usageTotals(2410, 0.0344) },
    ];

    for (const turn of turns) addUsage(state.usage, turn.usage, turn);

    const report: UsageReport = state.usage;
    expect(report.cost.total).toBeCloseTo(sumCosts(turns.map((turn) => turn.usage)), 10);
    expect(sumCosts(values(report.byRole))).toBeCloseTo(report.cost.total, 10);
    expect(sumCosts(values(report.byNode))).toBeCloseTo(report.cost.total, 10);
    expect(sumCosts(values(report.byTask))).toBeCloseTo(report.cost.total, 10);
    expect(sumCosts(report.turns ?? [])).toBeCloseTo(report.cost.total, 10);

    expect(report.byRole["Maintain"].cost.total).toBeCloseTo(0.1287, 10);
    expect(report.byRole["Build"].cost.total).toBeCloseTo(0.2148, 10);
    expect(report.byRole["Auto-Eval"].cost.total).toBeCloseTo(0.1537, 10);
    expect(report.byRole.planner.cost.total).toBeCloseTo(0.0344, 10);
    expect(report.byNode.Plan.cost.total).toBeCloseTo(0.1631, 10);
    expect(report.byNode.Build.cost.total).toBeCloseTo(0.2148, 10);
    expect(report.byNode.Eval.cost.total).toBeCloseTo(0.1537, 10);
    expect(report.byTask["task-4"].cost.total).toBeCloseTo(0.3685, 10);
  });
});

describe("usage extraction", () => {
  test("marks OpenAI Codex model usage as subscription cost display", () => {
    const state = createRunState("run", "/tmp/run", { id: "openai-codex/gpt-5.5", provider: "openai-codex" });

    expect(state.usage.costKind).toBe("subscription");
  });

  test("preserves existing nested usage cost totals", () => {
    expect(extractUsage({ usage: { input: 3, output: 4, totalTokens: 7, cost: { input: 0.01, output: 0.02, total: 0.03 } } })).toEqual({
      tokens: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, total: 7 },
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    });
  });

  test("extracts flat Pi assistant cost components", () => {
    expect(extractUsage({ usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, inputCost: 0.001, outputCost: 0.002, cacheReadCost: 0.0003, cacheWriteCost: 0.0004 } })).toEqual({
      tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 },
      cost: { input: 0.001, output: 0.002, cacheRead: 0.0003, cacheWrite: 0.0004, total: 0.0037 },
    });
  });

  test("prefers flat total cost aliases when present", () => {
    expect(extractUsage({ usage: { input: 1, output: 2, inputCost: 0.001, outputCost: 0.002, totalCost: 0.123 } })?.cost.total).toBe(0.123);
    expect(extractUsage({ usage: { input: 1, output: 2, costUsd: 0.456 } })?.cost.total).toBe(0.456);
  });

  test("extracts OpenAI/Codex snake_case token and USD cost aliases", () => {
    expect(extractUsage({
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cached_tokens: 30,
        cache_creation_input_tokens: 40,
        total_tokens: 100,
        cost: {
          input_cost_usd: 0.001,
          output_cost_usd: 0.002,
          cached_input_cost_usd: 0.0003,
          cache_creation_cost_usd: 0.0004,
          total_cost_usd: 0.0037,
        },
      },
    })).toEqual({
      tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 },
      cost: { input: 0.001, output: 0.002, cacheRead: 0.0003, cacheWrite: 0.0004, total: 0.0037 },
    });
  });

  test("does not allow a provided total cost to underreport normalized component costs", () => {
    const usage = extractUsage({
      usage: {
        input: 1000,
        output: 1000,
        cacheRead: 1000,
        cost: {
          input: 0.005,
          output: 0.03,
          cacheRead: 0.0005,
          // Some provider/Pi payloads can include a total alias that is missing
          // cached or output components. The extracted total must not be lower
          // than the normalized component sum.
          total: 0.005,
        },
      },
    });

    expect(usage?.cost.total).toBeCloseTo(0.0355, 10);
  });
});
