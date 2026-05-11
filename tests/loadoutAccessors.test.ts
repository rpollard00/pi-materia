import { describe, expect, test } from "bun:test";
import { getLoadoutSocket, loadoutLoopEntries, loadoutSocketEntries, loadoutSocketIdSet, loadoutSocketIds, loadoutSockets, loopSocketSet, loopSockets, materializeCanonicalSockets, validateLoadoutSocketReferences } from "../src/loadout/loadoutAccessors.js";
import type { MateriaLoopConfig, MateriaPipelineConfig } from "../src/types.js";

describe("socket-only loadout accessors", () => {
  test("loadoutSockets returns an empty map when sockets are omitted", () => {
    const loadout = {
      entry: "Socket-1",
    } as MateriaPipelineConfig;

    expect(loadoutSockets(loadout)).toEqual({});
  });

  test("loopSockets returns an empty list when sockets are omitted", () => {
    const loop = {} as MateriaLoopConfig;

    expect(loopSockets(loop)).toEqual([]);
  });

  test("materializeCanonicalSockets initializes missing socket collections", () => {
    const loadout = {
      entry: "Socket-1",
      loops: { work: {} },
    } as MateriaPipelineConfig;

    const materialized = materializeCanonicalSockets(loadout);

    expect(materialized.sockets).toEqual({});
    expect(materialized.loops?.work.sockets).toEqual([]);
  });

  test("socket-shaped loadouts continue to resolve sockets and loop membership", () => {
    const loadout = {
      entry: "Socket-1",
      sockets: { "Socket-1": { empty: true } },
      loops: { work: { sockets: ["Socket-1"] } },
    } satisfies MateriaPipelineConfig;

    expect(loadoutSockets(loadout)).toEqual({ "Socket-1": { empty: true } });
    expect(loopSockets(loadout.loops.work)).toEqual(["Socket-1"]);
  });

  test("provides ordered socket lookup and traversal helpers", () => {
    const loadout = {
      entry: "Socket-1",
      sockets: {
        "Socket-1": { type: "agent", materia: "Build", edges: [{ when: "always", to: "Socket-2" }] },
        "Socket-2": { type: "utility", utility: "vcs.status" },
      },
    } satisfies MateriaPipelineConfig;

    expect(loadoutSocketIds(loadout)).toEqual(["Socket-1", "Socket-2"]);
    expect(loadoutSocketEntries(loadout).map(([id]) => id)).toEqual(["Socket-1", "Socket-2"]);
    expect(loadoutSocketIdSet(loadout)).toEqual(new Set(["Socket-1", "Socket-2"]));
    expect(getLoadoutSocket(loadout, "Socket-2")?.type).toBe("utility");
  });

  test("provides loop traversal helpers", () => {
    const loadout = {
      entry: "Socket-1",
      sockets: { "Socket-1": { empty: true }, "Socket-2": { empty: true } },
      loops: { work: { sockets: ["Socket-2"], consumes: { from: "Socket-1" } } },
    } satisfies MateriaPipelineConfig;

    expect(loadoutLoopEntries(loadout).map(([id]) => id)).toEqual(["work"]);
    expect(loopSocketSet(loadout.loops.work)).toEqual(new Set(["Socket-2"]));
  });

  test("validates missing socket references against the canonical socket collection", () => {
    const loadout = {
      entry: "Socket-1",
      sockets: {
        "Socket-1": { empty: true, edges: [{ when: "always", to: "Socket-2" }], foreach: { items: "state.items", done: "Socket-3" } },
      },
      loops: { work: { sockets: ["Socket-4"], consumes: { from: "Socket-5", done: "Socket-6" }, iterator: { items: "state.items", done: "Socket-7" } } },
    } as MateriaPipelineConfig;

    const result = validateLoadoutSocketReferences(loadout);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual([
      "sockets.Socket-1.edges.0.to",
      "sockets.Socket-1.foreach.done",
      "loops.work.sockets.0",
      "loops.work.consumes.from",
      "loops.work.consumes.done",
      "loops.work.iterator.done",
    ]);
  });
});
