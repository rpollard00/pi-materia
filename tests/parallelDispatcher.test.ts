import { describe, expect, test } from "bun:test";
import { createFakeChildCastRunner } from "../src/application/index.js";
import { ParallelLoopDispatcher } from "../src/runtime/parallelDispatcher.js";
import type { MateriaCastState } from "../src/types.js";

function makeState(): MateriaCastState {
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
        parallel: { planInput: "state.parallelPlan", maxConcurrency: 2, workspaceMode: "jj", failurePolicy: "all_terminal", fanIn: "ordered" },
      },
    },
  } as any;
  return {
    version: 2,
    active: true,
    castId: "cast-1",
    request: "build the project",
    configSource: "test",
    configHash: "config-1",
    cwd: "/repo",
    runDir: "/repo/run",
    artifactRoot: "/repo/artifacts",
    phase: "Socket-2",
    currentSocketId: "Socket-2",
    awaitingResponse: false,
    socketState: "idle",
    startedAt: 1,
    updatedAt: 1,
    parallelRuns: {},
    data: {
      workItems: [
        { title: "one", context: "one" },
        { title: "two", context: "two" },
        { title: "three", context: "three" },
      ],
      parallelPlan: {
        version: 1,
        planId: "plan-1",
        workItemCount: 3,
        streams: [
          { laneId: "lane-a", name: "a", streamIndex: 0, workItemIndexes: [0] },
          { laneId: "lane-b", name: "b", streamIndex: 1, workItemIndexes: [1] },
          { laneId: "lane-c", name: "c", streamIndex: 2, workItemIndexes: [2] },
        ],
      },
    },
    cursors: {},
    visits: {},
    taskAttempts: {},
    edgeTraversals: {},
    runState: {
      runId: "run-1",
      startedAt: 1,
      runDir: "/repo/run",
      eventsFile: "/repo/run/events.jsonl",
      usageFile: "/repo/run/usage.json",
      usage: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, byMateria: {}, bySocket: {}, byTask: {}, byAttempt: {} },
      budgetWarned: false,
    },
    pipeline,
  } as MateriaCastState;
}

