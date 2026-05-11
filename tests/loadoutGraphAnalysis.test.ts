import { describe, expect, test } from "bun:test";
import { analyzeLoadoutGraph } from "../src/loadoutGraphAnalysis.js";
import { normalizeLoadedLoadout, prepareLoadoutForSave } from "../src/loadoutNormalization.js";
import type { MateriaPipelineConfig, PiMateriaConfig } from "../src/types.js";

const materia = {
  planner: { prompt: "Plan", tools: "none", generator: true },
  refiner: { prompt: "Refine", tools: "none", generator: true },
  Build: { prompt: "Build", tools: "coding" },
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
      type: "agent",
      materia: "planner",
      edges: [
        { when: "always", to: sharedWorkerId },
        { when: "always", to: ambiguousWorkerId },
      ],
    },
    [secondSourceId]: { type: "agent", materia: "refiner", edges: [{ when: "always", to: ambiguousWorkerId }] },
    [missingWorkerId]: { type: "agent", materia: "Build" },
    [ambiguousWorkerId]: { type: "agent", materia: "Build" },
  };

  for (const [index, id] of workerIds.entries()) {
    sockets[id] = { type: "agent", materia: "Build", edges: [{ when: "always", to: workerIds[(index + 1) % workerIds.length]! }] };
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

    const analysis = analyzeLoadoutGraph(loadout, materia);
    const normalized = normalizeLoadedLoadout(loadout, materia);
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
    expect(prepared.sockets["Socket-1"]?.assign?.workItems).toBe("$.workItems");
    expect(prepared.sockets["Socket-2"]?.assign?.workItems).toBeUndefined();

    const diagnosticKeys = analysis.diagnostics.map(({ code, loopId, from }) => `${code}:${loopId}:${from ?? ""}`).sort();
    expect(diagnosticKeys).toEqual([
      "loop-consumer-ambiguous:ambiguous:",
      "loop-consumer-missing:missing:",
      ...Array.from({ length: 24 }, (_, index) => `loop-consumer-stale:overlap-${index.toString().padStart(2, "0")}:Socket-999`),
    ].sort());
  });
});
