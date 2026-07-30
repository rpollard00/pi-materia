import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { defaultProactiveCompactionThresholdPercent } from "../src/castRuntime.js";
import { resolveProactiveCompactionThreshold, validateCompactionConfig } from "../src/runtime/compaction.js";
import type { ResolvedProactiveCompactionThreshold } from "../src/config/compactionConfig.js";
import { FakePiHarness } from "./fakePi.js";

/** Pi's fixed reserve, matching the constant in compactionConfig.ts. */
const PI_RESERVE = 16_384;

/** Assert a reserve_budget result matches the expected budget math. */
function expectBudgetResult(result: ResolvedProactiveCompactionThreshold, contextWindow: number): void {
  const usable = contextWindow - PI_RESERVE;
  const pct = (usable / contextWindow) * 100;
  expect(result.mode).toBe("reserve_budget");
  expect(result.thresholdPercent).toBeCloseTo(pct, 10);
  expect(result.usableBudget).toBe(usable);
  expect(result.reserve).toBe(PI_RESERVE);
}

async function makeHarness(compaction?: unknown): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-threshold-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify({
    artifactDir: ".pi/pi-materia",
    ...(compaction === undefined ? {} : { compaction }),
    activeLoadout: "Test",
    loadouts: { Test: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Build", edges: [{ when: 'always', to: 'end' }] } } } },
    materia: { Build: { tools: "coding", prompt: "Build materia prompt" } },
  }, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

describe("default proactive compaction reserve budget", () => {
  test.each([
    [64_000],
    [100_000],
    [127_999],
    [128_000],
    [199_999],
    [200_000],
    [272_000],
    [1_000_000],
  ])("computes usable budget = contextWindow - 16384 for %p-token window", (contextWindow: number) => {
    const result = resolveProactiveCompactionThreshold(undefined, contextWindow);
    expectBudgetResult(result, contextWindow);
  });

  test("derives diagnostic threshold percent from usable budget / contextWindow", () => {
    const result = resolveProactiveCompactionThreshold(undefined, 272_000);
    const usable = 272_000 - PI_RESERVE; // 255_616
    const expectedPct = (usable / 272_000) * 100; // ~93.976%
    expect(result.thresholdPercent).toBeCloseTo(expectedPct, 10);
    expect(result.usableBudget).toBe(255_616);
    expect(result.reserve).toBe(PI_RESERVE);
    expect(result.mode).toBe("reserve_budget");
  });

  test("defaultProactiveCompactionThresholdPercent returns the diagnostics percent", () => {
    const pct = defaultProactiveCompactionThresholdPercent(272_000);
    expect(pct).toBeCloseTo(((272_000 - PI_RESERVE) / 272_000) * 100, 10);
  });

  test("leaves threshold unresolved when context window metadata is unavailable or invalid", () => {
    expect(defaultProactiveCompactionThresholdPercent(undefined)).toBeUndefined();
    expect(defaultProactiveCompactionThresholdPercent(null)).toBeUndefined();
    expect(defaultProactiveCompactionThresholdPercent(0)).toBeUndefined();
    expect(defaultProactiveCompactionThresholdPercent(-1)).toBeUndefined();
    expect(defaultProactiveCompactionThresholdPercent(Number.NaN)).toBeUndefined();
    // The resolver itself also returns undefined thresholdPercent.
    const r = resolveProactiveCompactionThreshold(undefined, undefined);
    expect(r.thresholdPercent).toBeUndefined();
    expect(r.mode).toBe("reserve_budget");
    expect(r.usableBudget).toBeUndefined();
    expect(r.reserve).toBeUndefined();
  });

  test("uses active model metadata rather than stale/generic usage context window", async () => {
    const harness = await makeHarness();
    (harness.ctx as any).model = { provider: "test", id: "effective-200k", contextWindow: 200_000 };
    harness.contextUsage = { tokens: 120_000, contextWindow: 272_000, percent: (120_000 / 272_000) * 100 };

    await harness.runCommand("materia", "cast trigger proactive compaction from effective model window");

    // A 200k model with 120k tokens used is at 60% — below the ~91.8% reserve
    // budget threshold, so proactive compaction should NOT fire.
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
  });

  test("uses custom configured threshold tiers at inclusive lower boundaries", () => {
    const compaction = {
      proactiveThresholdTiers: [
        { id: "small", minContextWindow: 0, maxContextWindow: 50_000, thresholdPercent: 80 },
        { id: "medium", minContextWindow: 50_000, maxContextWindow: 150_000, thresholdPercent: 70 },
        { id: "large", minContextWindow: 150_000, thresholdPercent: 60 },
      ],
    };

    expect(resolveProactiveCompactionThreshold(compaction, 49_999)).toMatchObject({ thresholdPercent: 80, mode: "configured_tiered", tier: { id: "small" } });
    expect(resolveProactiveCompactionThreshold(compaction, 50_000)).toMatchObject({ thresholdPercent: 70, mode: "configured_tiered", tier: { id: "medium" } });
    expect(resolveProactiveCompactionThreshold(compaction, 150_000)).toMatchObject({ thresholdPercent: 60, mode: "configured_tiered", tier: { id: "large" } });
  });

  test("rejects invalid, gapped, overlapping, and malformed configured threshold tiers", () => {
    expect(() => validateCompactionConfig({ proactiveThresholdTiers: [] })).toThrow(/non-empty array/);
    expect(() => validateCompactionConfig({ proactiveThresholdTiers: [null as any] })).toThrow(/must be an object/);
    expect(() => validateCompactionConfig({ proactiveThresholdTiers: [{ thresholdPercent: -1 }] })).toThrow(/between 0 and 100/);
    expect(() => validateCompactionConfig({ proactiveThresholdTiers: [{ thresholdPercent: 101 }] })).toThrow(/between 0 and 100/);
    expect(() => validateCompactionConfig({ proactiveThresholdTiers: [{ minContextWindow: -1, thresholdPercent: 80 }] })).toThrow(/non-negative integer/);
    expect(() => validateCompactionConfig({ proactiveThresholdTiers: [{ minContextWindow: 0, maxContextWindow: 0, thresholdPercent: 80 }] })).toThrow(/greater than minContextWindow/);
    expect(() => validateCompactionConfig({ proactiveThresholdTiers: [
      { minContextWindow: 0, maxContextWindow: 10, thresholdPercent: 80 },
      { minContextWindow: 11, thresholdPercent: 70 },
    ] })).toThrow(/without gaps or overlaps/);
    expect(() => validateCompactionConfig({ proactiveThresholdTiers: [
      { minContextWindow: 0, maxContextWindow: 10, thresholdPercent: 80 },
      { minContextWindow: 9, thresholdPercent: 70 },
    ] })).toThrow(/without gaps or overlaps/);
    expect(() => validateCompactionConfig({ proactiveThresholdTiers: [
      { minContextWindow: 0, maxContextWindow: 10, thresholdPercent: 80 },
      { minContextWindow: 10, maxContextWindow: 20, thresholdPercent: 70 },
    ] })).toThrow(/final open-ended tier/);
  });

  test("preserves backward-compatible single-threshold configuration and lets it override tiers", () => {
    expect(resolveProactiveCompactionThreshold({ proactiveThresholdPercent: 42 }, 272_000)).toMatchObject({ thresholdPercent: 42, mode: "single_percent" });
    expect(resolveProactiveCompactionThreshold({
      proactiveThresholdPercent: 42,
      proactiveThresholdTiers: [{ minContextWindow: 0, thresholdPercent: 80 }],
    }, 272_000)).toMatchObject({ thresholdPercent: 42, mode: "single_percent" });
  });

  test("configured tiers drive proactive compaction events (preserved behavior)", async () => {
    const harness = await makeHarness({ proactiveThresholdTiers: [
      { id: "under-200k", minContextWindow: 0, maxContextWindow: 200_000, thresholdPercent: 90 },
      { id: "200k-plus", minContextWindow: 200_000, thresholdPercent: 45 },
    ] });
    (harness.ctx as any).model = { provider: "test", id: "effective-200k", contextWindow: 200_000 };
    harness.contextUsage = { tokens: 100_000, contextWindow: 200_000, percent: 50 };

    await harness.runCommand("materia", "cast trigger custom proactive compaction");

    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(1);
    const state = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    const events = (await readFile(state.runState.eventsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const compactionEvent = events.find((event) => event.type === "proactive_compaction_start");
    expect(compactionEvent.data).toMatchObject({ thresholdPercent: 45, thresholdMode: "configured_tiered", thresholdTier: { id: "200k-plus", minContextWindow: 200_000 } });
  });

  describe("Pi's strict greater-than boundary", () => {
    test("default budget-derived threshold percent is strictly diagnostic; caller decides overage", () => {
      const contextWindow = 272_000;
      const usable = contextWindow - PI_RESERVE; // 255_616
      const result = resolveProactiveCompactionThreshold(undefined, contextWindow);
      // The threshold is a diagnostic percent — the real boundary is usableBudget.
      expect(result.usableBudget).toBe(usable);
      expect(result.mode).toBe("reserve_budget");
      // At exactly usableBudget tokens, usage has NOT exceeded the budget.
      // (The strict > check is enforced in compactionWorkflow per work item 2.)
      expect(result.thresholdPercent).toBeGreaterThan(0);
      expect(result.thresholdPercent).toBeLessThan(100);
      expect(result.reserve).toBe(PI_RESERVE);
    });

    test("reserve budget is always exactly 16384 tokens regardless of context size", () => {
      for (const cw of [8_000, 16_384, 32_000, 64_000, 128_000, 200_000, 272_000, 1_000_000]) {
        const result = resolveProactiveCompactionThreshold(undefined, cw);
        expect(result.reserve).toBe(PI_RESERVE);
        expect(result.usableBudget).toBe(cw - PI_RESERVE);
      }
    });

    test("small context windows still subtract full reserve", () => {
      // A tiny window still follows the same rule — usableBudget may be
      // negative or tiny, which is a caller concern (hard window protection).
      const result = resolveProactiveCompactionThreshold(undefined, 20_000);
      expect(result.usableBudget).toBe(20_000 - PI_RESERVE); // 3_616
      expect(result.reserve).toBe(PI_RESERVE);
    });
  });
});
