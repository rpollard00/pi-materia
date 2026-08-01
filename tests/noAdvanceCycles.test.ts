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

  test("explicit retry re-entries stay governed by the edge retry budget, not the structural counter", () => {
    const cast = state();
    // maxNoAdvanceCycles is low (1) and the closing edge is an explicit retry
    // edge, so the per-item maxTraversals policy owns these cycles without an
    // unrelated cumulative no-advance cap stacked on top.
    for (let cycle = 0; cycle < 5; cycle += 1) {
      recordNoAdvanceSocketStart(cast, "Build", 1, true);
      recordNoAdvanceSocketStart(cast, "Eval", 1, false);
    }

    expect(cast.noAdvanceCycles).toMatchObject({ itemKey: "WI-1", count: 0 });
  });

  test("unannotated re-entry after explicit retries still exhausts with route diagnostics", () => {
    const cast = state();
    // Two cycles closed by an explicit retry edge never advance the structural counter...
    recordNoAdvanceSocketStart(cast, "Build", 1, true);
    recordNoAdvanceSocketStart(cast, "Eval", 1, true);
    recordNoAdvanceSocketStart(cast, "Build", 1, true);
    recordNoAdvanceSocketStart(cast, "Eval", 1, true);
    expect(cast.noAdvanceCycles?.count).toBe(0);

    // ...then a genuinely unbounded cycle closes through an unannotated edge
    // and the structural fallback still fails with the closed route.
    recordNoAdvanceSocketStart(cast, "Build", 1, false);
    recordNoAdvanceSocketStart(cast, "Eval", 1, false);
    expect(cast.noAdvanceCycles?.count).toBe(1);
    try {
      recordNoAdvanceSocketStart(cast, "Build", 1, false);
      throw new Error("expected no-advance cycle exhaustion");
    } catch (error) {
      expect(error).toBeInstanceOf(MateriaNoAdvanceCycleExhaustionError);
      expect((error as MateriaNoAdvanceCycleExhaustionError).sockets).toEqual(["Build", "Eval", "Build"]);
    }
  });

  test("explicit retry re-entry keeps subsequent cycle detection bounded", () => {
    const cast = state();
    recordNoAdvanceSocketStart(cast, "Build", 3);
    recordNoAdvanceSocketStart(cast, "Eval", 3);
    recordNoAdvanceSocketStart(cast, "Maintain", 3);
    // Closing the cycle via the explicit retry edge collapses the path without
    // incrementing the counter, so a later unannotated cycle is detected cleanly.
    recordNoAdvanceSocketStart(cast, "Build", 3, true);
    expect(cast.noAdvanceCycles).toMatchObject({ itemKey: "WI-1", count: 0, socketPath: ["Build"] });

    recordNoAdvanceSocketStart(cast, "Eval", 3);
    recordNoAdvanceSocketStart(cast, "Build", 3, false);
    expect(cast.noAdvanceCycles).toMatchObject({ itemKey: "WI-1", count: 1, socketPath: ["Build"] });
  });
});
