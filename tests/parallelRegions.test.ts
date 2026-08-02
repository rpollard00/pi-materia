import { describe, expect, test } from "bun:test";
import { deriveParallelBranchRegions } from "../src/graph/parallelRegions.js";
import { validatePipelineGraph } from "../src/graph/graphValidation.js";
import type { MateriaPipelineConfig } from "../src/types.js";

function graph(): MateriaPipelineConfig {
  return {
    entry: "Socket-1",
    sockets: {
      "Socket-1": { materia: "Planner", edges: [{ when: "always", to: "Socket-2" }] },
      "Socket-2": { materia: "Spawn", edges: [{ when: "always", to: "Socket-3" }] },
      "Socket-3": { materia: "Build", edges: [{ when: "always", to: "Socket-4" }] },
      "Socket-4": { materia: "Eval", edges: [{ when: "not_satisfied", to: "Socket-3" }] },
      "Socket-5": { materia: "Integrate" },
    },
    loops: {
      work: {
        sockets: ["Socket-3", "Socket-4"],
        consumes: { from: "Socket-1" },
        exit: { from: "Socket-4", when: "satisfied", to: "Socket-5" },
        parallel: { maxConcurrency: 2 },
      },
    },
  };
}

const parallelGenerator = (socketId: string) => socketId === "Socket-1";

describe("derived parallel branch regions", () => {
  test("derives a branch prelude, consuming loop, continuation, and concurrency override", () => {
    const result = deriveParallelBranchRegions(graph(), { isParallelGeneratorSocket: parallelGenerator });
    expect(result).toEqual({
      ok: true,
      value: [{
        generatorSocketId: "Socket-1",
        entrySocketId: "Socket-2",
        preludeSocketIds: ["Socket-2"],
        loopId: "work",
        loopSocketIds: ["Socket-3", "Socket-4"],
        continuationSocketId: "Socket-5",
        concurrency: { maxConcurrency: 2 },
      }],
    });
    expect(validatePipelineGraph(graph(), { isParallelGeneratorSocket: parallelGenerator }).ok).toBe(true);
  });

  test("does not let loop concurrency metadata opt an ordinary generator into parallelism", () => {
    expect(deriveParallelBranchRegions(graph(), { isParallelGeneratorSocket: () => false })).toEqual({ ok: true, value: [] });
  });

  test("rejects ambiguous preludes and multiple post-barrier continuations", () => {
    const ambiguous = graph();
    ambiguous.sockets["Socket-2"]!.edges!.push({ when: "satisfied", to: "Socket-5" });
    const pathResult = deriveParallelBranchRegions(ambiguous, { isParallelGeneratorSocket: parallelGenerator });
    expect(pathResult.ok).toBe(false);
    if (!pathResult.ok) expect(pathResult.issues[0]?.message).toContain("exactly one unconditional successor");

    const terminalBypass = graph();
    terminalBypass.sockets["Socket-1"]!.edges = [
      { when: "satisfied", to: "end" },
      { when: "always", to: "Socket-2" },
    ];
    const terminalBypassResult = deriveParallelBranchRegions(terminalBypass, { isParallelGeneratorSocket: parallelGenerator });
    expect(terminalBypassResult.ok).toBe(false);
    expect(validatePipelineGraph(terminalBypass, { isParallelGeneratorSocket: parallelGenerator }).ok).toBe(false);
    if (!terminalBypassResult.ok) {
      expect(terminalBypassResult.issues[0]?.message).toContain("exactly one unconditional successor");
      expect(terminalBypassResult.issues[0]?.message).toContain("has 2");
    }

    const continuations = graph();
    continuations.loops!.work!.exits = [{ id: "other", from: "Socket-4", condition: "not_satisfied", targetSocketId: "Socket-2" }];
    const continuationResult = deriveParallelBranchRegions(continuations, { isParallelGeneratorSocket: parallelGenerator });
    expect(continuationResult.ok).toBe(false);
    if (!continuationResult.ok) expect(continuationResult.issues[0]?.message).toContain("exactly one post-barrier continuation");
  });

  test("rejects overlapping initial branch regions", () => {
    const overlap = graph();
    overlap.sockets["Socket-6"] = { materia: "Planner2", edges: [{ when: "always", to: "Socket-2" }] };
    overlap.loops!.other = {
      sockets: ["Socket-3", "Socket-4"],
      consumes: { from: "Socket-6" },
      exit: { from: "Socket-4", when: "satisfied", to: "Socket-5" },
    };
    const result = deriveParallelBranchRegions(overlap, { isParallelGeneratorSocket: (id) => id === "Socket-1" || id === "Socket-6" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((issue) => issue.message.includes("overlap or nest"))).toBe(true);
  });
});
