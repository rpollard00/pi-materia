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
