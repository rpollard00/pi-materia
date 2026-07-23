import { describe, expect, test } from "bun:test";
import {
  MateriaNoAdvanceCycleExhaustionError,
  recordNoAdvanceSocketStart,
} from "../src/application/noAdvanceCycles.js";
import { applyAdvance } from "../src/application/workflowTransitions.js";
import type { MateriaCastState, ResolvedMateriaSocket } from "../src/types.js";

function state(): MateriaCastState {
  return {
    version: 2,
    active: true,
    castId: "cast",
    request: "request",
    configSource: "test",
    configHash: "hash",
    cwd: "/tmp",
    runDir: "/tmp/run",
    artifactRoot: "/tmp",
    phase: "Build",
    currentSocketId: "Build",
    currentMateria: "Build",
    currentItemKey: "WI-1",
    awaitingResponse: false,
    startedAt: 0,
    updatedAt: 0,
    data: { workItems: [{ title: "One" }, { title: "Two" }] },
    cursors: { workItemIndex: 0 },
    visits: {},
    taskAttempts: {},
    edgeTraversals: {},
    runState: { castId: "cast", runDir: "/tmp/run", usage: {} } as never,
    pipeline: { entry: {} as never, sockets: {} },
  };
}

function advancingSocket(): ResolvedMateriaSocket {
  return {
    id: "Maintain",
    socket: {
      materia: "Maintain",
      advance: { cursor: "workItemIndex", items: "state.workItems", when: "satisfied" },
    },
    materia: { tools: "coding", prompt: "maintain" },
  } as ResolvedMateriaSocket;
}

describe("no-advance cycle tracking", () => {
  test("fails only after the configured same-item cycle bound is exceeded", () => {
    const cast = state();

    for (let cycle = 0; cycle < 2; cycle += 1) {
      recordNoAdvanceSocketStart(cast, "Build", 2);
      recordNoAdvanceSocketStart(cast, "Eval", 2);
      recordNoAdvanceSocketStart(cast, "Maintain", 2);
    }

    expect(cast.noAdvanceCycles).toMatchObject({ itemKey: "WI-1", count: 1 });
    recordNoAdvanceSocketStart(cast, "Build", 2);
    recordNoAdvanceSocketStart(cast, "Eval", 2);
    recordNoAdvanceSocketStart(cast, "Maintain", 2);

    try {
      recordNoAdvanceSocketStart(cast, "Build", 2);
      throw new Error("expected no-advance cycle exhaustion");
    } catch (error) {
      expect(error).toBeInstanceOf(MateriaNoAdvanceCycleExhaustionError);
      expect((error as MateriaNoAdvanceCycleExhaustionError).message).toContain('itemKey "WI-1"');
      expect((error as MateriaNoAdvanceCycleExhaustionError).sockets).toEqual(["Build", "Eval", "Maintain", "Build"]);
    }
  });

  test("resets the counter immediately when the work-item cursor advances", () => {
    const cast = state();
    recordNoAdvanceSocketStart(cast, "Build", 3);
    recordNoAdvanceSocketStart(cast, "Eval", 3);
    recordNoAdvanceSocketStart(cast, "Build", 3);
    expect(cast.noAdvanceCycles?.count).toBe(1);

    applyAdvance(cast, advancingSocket(), { satisfied: true });

    expect(cast.cursors.workItemIndex).toBe(1);
    expect(cast.noAdvanceCycles).toBeUndefined();
  });

  test("starts a fresh counter when the current item key changes", () => {
    const cast = state();
    recordNoAdvanceSocketStart(cast, "Build", 3);
    recordNoAdvanceSocketStart(cast, "Build", 3);
    cast.currentItemKey = "WI-2";

    recordNoAdvanceSocketStart(cast, "Build", 3);

    expect(cast.noAdvanceCycles).toEqual({ itemKey: "WI-2", count: 0, socketPath: ["Build"] });
  });
});
