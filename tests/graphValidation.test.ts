import { describe, expect, test } from "bun:test";
import { edgeConditionState, edgeGuard, formatGraphValidationErrors, normalizePipelineGraph, stageValidatedPipelineGraphChange, validatePipelineGraph } from "../src/graphValidation.js";
import { assertCanonicalSocketId, isCanonicalSocketId, parseCanonicalSocketId } from "../src/socketIds.js";
import type { MateriaPipelineConfig } from "../src/types.js";

const validGraph = (): MateriaPipelineConfig => ({
  entry: "Socket-1",
  nodes: {
    "Socket-1": { type: "agent", materia: "Socket-1", next: "Socket-2" },
    "Socket-2": {
      type: "agent",
      materia: "Socket-2",
      edges: [
        { when: "satisfied", to: "Socket-4" },
        { when: "not_satisfied", to: "Socket-3" },
      ],
    },
    "Socket-3": { type: "agent", materia: "Socket-3", next: "Socket-4" },
    "Socket-4": { type: "agent", materia: "Socket-4" },
  },
});

describe("graph validation foundation", () => {
  test("parses and validates only canonical Socket-N identifiers", () => {
    expect(parseCanonicalSocketId("Socket-1")).toEqual({ id: "Socket-1", ordinal: 1 });
    expect(parseCanonicalSocketId("Socket-12")).toEqual({ id: "Socket-12", ordinal: 12 });
    for (const value of ["Socket-0", "Socket-03", "Socket 3", "Socket-only", "Build", "Auto-Eval"]) {
      expect(isCanonicalSocketId(value)).toBe(false);
    }
    expect(() => assertCanonicalSocketId("Build", "nodes.Build")).toThrow("Socket IDs are structural graph identifiers");
  });

  test("rejects non-canonical socket ids in loadout graph structure", () => {
    const graph = validGraph();
    graph.nodes["Socket-only"] = { type: "agent", materia: "AdHoc" };
    graph.nodes["Socket-2"].edges = [{ when: "always", to: "Build" }];

    const result = validatePipelineGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "invalid-socket-id", source: "nodes.Socket-only" }));
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "invalid-socket-id", source: "Socket-2.edges[0].to" }));
    expect(formatGraphValidationErrors(result.errors)).toContain("Expected Socket-N, where N is a positive integer without leading zeroes");
    expect(formatGraphValidationErrors(result.errors)).toContain("store human-readable labels or materia names in metadata fields");
  });

  test("accepts a graph with known endpoints and one satisfied/not_satisfied branch", () => {
    expect(validatePipelineGraph(validGraph())).toEqual({ ok: true, errors: [] });
  });

  test("rejects missing and unknown endpoints", () => {
    const graph = validGraph();
    graph.entry = "MissingEntry";
    graph.nodes["Socket-2"].edges = [{ when: "always", to: "MissingTarget" }, { when: "not_satisfied", to: undefined as never }];

    const result = validatePipelineGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(["invalid-socket-id", "invalid-socket-id", "missing-endpoint"]);
    expect(formatGraphValidationErrors(result.errors)).toContain('Invalid socket id "MissingEntry" referenced by entry. Expected Socket-N, where N is a positive integer without leading zeroes.');
    expect(formatGraphValidationErrors(result.errors)).toContain("Socket IDs are structural graph identifiers; store human-readable labels or materia names in metadata fields");
    expect(formatGraphValidationErrors(result.errors)).toContain("Missing graph endpoint referenced by Socket-2.edges[1].to.");
  });

  test("accepts repeated guarded edges because runtime evaluates them in order", () => {
    const graph = validGraph();
    graph.nodes["Socket-2"].edges = [
      { when: "satisfied", to: "Socket-4" },
      { when: "satisfied", to: "Socket-3" },
      { when: "not_satisfied", to: "Socket-3" },
      { when: "not_satisfied", to: "Socket-4" },
    ];

    expect(validatePipelineGraph(graph)).toEqual({ ok: true, errors: [] });
  });

  test("rejects empty and free-form edge conditions while accepting legacy flow aliases through normalization", () => {
    const graph = validGraph();
    graph.nodes["Socket-2"].edges = [
      { when: " " as never, to: "Socket-3" },
      { when: "$.passed == true" as never, to: "Socket-4" },
      { when: "exists($.override)" as never, to: "Socket-3" },
    ];

    const result = validatePipelineGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual([
      "invalid-edge-condition",
      "invalid-edge-condition",
      "invalid-edge-condition",
    ]);
    expect(formatGraphValidationErrors(result.errors)).toContain("Expected one of: always, satisfied, not_satisfied");
  });

  test("rejects unreachable outgoing edges after an always edge", () => {
    const graph = validGraph();
    graph.nodes["Socket-2"].edges = [
      { when: "always", to: "Socket-4" },
      { when: "not_satisfied", to: "Socket-3" },
      { when: "always", to: "Socket-3" },
    ];

    const result = validatePipelineGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors.filter((error) => error.code === "unreachable-edge").map((error) => error.message)).toEqual([
      'Socket "Socket-2" has an unreachable outgoing edge at Socket-2.edges[1] because Socket-2.edges[0] is unconditional and runtime selects the first satisfied edge in order.',
      'Socket "Socket-2" has an unreachable outgoing edge at Socket-2.edges[2] because Socket-2.edges[0] is unconditional and runtime selects the first satisfied edge in order.',
    ]);
  });

  test("accepts Auto-Eval branches to Maintain and Build even when both are satisfied guarded transitions", () => {
    const graph = validGraph();
    graph.nodes["Socket-3"].next = "Socket-5";
    graph.nodes["Socket-5"] = {
      type: "agent",
      materia: "Auto-Eval",
      edges: [
        { when: "satisfied", to: "Socket-4" },
        { when: "not_satisfied", to: "Socket-3", maxTraversals: 3 },
      ],
    };

    const result = stageValidatedPipelineGraphChange(graph, (draft) => {
      const retryEdge = draft.nodes["Socket-5"].edges?.[1];
      if (retryEdge) retryEdge.when = "satisfied";
    });

    expect(validatePipelineGraph(graph)).toEqual({ ok: true, errors: [] });
    expect(result.ok).toBe(true);
    expect(result.graph.nodes["Socket-5"].edges?.[1]?.when).toBe("satisfied");
  });

  test("accepts intentional iterative workflow loops bounded by runtime traversal limits", () => {
    const graph = validGraph();
    graph.nodes["Socket-3"].next = "Socket-5";
    graph.nodes["Socket-5"] = {
      type: "agent",
      materia: "Auto-Eval",
      edges: [
        { when: "satisfied", to: "Socket-4" },
        { when: "not_satisfied", to: "Socket-3", maxTraversals: 3 },
      ],
    };
    graph.nodes["Socket-4"].next = "Socket-3";
    graph.loops = {
      taskIteration: {
        label: "Build → Eval → Maintain until complete",
        nodes: ["Socket-3", "Socket-5", "Socket-4"],
        iterator: { items: "state.tasks", as: "task", cursor: "taskIndex", done: "end" },
        exit: { from: "Socket-4", when: "satisfied", to: "end" },
      },
    };

    const result = validatePipelineGraph(graph);

    expect(result).toEqual({ ok: true, errors: [] });
    expect(normalizePipelineGraph(graph).loops?.taskIteration.iterator?.cursor).toBe("taskIndex");
  });

  test("rejects loop regions that reference missing sockets or invalid exit conditions", () => {
    const graph = validGraph();
    graph.loops = { bad: { nodes: ["Socket-3", "Socket-9"], exit: { from: "Socket-9", when: "done" as never, to: "Socket-10" } } };

    const result = validatePipelineGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("unknown-endpoint");
    expect(result.errors.map((error) => error.code)).toContain("invalid-edge-condition");
  });

  test("rejects loop exits whose source is not a loop member", () => {
    const graph = validGraph();
    graph.loops = { bad: { nodes: ["Socket-3"], exit: { from: "Socket-4", when: "satisfied", to: "end" } } };

    const result = validatePipelineGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "invalid-loop", source: "loops.bad.exit.from" }));
  });

  test("normalizes legacy next and flow edges into canonical always edges", () => {
    const graph = validGraph();
    graph.nodes["Socket-1"].edges = [{ to: "Socket-4" } as never, { when: "Flow" as never, to: "Socket-2" }];

    const normalized = normalizePipelineGraph(graph);

    expect(normalized.nodes["Socket-1"].next).toBeUndefined();
    expect(normalized.nodes["Socket-1"].edges).toEqual([
      { to: "Socket-4", when: "always" },
      { to: "Socket-2", when: "always" },
      { when: "always", to: "Socket-2" },
    ]);
  });

  test("stages valid graph mutations and leaves the original graph unchanged on validation errors", () => {
    const graph = validGraph();
    const accepted = stageValidatedPipelineGraphChange(graph, (draft) => {
      draft.nodes["Socket-2"].edges = [{ when: "satisfied", to: "Socket-4" }];
    });

    expect(accepted.ok).toBe(true);
    expect(accepted.graph).not.toBe(graph);
    expect(accepted.graph.nodes["Socket-2"].edges).toHaveLength(1);
    expect(graph.nodes["Socket-2"].edges).toHaveLength(2);

    const acceptedLoop = stageValidatedPipelineGraphChange(graph, (draft) => {
      draft.nodes["Socket-4"].next = "Socket-3";
    });

    expect(acceptedLoop.ok).toBe(true);
    expect(acceptedLoop.graph.nodes["Socket-4"].edges).toEqual([{ when: "always", to: "Socket-3" }]);

    const rejected = stageValidatedPipelineGraphChange(graph, (draft) => {
      draft.nodes["Socket-4"].next = "MissingTarget";
    });

    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toContainEqual(expect.objectContaining({ code: "invalid-socket-id" }));
    expect(rejected.graph).toBe(graph);
    expect(graph.nodes["Socket-4"].next).toBeUndefined();
  });

  test("classifies only canonical edge condition strings", () => {
    expect(edgeConditionState({})).toBe("invalid");
    expect(edgeConditionState({ when: "always" })).toBe("always");
    expect(edgeConditionState({ when: "satisfied" })).toBe("satisfied");
    expect(edgeConditionState({ when: "not_satisfied" })).toBe("not_satisfied");
    expect(edgeConditionState({ when: "$.satisfied == true" })).toBe("invalid");
    expect(edgeConditionState({ when: "not satisfied" })).toBe("invalid");
  });

  test("classifies edge guards according to canonical runtime selection semantics", () => {
    expect(edgeGuard({})).toBe("guarded");
    expect(edgeGuard({ when: "   " })).toBe("guarded");
    expect(edgeGuard({ when: "always" })).toBe("unconditional");
    expect(edgeGuard({ when: "satisfied" })).toBe("guarded");
    expect(edgeGuard({ when: "not_satisfied" })).toBe("guarded");
    expect(edgeGuard({ when: "$.passed == true" })).toBe("guarded");
  });
});
