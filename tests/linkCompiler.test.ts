import { describe, expect, test } from "bun:test";
import { compileLinkPlan, createConfigLinkGraphSource } from "../src/link/compiler.js";
import type { DomainResult } from "../src/domain/result.js";
import { LINK_COMMAND_NAME, LINK_METADATA_VERSION, type LinkPlan, type ResolvedLinkTarget, type VirtualLoadoutSpec } from "../src/link/types.js";
import type { Loadout } from "../src/domain/loadout.js";
import type { MateriaCatalog } from "../src/domain/materia.js";

const materia = {
  Build: { id: "Build", type: "agent", behavior: { id: "Build" }, tools: "coding", prompt: "build", parse: "json" },
  Eval: { id: "Eval", type: "agent", behavior: { id: "Eval" }, tools: "none", prompt: "eval" },
  "Chain-Context": { id: "Chain-Context", type: "agent", behavior: { id: "Chain-Context" }, tools: "none", prompt: "context" },
} satisfies MateriaCatalog;

function target(order: number, kind: "materia" | "loadout", id: string): ResolvedLinkTarget {
  return { order, kind, id, requested: { order, raw: `${kind}:${id}`, prefix: kind, name: id }, displayName: id } as ResolvedLinkTarget;
}

function plan(targets: ResolvedLinkTarget[]): LinkPlan {
  return {
    version: LINK_METADATA_VERSION,
    invocation: { command: LINK_COMMAND_NAME, arguments: "Build Consult -- prompt" },
    prompt: "prompt",
    targets,
    lineage: { targetSequence: targets, invocation: { command: LINK_COMMAND_NAME, arguments: "Build Consult -- prompt" } },
  };
}

