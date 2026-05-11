import { describe, expect, test } from "bun:test";
import { applyGenericHandoffEnvelope } from "../src/application/handoff.js";
import { applyAdvance, selectNextTarget } from "../src/application/workflowTransitions.js";
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
    currentNode: "Socket-1",
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
    socket: { id, type: "utility", utility: "noop", ...config },
  } as ResolvedMateriaSocket;
}

const config = { materia: {}, loadouts: {}, activeLoadout: "default" } as PiMateriaConfig;

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

  test("advance increments cursor and returns done only after the final item", () => {
    const cast = state({ data: { workItems: [{ id: "one" }, { id: "two" }] }, cursors: { workItemIndex: 0 } });
    const current = socket("Socket-2", { advance: { cursor: "workItemIndex", items: "state.workItems", done: "end", when: "satisfied" } });
    expect(applyAdvance(cast, current, { satisfied: true })).toBeUndefined();
    expect(cast.cursors.workItemIndex).toBe(1);
    expect(applyAdvance(cast, current, { satisfied: true })).toBe("end");
  });
});
