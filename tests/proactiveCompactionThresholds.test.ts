import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { defaultProactiveCompactionThresholdPercent } from "../src/native.js";
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

async function makeHarness(): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-threshold-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify({
    artifactDir: ".pi/pi-materia",
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

  test("falls back conservatively when context window metadata is unavailable", () => {
    expect(defaultProactiveCompactionThresholdPercent(undefined)).toBe(55);
    expect(defaultProactiveCompactionThresholdPercent(null)).toBe(55);
    expect(defaultProactiveCompactionThresholdPercent(0)).toBe(55);
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
    expect(compactionEvent.data).toMatchObject({ contextWindow: 200_000, thresholdPercent: 55 });
  });
});
