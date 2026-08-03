import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakeChildCastRunner } from "../src/application/index.js";
import { createBaseExecutionScope, createExecutionScope } from "../src/domain/executionScope.js";
import { createParallelLaneArtifactStore } from "../src/infrastructure/index.js";
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
  test("notifies the parent session when parallel lanes are queued and spawned", async () => {
    const state = makeState();
    const notifications: string[] = [];
    const { childRunner, dispatcher: subject } = dispatcher();
    await subject.dispatch({
      pi: {} as any,
      ctx: { ui: { notify: (message: string) => notifications.push(message) } } as any,
      state,
      socket: {} as any,
      loopId: "build",
      config: { maxConcurrency: 2 },
    });

    expect(notifications[0]).toContain('parallel loop "build" started');
    expect(notifications[0]).toContain("The parent will continue automatically");
    expect(notifications.filter((message) => message.includes("spawned parallel lane"))).toHaveLength(2);
    expect(childRunner.listSnapshots()).toHaveLength(2);
  });

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
    expect(Object.keys(state.branchScopes)).toEqual([
      "cast:cast-1:base:branch:build:lane-a",
      "cast:cast-1:base:branch:build:lane-b",
      "cast:cast-1:base:branch:build:lane-c",
    ]);
  });

  test("fans in once with outputs and scope exports in stream order", async () => {
    const state = makeState();
    const events: Array<{ type: string; data: any }> = [];
    const fanIns: any[] = [];
    const { childRunner, dispatcher: subject } = dispatcher(undefined, { artifacts: { appendEvent: async (_run: unknown, type: string, data: unknown) => events.push({ type, data }) } });
    await subject.dispatch({
      pi: {} as any,
      ctx: {} as any,
      state,
      socket: {} as any,
      loopId: "build",
      config: { maxConcurrency: 2 },
      onFanIn: async (input) => { fanIns.push(input); },
    });
    const laneA = childRunner.listSnapshots().find((child) => child.identity.laneId === "lane-a")!;
    const replacementScope = createExecutionScope({
      id: `${laneA.executionScope.id}:workspace`,
      cwd: "/tmp/lane-a-workspace",
      state: { bookmark: "lane-a" },
      exports: { workspace: { producer: "spawn-jj-workspace", value: { name: "lane-a-workspace" } } },
    });
    childRunner.complete(laneA.identity.childCastId, {
      output: { satisfied: true, result: "A" },
      executionScope: replacementScope,
    });
    await flush(childRunner);

    expect(childRunner.listSnapshots().map((child) => child.identity.laneId)).toEqual(["lane-a", "lane-b", "lane-c"]);
    for (const child of childRunner.listSnapshots().filter((entry) => entry.identity.laneId !== "lane-a")) {
      childRunner.complete(child.identity.childCastId, { output: { result: child.identity.laneId } });
    }
    await flush(childRunner);

    const run = state.parallelRuns!.build!;
    expect(run.phase).toBe("completed");
    expect(run.fanInPhase).toBe("accepted");
    expect(run.lanes["lane-a"]?.terminalOutput).toEqual({ satisfied: true, result: "A" });
    expect(fanIns).toHaveLength(1);
    expect(fanIns[0].result.orderedBranches.map((branch: any) => branch.laneId)).toEqual(["lane-a", "lane-b", "lane-c"]);
    expect(fanIns[0].result.orderedBranches[0]).toMatchObject({
      terminalOutput: { satisfied: true, result: "A" },
      scope: { id: "cast:cast-1:base:branch:build:lane-a:workspace", cwd: "/tmp/lane-a-workspace" },
      scopeExports: { workspace: { producer: "spawn-jj-workspace", value: { name: "lane-a-workspace" } } },
    });
    expect(fanIns[0].result.orderedBranches[0].state).toBeUndefined();
    expect(state.branchScopes[replacementScope.id]).toEqual(replacementScope);
    expect(events.find((event) => event.type === "parallel_branches_terminal")?.data.orderedBranches.map((branch: any) => branch.laneId)).toEqual(["lane-a", "lane-b", "lane-c"]);
  });

  test("waits for all terminal branches and fails instead of invoking fan-in", async () => {
    const state = makeState();
    const failures: any[] = [];
    const fanIns: any[] = [];
    const { childRunner, dispatcher: subject } = dispatcher();
    await subject.dispatch({
      pi: {} as any,
      ctx: {} as any,
      state,
      socket: {} as any,
      loopId: "build",
      config: { maxConcurrency: 3 },
      onFanIn: async (input) => { fanIns.push(input); },
      onFailure: async (input) => { failures.push(input); },
    });
    const children = childRunner.listSnapshots();
    childRunner.fail(children[0]!.identity.childCastId, { error: "branch failed" });
    await flush(childRunner);
    expect(failures).toHaveLength(0);
    for (const child of children.slice(1)) childRunner.complete(child.identity.childCastId);
    await flush(childRunner);

    expect(fanIns).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toContain("lane-a (failed: branch failed)");
    expect(state.parallelRuns?.build?.phase).toBe("failed");
  });

  test("revives only failed branches while preserving accepted outputs and immutable attempt artifacts", async () => {
    const state = makeState();
    state.artifactRoot = await mkdtemp(path.join(os.tmpdir(), "materia-revival-"));
    const artifacts = { lane: createParallelLaneArtifactStore(), appendEvent: async () => undefined };
    const initial = dispatcher(undefined, { artifacts });
    await initial.dispatcher.dispatch({ pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: { maxConcurrency: 3 } });
    const children = initial.childRunner.listSnapshots();
    const byLane = (laneId: string) => children.find((child) => child.identity.laneId === laneId)!;
    initial.childRunner.complete(byLane("lane-a").identity.childCastId, { output: { result: "accepted-a" } });
    initial.childRunner.fail(byLane("lane-b").identity.childCastId, { error: "retry me" });
    initial.childRunner.complete(byLane("lane-c").identity.childCastId, { output: { result: "accepted-c" } });
    await flush(initial.childRunner);

    const acceptedBefore = structuredClone(state.parallelRuns!.build!.lanes["lane-a"]);
    const fanIns: any[] = [];
    const revived = dispatcher(initial.childRunner, { artifacts }).dispatcher;
    expect(await revived.validateRevival({ pi: {} as any, ctx: {} as any, state, loopId: "build", config: { maxConcurrency: 3 } })).toEqual({ ok: true, issues: [] });
    await revived.revive({ pi: {} as any, ctx: {} as any, state, loopId: "build", config: { maxConcurrency: 3 }, onFanIn: async (value) => { fanIns.push(value); } });

    expect(state.parallelRuns!.build!.lanes["lane-a"]).toEqual(acceptedBefore);
    const attempt2 = initial.childRunner.listSnapshots().find((child) => child.attempt === 2)!;
    expect(attempt2.identity.laneId).toBe("lane-b");
    expect(state.parallelRuns!.build!.lanes["lane-b"]!.childSession).toEqual({
      childCastId: attempt2.identity.childCastId,
      ...attempt2.paths,
    });

    initial.childRunner.fail(attempt2.identity.childCastId, { error: "retry me again" });
    await flush(initial.childRunner);
    const revivedAgain = dispatcher(initial.childRunner, { artifacts }).dispatcher;
    expect(await revivedAgain.validateRevival({ pi: {} as any, ctx: {} as any, state, loopId: "build", config: { maxConcurrency: 3 } })).toEqual({ ok: true, issues: [] });
    await revivedAgain.revive({ pi: {} as any, ctx: {} as any, state, loopId: "build", config: { maxConcurrency: 3 }, onFanIn: async (value) => { fanIns.push(value); } });
    const attempt3 = initial.childRunner.listSnapshots().find((child) => child.attempt === 3)!;
    expect(attempt3.paths).toEqual(attempt2.paths);
    expect(state.parallelRuns!.build!.lanes["lane-b"]!.childSession).toEqual({ childCastId: attempt3.identity.childCastId, ...attempt3.paths });
    const laneRoot = path.join(state.artifactRoot, "parallel", "build", "lanes", "lane-b");
    const attempt2Manifest = JSON.parse(await readFile(path.join(laneRoot, "attempt-2", "lane.json"), "utf8"));
    const attempt3Manifest = JSON.parse(await readFile(path.join(laneRoot, "attempt-3", "lane.json"), "utf8"));
    expect([attempt2Manifest.identity.attempt, attempt3Manifest.identity.attempt]).toEqual([2, 3]);
    expect(attempt2Manifest.paths.laneManifestPath).not.toBe(attempt3Manifest.paths.laneManifestPath);
    expect(attempt2Manifest.paths.sessionPath).toBe(attempt3Manifest.paths.sessionPath);

    initial.childRunner.complete(attempt3.identity.childCastId, { output: { result: "accepted-b" } });
    await flush(initial.childRunner);
    expect(JSON.parse(await readFile(path.join(laneRoot, "attempt-2", "terminal-result.json"), "utf8")).result.status).toBe("failed");
    expect(JSON.parse(await readFile(path.join(laneRoot, "attempt-3", "terminal-result.json"), "utf8")).result.status).toBe("succeeded");
    expect(fanIns).toHaveLength(1);
    expect(fanIns[0].result.orderedBranches.map((branch: any) => branch.terminalOutput)).toEqual([
      { result: "accepted-a" }, { result: "accepted-b" }, { result: "accepted-c" },
    ]);
  });

  test("rejects plan, graph, branch, and execution-scope drift before revival", async () => {
    const state = makeState();
    const initial = dispatcher();
    await initial.dispatcher.dispatch({ pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: { maxConcurrency: 3 } });
    const children = initial.childRunner.listSnapshots();
    initial.childRunner.fail(children[0]!.identity.childCastId, {});
    for (const child of children.slice(1)) initial.childRunner.complete(child.identity.childCastId);
    await flush(initial.childRunner);
    const subject = dispatcher(initial.childRunner).dispatcher;
    const input = { pi: {} as any, ctx: {} as any, state, loopId: "build", config: { maxConcurrency: 3 } };

    state.data.parallelPlan = { ...(state.data.parallelPlan as any), planId: "drifted" };
    expect((await subject.validateRevival(input)).issues.some((issue) => issue.code === "plan_mismatch")).toBe(true);
    state.data.parallelPlan = { ...(state.data.parallelPlan as any), planId: "plan-1" };
    const graphHash = state.parallelRuns!.build!.graphIdentity.graphHash;
    state.parallelRuns!.build!.graphIdentity.graphHash = "drifted";
    expect((await subject.validateRevival(input)).issues.some((issue) => issue.code === "graph_drift")).toBe(true);
    state.parallelRuns!.build!.graphIdentity.graphHash = graphHash;
    state.parallelRuns!.build!.lanes["lane-a"]!.branchId = "drifted";
    expect((await subject.validateRevival(input)).issues.some((issue) => issue.code === "branch_identity_drift")).toBe(true);
    state.parallelRuns!.build!.lanes["lane-a"]!.branchId = `${state.parallelRuns!.build!.runId}:branch:lane-a`;
    const lane = state.parallelRuns!.build!.lanes["lane-a"]!;
    const scope = lane.executionScope!;
    state.branchScopes[scope.id] = { ...scope, cwd: "/drifted" };
    expect((await subject.validateRevival(input)).issues.some((issue) => issue.code === "scope_drift")).toBe(true);

    state.branchScopes[scope.id] = structuredClone(scope);
    const sessionPath = lane.childSession!.sessionPath;
    lane.childSession!.sessionPath = "/drifted/session.jsonl";
    await expect(subject.revive(input)).rejects.toThrow(/session path drift/);
    lane.childSession!.sessionPath = sessionPath;
    lane.attempt += 1;
    await expect(subject.revive(input)).rejects.toThrow(/attempt drift/);
  });

  test("rejects retained child initial-data drift before revival and after resume", async () => {
    const setupFailedRun = async () => {
      const state = makeState();
      const initial = dispatcher();
      await initial.dispatcher.dispatch({ pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: { maxConcurrency: 3 } });
      const children = initial.childRunner.listSnapshots();
      initial.childRunner.fail(children[0]!.identity.childCastId, { error: "retry" });
      for (const child of children.slice(1)) initial.childRunner.complete(child.identity.childCastId);
      await flush(initial.childRunner);
      return { state, childRunner: initial.childRunner };
    };
    const delegate = (childRunner: ReturnType<typeof createFakeChildCastRunner>) => ({
      start: childRunner.start.bind(childRunner),
      observe: childRunner.observe.bind(childRunner),
      subscribe: childRunner.subscribe.bind(childRunner),
      resume: childRunner.resume.bind(childRunner),
      abort: childRunner.abort.bind(childRunner),
    });

    const before = await setupFailedRun();
    const beforePort = delegate(before.childRunner);
    beforePort.observe = async (input) => {
      const observation = await before.childRunner.observe(input);
      if (!observation || observation.snapshot.identity.laneId !== "lane-a") return observation;
      const drifted = structuredClone(observation);
      (drifted.snapshot.compiledLoadout.initialData as any).workItems = [{ title: "corrupted", context: "corrupted" }];
      return drifted;
    };
    const beforeSubject = dispatcher(beforePort as any).dispatcher;
    const beforeValidation = await beforeSubject.validateRevival({ pi: {} as any, ctx: {} as any, state: before.state, loopId: "build", config: { maxConcurrency: 3 } });
    expect(beforeValidation.ok).toBe(false);
    expect(beforeValidation.issues).toContainEqual(expect.objectContaining({ code: "child_session_drift", laneId: "lane-a" }));

    const after = await setupFailedRun();
    const afterPort = delegate(after.childRunner);
    afterPort.resume = async (input) => {
      const resumed = await after.childRunner.resume(input);
      const drifted = structuredClone(resumed);
      (drifted.snapshot.compiledLoadout.initialData as any).workItems = [{ title: "corrupted", context: "corrupted" }];
      return drifted;
    };
    const afterSubject = dispatcher(afterPort as any).dispatcher;
    await afterSubject.revive({ pi: {} as any, ctx: {} as any, state: after.state, loopId: "build", config: { maxConcurrency: 3 } });
    expect(after.state.parallelRuns!.build!.lanes["lane-a"]!.status).toBe("failed");
    expect(after.state.parallelRuns!.build!.lanes["lane-a"]!.failureReason).toContain("initial-data drift");
  });

  test("rejects complete child identity and cwd drift after resume", async () => {
    const state = makeState();
    const initial = dispatcher();
    await initial.dispatcher.dispatch({ pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: { maxConcurrency: 3 } });
    for (const child of initial.childRunner.listSnapshots()) initial.childRunner.fail(child.identity.childCastId, { error: "retry" });
    await flush(initial.childRunner);

    const children = {
      start: initial.childRunner.start.bind(initial.childRunner),
      observe: initial.childRunner.observe.bind(initial.childRunner),
      subscribe: initial.childRunner.subscribe.bind(initial.childRunner),
      abort: initial.childRunner.abort.bind(initial.childRunner),
      resume: async (input: any) => {
        const resumed = structuredClone(await initial.childRunner.resume(input));
        if (resumed.snapshot.identity.laneId === "lane-a") resumed.snapshot.identity.parentCastId = "other-parent";
        if (resumed.snapshot.identity.laneId === "lane-b") resumed.snapshot.identity.loopId = "other-loop";
        if (resumed.snapshot.identity.laneId === "lane-c") resumed.snapshot.cwd = "/other/cwd";
        return resumed;
      },
    };
    const subject = dispatcher(children as any).dispatcher;
    await subject.revive({ pi: {} as any, ctx: {} as any, state, loopId: "build", config: { maxConcurrency: 3 } });

    expect(state.parallelRuns!.build!.lanes["lane-a"]!.failureReason).toContain("identity or attempt drift");
    expect(state.parallelRuns!.build!.lanes["lane-b"]!.failureReason).toContain("identity or attempt drift");
    expect(state.parallelRuns!.build!.lanes["lane-c"]!.failureReason).toContain("cwd drift");
    expect(Object.values(state.parallelRuns!.build!.lanes).every((lane) => lane.status === "failed")).toBe(true);
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
    const fresh = dispatcher(childRunner).dispatcher;
    expect(await fresh.validateRevival({ pi: {} as any, ctx: {} as any, state, loopId: "build", config: { maxConcurrency: 2 } })).toEqual({ ok: true, issues: [] });
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
