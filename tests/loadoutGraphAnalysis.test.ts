import { describe, expect, test } from "bun:test";
import { analyzeLoadoutGraph } from "../src/graph/loadoutGraphAnalysis.js";
import { normalizeLoadedLoadout, prepareLoadoutForSave } from "../src/loadout/loadoutNormalization.js";
import type { MateriaPipelineConfig, PiMateriaConfig } from "../src/types.js";

const materia = {
  planner: { type: "agent", prompt: "Plan", tools: "none", generator: true },
  refiner: { type: "agent", prompt: "Refine", tools: "none", generator: true },
  Build: { type: "agent", prompt: "Build", tools: "coding" },
  scriptPlanner: { type: "utility", command: ["node", "plan.mjs"], generator: true },
} satisfies PiMateriaConfig["materia"];

function overlappingLoopLoadout(): MateriaPipelineConfig {
  const sourceId = "Socket-1";
  const secondSourceId = "Socket-2";
  const missingWorkerId = "Socket-3";
  const ambiguousWorkerId = "Socket-4";
  const sharedWorkerId = "Socket-100";
  const workerIds = Array.from({ length: 12 }, (_, index) => `Socket-${100 + index}`);
  const sockets: MateriaPipelineConfig["sockets"] = {
    [sourceId]: {
      materia: "planner",
      edges: [
        { when: "always", to: sharedWorkerId },
        { when: "always", to: ambiguousWorkerId },
      ],
    },
    [secondSourceId]: { materia: "refiner", edges: [{ when: "always", to: ambiguousWorkerId }] },
    [missingWorkerId]: { materia: "Build" },
    [ambiguousWorkerId]: { materia: "Build" },
  };

  for (const [index, id] of workerIds.entries()) {
    sockets[id] = { materia: "Build", edges: [{ when: "always", to: workerIds[(index + 1) % workerIds.length]! }] };
  }

  const loops: NonNullable<MateriaPipelineConfig["loops"]> = {};
  for (let index = 0; index < 24; index += 1) {
    const rotatingMembers = Array.from({ length: 8 }, (_, offset) => workerIds[(index + offset) % workerIds.length]!);
    loops[`overlap-${index.toString().padStart(2, "0")}`] = {
      sockets: Array.from(new Set([sharedWorkerId, ...rotatingMembers])),
      consumes: { from: "Socket-999", output: "workItems" },
    };
  }
  loops.missing = { sockets: [missingWorkerId], consumes: { from: sourceId, output: "workItems" } };
  loops.ambiguous = { sockets: [ambiguousWorkerId], consumes: { from: sourceId, output: "workItems" } };

  return { entry: sourceId, sockets, loops };
}

describe("loadout graph analysis under overlapping loop memberships", () => {
  test("derives loop consumers, diagnostics, and work-item facts deterministically", () => {
    const loadout = overlappingLoopLoadout();
    const before = JSON.stringify(loadout);

    const normalized = normalizeLoadedLoadout(structuredClone(loadout), materia);
    const analysis = normalized.analysis;
    const prepared = prepareLoadoutForSave(loadout, materia).loadout;

    expect(JSON.stringify(loadout)).toBe(before);
    expect(normalized.analysis.loopConsumerSources).toEqual(analysis.loopConsumerSources);
    expect(normalized.analysis.diagnostics).toEqual(analysis.diagnostics);

    for (let index = 0; index < 24; index += 1) {
      const loopId = `overlap-${index.toString().padStart(2, "0")}`;
      expect(analysis.loopConsumerSources.get(loopId)).toEqual({ from: "Socket-1", output: "workItems" });
      expect(prepared.loops?.[loopId]?.consumes).toEqual({ from: "Socket-1", output: "workItems" });
    }

    expect(analysis.loopConsumerSources.has("missing")).toBe(false);
    expect(analysis.loopConsumerSources.has("ambiguous")).toBe(false);
    expect(analysis.workItemProducingSocketIds).toEqual(new Set(["Socket-1"]));
    expect(analysis.workItemProducingSocketIds).toEqual(new Set(["Socket-1"]));
    // parse and assign are derived at runtime; save prep prunes them from utility sockets
    expect(prepared.sockets["Socket-1"]?.assign).toBeUndefined();
    expect(prepared.sockets["Socket-2"]?.assign?.workItems).toBeUndefined();

    const diagnosticKeys = analysis.diagnostics.map(({ code, loopId, from }) => `${code}:${loopId}:${from ?? ""}`).sort();
    expect(diagnosticKeys).toEqual([
      "loop-consumer-ambiguous:ambiguous:",
      "loop-consumer-missing:missing:",
      ...Array.from({ length: 24 }, (_, index) => `loop-consumer-stale:overlap-${index.toString().padStart(2, "0")}:Socket-999`),
    ].sort());
  });

  test("treats utility materia marked generator as loop workItems producers", () => {
    const loadout: MateriaPipelineConfig = {
      entry: "Socket-1",
      sockets: {
        "Socket-1": { materia: "scriptPlanner", edges: [{ when: "always", to: "Socket-2" }] },
        "Socket-2": { materia: "Build" },
      },
      loops: {
        work: { sockets: ["Socket-2"], consumes: { from: "stale", output: "workItems" } },
      },
    };

    const analysis = normalizeLoadedLoadout(structuredClone(loadout), materia).analysis;
    const prepared = prepareLoadoutForSave(loadout, materia).loadout;

    expect(analysis.loopConsumerSources.get("work")).toEqual({ from: "Socket-1", output: "workItems" });
    expect(analysis.workItemProducingSocketIds).toEqual(new Set(["Socket-1"]));
    expect(analysis.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["loop-consumer-stale"]);
    expect(prepared.loops?.work.consumes).toEqual({ from: "Socket-1", output: "workItems" });
    // parse and assign are derived at runtime; save prep prunes them from utility sockets
    expect(prepared.sockets["Socket-1"]?.parse).toBeUndefined();
    expect(prepared.sockets["Socket-1"]?.assign).toBeUndefined();
  });
});