describe("/materia link compiler", () => {
  test("exports a shared virtual-loadout compiler usable by single-materia autocast", async () => {
    const compilerModule = await import("../src/link/compiler.js");
    const compileVirtualLoadoutFromResolvedTargets = (compilerModule as unknown as {
      compileVirtualLoadoutFromResolvedTargets?: (input: { targets: ResolvedLinkTarget[]; source: ReturnType<typeof createConfigLinkGraphSource>; virtualLoadout: { id: string; name: string } }) => DomainResult<VirtualLoadoutSpec | { virtualLoadout: VirtualLoadoutSpec }>;
    }).compileVirtualLoadoutFromResolvedTargets;

    expect(typeof compileVirtualLoadoutFromResolvedTargets).toBe("function");
    if (!compileVirtualLoadoutFromResolvedTargets) return;

    const targets = [target(0, "materia", "Build")];
    const result = compileVirtualLoadoutFromResolvedTargets({
      targets,
      source: createConfigLinkGraphSource({ materia }),
      virtualLoadout: { id: "virtual-autocast-materia-Build", name: "Autocast virtual loadout: Build" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const spec = "virtualLoadout" in result.value ? result.value.virtualLoadout : result.value;
    expect(spec.loadout).toEqual({ id: "virtual-autocast-materia-Build", entry: "Socket-1", sockets: { "Socket-1": { materia: "Build", parse: "json" } } });
    expect(spec.metadata).toMatchObject({
      id: "virtual-autocast-materia-Build",
      name: "Autocast virtual loadout: Build",
      targets,
      remappings: [{ targetOrder: 0, fromSocketId: "Socket-1", toSocketId: "Socket-1" }],
      stitching: [],
    });
  });

  test("accepts terminal advance.done end sentinel during link-time loadout validation", () => {
    const hojoConsult: Loadout = {
      id: "Hojo-Consult",
      entry: "Socket-7",
      sockets: {
        "Socket-7": { materia: "Build", advance: { cursor: "items", items: "$.items", done: "end" } },
      },
    };

    const result = compileLinkPlan(
      { plan: plan([target(0, "materia", "Chain-Context"), target(1, "loadout", "Hojo-Consult")]) },
      createConfigLinkGraphSource({ materia, loadouts: { "Hojo-Consult": hojoConsult } }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.virtualLoadout.loadout.sockets["Socket-2"]?.advance?.done).toBe("end");
  });

  test("rejects unknown non-sentinel advance.done targets during link-time loadout validation", () => {
    const broken: Loadout = {
      id: "Broken",
      entry: "Socket-7",
      sockets: {
        "Socket-7": { materia: "Build", advance: { cursor: "items", items: "$.items", done: "missing" } },
      },
    };

    const result = compileLinkPlan(
      { plan: plan([target(0, "loadout", "Broken")]) },
      createConfigLinkGraphSource({ materia, loadouts: { Broken: broken } }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      {
        path: "link.targets.0.loadout.sockets.Socket-7.advance.done",
        message: "advance exhaustion target must reference an existing socket or terminal end",
      },
    ]);
  });

  test("composes materia-to-materia targets with deterministic stitching", () => {
    const inputPlan = plan([target(0, "materia", "Build"), target(1, "materia", "Eval")]);

    const result = compileLinkPlan({ plan: inputPlan }, createConfigLinkGraphSource({ materia }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.virtualLoadout.loadout).toMatchObject({
      id: "virtual-link-materia-Build-materia-Eval",
      entry: "Socket-1",
      sockets: {
        "Socket-1": { materia: "Build", parse: "json", edges: [{ when: "always", to: "Socket-2" }] },
        "Socket-2": { materia: "Eval" },
      },
    });
    expect(result.value.virtualLoadout.metadata.stitching).toEqual([
      { fromTargetOrder: 0, toTargetOrder: 1, fromSocketId: "Socket-1", toSocketId: "Socket-2", mode: "implicit-single-compatible" },
    ]);
  });

  test("remaps linked loadout loop metadata and preserves terminal targets without mutating source", () => {
    const iterative: Loadout = {
      id: "Iterative",
      entry: "Socket-7",
      sockets: {
        "Socket-7": { materia: "Build", edges: [{ when: "always", to: "Socket-8" }] },
        "Socket-8": { materia: "Eval", foreach: { items: "$.items", done: "Socket-10" } },
        "Socket-9": { materia: "Build", advance: { cursor: "items", items: "$.items", done: "end" } },
        "Socket-10": { materia: "Eval" },
      },
      loops: {
        work: {
          sockets: ["Socket-7", "Socket-8", "Socket-9"],
          consumes: { from: "Socket-7", done: "Socket-8" },
          iterator: { items: "$.items", done: "Socket-10" },
          exit: { from: "Socket-9", when: "satisfied", to: "Socket-10" },
          exits: [
            { id: "route", from: "Socket-9", condition: "not_satisfied", targetSocketId: "Socket-10" },
            { id: "terminal", from: "Socket-9", condition: "always", targetSocketId: "end" },
          ],
        },
      },
    };
    const before = JSON.stringify(iterative);

    const result = compileLinkPlan({ plan: plan([target(0, "materia", "Chain-Context"), target(1, "loadout", "Iterative")]) }, createConfigLinkGraphSource({ materia, loadouts: { Iterative: iterative } }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(iterative)).toBe(before);
    expect(result.value.virtualLoadout.loadout.sockets["Socket-2"]?.edges).toEqual([{ when: "always", to: "Socket-3" }]);
    expect(result.value.virtualLoadout.loadout.sockets["Socket-3"]?.foreach?.done).toBe("Socket-5");
    expect(result.value.virtualLoadout.loadout.sockets["Socket-4"]?.advance?.done).toBe("end");
    expect(result.value.virtualLoadout.loadout.loops?.["t1-work"]).toMatchObject({
      sockets: ["Socket-2", "Socket-3", "Socket-4"],
      consumes: { from: "Socket-2", done: "Socket-3" },
      iterator: { done: "Socket-5" },
      exit: { from: "Socket-4", when: "satisfied", to: "Socket-5" },
      exits: [
        { id: "route", from: "Socket-4", condition: "not_satisfied", targetSocketId: "Socket-5" },
        { id: "terminal", from: "Socket-4", condition: "always", targetSocketId: "end" },
      ],
    });
  });

  test("composes loadout-to-loadout targets while remapping colliding socket ids", () => {
    const first: Loadout = { entry: "Socket-1", sockets: { "Socket-1": { materia: "Build", edges: [{ when: "satisfied", to: "Socket-2" }] }, "Socket-2": { materia: "Eval", socketKind: "entry" } } };
    const second: Loadout = { entry: "Socket-1", sockets: { "Socket-1": { materia: "Eval", edges: [{ when: "satisfied", to: "Socket-2" }] }, "Socket-2": { materia: "Build" } } };

    const result = compileLinkPlan({ plan: plan([target(0, "loadout", "First"), target(1, "loadout", "Second")]) }, createConfigLinkGraphSource({ materia, loadouts: { First: first, Second: second } }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.virtualLoadout.loadout.sockets).sort()).toEqual(["Socket-1", "Socket-2", "Socket-3", "Socket-4"]);
    expect(result.value.virtualLoadout.loadout.sockets["Socket-1"]?.edges).toEqual([{ when: "satisfied", to: "Socket-2" }]);
    expect(result.value.virtualLoadout.loadout.sockets["Socket-2"]?.edges).toEqual([{ when: "always", to: "Socket-3" }]);
    expect(result.value.virtualLoadout.metadata.remappings).toEqual([
      { targetOrder: 0, fromSocketId: "Socket-1", toSocketId: "Socket-1" },
      { targetOrder: 0, fromSocketId: "Socket-2", toSocketId: "Socket-2" },
      { targetOrder: 1, fromSocketId: "Socket-1", toSocketId: "Socket-3" },
      { targetOrder: 1, fromSocketId: "Socket-2", toSocketId: "Socket-4" },
    ]);
  });

  test("composes materia and loadout targets into an ephemeral stitched virtual loadout", () => {
    const consult: Loadout = {
      id: "Consult",
      entry: "Socket-1",
      sockets: {
        "Socket-1": { materia: "Eval", edges: [{ when: "satisfied", to: "Socket-2" }] },
        "Socket-2": { materia: "Build" },
      },
    };
    const inputPlan = plan([target(0, "materia", "Build"), target(1, "loadout", "Consult")]);
    const before = JSON.stringify(consult);

    const result = compileLinkPlan({ plan: inputPlan }, createConfigLinkGraphSource({ materia, loadouts: { Consult: consult } }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(consult)).toBe(before);
    expect(result.value.virtualLoadout.loadout).toEqual({
      id: "virtual-link-materia-Build-loadout-Consult",
      entry: "Socket-1",
      sockets: {
        "Socket-1": { materia: "Build", parse: "json", edges: [{ when: "always", to: "Socket-2" }] },
        "Socket-2": { materia: "Eval", edges: [{ when: "satisfied", to: "Socket-3" }] },
        "Socket-3": { materia: "Build" },
      },
    });
    expect(result.value.virtualLoadout.metadata.remappings).toEqual([
      { targetOrder: 0, fromSocketId: "Socket-1", toSocketId: "Socket-1" },
      { targetOrder: 1, fromSocketId: "Socket-1", toSocketId: "Socket-2" },
      { targetOrder: 1, fromSocketId: "Socket-2", toSocketId: "Socket-3" },
    ]);
    expect(result.value.virtualLoadout.metadata.stitching).toEqual([
      { fromTargetOrder: 0, toTargetOrder: 1, fromSocketId: "Socket-1", toSocketId: "Socket-2", mode: "implicit-single-compatible" },
    ]);
    expect(inputPlan.lineage.virtualLoadout?.id).toBe("virtual-link-materia-Build-loadout-Consult");
  });

  test("rejects ambiguous implicit terminal stitching instead of guessing", () => {
    const fanout: Loadout = {
      entry: "Socket-1",
      sockets: {
        "Socket-1": { materia: "Build", edges: [{ when: "always", to: "Socket-2" }] },
        "Socket-2": { materia: "Build" },
        "Socket-3": { materia: "Eval" },
      },
    };

    const result = compileLinkPlan({ plan: plan([target(0, "loadout", "Fanout"), target(1, "materia", "Eval")]) }, createConfigLinkGraphSource({ materia, loadouts: { Fanout: fanout } }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toContain("ambiguous implicit terminal stitching");
  });

  test("rejects unsupported cycles in compiled graph", () => {
    const cycle: Loadout = {
      entry: "Socket-1",
      sockets: {
        "Socket-1": { materia: "Build", edges: [{ when: "always", to: "Socket-2" }] },
        "Socket-2": { materia: "Eval", edges: [{ when: "always", to: "Socket-1" }] },
      },
    };

    const result = compileLinkPlan({ plan: plan([target(0, "loadout", "Cycle")]) }, createConfigLinkGraphSource({ materia, loadouts: { Cycle: cycle } }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toContain("unsupported cycle");
  });
});
