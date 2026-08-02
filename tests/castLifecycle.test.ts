import { describe, expect, test } from "bun:test";
import { createCastLifecycle } from "../src/runtime/castLifecycle.js";

describe("cast lifecycle parallel revival", () => {
  test("revives an intrinsic parallel region without a loop concurrency override", async () => {
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
    const state = {
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
    const ctx = {
      ui: {
        notify: (message: string) => notifications.push(message),
      },
    };

    await lifecycle.reviveNativeCast({} as any, ctx as any, state.castId);

    expect(reviveCalls).toHaveLength(1);
    expect(reviveCalls[0]).toMatchObject({
      state,
      loopId: "work",
      config: { maxConcurrency: 3 },
    });
    expect(notifications.at(-1)).toContain("revived failed parallel lanes");
  });
});
