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
});
