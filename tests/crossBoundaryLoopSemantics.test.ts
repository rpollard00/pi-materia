import { describe, expect, test } from "bun:test";
import { applyAdvance, resolveEmptyLoopExhaustionTarget, selectNextTarget } from "../src/application/workflowTransitions.js";
import { evaluateHandoffRouteCondition } from "../src/domain/routing.js";
import type { Loadout } from "../src/domain/loadout.js";
import { validatePipelineGraph } from "../src/graph/graphValidation.js";
import {
  buildLoopExitIndex,
  classifyGraphTarget,
  resolveIndexedLoopExhaustionTarget,
  TERMINAL_GRAPH_TARGET,
} from "../src/graph/graphSemantics.js";
import { materializeLoadoutLoopSemantics } from "../src/graph/loopSemantics.js";
import { compileLinkPlan, createConfigLinkGraphSource } from "../src/link/compiler.js";
import { LINK_COMMAND_NAME, LINK_METADATA_VERSION, type LinkPlan, type ResolvedLinkTarget } from "../src/link/types.js";
import { normalizeLoadedLoadout } from "../src/loadout/loadoutNormalization.js";
import type { MateriaCastState, MateriaPipelineConfig, PiMateriaConfig, ResolvedMateriaSocket } from "../src/types.js";

const materia = {
  planner: { prompt: "Plan", tools: "none", generator: true },
  Build: { id: "Build", type: "agent", behavior: { id: "Build" }, tools: "coding", prompt: "build", parse: "json" },
  Maintain: { id: "Maintain", type: "agent", behavior: { id: "Maintain" }, tools: "coding", prompt: "maintain", parse: "json" },
  Narrate: { id: "Narrate", type: "agent", behavior: { id: "Narrate" }, tools: "none", prompt: "narrate" },
  "Chain-Context": { id: "Chain-Context", type: "agent", behavior: { id: "Chain-Context" }, tools: "none", prompt: "context" },
} satisfies PiMateriaConfig["materia"];

function socket(id: string, config: Partial<ResolvedMateriaSocket["socket"]> = {}): ResolvedMateriaSocket {
  const socketConfig = { materia: "Noop", ...config } as ResolvedMateriaSocket["socket"];
  return { id, socket: socketConfig, materiaId: socketConfig.materia, materia: { type: "utility", utility: "noop" } } as ResolvedMateriaSocket;
}

function state(overrides: Partial<MateriaCastState> = {}): MateriaCastState {
  return {
    version: 1,
    active: true,
    castId: "cast",
    request: "request",
    configSource: "test",
    configHash: "hash",
    cwd: "/tmp",
    runDir: "/tmp/run",
    artifactRoot: "/tmp",
    phase: "Socket-1",
    currentSocketId: "Socket-1",
    currentMateria: "Materia",
    awaitingResponse: false,
    startedAt: 0,
    updatedAt: 0,
    data: {},
    cursors: {},
    visits: {},
    edgeTraversals: {},
    runState: {
      runId: "cast",
      startedAt: 0,
      runDir: "/tmp/run",
      eventsFile: "/tmp/run/events.jsonl",
      usageFile: "/tmp/run/usage.json",
      usage: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, costKind: "none" },
      lastMessage: "",
    },
    pipeline: { entry: socket("Socket-1"), sockets: {}, loops: {} },
    ...overrides,
  } as MateriaCastState;
}

function target(order: number, kind: "materia" | "loadout", id: string): ResolvedLinkTarget {
  return { order, kind, id, requested: { order, raw: `${kind}:${id}`, prefix: kind, name: id }, displayName: id } as ResolvedLinkTarget;
}

function plan(targets: ResolvedLinkTarget[]): LinkPlan {
  return {
    version: LINK_METADATA_VERSION,
    invocation: { command: LINK_COMMAND_NAME, arguments: "Chain-Context loadout:UiLoop -- prompt" },
    prompt: "prompt",
    targets,
    lineage: { targetSequence: targets, invocation: { command: LINK_COMMAND_NAME, arguments: "Chain-Context loadout:UiLoop -- prompt" } },
  };
}

