import { describe, expect, test } from "bun:test";
import { loadoutSockets, loopSockets, materializeCanonicalSockets } from "../src/loadoutAccessors.js";
import type { MateriaLoopConfig, MateriaPipelineConfig } from "../src/types.js";

describe("socket-only loadout accessors", () => {
  test("loadoutSockets does not read legacy nodes as a migration alias", () => {
    const loadout = {
      entry: "Socket-1",
      nodes: { "Socket-1": { empty: true } },
    } as MateriaPipelineConfig;

    expect(loadoutSockets(loadout)).toEqual({});
  });

  test("loopSockets does not read legacy loop nodes as a migration alias", () => {
    const loop = { nodes: ["Socket-2"] } as MateriaLoopConfig;

    expect(loopSockets(loop)).toEqual([]);
  });

  test("materializeCanonicalSockets initializes sockets without copying legacy nodes", () => {
    const loadout = {
      entry: "Socket-1",
      nodes: { "Socket-1": { empty: true } },
      loops: { work: { nodes: ["Socket-1"] } },
    } as MateriaPipelineConfig;

    const materialized = materializeCanonicalSockets(loadout);

    expect(materialized.sockets).toEqual({});
    expect(materialized.nodes).toEqual({ "Socket-1": { empty: true } });
    expect(materialized.loops?.work.sockets).toEqual([]);
    expect(materialized.loops?.work.nodes).toEqual(["Socket-1"]);
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
});
