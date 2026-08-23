import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  formatCostLabel,
  formatUsage,
  renderCompactUsageWidget,
  showUsageSummary,
} from "../src/presentation/auxiliaryWidgets.js";
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

describe("one-shot usage widgets", () => {
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
});
