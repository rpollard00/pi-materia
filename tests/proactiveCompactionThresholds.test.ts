import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { defaultProactiveCompactionThresholdPercent } from "../src/native.js";
import { resolveProactiveCompactionThreshold, validateCompactionConfig } from "../src/compaction.js";
import { FakePiHarness } from "./fakePi.js";

const cases: Array<[number, number]> = [
  [64_000, 75],
  [100_000, 75],
  [127_999, 75],
  [128_000, 65],
  [199_999, 65],
  [200_000, 55],
  [272_000, 55],
];

async function makeHarness(compaction?: unknown): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-threshold-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify({
    artifactDir: ".pi/pi-materia",
    ...(compaction === undefined ? {} : { compaction }),
    pipeline: { entry: "work", nodes: { work: { type: "agent", role: "Build", next: "end" } } },
    roles: { Build: { tools: "coding", systemPrompt: "Build role prompt" } },
  }, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

describe("default proactive compaction threshold tiers", () => {
  test.each(cases)("uses %p-token context window -> %p%% threshold", (contextWindow, threshold) => {
    expect(defaultProactiveCompactionThresholdPercent(contextWindow)).toBe(threshold);
  });

  test("falls back conservatively when context window metadata is unavailable or invalid", () => {
    expect(defaultProactiveCompactionThresholdPercent(undefined)).toBe(55);
    expect(defaultProactiveCompactionThresholdPercent(null)).toBe(55);
    expect(defaultProactiveCompactionThresholdPercent(0)).toBe(55);
    expect(defaultProactiveCompactionThresholdPercent(-1)).toBe(55);
    expect(defaultProactiveCompactionThresholdPercent(Number.NaN)).toBe(55);
  });

  test("uses active model metadata rather than stale/generic usage context window", async () => {
    const harness = await makeHarness();
    (harness.ctx as any).model = { provider: "test", id: "effective-200k", contextWindow: 200_000 };
    harness.contextUsage = { tokens: 120_000, contextWindow: 272_000, percent: (120_000 / 272_000) * 100 };

    await harness.runCommand("materia", "cast trigger proactive compaction from effective model window");

    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(1);
    const state = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    const events = (await readFile(state.runState.eventsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const compactionEvent = events.find((event) => event.type === "proactive_compaction_start");
    expect(compactionEvent.data).toMatchObject({ contextWindow: 200_000, thresholdPercent: 55, thresholdMode: "default_tiered", thresholdTier: { id: "gte-200k", minContextWindow: 200_000 }, percent: 60 });
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

  test("configured tiers drive proactive compaction events", async () => {
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
});
