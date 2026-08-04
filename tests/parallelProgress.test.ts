import { describe, expect, test } from "bun:test";
import { deriveNominalParallelLaneProgress } from "../src/domain/parallelProgress.js";

const definition = {
  orderedLoopSocketIds: ["Socket-2", "Socket-3", "Socket-4"],
  workItemCount: 2,
} as const;

describe("nominal parallel lane progress", () => {
  test("counts ordered loop nodes for every assigned work item", () => {
    expect(deriveNominalParallelLaneProgress({ definition, workItemCursor: 0, activeSocketId: "Socket-2" })).toEqual({ position: 1, total: 6 });
    expect(deriveNominalParallelLaneProgress({ definition, workItemCursor: 0, activeSocketId: "Socket-4" })).toEqual({ position: 3, total: 6 });
    expect(deriveNominalParallelLaneProgress({ definition, workItemCursor: 1, activeSocketId: "Socket-3" })).toEqual({ position: 5, total: 6 });
  });

  test("excludes branch-prelude nodes from both total and position", () => {
    const compiledDefinition = {
      orderedLoopSocketIds: ["Socket-1", "Socket-2"],
      workItemCount: 2,
    } as const;
    expect(deriveNominalParallelLaneProgress({
      definition: compiledDefinition,
      workItemCursor: 0,
      activeSocketId: "Socket-3", // Compiled prelude, intentionally absent above.
    })).toEqual({ position: 0, total: 4 });
  });

  test("clamps malformed cursors and terminal bounds", () => {
    expect(deriveNominalParallelLaneProgress({ definition, workItemCursor: -10, activeSocketId: "Socket-2" })).toEqual({ position: 1, total: 6 });
    expect(deriveNominalParallelLaneProgress({ definition, workItemCursor: 99, activeSocketId: "Socket-2" })).toEqual({ position: 6, total: 6 });
    expect(deriveNominalParallelLaneProgress({ definition, workItemCursor: Number.POSITIVE_INFINITY })).toEqual({ position: 6, total: 6 });
    expect(deriveNominalParallelLaneProgress({ definition, workItemCursor: "bad", activeSocketId: "not-a-loop-node" })).toEqual({ position: 0, total: 6 });
    expect(deriveNominalParallelLaneProgress({
      definition: { orderedLoopSocketIds: [], workItemCount: -1 },
      workItemCursor: 5,
    })).toEqual({ position: 0, total: 0 });
  });
});