describe("parallel loop dispatcher", () => {
  test("aggregates child telemetry once and forwards lane provenance", async () => {
    const childRunner = createFakeChildCastRunner({ now: () => 10 });
    const forwarded: Array<{ provenance: Record<string, unknown>; event: unknown }> = [];
    const usageWrites: number[] = [];
    const laneArtifacts = {
      async initialize(input: any) {
        return {
          laneManifestPath: `${input.paths.runDirectory}/lane.json`,
          eventStreamPath: `${input.paths.runDirectory}/events.jsonl`,
          terminalResultPath: `${input.paths.runDirectory}/terminal.json`,
          revisionPath: `${input.paths.runDirectory}/revision.json`,
          diagnosticsPath: `${input.paths.runDirectory}/diagnostics.json`,
          usagePath: `${input.paths.runDirectory}/usage.json`,
          launchSpecPath: `${input.paths.runDirectory}/child-launch.json`,
          sessionPath: input.paths.sessionPath,
          stdoutPath: `${input.paths.artifactRoot}/child-stdout.jsonl`,
          stderrPath: `${input.paths.artifactRoot}/child-stderr.log`,
          socketArtifactsPath: input.paths.artifactRoot,
        };
      },
      async appendEvent(input: any) { forwarded.push(input.event); },
      async writeTerminalResult() {},
      async writeRevision() {},
      async writeDiagnostics() {},
      async writeUsage() {},
    };
    const state = makeState();
    const usage = {
      tokens: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5 },
      cost: { input: 0.2, output: 0.3, cacheRead: 0, cacheWrite: 0, total: 0.5 },
    };
    const dispatcher = new ParallelLoopDispatcher({
      children: childRunner,
      workspaces: {
        async pinBaseline() { return { repositoryRoot: "/repo", baseline: { commitId: "base", changeId: "base-change" } }; },
        async create(input: { laneId: string }) {
          return {
            repositoryRoot: "/repo",
            workspaceRoot: "/tmp/materia",
            workspacePath: `/tmp/materia/${input.laneId}`,
            workspaceName: input.laneId,
            baseline: { commitId: "base", changeId: "base-change" },
            revision: { commitId: "base", changeId: "base-change" },
          };
        },
      },
      state: { saveCastState: () => undefined },
      artifacts: {
        appendEvent: async () => undefined,
        writeUsage: async (runState) => { usageWrites.push(runState.usage.tokens.total); },
        lane: laneArtifacts,
      },
    });

    await dispatcher.dispatch({ pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: state.pipeline.loops!.build.parallel! });
    const first = childRunner.listSnapshots()[0]!;
    childRunner.emit(first.identity.childCastId, { type: "socket_output", socketId: "Build", usage });
    childRunner.complete(first.identity.childCastId, { usage, output: { commitId: "head-a", changeId: "change-a" } });
    await childRunner.drain();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.runState.usage.tokens.total).toBe(5);
    expect(state.runState.usage.cost.total).toBe(0.5);
    expect(usageWrites.at(-1)).toBe(5);
    expect(forwarded.some((entry) => entry.provenance.laneId === "lane-a" && entry.provenance.childSequence !== undefined)).toBe(true);
    expect(state.parallelRuns?.build?.lanes["lane-a"]?.status).toBe("accepted");
  });

  test("hard-stops all lanes when aggregated usage exhausts the parent budget", async () => {
    const childRunner = createFakeChildCastRunner({ now: () => 10 });
    const state = makeState();
    const budgetFailures: string[] = [];
    const dispatcher = new ParallelLoopDispatcher({
      children: childRunner,
      workspaces: {
        async pinBaseline() { return { repositoryRoot: "/repo", baseline: { commitId: "base", changeId: "base-change" } }; },
        async create(input: { laneId: string }) {
          return {
            repositoryRoot: "/repo",
            workspaceRoot: "/tmp/materia",
            workspacePath: `/tmp/materia/${input.laneId}`,
            workspaceName: input.laneId,
            baseline: { commitId: "base", changeId: "base-change" },
            revision: { commitId: "base", changeId: "base-change" },
          };
        },
      },
      state: { saveCastState: () => undefined },
      budget: {
        async assertBudget(current) {
          if (current.runState.usage.tokens.total >= 5) throw new Error("pi-materia budget limit reached");
        },
      },
      onBudgetExceeded: async (_pi, _ctx, _state, error) => { budgetFailures.push(String(error)); },
    });

    await dispatcher.dispatch({ pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: state.pipeline.loops!.build.parallel! });
    const first = childRunner.listSnapshots()[0]!;
    childRunner.emit(first.identity.childCastId, {
      type: "socket_output",
      usage: {
        tokens: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5 },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    await childRunner.drain();

    expect(state.runState.usage.tokens.total).toBe(5);
    expect(budgetFailures).toEqual(["Error: pi-materia budget limit reached"]);
    expect(state.parallelRuns?.build?.phase).toBe("failed");
    expect(state.parallelRuns?.build?.lanes["lane-a"]?.status).toBe("interrupted");
    expect(state.parallelRuns?.build?.lanes["lane-b"]?.status).toBe("interrupted");
    expect(state.parallelRuns?.build?.lanes["lane-c"]?.status).toBe("failed");
    expect(childRunner.listSnapshots().every((snapshot) => snapshot.status === "interrupted")).toBe(true);
  });

  test("writes terminal, revision, and bounded diagnostics when workspace creation fails", async () => {
    const childRunner = createFakeChildCastRunner({ now: () => 10 });
    const state = makeState();
    const terminal: any[] = [];
    const revisions: any[] = [];
    const diagnostics: any[] = [];
    const laneArtifacts = {
      async initialize() { return {} as any; },
      async appendEvent() {},
      async writeTerminalResult(input: any) { terminal.push(input); },
      async writeRevision(input: any) { revisions.push(input); },
      async writeDiagnostics(input: any) { diagnostics.push(input); },
      async writeUsage() {},
    };
    const dispatcher = new ParallelLoopDispatcher({
      children: childRunner,
      workspaces: {
        async pinBaseline() { return { repositoryRoot: "/repo", baseline: { commitId: "base", changeId: "base-change" } }; },
        async create() { throw new Error("jj unavailable"); },
      },
      state: { saveCastState: () => undefined },
      artifacts: { lane: laneArtifacts },
    });

    await dispatcher.dispatch({ pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: state.pipeline.loops!.build.parallel! });

    expect(childRunner.listSnapshots()).toHaveLength(0);
    expect(state.parallelRuns?.build?.lanes["lane-a"]?.status).toBe("failed");
    expect(terminal[0]?.result).toMatchObject({ status: "failed", accepted: false, error: "workspace creation failed: jj unavailable" });
    expect(revisions[0]?.revision).toEqual({ baseline: { commitId: "base", changeId: "base-change" } });
    expect(diagnostics[0]?.diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.diagnostics[0].message.length).toBeLessThanOrEqual(1_000);
  });

  test("writes failure artifacts when child start fails", async () => {
    const runner = createFakeChildCastRunner({ now: () => 10 });
    const children = {
      start: async () => { throw new Error("child process unavailable"); },
      observe: runner.observe.bind(runner),
      subscribe: runner.subscribe.bind(runner),
      resume: runner.resume.bind(runner),
      abort: runner.abort.bind(runner),
    } as any;
    const state = makeState();
    const terminal: any[] = [];
    const revisions: any[] = [];
    const diagnostics: any[] = [];
    const laneArtifacts = {
      async initialize() { return {} as any; },
      async appendEvent() {},
      async writeTerminalResult(input: any) { terminal.push(input); },
      async writeRevision(input: any) { revisions.push(input); },
      async writeDiagnostics(input: any) { diagnostics.push(input); },
      async writeUsage() {},
    };
    const dispatcher = new ParallelLoopDispatcher({
      children,
      workspaces: {
        async pinBaseline() { return { repositoryRoot: "/repo", baseline: { commitId: "base", changeId: "base-change" } }; },
        async create(input: { laneId: string }) {
          return {
            repositoryRoot: "/repo",
            workspaceRoot: "/tmp/materia",
            workspacePath: `/tmp/materia/${input.laneId}`,
            workspaceName: input.laneId,
            baseline: { commitId: "base", changeId: "base-change" },
            revision: { commitId: "base", changeId: "base-change" },
          };
        },
      },
      state: { saveCastState: () => undefined },
      artifacts: { lane: laneArtifacts },
    });

    await dispatcher.dispatch({ pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: state.pipeline.loops!.build.parallel! });

    expect(state.parallelRuns?.build?.lanes["lane-a"]?.status).toBe("failed");
    expect(terminal[0]?.result.error).toBe("child launch failed: child process unavailable");
    expect(revisions[0]?.revision).toMatchObject({ baseline: { commitId: "base", changeId: "base-change" }, workspace: { commitId: "base", changeId: "base-change" } });
    expect(diagnostics[0]?.diagnostics[0].message).toBe("child launch failed: child process unavailable");
  });

  test("settles all-terminal runs when lanes fail before a child callback", async () => {
    for (const failureMode of ["workspace", "child"] as const) {
      const childRunner = createFakeChildCastRunner({ now: () => 10 });
      const state = makeState();
      const baseline = { commitId: "base", changeId: "base-change" };
      const workspaces = {
        async pinBaseline() { return { repositoryRoot: "/repo", baseline }; },
        async create(input: { laneId: string }) {
          if (failureMode === "workspace") throw new Error("jj unavailable");
          return {
            repositoryRoot: "/repo",
            workspaceRoot: "/tmp/materia",
            workspacePath: `/tmp/materia/${input.laneId}`,
            workspaceName: input.laneId,
            baseline,
            revision: baseline,
          };
        },
      };
      const children = failureMode === "workspace" ? childRunner : {
        start: async () => { throw new Error("child process unavailable"); },
        observe: childRunner.observe.bind(childRunner),
        subscribe: childRunner.subscribe.bind(childRunner),
        resume: childRunner.resume.bind(childRunner),
        abort: childRunner.abort.bind(childRunner),
      };
      const dispatcher = new ParallelLoopDispatcher({
        children: children as any,
        workspaces,
        state: { saveCastState: () => undefined },
      });

      await dispatcher.dispatch({ pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: state.pipeline.loops!.build.parallel! });

      const run = state.parallelRuns?.build;
      expect(run?.phase).toBe("failed");
      expect(run?.fanInPhase).toBe("skipped");
      expect(Object.values(run?.lanes ?? {}).every((lane) => lane.status === "failed")).toBe(true);
      expect(state.active).toBe(false);
      expect(state.socketState).toBe("failed");
      expect(state.failedReason).toContain("fan-in skipped");
    }
  });

  test("launches ordered streams with bounded concurrency and child context", async () => {
    const childRunner = createFakeChildCastRunner({ now: () => 10 });
    const created: string[] = [];
    const workspace = {
      async pinBaseline() { return { repositoryRoot: "/repo", baseline: { commitId: "base", changeId: "base-change" } }; },
      async create(input: { laneId: string }) {
        created.push(input.laneId);
        return {
          repositoryRoot: "/repo",
          workspaceRoot: "/tmp/materia",
          workspacePath: `/tmp/materia/${input.laneId}`,
          workspaceName: input.laneId,
          baseline: { commitId: "base", changeId: "base-change" },
          revision: { commitId: "base", changeId: "base-change" },
        };
      },
    };
    const saved: MateriaCastState[] = [];
    const dispatcher = new ParallelLoopDispatcher({
      children: childRunner,
      workspaces: workspace,
      state: { saveCastState: (_pi, state) => saved.push(state) },
    });

    await dispatcher.dispatch({ pi: {} as any, ctx: {} as any, state: makeState(), socket: {} as any, loopId: "build", config: makeState().pipeline.loops!.build.parallel! });

    expect(childRunner.listSnapshots()).toHaveLength(2);
    expect(created).toEqual(["lane-a", "lane-b"]);
    expect(childRunner.listSnapshots()[0]?.compiledLoadout.initialData).toMatchObject({
      workItems: [{ title: "one", context: "one" }],
      parallelContext: { planId: "plan-1", laneId: "lane-a", streamIndex: 0 },
      parallelLane: { laneId: "lane-a", streamIndex: 0 },
      parallelRun: { runId: "parallel:cast-1:build:plan-1", laneId: "lane-a" },
    });
    expect(saved.at(-1)?.socketState).toBe("running_parallel");

    const first = childRunner.listSnapshots()[0]!;
    childRunner.complete(first.identity.childCastId, { output: { state: { parallelLaneCheckpoint: { latestMeaningfulHead: { commitId: "head-a", changeId: "change-a" } } } } });
    await childRunner.drain();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(childRunner.listSnapshots()).toHaveLength(3);
    expect(created).toEqual(["lane-a", "lane-b", "lane-c"]);
    expect(saved.at(-1)?.parallelRuns?.build?.lanes["lane-a"]?.status).toBe("accepted");
    expect(saved.at(-1)?.parallelRuns?.build?.lanes["lane-a"]?.acceptedHead).toEqual({ commitId: "head-a", changeId: "change-a" });
  });

  test("waits for pre-run initialization cancellation before launching lanes", async () => {
    const childRunner = createFakeChildCastRunner({ now: () => 10 });
    const state = makeState();
    let resolveBaseline!: (value: { repositoryRoot: string; baseline: { commitId: string; changeId: string } }) => void;
    const baseline = new Promise<{ repositoryRoot: string; baseline: { commitId: string; changeId: string } }>((resolve) => {
      resolveBaseline = resolve;
    });
    let workspaceCreates = 0;
    const dispatcher = new ParallelLoopDispatcher({
      children: childRunner,
      workspaces: {
        pinBaseline: async () => baseline,
        async create() {
          workspaceCreates += 1;
          throw new Error("workspace creation should not run after cancellation");
        },
      },
      state: { saveCastState: () => undefined },
    });
    const input = { pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: state.pipeline.loops!.build.parallel! };

    const dispatch = dispatcher.dispatch(input);
    await Promise.resolve();
    const cancellation = dispatcher.cancel({ pi: input.pi, ctx: input.ctx, state, reason: "cancel during baseline pin" });
    resolveBaseline({ repositoryRoot: "/repo", baseline: { commitId: "base", changeId: "base-change" } });

    await Promise.all([dispatch, cancellation]);

    expect(workspaceCreates).toBe(0);
    expect(childRunner.listSnapshots()).toHaveLength(0);
    expect(state.parallelRuns?.build?.phase).toBe("failed");
    expect(Object.values(state.parallelRuns?.build?.lanes ?? {}).every((lane) => lane.status === "interrupted")).toBe(true);
  });

  test("revives failed or unaccepted lanes while preserving accepted heads and stream membership", async () => {
    const childRunner = createFakeChildCastRunner({ now: () => 10 });
    const state = makeState();
    const created: string[] = [];
    const baseline = { commitId: "base", changeId: "base-change" };
    const workspaces = {
      async pinBaseline() { return { repositoryRoot: "/repo", baseline }; },
      async create(input: { laneId: string }) {
        created.push(input.laneId);
        return {
          repositoryRoot: "/repo",
          workspaceRoot: "/tmp/materia",
          workspacePath: `/tmp/materia/${input.laneId}`,
          workspaceName: input.laneId,
          baseline,
          revision: baseline,
        };
      },
      async fanIn(input: any) {
        const orderedHeads = input.queueOrder.map((laneId: string, queueIndex: number) => {
          const lane = input.lanes.find((candidate: any) => candidate.laneId === laneId);
          return {
            laneId,
            streamIndex: lane.streamIndex,
            queueIndex,
            workItemIndexes: [...lane.workItemIndexes],
            head: lane.acceptedHead,
            workspace: lane.workspace,
          };
        });
        return {
          version: 1,
          parentCastId: input.parentCastId,
          loopId: input.loopId,
          runId: input.runId,
          baseline,
          parentRevisionBefore: baseline,
          parentRevisionAfter: baseline,
          orderedHeads,
          integrationRevision: baseline,
          outcome: "clean",
          conflictedPaths: [],
          conflictDetails: [],
          operationId: "fan-in",
          startedAt: 1,
          completedAt: 2,
          satisfied: true,
        };
      },
    };
    const dispatcher = new ParallelLoopDispatcher({
      children: childRunner,
      workspaces,
      state: { saveCastState: () => undefined },
    });
    const input = { pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: state.pipeline.loops!.build.parallel! };

    await dispatcher.dispatch(input);
    const initial = childRunner.listSnapshots();
    const laneA = initial.find((child) => child.identity.laneId === "lane-a")!;
    const laneB = initial.find((child) => child.identity.laneId === "lane-b")!;
    childRunner.complete(laneA.identity.childCastId, { output: baseline });
    // A child that exits cleanly without an accepted terminal result is
    // persisted as succeeded/accepted=false, but the lane is still failed and
    // must be eligible for explicit revival.
    childRunner.complete(laneB.identity.childCastId, { accepted: false, message: "no accepted terminal result" });
    await childRunner.drain();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const laneC = childRunner.listSnapshots().find((child) => child.identity.laneId === "lane-c")!;
    childRunner.complete(laneC.identity.childCastId, { output: baseline });
    await childRunner.drain();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const failedRun = state.parallelRuns?.build!;
    expect(failedRun.phase).toBe("failed");
    expect(failedRun.fanInPhase).toBe("skipped");
    expect(failedRun.lanes["lane-a"]?.status).toBe("accepted");
    expect(failedRun.lanes["lane-c"]?.status).toBe("accepted");
    const acceptedHead = failedRun.lanes["lane-a"]?.acceptedHead;
    const acceptedAttempt = failedRun.lanes["lane-a"]?.attempt;
    const beforeChildren = childRunner.listSnapshots().length;

    await dispatcher.revive(input);
    expect(created).toEqual(["lane-a", "lane-b", "lane-c", "lane-b"]);
    const revivedChild = childRunner.listSnapshots().find((child) => child.identity.laneId === "lane-b")!;
    expect(revivedChild.identity.childCastId).toBe(laneB.identity.childCastId);
    expect(revivedChild.attempt).toBe(2);
    expect(childRunner.listSnapshots().filter((child) => child.identity.laneId !== "lane-b")).toHaveLength(beforeChildren - 1);
    expect(state.parallelRuns?.build?.lanes["lane-a"]?.acceptedHead).toEqual(acceptedHead);
    expect(state.parallelRuns?.build?.lanes["lane-a"]?.attempt).toBe(acceptedAttempt);
    expect(state.parallelRuns?.build?.lanes["lane-b"]?.workItemIndexes).toEqual([1]);

    childRunner.complete(revivedChild.identity.childCastId, { output: baseline });
    await childRunner.drain();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.parallelRuns?.build?.fanInProvenance?.orderedHeads.map((head) => head.laneId)).toEqual(["lane-a", "lane-b", "lane-c"]);
  });

  test("rejects revival when a preserved workspace drifts or is no longer tracked", async () => {
    const childRunner = createFakeChildCastRunner({ now: () => 10 });
    const state = makeState();
    const baseline = { commitId: "base", changeId: "base-change" };
    const inspections = new Map<string, { exists: boolean; tracked: boolean; currentRevision: typeof baseline }>();
    const workspaces = {
      async pinBaseline() { return { repositoryRoot: "/repo", baseline }; },
      async create(input: { laneId: string }) {
        inspections.set(input.laneId, { exists: true, tracked: true, currentRevision: baseline });
        return {
          repositoryRoot: "/repo",
          workspaceRoot: "/tmp/materia",
          workspacePath: `/tmp/materia/${input.laneId}`,
          workspaceName: input.laneId,
          baseline,
          revision: baseline,
        };
      },
      async inspect(input: { workspaceName: string }) {
        return inspections.get(input.workspaceName);
      },
    };
    const dispatcher = new ParallelLoopDispatcher({
      children: childRunner,
      workspaces,
      state: { saveCastState: () => undefined },
    });
    const input = { pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: state.pipeline.loops!.build.parallel! };

    await dispatcher.dispatch(input);
    const initial = childRunner.listSnapshots();
    const laneA = initial.find((child) => child.identity.laneId === "lane-a")!;
    const laneB = initial.find((child) => child.identity.laneId === "lane-b")!;
    const headA = { commitId: "head-a", changeId: "change-a" };
    inspections.get("lane-a")!.currentRevision = headA;
    childRunner.complete(laneA.identity.childCastId, { output: headA });
    childRunner.complete(laneB.identity.childCastId, { accepted: false, message: "retry this lane" });
    await childRunner.drain();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const laneC = childRunner.listSnapshots().find((child) => child.identity.laneId === "lane-c")!;
    const headC = { commitId: "head-c", changeId: "change-c" };
    inspections.get("lane-c")!.currentRevision = headC;
    childRunner.complete(laneC.identity.childCastId, { output: headC });
    await childRunner.drain();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const beforeChildren = childRunner.listSnapshots().length;
    inspections.get("lane-a")!.tracked = false;
    const untracked = await dispatcher.validateRevival(input);
    expect(untracked.ok).toBe(false);
    expect(untracked.issues.some((issue) => issue.code === "workspace_untracked" && issue.laneId === "lane-a")).toBe(true);
    expect(childRunner.listSnapshots()).toHaveLength(beforeChildren);

    inspections.get("lane-a")!.tracked = true;
    inspections.get("lane-a")!.currentRevision = { commitId: "drifted", changeId: "drifted-change" };
    const drifted = await dispatcher.validateRevival(input);
    expect(drifted.ok).toBe(false);
    expect(drifted.issues.some((issue) => issue.code === "accepted_head_drift" && issue.laneId === "lane-a")).toBe(true);
    await expect(dispatcher.revive(input)).rejects.toThrow("accepted lane workspace revision");
    expect(childRunner.listSnapshots()).toHaveLength(beforeChildren);
  });

  test("cancels active and queued lanes, preserves workspace ownership, and ignores late callbacks", async () => {
    const childRunner = createFakeChildCastRunner({ now: () => 10 });
    const state = makeState();
    const dispatcher = new ParallelLoopDispatcher({
      children: childRunner,
      workspaces: {
        async pinBaseline() { return { repositoryRoot: "/repo", baseline: { commitId: "base", changeId: "base-change" } }; },
        async create(input: { laneId: string }) {
          return {
            repositoryRoot: "/repo",
            workspaceRoot: "/tmp/materia",
            workspacePath: `/tmp/materia/${input.laneId}`,
            workspaceName: input.laneId,
            baseline: { commitId: "base", changeId: "base-change" },
            revision: { commitId: "head-${input.laneId}", changeId: "change-${input.laneId}" },
          };
        },
      },
      state: { saveCastState: () => undefined },
    });
    const input = { pi: {} as any, ctx: {} as any, state, socket: {} as any, loopId: "build", config: state.pipeline.loops!.build.parallel! };

    await dispatcher.dispatch(input);
    await dispatcher.cancel({ pi: input.pi, ctx: input.ctx, state, loopId: "build", reason: "parent abort" });
    await childRunner.drain();

    expect(childRunner.listSnapshots().every((snapshot) => snapshot.status === "interrupted")).toBe(true);
    expect(state.parallelRuns?.build?.phase).toBe("failed");
    expect(state.parallelRuns?.build?.fanInPhase).toBe("skipped");
    expect(Object.values(state.parallelRuns?.build?.lanes ?? {}).every((lane) => lane.status === "interrupted")).toBe(true);
    expect(state.parallelRuns?.build?.lanes["lane-a"]?.workspace?.workspacePath).toBe("/tmp/materia/lane-a");
    expect(state.parallelRuns?.build?.lanes["lane-b"]?.workspace?.workspacePath).toBe("/tmp/materia/lane-b");
    expect(state.parallelRuns?.build?.lanes["lane-c"]?.workspace).toBeUndefined();

    const beforeLateEvent = JSON.stringify(state.parallelRuns?.build);
    childRunner.emit(childRunner.listSnapshots()[0]!.identity.childCastId, { type: "late_diagnostic", payload: { message: "too late" } });
    await childRunner.drain();
    await dispatcher.cancel({ pi: input.pi, ctx: input.ctx, state, loopId: "build", reason: "repeated abort" });
    expect(JSON.stringify(state.parallelRuns?.build)).toBe(beforeLateEvent);
  });
});
