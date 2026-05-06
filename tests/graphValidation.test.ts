import { describe, expect, test } from "bun:test";
import { edgeConditionState, formatGraphValidationErrors, stageValidatedPipelineGraphChange, validatePipelineGraph } from "../src/graphValidation.js";
import type { MateriaPipelineConfig } from "../src/types.js";

const validGraph = (): MateriaPipelineConfig => ({
  entry: "Plan",
  nodes: {
    Plan: { type: "agent", materia: "Plan", next: "Check" },
    Check: {
      type: "agent",
      materia: "Check",
      edges: [
        { when: "$.passed == true", to: "Maintain" },
        { when: "$.passed == false", to: "Build" },
      ],
    },
    Build: { type: "agent", materia: "Build", next: "Maintain" },
    Maintain: { type: "agent", materia: "Maintain" },
  },
});

describe("graph validation foundation", () => {
  test("accepts a graph with known endpoints and one satisfied/unsatisfied branch", () => {
    expect(validatePipelineGraph(validGraph())).toEqual({ ok: true, errors: [] });
  });

  test("rejects missing and unknown endpoints", () => {
    const graph = validGraph();
    graph.entry = "MissingEntry";
    graph.nodes.Check.edges = [{ to: "MissingTarget" }, { when: "$.passed == false" as string, to: undefined as never }];

    const result = validatePipelineGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(["unknown-endpoint", "unknown-endpoint", "missing-endpoint"]);
    expect(formatGraphValidationErrors(result.errors)).toContain('Unknown graph endpoint "MissingEntry" referenced by entry.');
    expect(formatGraphValidationErrors(result.errors)).toContain("Missing graph endpoint referenced by Check.edges[1].to.");
  });

  test("enforces at most one outgoing satisfied and one outgoing unsatisfied edge per socket", () => {
    const graph = validGraph();
    graph.nodes.Check.edges = [
      { when: "$.passed == true", to: "Maintain" },
      { when: "$.reviewed != false", to: "Build" },
      { when: "$.passed == false", to: "Build" },
      { when: "$.retry != true", to: "Maintain" },
    ];

    const result = validatePipelineGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors.filter((error) => error.code === "duplicate-condition").map((error) => error.message)).toEqual([
      'Socket "Check" has more than one outgoing satisfied edge (Check.edges[0] and Check.edges[1]).',
      'Socket "Check" has more than one outgoing unsatisfied edge (Check.edges[2] and Check.edges[3]).',
    ]);
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
      draft.nodes.Check.edges = [{ when: "$.passed == true", to: "Maintain" }];
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

  test("classifies current satisfied and unsatisfied edge condition strings", () => {
    expect(edgeConditionState({})).toBe("satisfied");
    expect(edgeConditionState({ when: "satisfied" })).toBe("satisfied");
    expect(edgeConditionState({ when: "$.satisfied == true" })).toBe("satisfied");
    expect(edgeConditionState({ when: "$.passed != false" })).toBe("satisfied");
    expect(edgeConditionState({ when: "not_satisfied" })).toBe("unsatisfied");
    expect(edgeConditionState({ when: "$.satisfied == false" })).toBe("unsatisfied");
    expect(edgeConditionState({ when: "$.passed != true" })).toBe("unsatisfied");
    expect(edgeConditionState({ when: "$.score > 2" })).toBe("other");
  });
});
