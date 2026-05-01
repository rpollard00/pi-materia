import { describe, expect, test } from "bun:test";
import { formatCostLabel, formatUsage, renderUsageSummary } from "../src/ui.js";
import type { UsageReport, UsageTotals } from "../src/types.js";

function totals(tokens: number, cost: number): UsageTotals {
  return {
    tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens },
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
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
      byRole: { Build: totals(100, 0.4567) },
      byNode: {},
      byTask: {},
      byAttempt: {},
    };

    expect(renderUsageSummary(usage)).toEqual([
      "Materia Usage Summary",
      "Cost display: estimated token value only; subscription usage is not billed per token.",
      "total: 100 tokens, estimated token value: $0.4567 (subscription; no per-token billing implied)",
      "",
      "By role:",
      "- Build: 100 tokens, estimated token value: $0.4567 (subscription; no per-token billing implied)",
      "",
      "By node:",
      "- none observed",
      "",
      "By task:",
      "- none observed",
    ]);
  });
});
