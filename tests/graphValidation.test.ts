import { describe, expect, test } from "bun:test";
import { edgeConditionState, edgeGuard, formatGraphValidationErrors, stageValidatedPipelineGraphChange, validatePipelineGraph } from "../src/graphValidation.js";
import type { MateriaPipelineConfig } from "../src/types.js";

const validGraph = (): MateriaPipelineConfig => ({
  entry: "Plan",
  nodes: {
    Plan: { type: "agent", materia: "Plan", next: "Check" },
    Check: {
      type: "agent",
      materia: "Check",
      edges: [
        { when: "satisfied", to: "Maintain" },
        { when: "not_satisfied", to: "Build" },
      ],
    },
    Build: { type: "agent", materia: "Build", next: "Maintain" },
    Maintain: { type: "agent", materia: "Maintain" },
  },
});

describe("graph validation foundation", () => {
  test("accepts a graph with known endpoints and one satisfied/not_satisfied branch", () => {
    expect(validatePipelineGraph(validGraph())).toEqual({ ok: true, errors: [] });
  });

  test("rejects missing and unknown endpoints", () => {
    const graph = validGraph();
    graph.entry = "MissingEntry";
    graph.nodes.Check.edges = [{ when: "always", to: "MissingTarget" }, { when: "not_satisfied", to: undefined as never }];

    const result = validatePipelineGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(["unknown-endpoint", "unknown-endpoint", "missing-endpoint"]);
    expect(formatGraphValidationErrors(result.errors)).toContain('Unknown graph endpoint "MissingEntry" referenced by entry.');
    expect(formatGraphValidationErrors(result.errors)).toContain("Missing graph endpoint referenced by Check.edges[1].to.");
  });

  test("accepts repeated guarded edges because runtime evaluates them in order", () => {
    const graph = validGraph();
    graph.nodes.Check.edges = [
      { when: "satisfied", to: "Maintain" },
      { when: "satisfied", to: "Build" },
      { when: "not_satisfied", to: "Build" },
      { when: "not_satisfied", to: "Maintain" },
    ];

    expect(validatePipelineGraph(graph)).toEqual({ ok: true, errors: [] });
  });

  test("rejects missing, empty, legacy, and free-form edge conditions", () => {
    const graph = validGraph();
    graph.nodes.Check.edges = [
      { to: "Maintain" } as never,
      { when: "" as never, to: "Build" },
      { when: "$.passed == true" as never, to: "Maintain" },
      { when: "exists($.override)" as never, to: "Build" },
    ];

    const result = validatePipelineGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual([
      "invalid-edge-condition",
      "invalid-edge-condition",
      "invalid-edge-condition",
      "invalid-edge-condition",
    ]);
    expect(formatGraphValidationErrors(result.errors)).toContain("Expected one of: always, satisfied, not_satisfied");
  });

  test("rejects unreachable outgoing edges after an always edge", () => {
    const graph = validGraph();
    graph.nodes.Check.edges = [
      { when: "always", to: "Maintain" },
      { when: "not_satisfied", to: "Build" },
      { when: "always", to: "Build" },
    ];

    const result = validatePipelineGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors.filter((error) => error.code === "unreachable-edge").map((error) => error.message)).toEqual([
      'Socket "Check" has an unreachable outgoing edge at Check.edges[1] because Check.edges[0] is unconditional and runtime selects the first satisfied edge in order.',
      'Socket "Check" has an unreachable outgoing edge at Check.edges[2] because Check.edges[0] is unconditional and runtime selects the first satisfied edge in order.',
    ]);
  });

  test("accepts Auto-Eval branches to Maintain and Build even when both are satisfied guarded transitions", () => {
    const graph = validGraph();
    graph.nodes.Build.next = "Auto-Eval";
    graph.nodes["Auto-Eval"] = {
      type: "agent",
      materia: "Auto-Eval",
      edges: [
        { when: "satisfied", to: "Maintain" },
        { when: "not_satisfied", to: "Build", maxTraversals: 3 },
      ],
    };

    const result = stageValidatedPipelineGraphChange(graph, (draft) => {
      const retryEdge = draft.nodes["Auto-Eval"].edges?.[1];
      if (retryEdge) retryEdge.when = "satisfied";
    });

    expect(validatePipelineGraph(graph)).toEqual({ ok: true, errors: [] });
    expect(result.ok).toBe(true);
    expect(result.graph.nodes["Auto-Eval"].edges?.[1]?.when).toBe("satisfied");
  });

  test("accepts intentional iterative workflow loops bounded by runtime traversal limits", () => {
    const graph = validGraph();
    graph.nodes.Build.next = "Auto-Eval";
    graph.nodes["Auto-Eval"] = {
      type: "agent",
      materia: "Auto-Eval",
      edges: [
        { when: "satisfied", to: "Maintain" },
        { when: "not_satisfied", to: "Build", maxTraversals: 3 },
      ],
    };
    graph.nodes.Maintain.next = "Build";

    const result = validatePipelineGraph(graph);

    expect(result).toEqual({ ok: true, errors: [] });
  });

  test("stages valid graph mutations and leaves the original graph unchanged on validation errors", () => {
    const graph = validGraph();
    const accepted = stageValidatedPipelineGraphChange(graph, (draft) => {
      draft.nodes.Check.edges = [{ when: "satisfied", to: "Maintain" }];
    });

    expect(accepted.ok).toBe(true);
    expect(accepted.graph).not.toBe(graph);
    expect(accepted.graph.nodes.Check.edges).toHaveLength(1);
    expect(graph.nodes.Check.edges).toHaveLength(2);

    const acceptedLoop = stageValidatedPipelineGraphChange(graph, (draft) => {
      draft.nodes.Maintain.next = "Build";
    });

    expect(acceptedLoop.ok).toBe(true);
    expect(acceptedLoop.graph.nodes.Maintain.next).toBe("Build");

    const rejected = stageValidatedPipelineGraphChange(graph, (draft) => {
      draft.nodes.Maintain.next = "MissingTarget";
    });

    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toContainEqual(expect.objectContaining({ code: "unknown-endpoint" }));
    expect(rejected.graph).toBe(graph);
    expect(graph.nodes.Maintain.next).toBeUndefined();
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
