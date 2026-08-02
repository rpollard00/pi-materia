import { describe, expect, test } from "bun:test";
import { createFakeChildCastRunner } from "../src/application/index.js";
import { createBaseExecutionScope, createExecutionScope } from "../src/domain/executionScope.js";
import { ParallelLoopDispatcher } from "../src/runtime/parallelDispatcher.js";
import type { MateriaCastState } from "../src/types.js";

function makeState(): MateriaCastState {
  const baseScope = createExecutionScope({
    ...createBaseExecutionScope("cast-1", "/repo"),
    state: { bookmark: "shared-on-purpose", nested: { value: 1 } },
    exports: { seed: { producer: "test", value: { key: "value" } } },
  });
  const pipeline = {
    entry: "Socket-1",
    sockets: {
      "Socket-1": { materia: "Planner", edges: [{ when: "always", to: "Socket-2" }] },
      "Socket-2": { materia: "Build", edges: [{ when: "always", to: "Socket-3" }] },
      "Socket-3": { materia: "Eval", edges: [{ when: "always", to: "Socket-2" }] },
    },
    loops: {
      build: {
        sockets: ["Socket-2", "Socket-3"],
        consumes: { from: "Socket-1", output: "workItems" },
        iterator: { items: "state.workItems", as: "workItem", cursor: "workItemIndex", done: "end" },
        parallel: { maxConcurrency: 2 },
      },
    },
  } as any;
  return {
    version: 2, active: true, castId: "cast-1", request: "build", configSource: "test", configHash: "config-1",
    cwd: "/repo", baseScope, activeScope: baseScope, branchScopes: {}, runDir: "/repo/run", artifactRoot: "/repo/artifacts",
    phase: "Socket-2", currentSocketId: "Socket-2", awaitingResponse: false, socketState: "idle", startedAt: 1, updatedAt: 1,
    parallelRuns: {},
    data: {
      workItems: [{ title: "one", context: "one" }, { title: "two", context: "two" }, { title: "three", context: "three" }],
      parallelPlan: { version: 1, planId: "plan-1", workItemCount: 3, streams: [
        { laneId: "lane-a", name: "a", streamIndex: 0, workItemIndexes: [0] },
        { laneId: "lane-b", name: "b", streamIndex: 1, workItemIndexes: [1] },
        { laneId: "lane-c", name: "c", streamIndex: 2, workItemIndexes: [2] },
      ] },
    },
    cursors: {}, visits: {}, taskAttempts: {}, edgeTraversals: {},
    runState: { runId: "run-1", startedAt: 1, runDir: "/repo/run", eventsFile: "/repo/run/events.jsonl", usageFile: "/repo/run/usage.json", usage: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, byMateria: {}, bySocket: {}, byTask: {}, byAttempt: {} }, budgetWarned: false },
    pipeline,
  } as MateriaCastState;
}

function dispatcher(childRunner = createFakeChildCastRunner({ now: () => 10 }), extra: Record<string, unknown> = {}) {
  return { childRunner, dispatcher: new ParallelLoopDispatcher({ children: childRunner, state: { saveCastState: () => undefined }, ...extra } as any) };
}

