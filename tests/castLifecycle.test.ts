import { describe, expect, test } from "bun:test";
import { createCastLifecycle } from "../src/runtime/castLifecycle.js";

describe("cast lifecycle parallel revival", () => {
  function makeParallelState() {
    const socket = {
      id: "Socket-2",
      socket: { materia: "Build" },
      materia: { type: "agent", tools: "coding", prompt: "Build it" },
    };
    const run = {
      runId: "parallel-1",
      phase: "failed",
      fanInPhase: "skipped",
      maxConcurrency: 3,
      lanes: {
        "lane-a": { laneId: "lane-a", status: "accepted" },
        "lane-b": { laneId: "lane-b", status: "failed" },
      },
    };
    return {
      active: false,
      castId: "cast-1",
      phase: "failed",
      socketState: "failed",
      currentSocketId: socket.id,
      data: {},
      runState: { runId: "cast-1" },
      pipeline: {
        entry: socket,
        sockets: { [socket.id]: socket },
        loops: {
          work: {
            sockets: [socket.id],
            consumes: { from: "Socket-1", output: "workItems" },
            iterator: { items: "state.workItems", as: "workItem", cursor: "workItemIndex", done: "end" },
          },
        },
      },
      parallelRuns: { work: run },
    };
  }

  test("revives an intrinsic parallel region without a loop concurrency override", async () => {
    const state = makeParallelState();
    const reviveCalls: any[] = [];
    const lifecycle = createCastLifecycle({
      state: {
        loadActiveCastState: () => undefined,
        loadCastStateById: () => state,
      },
      parallel: {
        revive: async (input: any) => {
          reviveCalls.push(input);
        },
      },
    } as any);
    const notifications: string[] = [];
    const ctx = { ui: { notify: (message: string) => notifications.push(message) } };

    await lifecycle.reviveNativeCast({} as any, ctx as any, state.castId);

    expect(reviveCalls).toHaveLength(1);
    expect(reviveCalls[0]).toMatchObject({ state, loopId: "work", config: { maxConcurrency: 3 } });
    expect(notifications.at(-1)).toContain("revived failed parallel lanes");
  });

  test("dispatches selected lane recast through the native parallel recovery boundary", async () => {
    const state = makeParallelState();
    const recastCalls: any[] = [];
    const lifecycle = createCastLifecycle({
      state: {
        loadActiveCastState: () => undefined,
        loadCastStateById: () => state,
      },
      parallel: {
        revive: async () => undefined,
        recast: async (input: any) => {
          recastCalls.push(input);
        },
      },
    } as any);
    const notifications: string[] = [];
    const ctx = { ui: { notify: (message: string) => notifications.push(message) } };

    await lifecycle.recoverParallelNativeCast({} as any, ctx as any, state.castId, { operation: "recast", loopId: "work", laneIds: ["lane-b"], laneNumber: 2 });

    expect(recastCalls).toHaveLength(1);
    expect(recastCalls[0]).toMatchObject({ state, loopId: "work", config: { maxConcurrency: 3 }, operation: "recast", laneIds: ["lane-b"], laneNumber: 2 });
    expect(notifications.at(-1)).toContain("recast failed parallel lanes (lane-b)");
  });
});
