import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveMateriaConfigPatch } from "../src/config/config.js";
import { isCanonicalOrNormalizedLoopRouting, normalizeLegacyLoopRoutingCompatibilityInPlace } from "../src/loadout/loopCompatibility.js";
import { prepareLoadoutForRuntime, prepareLoadoutForSave, normalizeLoadedLoadout } from "../src/loadout/loadoutNormalization.js";
import type { MateriaPipelineConfig, PiMateriaConfig } from "../src/types.js";

const materia = {
  planner: { prompt: "Plan", tools: "none", generator: true },
  refiner: { prompt: "Refine", tools: "none", generator: true },
  Build: { prompt: "Build", tools: "coding" },
  Maintain: { prompt: "Maintain", tools: "coding" },
} satisfies PiMateriaConfig["materia"];

function generatorLoopLoadout(): MateriaPipelineConfig {
  return {
    entry: "Socket-1",
    layout: { sockets: { "Socket-2": { x: 20, y: 30 }, "Socket-99": { x: 99, y: 99 } } },
    loops: {
      taskIteration: {
        sockets: ["Socket-3", "Socket-4"],
        consumes: { from: "Socket-1", output: "workItems" },
        exit: { from: "Socket-4", when: "satisfied", to: "end" },
      },
    },
    sockets: {
      "Socket-1": { type: "agent", materia: "planner", layout: { x: 1, y: 2 }, edges: [{ when: "always", to: "Socket-2" }] },
      "Socket-2": { type: "agent", materia: "refiner", layout: { x: 3, y: 4 }, edges: [{ when: "always", to: "Socket-3" }] },
      "Socket-3": { type: "agent", materia: "Build", edges: [{ when: "always", to: "Socket-4" }] },
      "Socket-4": { type: "agent", materia: "Maintain", edges: [{ when: "always", to: "Socket-3" }] },
    },
  };
}

describe("shared loadout normalization", () => {
  test("normalizes loaded legacy layout without trusting stale loop metadata or mutating input", () => {
    const previous = generatorLoopLoadout();
    const before = JSON.stringify(previous);

    const { loadout, analysis } = normalizeLoadedLoadout(previous, materia);

    expect(JSON.stringify(previous)).toBe(before);
    expect(loadout.layout?.sockets).toEqual({ "Socket-1": { x: 1, y: 2 }, "Socket-2": { x: 20, y: 30 } });
    expect(loadout.sockets["Socket-1"].layout).toBeUndefined();
    expect(loadout.sockets["Socket-2"].layout).toBeUndefined();
    expect(analysis.loopConsumerSources.get("taskIteration")?.from).toBe("Socket-2");
    expect(loadout.loops?.taskIteration.consumes?.from).toBe("Socket-1");
  });

  test("prepares save/runtime loadouts by reconciling loop consumers, pruning layout, and materializing controls", () => {
    const save = prepareLoadoutForSave(generatorLoopLoadout(), materia, { loadoutName: "Loop" }).loadout;
    const runtime = prepareLoadoutForRuntime(generatorLoopLoadout(), { materia }, { loadoutName: "Loop" }).loadout;

    for (const prepared of [save, runtime]) {
      expect(prepared.loops?.taskIteration.consumes?.from).toBe("Socket-2");
      expect(prepared.layout?.sockets).toEqual({ "Socket-1": { x: 1, y: 2 }, "Socket-2": { x: 20, y: 30 } });
      expect(prepared.sockets["Socket-2"].parse).toBe("json");
      expect(prepared.sockets["Socket-2"].assign?.workItems).toBe("$.workItems");
      expect(prepared.sockets["Socket-4"].advance).toEqual({ cursor: "workItemIndex", items: "state.workItems", when: "satisfied" });
      expect(prepared.loops?.taskIteration.exits).toBeUndefined();
    }
    expect(JSON.stringify(prepareLoadoutForSave(save, materia).loadout)).toBe(JSON.stringify(save));
  });

  test("save path writes the same reconciled metadata and pruned layout used by runtime", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-normalize-save-"));
    const file = await saveMateriaConfigPatch(cwd, { activeLoadout: "Loop", materia, loadouts: { Loop: generatorLoopLoadout() } }, { target: "project" });

    const saved = JSON.parse(await readFile(file, "utf8")) as PiMateriaConfig;
    const loadout = saved.loadouts?.Loop;
    expect(loadout?.loops?.taskIteration.consumes?.from).toBe("Socket-2");
    expect(loadout?.layout?.sockets).toEqual({ "Socket-1": { x: 1, y: 2 }, "Socket-2": { x: 20, y: 30 } });
    expect(loadout?.sockets["Socket-2"].assign?.workItems).toBe("$.workItems");
    expect(loadout?.sockets["Socket-4"].advance).toEqual({ cursor: "workItemIndex", items: "state.workItems", when: "satisfied" });
    expect(loadout?.loops?.taskIteration.exits).toBeUndefined();
  });

  test("normalizes legacy advance.done routing into canonical loop exits without rewriting normal edges", () => {
    const legacy: MateriaPipelineConfig = {
      entry: "Socket-1",
      loops: {
        work: { sockets: ["Socket-2", "Socket-3"] },
      },
      sockets: {
        "Socket-1": { type: "agent", materia: "planner", edges: [{ when: "always", to: "Socket-2" }] },
        "Socket-2": { type: "agent", materia: "Build", edges: [{ when: "not_satisfied", to: "Socket-2" }, { when: "satisfied", to: "Socket-3" }] },
        "Socket-3": { type: "agent", materia: "Maintain", edges: [{ when: "always", to: "Socket-2" }], advance: { cursor: "workItemIndex", items: "state.workItems", done: "Socket-4", when: "satisfied" } },
        "Socket-4": { type: "agent", materia: "Build" },
      },
    };

    expect(isCanonicalOrNormalizedLoopRouting(legacy)).toBe(false);
    const { loadout } = normalizeLoadedLoadout(legacy, materia);

    expect(isCanonicalOrNormalizedLoopRouting(loadout)).toBe(true);
    expect(loadout.loops?.work.exits).toEqual([{ id: "exit:Socket-3:satisfied", from: "Socket-3", condition: "satisfied", targetSocketId: "Socket-4" }]);
    expect(loadout.sockets["Socket-2"].edges).toEqual([{ when: "not_satisfied", to: "Socket-2" }, { when: "satisfied", to: "Socket-3" }]);
    expect(loadout.sockets["Socket-3"].edges).toEqual([{ when: "always", to: "Socket-2" }]);
    expect(loadout.sockets["Socket-3"].advance?.done).toBe("Socket-4");
  });

  test("compatibility detection identifies legacy terminal back-edges without treating them as exit routes", () => {
    const loadout = generatorLoopLoadout();
    const result = normalizeLegacyLoopRoutingCompatibilityInPlace(loadout);

    expect(result.detections).toContainEqual(expect.objectContaining({ kind: "legacy-terminal-back-edge", loopId: "taskIteration", socketId: "Socket-4", targetSocketId: "Socket-3", condition: "always" }));
    expect(loadout.loops?.taskIteration.exits).toBeUndefined();
  });
});
