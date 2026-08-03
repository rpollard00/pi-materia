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

    // Monitoring remains lifecycle-only even though durable state and the
    // in-process fan-in retain complete outputs and execution scopes.
    const startedEvent = events.find((event) => event.type === "parallel_lane_started")!.data;
    expect(startedEvent.status).toBe("running");
    expect(startedEvent.executionScope).toBeUndefined();
    expect(startedEvent.artifactPaths).toBeUndefined();
    const laneTerminalEvents = events.filter((event) => event.type === "parallel_lane_terminal").map((event) => event.data);
    expect(laneTerminalEvents).toHaveLength(3);
    expect(laneTerminalEvents.every((event) => event.status === "accepted" && event.output === undefined && event.executionScope === undefined && event.accepted === undefined)).toBe(true);
    const barrierEvent = events.find((event) => event.type === "parallel_branches_terminal")!.data;
    expect(barrierEvent).toMatchObject({ parentCastId: "cast-1", loopId: "build", status: "accepted", barrier: { reached: 3, total: 3, phase: "accepted", statuses: { accepted: 3 } } });
    expect(barrierEvent.orderedBranches).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain("lane-a-workspace");
    expect(JSON.stringify(events)).not.toContain('"result":"A"');
    expect(childRunner.listSnapshots()).toEqual([]);
    expect(subject.run).toBeUndefined();
  });

  test("ignores callbacks that arrive after barrier resource retirement", async () => {
    const state = makeState();
    const childRunner = createFakeChildCastRunner({ now: () => 10 });
    const observers: any[] = [];
    const children = {
      start: childRunner.start.bind(childRunner),
      observe: childRunner.observe.bind(childRunner),
      resume: childRunner.resume.bind(childRunner),
      abort: childRunner.abort.bind(childRunner),
      retire: childRunner.retire.bind(childRunner),
      subscribe: (input: any, observer: any) => {
        observers.push(observer);
        return childRunner.subscribe(input, observer);
      },
    };
    const fanIns: unknown[] = [];
    const subject = new ParallelLoopDispatcher({ children, state: { saveCastState: () => undefined } } as any);
    await subject.dispatch({ pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: { maxConcurrency: 3 }, onFanIn: async (value) => { fanIns.push(value); } });
    for (const child of childRunner.listSnapshots()) childRunner.complete(child.identity.childCastId);
    await flush(childRunner);

    const usageBefore = structuredClone(state.runState.usage);
    await observers[0].onEvent?.({ childCastId: "late", sequence: 999, type: "usage_checkpoint", occurredAt: 999, usage: { tokens: { input: 99, output: 0, cacheRead: 0, cacheWrite: 0, total: 99 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    await observers[0].onTerminal?.({ status: "failed", accepted: false, endedAt: 999, error: "late" });

    expect(state.runState.usage).toEqual(usageBefore);
    expect(state.parallelRuns?.build?.phase).toBe("completed");
    expect(fanIns).toHaveLength(1);
    expect(subject.run).toBeUndefined();
  });

  test("does not let a terminal callback paused in observation mutate a reused dispatcher", async () => {
    const firstState = makeState();
    const nextState = makeState();
    nextState.castId = "cast-2";
    nextState.runState.runId = "run-2";
    const childRunner = createFakeChildCastRunner({ now: () => 10 });
    let releaseObservation!: () => void;
    const observationReleased = new Promise<void>((resolve) => { releaseObservation = resolve; });
    let observationStarted!: () => void;
    const observationEntered = new Promise<void>((resolve) => { observationStarted = resolve; });
    let deferNextObservation = true;
    const children = {
      start: childRunner.start.bind(childRunner),
      resume: childRunner.resume.bind(childRunner),
      abort: childRunner.abort.bind(childRunner),
      retire: childRunner.retire.bind(childRunner),
      subscribe: childRunner.subscribe.bind(childRunner),
      observe: async (input: any) => {
        if (deferNextObservation) {
          deferNextObservation = false;
          observationStarted();
          await observationReleased;
        }
        return childRunner.observe(input);
      },
    };
    const terminalEvents: Array<{ state: MateriaCastState; type: string }> = [];
    const subject = new ParallelLoopDispatcher({
      children,
      state: { saveCastState: () => undefined },
      artifacts: { appendEvent: async (runState: MateriaCastState["runState"], type: string) => terminalEvents.push({ state: runState === firstState.runState ? firstState : nextState, type }) },
    } as any);
    await subject.dispatch({ pi: {} as any, ctx: {} as any, state: firstState, socket: {} as any, loopId: "build", config: { maxConcurrency: 1 } });
    const firstChild = childRunner.listSnapshots()[0]!;
    childRunner.complete(firstChild.identity.childCastId);
    await observationEntered;

    await subject.cancel({ pi: {} as any, state: firstState, loopId: "build" });
    await subject.dispatch({ pi: {} as any, ctx: {} as any, state: nextState, socket: {} as any, loopId: "build", config: { maxConcurrency: 1 } });
    releaseObservation();
    await flush(childRunner);

    expect(firstState.parallelRuns?.build?.phase).toBe("failed");
    expect(nextState.parallelRuns?.build?.phase).toBe("dispatching");
    expect(nextState.parallelRuns?.build?.lanes["lane-a"]?.status).toBe("running");
    expect(terminalEvents.filter((event) => event.type === "parallel_lane_terminal")).toHaveLength(0);
    expect(subject.run?.parentCastId).toBe("cast-2");
  });

  test("does not let terminal usage paused in artifact I/O enforce budget on a reused dispatcher", async () => {
    const firstState = makeState();
    const nextState = makeState();
    nextState.castId = "cast-2";
    nextState.runState.runId = "run-2";
    const childRunner = createFakeChildCastRunner({ now: () => 10 });
    let releaseUsageWrite!: () => void;
    const usageWriteReleased = new Promise<void>((resolve) => { releaseUsageWrite = resolve; });
    let usageWriteStarted!: () => void;
    const usageWriteEntered = new Promise<void>((resolve) => { usageWriteStarted = resolve; });
    let deferFirstUsageWrite = true;
    const budgetFailures: unknown[] = [];
    const children = {
      start: childRunner.start.bind(childRunner),
      observe: childRunner.observe.bind(childRunner),
      resume: childRunner.resume.bind(childRunner),
      abort: childRunner.abort.bind(childRunner),
      retire: childRunner.retire.bind(childRunner),
      // Exercise terminal-only accounting rather than the fake runner's
      // duplicate terminal stream checkpoint.
      subscribe: (input: any, observer: any) => childRunner.subscribe(input, {
        ...observer,
        onEvent: (event: any) => event.type === "terminal" ? undefined : observer.onEvent?.(event),
      }),
    };
    const subject = new ParallelLoopDispatcher({
      children,
      state: { saveCastState: () => undefined },
      artifacts: {
        appendEvent: async () => undefined,
        writeUsage: async () => {
          if (!deferFirstUsageWrite) return;
          deferFirstUsageWrite = false;
          usageWriteStarted();
          await usageWriteReleased;
        },
      },
      budget: { assertBudget: async (value: MateriaCastState) => { if (value.runState.usage.tokens.total > 0) throw new Error("limit"); } },
      onBudgetExceeded: async (...args: unknown[]) => { budgetFailures.push(args); },
    } as any);
    await subject.dispatch({ pi: {} as any, ctx: {} as any, state: firstState, socket: {} as any, loopId: "build", config: { maxConcurrency: 1 } });
    const firstChild = childRunner.listSnapshots()[0]!;
    childRunner.complete(firstChild.identity.childCastId, {
      usage: { tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    await usageWriteEntered;

    await subject.cancel({ pi: {} as any, state: firstState, loopId: "build" });
    await subject.dispatch({ pi: {} as any, ctx: {} as any, state: nextState, socket: {} as any, loopId: "build", config: { maxConcurrency: 1 } });
    const nextChild = childRunner.listSnapshots().find((child) => child.identity.parentCastId === "cast-2")!;
    releaseUsageWrite();
    await flush(childRunner);

    expect(firstState.parallelRuns?.build?.phase).toBe("failed");
    expect(nextState.parallelRuns?.build?.phase).toBe("dispatching");
    expect(nextState.parallelRuns?.build?.lanes["lane-a"]?.status).toBe("running");
    expect(childRunner.getSnapshot(nextChild.identity.childCastId)?.status).toBe("running");
    expect(budgetFailures).toEqual([]);
    expect(subject.run?.parentCastId).toBe("cast-2");
  });

  test("keeps a chained fan-in dispatch owned by the next run", async () => {
    const firstState = makeState();
    const nextState = makeState();
    nextState.castId = "cast-2";
    nextState.runState.runId = "run-2";
    const childRunner = createFakeChildCastRunner({ now: () => 10 });
    const observers: any[] = [];
    const children = {
      start: childRunner.start.bind(childRunner),
      observe: childRunner.observe.bind(childRunner),
      resume: childRunner.resume.bind(childRunner),
      abort: childRunner.abort.bind(childRunner),
      retire: childRunner.retire.bind(childRunner),
      subscribe: (input: any, observer: any) => {
        observers.push(observer);
        return childRunner.subscribe(input, observer);
      },
    };
    const subject = new ParallelLoopDispatcher({ children, state: { saveCastState: () => undefined } } as any);
    const nextFanIns: unknown[] = [];
    await subject.dispatch({
      pi: {} as any, ctx: {} as any, state: firstState, socket: {} as any, loopId: "build", config: { maxConcurrency: 3 },
      onFanIn: async () => {
        await subject.dispatch({
          pi: {} as any, ctx: {} as any, state: nextState, socket: {} as any, loopId: "build", config: { maxConcurrency: 3 },
          onFanIn: async (value) => { nextFanIns.push(value); },
        });
      },
    });
    for (const child of childRunner.listSnapshots()) childRunner.complete(child.identity.childCastId);
    await flush(childRunner);

    expect(subject.run?.parentCastId).toBe("cast-2");
    const nextChildren = childRunner.listSnapshots().filter((child) => child.identity.parentCastId === "cast-2");
    expect(nextChildren).toHaveLength(3);
    // A callback captured from the retired run cannot delete a same-named lane
    // from the new run.
    await observers[0].onTerminal?.({ status: "failed", accepted: false, endedAt: 99, error: "late old callback" });
    for (const child of nextChildren) childRunner.complete(child.identity.childCastId);
    await flush(childRunner);

    expect(nextState.parallelRuns?.build?.phase).toBe("completed");
    expect(nextFanIns).toHaveLength(1);
    expect(subject.run).toBeUndefined();
  });

  test("waits for all terminal branches and fails instead of invoking fan-in", async () => {
    const state = makeState();
    const failures: any[] = [];
    const fanIns: any[] = [];
    const events: Array<{ type: string; data: any }> = [];
    const { childRunner, dispatcher: subject } = dispatcher(undefined, { artifacts: { appendEvent: async (_run: unknown, type: string, data: unknown) => events.push({ type, data }) } });
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
    const failedLane = events.find((event) => event.type === "parallel_lane_terminal" && event.data.laneId === "lane-a")!.data;
    expect(failedLane).toMatchObject({ status: "failed", error: "branch failed", barrier: { reached: 1, total: 3 } });
    expect(failedLane.output).toBeUndefined();
    expect(failedLane.executionScope).toBeUndefined();
    const failedBarrier = events.find((event) => event.type === "parallel_branches_failed")!.data;
    expect(failedBarrier).toMatchObject({ status: "failed", barrier: { reached: 3, total: 3, phase: "failed", statuses: { accepted: 2, failed: 1 } } });
    expect(failedBarrier.orderedBranches).toBeUndefined();
    expect(childRunner.listSnapshots()).toEqual([
      expect.objectContaining({ status: "failed", events: [], diagnostics: [] }),
    ]);
    expect(subject.run).toBeUndefined();
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

    initial.childRunner.emit(attempt3.identity.childCastId, {
      type: "usage_checkpoint",
      usage: {
        tokens: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5, reasoningSignature: "must-not-leak" },
        cost: { input: 0.2, output: 0.3, cacheRead: 0, cacheWrite: 0, total: 0.5, toolResult: "must-not-leak" },
      } as any,
    });
    await flush(initial.childRunner);
    initial.childRunner.complete(attempt3.identity.childCastId, { output: { result: "accepted-b" } });
    await flush(initial.childRunner);
    expect(JSON.parse(await readFile(path.join(laneRoot, "attempt-2", "terminal-result.json"), "utf8")).result.status).toBe("failed");
    expect(JSON.parse(await readFile(path.join(laneRoot, "attempt-3", "terminal-result.json"), "utf8")).result.status).toBe("succeeded");
    const attempt2Events = (await readFile(path.join(laneRoot, "attempt-2", "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const attempt3Events = (await readFile(path.join(laneRoot, "attempt-3", "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(attempt2Events.map((entry) => entry.event.type)).toEqual(["parallel_lane_resumed", "parallel_lane_terminal"]);
    expect(attempt3Events.map((entry) => entry.event.type)).toEqual(["parallel_lane_resumed", "usage_checkpoint", "parallel_lane_terminal"]);
    expect(JSON.stringify(attempt3Events)).not.toContain("accepted-b");
    expect(JSON.stringify(attempt3Events)).not.toContain("must-not-leak");
    const attempt3Terminal = JSON.parse(await readFile(path.join(laneRoot, "attempt-3", "terminal-result.json"), "utf8"));
    expect(attempt3Terminal.result.output).toEqual({ result: "accepted-b" });
    expect(JSON.stringify(attempt3Terminal.usage)).not.toContain("must-not-leak");
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

  test("checkpoints only real usage deltas during an observational event storm", async () => {
    const state = makeState();
    const saved: MateriaCastState[] = [];
    const forwarded: Array<{ type: string; data: unknown }> = [];
    const laneEvents: any[] = [];
    const childRunner = createFakeChildCastRunner({ now: () => 10, maxRetainedEvents: 32 });
    const subject = new ParallelLoopDispatcher({
      children: childRunner,
      state: { saveCastState: (_pi: unknown, value: MateriaCastState) => { saved.push(structuredClone(value)); } },
      artifacts: {
        appendEvent: async (_run: unknown, type: string, data: unknown) => { forwarded.push({ type, data }); },
        lane: {
          initialize: async () => undefined,
          appendEvent: async (input: unknown) => { laneEvents.push(input); },
          writeTerminalResult: async () => undefined,
          writeDiagnostics: async () => undefined,
          writeUsage: async () => undefined,
        },
      },
    } as any);
    await subject.dispatch({ pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: { maxConcurrency: 1 } });
    const child = childRunner.listSnapshots()[0]!;
    const savesAfterLaunch = saved.length;
    const artifactsAfterLaunch = forwarded.length;
    const laneArtifactsAfterLaunch = laneEvents.length;
    expect(laneEvents.map((entry) => entry.event.event.type)).toEqual(["parallel_lane_started"]);

    for (let index = 0; index < 1_000; index += 1) {
      childRunner.emit(child.identity.childCastId, { type: "message_update", payload: { index, token: "x".repeat(100) } });
    }
    await flush(childRunner);

    expect(saved).toHaveLength(savesAfterLaunch);
    expect(forwarded).toHaveLength(artifactsAfterLaunch);
    expect(laneEvents).toHaveLength(laneArtifactsAfterLaunch);
    expect(forwarded.some((event) => event.type === "parallel_child_event")).toBe(false);
    expect(state.parallelRuns!.build!.lanes["lane-a"]!.lastEvent?.sequence).toBe(1_001);
    expect(saved.at(-1)!.parallelRuns!.build!.lanes["lane-a"]!.lastEvent).toBeUndefined();

    const usage = { tokens: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5 }, cost: { input: 0.2, output: 0.3, cacheRead: 0, cacheWrite: 0, total: 0.5 } };
    childRunner.emit(child.identity.childCastId, { type: "usage_checkpoint", usage });
    await flush(childRunner);

    expect(saved).toHaveLength(savesAfterLaunch + 1);
    expect(forwarded).toHaveLength(artifactsAfterLaunch);
    expect(laneEvents).toHaveLength(laneArtifactsAfterLaunch + 1);
    expect(laneEvents.at(-1).event.event).toMatchObject({ type: "usage_checkpoint", usage });
    expect(state.runState.usage.tokens.total).toBe(5);
    expect(state.runState.usage.cost.total).toBe(0.5);
    expect(saved.at(-1)!.parallelRuns!.build!.lanes["lane-a"]!.lastEvent?.sequence).toBe(1_002);
  });

  test("replays from a stale durable watermark when reviving a child", async () => {
    const state = makeState();
    const initial = dispatcher();
    await initial.dispatcher.dispatch({ pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: { maxConcurrency: 3 } });
    const laneA = initial.childRunner.listSnapshots().find((child) => child.identity.laneId === "lane-a")!;
    for (let index = 0; index < 8; index += 1) initial.childRunner.emit(laneA.identity.childCastId, { type: "message_update", payload: { index } });
    await flush(initial.childRunner);
    for (const child of initial.childRunner.listSnapshots()) initial.childRunner.fail(child.identity.childCastId, { error: "retry" });
    await flush(initial.childRunner);

    // Model a crash whose last observational watermark never reached disk.
    state.parallelRuns!.build!.lanes["lane-a"]!.lastEvent = undefined;
    let resumedAfterSequence: number | undefined;
    const children = {
      start: initial.childRunner.start.bind(initial.childRunner),
      observe: initial.childRunner.observe.bind(initial.childRunner),
      resume: initial.childRunner.resume.bind(initial.childRunner),
      abort: initial.childRunner.abort.bind(initial.childRunner),
      subscribe: (input: any, observer: any) => {
        if (input.childCastId === laneA.identity.childCastId) resumedAfterSequence = input.afterSequence;
        return initial.childRunner.subscribe(input, observer);
      },
    };
    const revived = dispatcher(children as any).dispatcher;
    await revived.revive({ pi: {} as any, ctx: {} as any, state, loopId: "build", config: { maxConcurrency: 3 } });

    expect(resumedAfterSequence).toBe(0);
    expect(state.parallelRuns!.build!.lanes["lane-a"]!.lastEvent?.sequence).toBeGreaterThan(0);
  });

  test("persists and records budget failure only after a real usage delta", async () => {
    const state = makeState();
    const laneEvents: any[] = [];
    const parentEvents: string[] = [];
    const budgetFailures: unknown[] = [];
    const childRunner = createFakeChildCastRunner({ now: () => 10 });
    const subject = new ParallelLoopDispatcher({
      children: childRunner,
      state: { saveCastState: () => undefined },
      budget: { assertBudget: async (value: MateriaCastState) => { if (value.runState.usage.tokens.total > 0) throw new Error("limit"); } },
      onBudgetExceeded: async (_pi: unknown, _ctx: unknown, _state: unknown, error: unknown) => { budgetFailures.push(error); },
      artifacts: {
        appendEvent: async (_run: unknown, type: string) => { parentEvents.push(type); },
        lane: {
          initialize: async () => undefined,
          appendEvent: async (input: unknown) => { laneEvents.push(input); },
          writeTerminalResult: async () => undefined,
          writeDiagnostics: async () => undefined,
          writeUsage: async () => undefined,
        },
      },
    } as any);
    await subject.dispatch({ pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: { maxConcurrency: 1 } });
    const child = childRunner.listSnapshots()[0]!;
    for (let index = 0; index < 100; index += 1) childRunner.emit(child.identity.childCastId, { type: "message_update", payload: { index } });
    await flush(childRunner);
    expect(laneEvents.map((entry) => entry.event.event.type)).toEqual(["parallel_lane_started"]);

    childRunner.emit(child.identity.childCastId, { type: "usage_checkpoint", usage: { tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    await flush(childRunner);

    expect(state.parallelRuns!.build!.phase).toBe("failed");
    expect(budgetFailures).toHaveLength(1);
    expect(parentEvents).toContain("parallel_budget_exceeded");
    expect(laneEvents.map((entry) => entry.event.event.type)).toEqual(["parallel_lane_started", "usage_checkpoint", "parallel_lane_budget_exceeded"]);
  });

  test("stops terminal processing when terminal-only usage exhausts the budget", async () => {
    const state = makeState();
    const childRunner = createFakeChildCastRunner({ now: () => 10 });
    const budgetFailures: unknown[] = [];
    const subject = new ParallelLoopDispatcher({
      children: childRunner,
      state: { saveCastState: () => undefined },
      budget: { assertBudget: async (value: MateriaCastState) => { if (value.runState.usage.tokens.total > 0) throw new Error("limit"); } },
      onBudgetExceeded: async (_pi: unknown, _ctx: unknown, _state: unknown, error: unknown) => { budgetFailures.push(error); },
    } as any);
    await subject.dispatch({ pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: { maxConcurrency: 1 } });
    childRunner.complete(childRunner.listSnapshots()[0]!.identity.childCastId, {
      usage: { tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });

    await flush(childRunner);

    expect(state.parallelRuns?.build?.phase).toBe("failed");
    expect(state.parallelRuns?.build?.fanInPhase).toBe("failed");
    expect(budgetFailures).toHaveLength(1);
    expect(subject.run).toBeUndefined();
  });

  test("cancels active and queued branches without workspace cleanup", async () => {
    const state = makeState();
    const laneEvents: any[] = [];
    const lane = {
      initialize: async () => undefined,
      appendEvent: async (input: unknown) => { laneEvents.push(input); },
      writeTerminalResult: async () => undefined,
      writeDiagnostics: async () => undefined,
      writeUsage: async () => undefined,
    };
    const { childRunner, dispatcher: subject } = dispatcher(undefined, { artifacts: { lane, appendEvent: async () => undefined } });
    await subject.dispatch({ pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: { maxConcurrency: 2 } });
    await subject.cancel({ pi: {} as any, state, loopId: "build", reason: "parent abort" });
    await flush(childRunner);

    expect(childRunner.listSnapshots().every((child) => child.status === "interrupted" && child.events.length === 0 && child.diagnostics.length === 0)).toBe(true);
    expect(subject.run).toBeUndefined();
    expect(state.parallelRuns?.build?.phase).toBe("failed");
    expect(Object.values(state.parallelRuns?.build?.lanes ?? {}).every((lane) => lane.status === "interrupted")).toBe(true);
    expect(laneEvents.map((entry) => entry.event.event.type)).toEqual([
      "parallel_lane_started", "parallel_lane_started", "parallel_lane_cancelled", "parallel_lane_cancelled",
    ]);
    const fresh = dispatcher(childRunner).dispatcher;
    expect(await fresh.validateRevival({ pi: {} as any, ctx: {} as any, state, loopId: "build", config: { maxConcurrency: 2 } })).toEqual({ ok: true, issues: [] });
  });

  test("reuses the same dispatcher for a later cast after cancellation", async () => {
    const cancelledState = makeState();
    const nextState = makeState();
    nextState.castId = "cast-2";
    nextState.runState.runId = "run-2";
    const { childRunner, dispatcher: subject } = dispatcher();
    await subject.dispatch({ pi: {} as any, ctx: {} as any, state: cancelledState, socket: {} as any, loopId: "build", config: { maxConcurrency: 2 } });
    await subject.cancel({ pi: {} as any, state: cancelledState, loopId: "build" });

    const fanIns: unknown[] = [];
    await subject.dispatch({
      pi: {} as any, ctx: {} as any, state: nextState, socket: {} as any, loopId: "build", config: { maxConcurrency: 3 },
      onFanIn: async (value) => { fanIns.push(value); },
    });
    const nextChildren = childRunner.listSnapshots().filter((child) => child.identity.parentCastId === "cast-2");
    expect(nextChildren).toHaveLength(3);
    for (const child of nextChildren) childRunner.complete(child.identity.childCastId);
    await flush(childRunner);

    expect(nextState.parallelRuns?.build?.phase).toBe("completed");
    expect(fanIns).toHaveLength(1);
    expect(subject.run).toBeUndefined();
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

  test("persists cancellation usage and watermark so revival is idempotent", async () => {
    const state = makeState();
    const childRunner = createFakeChildCastRunner({ now: () => 10 });
    let coordinatorAlive = false;
    const children = {
      start: childRunner.start.bind(childRunner),
      resume: childRunner.resume.bind(childRunner),
      abort: childRunner.abort.bind(childRunner),
      observe: childRunner.observe.bind(childRunner),
      // Simulate a coordinator that crashes before receiving child events.
      subscribe: (input: any, observer: any) => coordinatorAlive
        ? childRunner.subscribe(input, observer)
        : { childCastId: input.childCastId, unsubscribe: () => undefined },
    };
    const saved: MateriaCastState[] = [];
    const statePort = { saveCastState: (_pi: unknown, value: MateriaCastState) => { saved.push(structuredClone(value)); } };
    const initial = new ParallelLoopDispatcher({ children, state: statePort } as any);
    await initial.dispatch({ pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: { maxConcurrency: 1 } });
    const child = childRunner.listSnapshots()[0]!;
    const usage = { tokens: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, total: 7 }, cost: { input: 0.3, output: 0.4, cacheRead: 0, cacheWrite: 0, total: 0.7 } };
    const checkpoint = childRunner.emit(child.identity.childCastId, { type: "usage_checkpoint", usage });
    expect(state.runState.usage.tokens.total).toBe(0);

    const cancelling = new ParallelLoopDispatcher({ children, state: statePort } as any);
    await cancelling.cancel({ pi: {} as any, state, loopId: "build" });

    const cancelledLane = state.parallelRuns!.build!.lanes["lane-a"]!;
    expect(cancelledLane.usage).toEqual(usage);
    expect(cancelledLane.lastEvent?.sequence).toBeGreaterThanOrEqual(checkpoint.sequence);
    expect(saved.at(-1)!.parallelRuns!.build!.lanes["lane-a"]!.usage).toEqual(usage);
    expect(state.runState.usage.tokens.total).toBe(7);

    coordinatorAlive = true;
    const revived = new ParallelLoopDispatcher({ children, state: statePort } as any);
    await revived.revive({ pi: {} as any, ctx: {} as any, state, loopId: "build", config: { maxConcurrency: 1 } });
    await flush(childRunner);

    expect(state.runState.usage.tokens.total).toBe(7);
    expect(state.runState.usage.cost.total).toBeCloseTo(0.7);
  });
});