function uiAuthoredLoopLoadout(): Loadout {
  return {
    id: "UiLoop",
    entry: "Socket-7",
    sockets: {
      "Socket-7": { materia: "Build", edges: [{ when: "always", to: "Socket-8" }] },
      "Socket-8": { materia: "Maintain", parse: "json", advance: { cursor: "workItemIndex", items: "state.workItems", when: "satisfied", done: "end" }, edges: [{ when: "not_satisfied", to: "Socket-7" }] },
      "Socket-9": { materia: "Narrate" },
    },
    loops: {
      work: {
        sockets: ["Socket-7", "Socket-8"],
        exit: { from: "Socket-8", when: "satisfied", to: "Socket-9" },
        exits: [{ id: "post-loop", from: "Socket-8", condition: "satisfied", targetSocketId: "Socket-9" }],
      },
    },
  };
}

describe("cross-boundary structured loop semantics regressions", () => {
  test("shared semantics and runtime route loop exhaustion through canonical exits", () => {
    const index = buildLoopExitIndex({ work: { sockets: ["Socket-2"], exits: [{ id: "post-loop", from: "Socket-2", condition: "satisfied", targetSocketId: "Socket-3" }] } });
    expect(resolveIndexedLoopExhaustionTarget(index, "Socket-2", { reason: "post-final-item", satisfied: true })).toBe("Socket-3");

    const current = socket("Socket-2", { advance: { cursor: "workItemIndex", items: "state.workItems", when: "satisfied" } });
    const cast = state({
      data: { workItems: [{ id: "one" }] },
      pipeline: {
        entry: socket("Socket-1"),
        sockets: { "Socket-2": current, "Socket-3": socket("Socket-3") },
        loops: { work: { sockets: ["Socket-2"], exits: [{ id: "post-loop", from: "Socket-2", condition: "satisfied", targetSocketId: "Socket-3" }] } },
      },
    });

    expect(applyAdvance(cast, current, { satisfied: true })).toBe("Socket-3");
    expect(cast.cursors.workItemIndex).toBe(1);
  });

  test("loop exhaustion and empty-loop entry fall through to terminal end when no canonical exit route matches", () => {
    const current = socket("Socket-2", { advance: { cursor: "workItemIndex", items: "state.workItems", when: "satisfied" } });
    const cast = state({
      data: { workItems: [{ id: "one" }] },
      pipeline: { entry: socket("Socket-1"), sockets: { "Socket-2": current }, loops: { work: { sockets: ["Socket-2"] } } },
    });

    expect(applyAdvance(cast, current, { satisfied: true })).toBe(TERMINAL_GRAPH_TARGET);
    expect(resolveEmptyLoopExhaustionTarget(cast, current, "Legacy-Done")).toBe(TERMINAL_GRAPH_TARGET);
  });

  test("validation keeps end terminal-only, rejects unknown targets, and leaves same-item control-flow edges alone", () => {
    expect(classifyGraphTarget("end", new Set(["Socket-1"]))).toEqual({ kind: "terminal", target: "end" });
    expect(classifyGraphTarget("Missing", new Set(["Socket-1"]))).toEqual({ kind: "unknown", target: "Missing" });
    expect(evaluateHandoffRouteCondition("satisfied", true)).toBe(true);
    expect(evaluateHandoffRouteCondition("not_satisfied", false)).toBe(true);

    const graph: MateriaPipelineConfig = {
      entry: "Socket-1",
      sockets: {
        "Socket-1": { materia: "Build", edges: [{ when: "always", to: "Socket-2" }] },
        "Socket-2": { materia: "Maintain", parse: "json", advance: { cursor: "workItemIndex", items: "state.workItems", when: "satisfied" }, edges: [{ when: "not_satisfied", to: "Socket-2" }, { when: "satisfied", to: "Socket-3" }] },
        "Socket-3": { materia: "Narrate" },
      },
      loops: { work: { sockets: ["Socket-2"], exits: [{ id: "bad", from: "Socket-2", condition: "satisfied", targetSocketId: "Socket-99" }] } },
    };

    const result = validatePipelineGraph(graph);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "unknown-endpoint", source: "loops.work.exits[0].targetSocketId" }));

    graph.loops!.work.exits![0].targetSocketId = "Socket-3";
    expect(validatePipelineGraph(graph)).toEqual({ ok: true, errors: [] });

    const runtime = state({ pipeline: { entry: socket("Socket-1"), sockets: { "Socket-2": socket("Socket-2", graph.sockets["Socket-2"]), "Socket-3": socket("Socket-3") }, loops: { work: graph.loops!.work } } });
    expect(selectNextTarget(runtime, socket("Socket-2", graph.sockets["Socket-2"]), { satisfied: false }, { materia: {}, loadouts: {}, activeLoadout: "default" } as PiMateriaConfig)).toBe("Socket-2");
  });

  test("materialization emits canonical loop exits and advance without route-bearing done", () => {
    const loadout: MateriaPipelineConfig = {
      entry: "Socket-1",
      sockets: {
        "Socket-1": { materia: "planner", edges: [{ when: "always", to: "Socket-2" }] },
        "Socket-2": { materia: "Build", edges: [{ when: "always", to: "Socket-3" }] },
        "Socket-3": { materia: "Maintain", edges: [{ when: "not_satisfied", to: "Socket-2" }] },
        "Socket-4": { materia: "Narrate" },
      },
      loops: { work: { sockets: ["Socket-2", "Socket-3"], consumes: { from: "Socket-1", output: "workItems" }, exit: { from: "Socket-3", when: "satisfied", to: "Socket-4" } } },
    };

    materializeLoadoutLoopSemantics({ materia }, loadout);

    expect(loadout.sockets["Socket-3"].advance).toEqual({ cursor: "workItemIndex", items: "state.workItems", when: "satisfied" });
    expect(loadout.loops?.work.exits).toEqual([{ id: "exit:Socket-3:satisfied", from: "Socket-3", condition: "satisfied", targetSocketId: "Socket-4" }]);
    expect(validatePipelineGraph(loadout, { isGeneratorSocket: (socketId) => socketId === "Socket-1" })).toEqual({ ok: true, errors: [] });
  });

  test("normalization preserves current advance metadata without mutating the source", () => {
    const current: MateriaPipelineConfig = {
      entry: "Socket-1",
      sockets: {
        "Socket-1": { materia: "Build", edges: [{ when: "always", to: "Socket-2" }] },
        "Socket-2": { materia: "Maintain", advance: { cursor: "workItemIndex", items: "state.workItems", when: "satisfied" } },
      },
      loops: { work: { sockets: ["Socket-2"] } },
    };
    const before = JSON.stringify(current);

    const { loadout } = normalizeLoadedLoadout(current, materia);

    expect(JSON.stringify(current)).toBe(before);
    expect(loadout.sockets["Socket-2"].advance).toEqual({ cursor: "workItemIndex", items: "state.workItems", when: "satisfied" });
    expect(loadout.loops?.work.exits).toBeUndefined();
  });

  test("link compilation remaps UI-authored loop metadata, preserves end, and does not mutate source loadouts", () => {
    const uiLoop = uiAuthoredLoopLoadout();
    const before = JSON.stringify(uiLoop);

    const result = compileLinkPlan(
      { plan: plan([target(0, "materia", "Chain-Context"), target(1, "loadout", "UiLoop")]) },
      createConfigLinkGraphSource({ materia, loadouts: { UiLoop: uiLoop } }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(uiLoop)).toBe(before);
    expect(result.value.virtualLoadout.loadout.sockets["Socket-3"]?.advance?.done).toBe("end");
    expect(result.value.virtualLoadout.loadout.loops?.["t1-work"]).toMatchObject({
      sockets: ["Socket-2", "Socket-3"],
      exit: { from: "Socket-3", when: "satisfied", to: "Socket-4" },
      exits: [{ id: "post-loop", from: "Socket-3", condition: "satisfied", targetSocketId: "Socket-4" }],
    });
  });
});
