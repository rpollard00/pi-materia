import { describe, expect, test } from "bun:test";
import { createCastLifecycle } from "../src/runtime/castLifecycle.js";

describe("cast lifecycle parallel revival delegation", () => {
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

  test("delegates bulk parallel revival to the lane recovery module with the single candidate run", async () => {
    const state = makeParallelState();
    const recoverCalls: any[] = [];
    const lifecycle = createCastLifecycle({
      state: {
        loadActiveCastState: () => undefined,
        loadCastStateById: () => state,
      },
      parallelRecovery: {
        recover: async (input: any) => {
          recoverCalls.push(input);
          return state;
        },
      },
    } as any);
    const ctx = { ui: { notify: () => {} } };

    await lifecycle.reviveNativeCast({} as any, ctx as any, state.castId);

    expect(recoverCalls).toHaveLength(1);
    expect(recoverCalls[0]).toMatchObject({ operation: "revive", castId: "cast-1", loopId: "work" });
  });

  test("rejects a cast with multiple recoverable parallel runs before delegating", async () => {
    const state = makeParallelState();
    state.parallelRuns.extra = { ...state.parallelRuns.work, runId: "parallel-2" };
    let recovered = false;
    const lifecycle = createCastLifecycle({
      state: {
        loadActiveCastState: () => undefined,
        loadCastStateById: () => state,
      },
      parallelRecovery: {
        recover: async () => {
          recovered = true;
          return state;
        },
      },
    } as any);
    const ctx = { ui: { notify: () => {} } };

    await expect(lifecycle.reviveNativeCast({} as any, ctx as any, state.castId)).rejects.toThrow("multiple failed parallel lane runs");
    expect(recovered).toBe(false);
  });
});
