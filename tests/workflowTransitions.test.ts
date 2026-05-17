import { describe, expect, test } from "bun:test";
import { applyGenericHandoffEnvelope } from "../src/application/handoff.js";
import { applyAdvance, resolveEmptyLoopExhaustionTarget, selectNextTarget } from "../src/application/workflowTransitions.js";
import { evaluateHandoffRouteCondition, selectMatchingEdge } from "../src/domain/routing.js";
import type { MateriaCastState, PiMateriaConfig, ResolvedMateriaSocket } from "../src/types.js";

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

function socket(id: string, config: Partial<ResolvedMateriaSocket["socket"]> = {}): ResolvedMateriaSocket {
  return {
    id,
    socket: { id, type: "utility", materia: "Noop", ...config },
    materiaId: "Noop",
    materia: { type: "utility", utility: "noop" },
  } as ResolvedMateriaSocket;
}

const config = { materia: { Noop: { type: "utility", utility: "noop" } }, loadouts: {}, activeLoadout: "default" } as PiMateriaConfig;

describe("workflow transitions", () => {
  test("domain routing treats satisfied as the reserved canonical control field", () => {
    expect(evaluateHandoffRouteCondition("satisfied", true)).toBe(true);
    expect(evaluateHandoffRouteCondition("not_satisfied", false)).toBe(true);
    expect(selectMatchingEdge([{ when: "not_satisfied", to: "retry" }, { when: "always", to: "end" }], false)?.to).toBe("retry");
  });

  test("handoff envelope adopts canonical workItems and preserves evaluator fields", () => {
    const cast = state();
    applyGenericHandoffEnvelope(cast, { workItems: [{ id: "one" }], satisfied: true, feedback: "ok", missing: [] });
    expect(cast.data.workItems).toEqual([{ id: "one" }]);
    expect(cast.data.envelope).toMatchObject({ workItems: [{ id: "one" }], satisfied: true, feedback: "ok", missing: [] });
  });

  test("selectNextTarget enforces traversal limits while routing on satisfied", () => {
    const cast = state();
    const current = socket("Socket-1", { edges: [{ when: "satisfied", to: "done", maxTraversals: 1 }, { when: "always", to: "fallback" }] });
    expect(selectNextTarget(cast, current, { satisfied: true }, config)).toBe("done");
    expect(() => selectNextTarget(cast, current, { satisfied: true }, config)).toThrow(/edge traversal limit exceeded/);
  });

  test("advance increments cursor and routes final-item exhaustion through canonical loop exits", () => {
    const current = socket("Socket-2", { advance: { cursor: "workItemIndex", items: "state.workItems", done: "Legacy-Done", when: "satisfied" } });
    const cast = state({
      data: { workItems: [{ id: "one" }, { id: "two" }] },
      cursors: { workItemIndex: 0 },
      pipeline: {
        entry: socket("Socket-1"),
        sockets: { "Socket-2": current, "Socket-3": socket("Socket-3") },
        loops: { work: { sockets: ["Socket-2"], exits: [{ id: "after-work", from: "Socket-2", condition: "satisfied", targetSocketId: "Socket-3" }] } },
      },
    });

    expect(applyAdvance(cast, current, { satisfied: true })).toBeUndefined();
    expect(cast.cursors.workItemIndex).toBe(1);
    expect(applyAdvance(cast, current, { satisfied: true })).toBe("Socket-3");
    expect(cast.cursors.workItemIndex).toBe(2);
  });

  test("loop exhaustion without a matching canonical exit falls through to terminal end", () => {
    const current = socket("Socket-2", { advance: { cursor: "workItemIndex", items: "state.workItems", done: "Legacy-Done", when: "satisfied" } });
    const cast = state({
      data: { workItems: [{ id: "one" }] },
      pipeline: {
        entry: socket("Socket-1"),
        sockets: { "Socket-2": current, "Socket-3": socket("Socket-3") },
        loops: { work: { sockets: ["Socket-2"], exits: [{ id: "after-work", from: "Socket-2", condition: "not_satisfied", targetSocketId: "Socket-3" }] } },
      },
    });

    expect(applyAdvance(cast, current, { satisfied: true })).toBe("end");
    expect(cast.cursors.workItemIndex).toBe(1);
  });

  test("empty-loop entry uses canonical exit-or-terminal semantics", () => {
    const current = socket("Socket-2");
    const cast = state({
      data: { workItems: [] },
      pipeline: {
        entry: socket("Socket-1"),
        sockets: { "Socket-2": current, "Socket-3": socket("Socket-3") },
        loops: { work: { sockets: ["Socket-2"], exits: [{ id: "empty", from: "Socket-2", condition: "always", targetSocketId: "Socket-3" }] } },
      },
    });

    expect(resolveEmptyLoopExhaustionTarget(cast, current, "Legacy-Done")).toBe("Socket-3");

    const noExitCast = state({
      data: { workItems: [] },
      pipeline: { entry: socket("Socket-1"), sockets: { "Socket-2": current }, loops: { work: { sockets: ["Socket-2"] } } },
    });
    expect(resolveEmptyLoopExhaustionTarget(noExitCast, current, "Legacy-Done")).toBe("end");
  });

  test("legacy advance.done fallback is migration-only when no loop metadata owns the socket", () => {
    const current = socket("Socket-2", { advance: { cursor: "workItemIndex", items: "state.workItems", done: "Legacy-Done", when: "satisfied" } });
    const cast = state({ data: { workItems: [{ id: "one" }] }, pipeline: { entry: socket("Socket-1"), sockets: { "Socket-2": current }, loops: {} } });

    expect(applyAdvance(cast, current, { satisfied: true })).toBe("Legacy-Done");
  });

  test("same-item satisfied and not_satisfied edges continue routing when advance does not exhaust", () => {
    const current = socket("Socket-2", {
      advance: { cursor: "workItemIndex", items: "state.workItems", done: "end", when: "satisfied" },
      edges: [{ when: "not_satisfied", to: "Socket-2" }, { when: "satisfied", to: "Socket-3" }],
    });
    const cast = state({ data: { workItems: [{ id: "one" }, { id: "two" }] }, pipeline: { entry: socket("Socket-1"), sockets: { "Socket-2": current, "Socket-3": socket("Socket-3") }, loops: { work: { sockets: ["Socket-2"] } } } });

    expect(applyAdvance(cast, current, { satisfied: false })).toBeUndefined();
    expect(cast.cursors.workItemIndex).toBeUndefined();
    expect(selectNextTarget(cast, current, { satisfied: false }, config)).toBe("Socket-2");
    expect(applyAdvance(cast, current, { satisfied: true })).toBeUndefined();
    expect(cast.cursors.workItemIndex).toBe(1);
    expect(selectNextTarget(cast, current, { satisfied: true }, config)).toBe("Socket-3");
  });
});
