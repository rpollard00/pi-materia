import { describe, expect, test } from "bun:test";
import { attachLinkStateData, createLinkPlan, createLinkRuntimeState } from "../src/link/planner.js";
import { LINK_CAST_STATE_KEY, LINK_COMMAND_NAME, PREVIOUS_CAST_CONTEXT_STATE_KEY, type ResolvedLinkTarget, type VirtualLoadoutSpec } from "../src/link/types.js";

function target(order: number): ResolvedLinkTarget {
  return { order, kind: "materia", id: `M${order}`, requested: { order, raw: `materia:M${order}`, prefix: "materia", name: `M${order}` }, displayName: `M${order}` } as ResolvedLinkTarget;
}

const virtualLoadout: VirtualLoadoutSpec = {
  metadata: { id: "virtual-link-materia-M0", name: "Linked: M0", version: 1, targets: [target(0)], remappings: [], stitching: [] },
  loadout: { id: "virtual-link-materia-M0", entry: "Socket-1", sockets: { "Socket-1": { type: "agent", materia: "M0" } } },
};

describe("/materia link planner and chain state", () => {
  test("records lineage metadata including previous cast and virtual loadout", () => {
    const plan = createLinkPlan({
      invocation: { command: LINK_COMMAND_NAME, arguments: "--from cast-1 materia:M0 -- continue" },
      prompt: "continue",
      fromCastId: "cast-1",
      targets: [target(0)],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const runtime = createLinkRuntimeState(virtualLoadout, { castId: "cast-1", request: "prior", artifacts: [], loadedAt: 123 });
    const state = { castId: "cast-2", data: {} as Record<string, unknown> };
    const link = attachLinkStateData(state, plan.value, runtime);

    expect(link.fromCastId).toBe("cast-1");
    expect(link.plan.lineage.castId).toBe("cast-2");
    expect(link.plan.lineage.targetSequence.map((entry) => entry.id)).toEqual(["M0"]);
    expect(link.virtualLoadout.id).toBe("virtual-link-materia-M0");
    expect(state.data[LINK_CAST_STATE_KEY]).toBe(link);
    expect(state.data[PREVIOUS_CAST_CONTEXT_STATE_KEY]).toEqual({ castId: "cast-1", request: "prior", artifacts: [], loadedAt: 123 });
  });

  test("does not attach previous-cast context when no --from context was loaded", () => {
    const plan = createLinkPlan({ invocation: { command: LINK_COMMAND_NAME, arguments: "M0 -- go" }, prompt: "go", targets: [target(0)] });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const state = { data: {} as Record<string, unknown> };
    attachLinkStateData(state, plan.value, createLinkRuntimeState(virtualLoadout));

    expect(state.data[LINK_CAST_STATE_KEY]).toBeTruthy();
    expect(state.data[PREVIOUS_CAST_CONTEXT_STATE_KEY]).toBeUndefined();
  });
});
