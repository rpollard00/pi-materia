import { describe, expect, test } from "bun:test";
import { extractUsage } from "../src/usage.js";

describe("usage extraction", () => {
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
});