async function flush(childRunner: ReturnType<typeof createFakeChildCastRunner>) {
  await childRunner.drain();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("workspace-neutral parallel loop dispatcher", () => {
  test("clones the base execution scope for each bounded branch and permits a shared cwd", async () => {
    const state = makeState();
    const { childRunner, dispatcher: subject } = dispatcher();
    await subject.dispatch({ pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: { maxConcurrency: 2 } });

    const started = childRunner.listSnapshots();
    expect(started).toHaveLength(2);
    expect(started.map((child) => child.cwd)).toEqual(["/repo", "/repo"]);
    expect(started.map((child) => child.executionScope.id)).toEqual([
      "cast:cast-1:base:branch:build:lane-a",
      "cast:cast-1:base:branch:build:lane-b",
    ]);
    expect(started[0]!.executionScope.state).toEqual(state.baseScope.state);
    expect(started[0]!.executionScope.state).not.toBe(state.baseScope.state);
    expect(Object.keys(state.branchScopes)).toEqual(started.map((child) => child.executionScope.id));
    expect(state.parallelRuns?.build?.baseline).toBeUndefined();
    expect(state.parallelRuns?.build?.lanes["lane-a"]?.workspace).toBeUndefined();
  });

  test("queues in stream order and accepts opaque outputs without revision heads", async () => {
    const state = makeState();
    const events: Array<{ type: string; data: any }> = [];
    const { childRunner, dispatcher: subject } = dispatcher(undefined, { artifacts: { appendEvent: async (_run: unknown, type: string, data: unknown) => events.push({ type, data }) } });
    await subject.dispatch({ pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: { maxConcurrency: 2 } });
    const laneA = childRunner.listSnapshots().find((child) => child.identity.laneId === "lane-a")!;
    childRunner.complete(laneA.identity.childCastId, { output: { satisfied: true, result: "A" } });
    await flush(childRunner);

    expect(childRunner.listSnapshots().map((child) => child.identity.laneId)).toEqual(["lane-a", "lane-b", "lane-c"]);
    for (const child of childRunner.listSnapshots().filter((entry) => entry.identity.laneId !== "lane-a")) {
      childRunner.complete(child.identity.childCastId, { output: { result: child.identity.laneId } });
    }
    await flush(childRunner);

    const run = state.parallelRuns!.build!;
    expect(run.phase).toBe("fan_in");
    expect(run.fanInPhase).toBe("ready");
    expect(run.lanes["lane-a"]?.acceptedHead).toBeUndefined();
    expect(run.lanes["lane-a"]?.terminalOutput).toEqual({ satisfied: true, result: "A" });
    expect(events.find((event) => event.type === "parallel_branches_terminal")?.data.orderedBranches.map((branch: any) => branch.laneId)).toEqual(["lane-a", "lane-b", "lane-c"]);
  });

  test("aggregates usage and preserves event forwarding", async () => {
    const state = makeState();
    const forwarded: any[] = [];
    const { childRunner, dispatcher: subject } = dispatcher(undefined, { artifacts: { appendEvent: async (_run: unknown, type: string, data: unknown) => forwarded.push({ type, data }) } });
    await subject.dispatch({ pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: { maxConcurrency: 1 } });
    const child = childRunner.listSnapshots()[0]!;
    const usage = { tokens: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5 }, cost: { input: 0.2, output: 0.3, cacheRead: 0, cacheWrite: 0, total: 0.5 } };
    childRunner.emit(child.identity.childCastId, { type: "socket_output", usage });
    await flush(childRunner);

    expect(state.runState.usage.tokens.total).toBe(5);
    expect(state.runState.usage.cost.total).toBe(0.5);
    expect(forwarded.some((event) => event.type === "parallel_child_event" && event.data.provenance.laneId === "lane-a")).toBe(true);
  });

  test("cancels active and queued branches without workspace cleanup", async () => {
    const state = makeState();
    const { childRunner, dispatcher: subject } = dispatcher();
    await subject.dispatch({ pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: { maxConcurrency: 2 } });
    await subject.cancel({ pi: {} as any, state, loopId: "build", reason: "parent abort" });
    await flush(childRunner);

    expect(childRunner.listSnapshots().every((child) => child.status === "interrupted")).toBe(true);
    expect(state.parallelRuns?.build?.phase).toBe("failed");
    expect(Object.values(state.parallelRuns?.build?.lanes ?? {}).every((lane) => lane.status === "interrupted")).toBe(true);
    expect(Object.values(state.parallelRuns?.build?.lanes ?? {}).every((lane) => lane.workspace === undefined)).toBe(true);
  });

  test("rehydrates persisted running children when cancellation uses a fresh dispatcher", async () => {
    const state = makeState();
    const initial = dispatcher();
    await initial.dispatcher.dispatch({ pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: { maxConcurrency: 2 } });

    const fresh = dispatcher(initial.childRunner).dispatcher;
    await fresh.cancel({ pi: {} as any, state, loopId: "build", reason: "revived parent abort" });
    await flush(initial.childRunner);

    expect(initial.childRunner.listSnapshots().every((child) => child.status === "interrupted")).toBe(true);
    expect(state.parallelRuns?.build?.phase).toBe("failed");
    expect(Object.values(state.parallelRuns?.build?.lanes ?? {}).every((lane) => lane.status === "interrupted")).toBe(true);
  });

  test("fresh cancellation skips an earlier terminal run and cancels every nonterminal persisted run", async () => {
    const state = makeState();
    const initial = dispatcher();
    await initial.dispatcher.dispatch({ pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: { maxConcurrency: 2 } });
    const running = state.parallelRuns!.build!;
    const earlier = structuredClone(running);
    earlier.loopId = "earlier";
    earlier.runId = "earlier-run";
    earlier.phase = "completed";
    earlier.fanInPhase = "accepted";
    for (const lane of Object.values(earlier.lanes)) lane.status = "accepted";
    const queued = structuredClone(running);
    queued.loopId = "queued";
    queued.runId = "queued-run";
    queued.configIdentity.loopId = "queued";
    for (const lane of Object.values(queued.lanes)) {
      lane.status = "queued";
      lane.childCastId = undefined;
    }
    state.parallelRuns = { earlier, queued, build: running };

    const fresh = dispatcher(initial.childRunner).dispatcher;
    await fresh.cancel({ pi: {} as any, state, reason: "revived parent abort" });
    await flush(initial.childRunner);

    expect(state.parallelRuns.earlier?.phase).toBe("completed");
    expect(state.parallelRuns.queued?.phase).toBe("failed");
    expect(Object.values(state.parallelRuns.queued?.lanes ?? {}).every((lane) => lane.status === "interrupted")).toBe(true);
    expect(state.parallelRuns.build?.phase).toBe("failed");
    expect(Object.values(state.parallelRuns.build?.lanes ?? {}).every((lane) => lane.status === "interrupted")).toBe(true);
    expect(initial.childRunner.listSnapshots().every((child) => child.status === "interrupted")).toBe(true);
  });

  test("observes cumulative usage before cancellation when event delivery is delayed", async () => {
    const state = makeState();
    const childRunner = createFakeChildCastRunner({ now: () => 10 });
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    const children = {
      start: (input: any) => childRunner.start(input),
      resume: (input: any) => childRunner.resume(input),
      abort: (input: any) => childRunner.abort(input),
      observe: (input: any) => childRunner.observe(input),
      subscribe: (input: any, observer: any) => childRunner.subscribe(input, {
        ...observer,
        onEvent: async (event: any) => { await delayed; await observer.onEvent?.(event); },
      }),
    };
    const subject = new ParallelLoopDispatcher({ children, state: { saveCastState: () => undefined } } as any);
    await subject.dispatch({ pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: { maxConcurrency: 1 } });
    const child = childRunner.listSnapshots()[0]!;
    childRunner.emit(child.identity.childCastId, {
      type: "socket_output",
      usage: { tokens: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, total: 7 }, cost: { input: 0.3, output: 0.4, cacheRead: 0, cacheWrite: 0, total: 0.7 } },
    });

    await subject.cancel({ pi: {} as any, state, loopId: "build" });
    expect(state.runState.usage.tokens.total).toBe(7);
    expect(state.runState.usage.cost.total).toBeCloseTo(0.7);
    release();
    await flush(childRunner);
    expect(state.runState.usage.tokens.total).toBe(7);
  });
});
