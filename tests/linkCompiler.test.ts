import { describe, expect, test } from "bun:test";
import { compileLinkPlan, createConfigLinkGraphSource } from "../src/link/compiler.js";
import { LINK_COMMAND_NAME, LINK_METADATA_VERSION, type LinkPlan, type ResolvedLinkTarget } from "../src/link/types.js";
import type { Loadout } from "../src/domain/loadout.js";
import type { MateriaCatalog } from "../src/domain/materia.js";

const materia = {
  Build: { id: "Build", type: "agent", behavior: { id: "Build" }, tools: "coding", prompt: "build", parse: "json" },
  Eval: { id: "Eval", type: "agent", behavior: { id: "Eval" }, tools: "none", prompt: "eval" },
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
  test("composes materia-to-materia targets with deterministic stitching", () => {
    const inputPlan = plan([target(0, "materia", "Build"), target(1, "materia", "Eval")]);

    const result = compileLinkPlan({ plan: inputPlan }, createConfigLinkGraphSource({ materia }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.virtualLoadout.loadout).toMatchObject({
      id: "virtual-link-materia-Build-materia-Eval",
      entry: "Socket-1",
      sockets: {
        "Socket-1": { type: "agent", materia: "Build", parse: "json", edges: [{ when: "always", to: "Socket-2" }] },
        "Socket-2": { type: "agent", materia: "Eval" },
      },
    });
    expect(result.value.virtualLoadout.metadata.stitching).toEqual([
      { fromTargetOrder: 0, toTargetOrder: 1, fromSocketId: "Socket-1", toSocketId: "Socket-2", mode: "implicit-single-compatible" },
    ]);
  });

  test("composes loadout-to-loadout targets while remapping colliding socket ids", () => {
    const first: Loadout = { entry: "Socket-1", sockets: { "Socket-1": { type: "agent", materia: "Build", edges: [{ when: "satisfied", to: "Socket-2" }] }, "Socket-2": { type: "agent", materia: "Eval", socketKind: "entry" } } };
    const second: Loadout = { entry: "Socket-1", sockets: { "Socket-1": { type: "agent", materia: "Eval", edges: [{ when: "satisfied", to: "Socket-2" }] }, "Socket-2": { type: "agent", materia: "Build" } } };

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
        "Socket-1": { type: "agent", materia: "Eval", edges: [{ when: "satisfied", to: "Socket-2" }] },
        "Socket-2": { type: "agent", materia: "Build" },
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
        "Socket-1": { type: "agent", materia: "Build", parse: "json", edges: [{ when: "always", to: "Socket-2" }] },
        "Socket-2": { type: "agent", materia: "Eval", edges: [{ when: "satisfied", to: "Socket-3" }] },
        "Socket-3": { type: "agent", materia: "Build" },
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
        "Socket-1": { type: "agent", materia: "Build", edges: [{ when: "always", to: "Socket-2" }] },
        "Socket-2": { type: "agent", materia: "Build" },
        "Socket-3": { type: "agent", materia: "Eval" },
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
        "Socket-1": { type: "agent", materia: "Build", edges: [{ when: "always", to: "Socket-2" }] },
        "Socket-2": { type: "agent", materia: "Eval", edges: [{ when: "always", to: "Socket-1" }] },
      },
    };

    const result = compileLinkPlan({ plan: plan([target(0, "loadout", "Cycle")]) }, createConfigLinkGraphSource({ materia, loadouts: { Cycle: cycle } }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toContain("unsupported cycle");
  });
});
