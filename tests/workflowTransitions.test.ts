import { describe, expect, test } from "bun:test";
import { applyGenericHandoffEnvelope } from "../src/application/handoff.js";
import { applyAdvance, applyAssignments, evaluateCondition, resolveEmptyLoopExhaustionTarget, selectNextTarget } from "../src/application/workflowTransitions.js";
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

const config = { materia: { Noop: { utility: "noop" } }, loadouts: {}, activeLoadout: "default" } as PiMateriaConfig;

describe("workflow transitions", () => {
  test("domain routing treats satisfied as the reserved canonical control field", () => {
    expect(evaluateHandoffRouteCondition("satisfied", true)).toBe(true);
    expect(evaluateHandoffRouteCondition("not_satisfied", false)).toBe(true);
    expect(selectMatchingEdge([{ when: "not_satisfied", to: "retry" }, { when: "always", to: "end" }], false)?.to).toBe("retry");
  });

  test("handoff envelope adopts only small-contract agent fields", () => {
    const cast = state();
    const workItems = [{ title: "One", context: "Do one." }];
    applyGenericHandoffEnvelope(cast, { workItems, satisfied: true, context: "done", feedback: "ok", missing: [] });
    expect(cast.data.workItems).toEqual(workItems);
    expect(cast.data.context).toBe("[handoff context] done");
    expect(cast.data.envelope).toEqual({ workItems, satisfied: true, context: "done" });
  });

  test("sparse planner output updates title/context workItems without dropping carried context", () => {
    const cast = state({
      data: {
        envelope: { context: "keep carried context" },
        context: "keep carried context",
        workItems: [{ title: "Old", context: "Old context." }],
      },
    });
    const planner = socket("Planner", { parse: "json" });
    planner.materia = { tools: "readOnly", prompt: "plan", generator: true };
    const workItems = [{ title: "New", context: "New context." }];

    applyGenericHandoffEnvelope(cast, { context: "Plan created.", workItems }, planner);

    expect(cast.data.context).toBe("keep carried context\n\n[Planner Noop] Plan created.");
    expect(cast.data.workItems).toEqual(workItems);
    expect(cast.data.envelope).toEqual({ context: "Plan created.", workItems });
  });

  test("parallel generator atomically adopts workItems and its intrinsic normalized plan", () => {
    const cast = state({ data: { workItems: [{ title: "Old", context: "Old." }], parallelSchedule: { stale: true } } });
    const planner = {
      id: "Parallel-Planner",
      socket: { id: "Parallel-Planner", type: "agent", materia: "Planner", parse: "json" },
      materia: { tools: "readOnly", prompt: "plan", generator: true, parallel: true },
    } as ResolvedMateriaSocket;
    const output = {
      workItems: [{ title: "New", context: "New." }],
      parallelSchedule: { version: 1, streams: [{ name: "main", workItemIndexes: [0] }] },
    };

    applyGenericHandoffEnvelope(cast, output, planner);

    expect(cast.data.workItems).toEqual(output.workItems);
    expect(cast.data.parallelPlan).toMatchObject({
      version: 1,
      workItemCount: 1,
      streams: [{ laneId: "lane-main", name: "main", streamIndex: 0, workItemIndexes: [0] }],
    });
    expect(cast.data).not.toHaveProperty("parallelSchedule");

    const beforeInvalidCommit = structuredClone(cast.data);
    expect(() => applyGenericHandoffEnvelope(cast, {
      workItems: [{ title: "Broken", context: "Broken." }],
      parallelSchedule: { version: 1, streams: [] },
    }, planner)).toThrow(/not assigned/);
    expect(cast.data).toEqual(beforeInvalidCommit);
  });

  test("sparse evaluator output updates satisfied and context without adopting obsolete evaluator fields", () => {
    const cast = state({
      data: {
        envelope: { context: "Existing" },
        context: "Existing",
      },
    });

    applyGenericHandoffEnvelope(cast, { satisfied: false, context: "Missing route.", feedback: "obsolete", missing: ["obsolete"] }, socket("Eval", { parse: "json" }));

    expect(cast.data.context).toBe("Existing\n\n[Eval Noop] Missing route.");
    expect(cast.data).not.toHaveProperty("feedback");
    expect(cast.data.envelope).toEqual({ context: "Missing route.", satisfied: false });
  });

  test("utility state patches are shallow-merged without workItems or satisfied", () => {
    const cast = state({ data: { existing: true, nested: { old: true }, workItems: [{ title: "Old", context: "Old." }], satisfied: false } });

    applyGenericHandoffEnvelope(cast, { state: { vcs: { kind: "jj" }, nested: { fresh: true }, workItems: [{ title: "New", context: "New." }], satisfied: true } }, socket("DetectVcs", { parse: "json" }));

    expect(cast.data).toMatchObject({ existing: true, vcs: { kind: "jj" }, nested: { fresh: true }, workItems: [{ title: "Old", context: "Old." }], satisfied: false });
  });

  test("obsolete broad-envelope arrays are ignored by generic handoff application", () => {
    const cast = state({ data: { decisions: ["old"], risks: ["old risk"], envelope: { decisions: ["old"], risks: ["old risk"] } } });

    applyGenericHandoffEnvelope(cast, { decisions: [], risks: [] });

    expect(cast.data.decisions).toEqual(["old"]);
    expect(cast.data.risks).toEqual(["old risk"]);
    expect(cast.data.envelope).toEqual({ decisions: ["old"], risks: ["old risk"] });
  });

  test("selectNextTarget enforces traversal limits while routing on satisfied", () => {
    const cast = state();
    const current = socket("Socket-1", { edges: [{ when: "satisfied", to: "done", maxTraversals: 1 }, { when: "always", to: "fallback" }] });
    expect(selectNextTarget(cast, current, { satisfied: true }, config)).toBe("done");
    expect(() => selectNextTarget(cast, current, { satisfied: true }, config)).toThrow(/edge traversal limit exceeded/);
  });

  test("explicit retry traversals are scoped per work item with a stable scoped key", () => {
    const cast = state();
    const current = socket("Socket-1", { edges: [{ when: "not_satisfied", to: "retry", maxTraversals: 2 }, { when: "always", to: "done" }] });
    cast.currentItemKey = "WI-1";
    // WI-1 consumes its own two retries, then exhausts.
    expect(selectNextTarget(cast, current, { satisfied: false }, config)).toBe("retry");
    expect(selectNextTarget(cast, current, { satisfied: false }, config)).toBe("retry");
    expect(() => selectNextTarget(cast, current, { satisfied: false }, config)).toThrow(/edge traversal limit exceeded/);
    // WI-2 starts a fresh budget on the same edge; WI-1's consumption does not count against it.
    cast.currentItemKey = "WI-2";
    expect(selectNextTarget(cast, current, { satisfied: false }, config)).toBe("retry");
    expect(selectNextTarget(cast, current, { satisfied: false }, config)).toBe("retry");
    expect(() => selectNextTarget(cast, current, { satisfied: false }, config)).toThrow(/edge traversal limit exceeded/);
    // Stable scoped retry counts remain item-independent while aggregate diagnostics accumulate.
    expect(cast.scopedEdgeRetries).toMatchObject({ "Socket-1->retry@WI-1": 3, "Socket-1->retry@WI-2": 3 });
    expect(cast.edgeTraversals["Socket-1->retry"]).toBe(6);
    // Revived-aware allowances are scoped by the same edge-and-item identity so
    // reviving WI-1's exhausted retry never changes WI-2's allowance.
    expect(cast.edgeAllowances).toMatchObject({ "Socket-1->retry@WI-1": { originalLimit: 2, effectiveLimit: 2, reviveCount: 0 }, "Socket-1->retry@WI-2": { originalLimit: 2, effectiveLimit: 2, reviveCount: 0 } });
    expect(cast.edgeAllowances?.["Socket-1->retry"]).toBeUndefined();
  });

  test("retry traversals outside item loops use a singleton scope", () => {
    const cast = state();
    const current = socket("Socket-1", { edges: [{ when: "not_satisfied", to: "retry", maxTraversals: 1 }] });
    expect(selectNextTarget(cast, current, { satisfied: false }, config)).toBe("retry");
    expect(() => selectNextTarget(cast, current, { satisfied: false }, config)).toThrow(/edge traversal limit exceeded/);
    expect(cast.scopedEdgeRetries).toEqual({ "Socket-1->retry": 2 });
    expect(cast.edgeAllowances).toEqual({ "Socket-1->retry": { originalLimit: 1, effectiveLimit: 1, reviveCount: 0 } });
  });

  test("edges without explicit maxTraversals remain unbounded retry budgets", () => {
    const cast = state();
    const current = socket("Socket-1", { edges: [{ when: "not_satisfied", to: "retry" }] });
    for (let index = 0; index < 40; index += 1) {
      expect(selectNextTarget(cast, current, { satisfied: false }, config)).toBe("retry");
    }
    // Aggregate diagnostics keep counting; no scoped retry budget is created.
    expect(cast.edgeTraversals["Socket-1->retry"]).toBe(40);
    expect(cast.scopedEdgeRetries).toBeUndefined();
  });

  test("routing and advancement use current parsed satisfied instead of stale carried state", () => {
    const cast = state({ data: { satisfied: true, workItems: [{ id: "one" }] }, lastJson: { satisfied: true } });
    const current = socket("Socket-1", {
      edges: [{ when: "satisfied", to: "done" }, { when: "not_satisfied", to: "retry" }],
      advance: { cursor: "workItemIndex", items: "state.workItems", when: "satisfied" },
    });

    expect(evaluateCondition("satisfied", cast, { satisfied: false })).toBe(false);
    expect(applyAdvance(cast, current, { satisfied: false })).toBeUndefined();
    expect(cast.cursors.workItemIndex).toBeUndefined();
    expect(selectNextTarget(cast, current, { satisfied: false }, config)).toBe("retry");
  });

  test("assignment uses current sparse parsed payload paths, including custom nested outputs", () => {
    const cast = state({ data: { checkpoint: { created: false }, commands: ["old"], meta: { label: "old" } } });
    const current = {
      id: "Maintain",
      socket: {
        materia: "Maintain",
        parse: "json",
        assign: {
          "checkpoint.created": "$.checkpointCreated",
          commands: "$.commands",
          "meta.label": "$.artifacts.0.label",
        },
      },
      materia: { tools: "coding", prompt: "maintain" },
    } satisfies ResolvedMateriaSocket;

    applyAssignments(cast, current, { checkpointCreated: true, commands: ["jj status"], artifacts: [{ label: "snapshot" }] });

    expect(cast.data.checkpoint).toEqual({ created: true });
    expect(cast.data.commands).toEqual(["jj status"]);
    expect(cast.data.meta).toEqual({ label: "snapshot" });
  });

  test("explicit $.text assignment is the durable handoff path into run state", () => {
    const cast = state({ data: {} });
    const current = {
      id: "Narrate",
      socket: { materia: "Narrate", parse: "json", assign: { prNotes: "$.text" } },
      materia: { tools: "readOnly", prompt: "narrate" },
    } satisfies ResolvedMateriaSocket;

    applyAssignments(cast, current, { satisfied: true, context: "internal only", text: "## Summary\n\nShipped the feature." });

    // Renderable text is persisted into a named state slot by explicit
    // assignment, while the surrounding handoff metadata is not mirrored.
    expect(cast.data.prNotes).toBe("## Summary\n\nShipped the feature.");
    expect(cast.data.envelope).toBeUndefined();
    expect(cast.data).not.toHaveProperty("texts");
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

    expect(resolveEmptyLoopExhaustionTarget(cast, current, "Unused-Done")).toBe("Socket-3");

    const noExitCast = state({
      data: { workItems: [] },
      pipeline: { entry: socket("Socket-1"), sockets: { "Socket-2": current }, loops: { work: { sockets: ["Socket-2"] } } },
    });
    expect(resolveEmptyLoopExhaustionTarget(noExitCast, current, "Unused-Done")).toBe("end");
  });

  test("advance exhaustion without loop metadata falls through to end", () => {
    const current = socket("Socket-2", { advance: { cursor: "workItemIndex", items: "state.workItems", when: "satisfied" } });
    const cast = state({ data: { workItems: [{ id: "one" }] }, pipeline: { entry: socket("Socket-1"), sockets: { "Socket-2": current }, loops: {} } });

    expect(applyAdvance(cast, current, { satisfied: true })).toBe("end");
  });

  test("same-item satisfied and not_satisfied edges continue routing when advance does not exhaust", () => {
    const current = socket("Socket-2", {
      advance: { cursor: "workItemIndex", items: "state.workItems", when: "satisfied" },
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
