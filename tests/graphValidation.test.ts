import { describe, expect, test } from "bun:test";
import { edgeConditionState, edgeGuard, formatGraphValidationErrors, normalizePipelineGraph, stageValidatedPipelineGraphChange, validatePipelineGraph } from "../src/graph/graphValidation.js";
import { assertCanonicalSocketId, isCanonicalSocketId, parseCanonicalSocketId } from "../src/domain/socket.js";
import type { MateriaPipelineConfig } from "../src/types.js";

const validGraph = (): MateriaPipelineConfig => ({
  entry: "Socket-1",
  sockets: {
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
    expect(() => assertCanonicalSocketId("Build", "sockets.Build")).toThrow("Socket IDs are structural graph identifiers");
  });

  test("rejects non-canonical socket ids in loadout graph structure", () => {
    const graph = validGraph();
    graph.sockets["Socket-only"] = { type: "agent", materia: "AdHoc" };
    graph.sockets["Socket-2"].edges = [{ when: "always", to: "Build" }];

    const result = validatePipelineGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "invalid-socket-id", source: "sockets.Socket-only" }));
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "invalid-socket-id", source: "Socket-2.edges[0].to" }));
    expect(formatGraphValidationErrors(result.errors)).toContain("Expected Socket-N, where N is a positive integer without leading zeroes");
    expect(formatGraphValidationErrors(result.errors)).toContain("store human-readable labels or materia names in metadata fields");
  });

  test("validates all loadout socket references as canonical ids while preserving end only for targets", () => {
    const graph = validGraph();
    graph.sockets["Socket-1"].foreach = { items: "state.items", done: "Socket 3" };
    graph.sockets["Socket-2"].advance = { cursor: "i", items: "state.items", done: "Socket-03" };
    graph.loops = {
      bad: {
        sockets: ["Socket-3", "end"],
        consumes: { from: "Auto-Eval", done: "end" },
        iterator: { items: "state.items", done: "end" },
        exit: { from: "Socket-3", when: "satisfied", to: "end" },
      },
    };

    const result = validatePipelineGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid-socket-id", source: "Socket-1.foreach.done" }),
      expect.objectContaining({ code: "invalid-socket-id", source: "Socket-2.advance.done" }),
      expect.objectContaining({ code: "invalid-socket-id", source: "loops.bad.sockets[1]" }),
      expect.objectContaining({ code: "invalid-socket-id", source: "loops.bad.consumes.from" }),
    ]));
    expect(result.errors).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "loops.bad.consumes.done" }),
      expect.objectContaining({ source: "loops.bad.iterator.done" }),
      expect.objectContaining({ source: "loops.bad.exit.to" }),
    ]));
  });

  test("rejects end as a loadout entry because entry must be a socket", () => {
    const graph = validGraph();
    graph.entry = "end";

    const result = validatePipelineGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "invalid-socket-id", source: "entry" }));
  });

  test("accepts a graph with known endpoints and one satisfied/not_satisfied branch", () => {
    expect(validatePipelineGraph(validGraph())).toEqual({ ok: true, errors: [] });
  });

  test("rejects missing and unknown endpoints", () => {
    const graph = validGraph();
    graph.entry = "MissingEntry";
    graph.sockets["Socket-2"].edges = [{ when: "always", to: "MissingTarget" }, { when: "not_satisfied", to: undefined as never }];

    const result = validatePipelineGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(["invalid-socket-id", "invalid-socket-id", "missing-endpoint"]);
    expect(formatGraphValidationErrors(result.errors)).toContain('Invalid socket id "MissingEntry" referenced by entry. Expected Socket-N, where N is a positive integer without leading zeroes.');
    expect(formatGraphValidationErrors(result.errors)).toContain("Socket IDs are structural graph identifiers; store human-readable labels or materia names in metadata fields");
    expect(formatGraphValidationErrors(result.errors)).toContain("Missing graph endpoint referenced by Socket-2.edges[1].to.");
  });

  test("accepts repeated guarded edges because runtime evaluates them in order", () => {
    const graph = validGraph();
    graph.sockets["Socket-2"].edges = [
      { when: "satisfied", to: "Socket-4" },
      { when: "satisfied", to: "Socket-3" },
      { when: "not_satisfied", to: "Socket-3" },
      { when: "not_satisfied", to: "Socket-4" },
    ];

    expect(validatePipelineGraph(graph)).toEqual({ ok: true, errors: [] });
  });

  test("rejects empty and free-form edge conditions while accepting legacy flow aliases through normalization", () => {
    const graph = validGraph();
    graph.sockets["Socket-2"].edges = [
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
    graph.sockets["Socket-2"].edges = [
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
    graph.sockets["Socket-3"].next = "Socket-5";
    graph.sockets["Socket-5"] = {
      type: "agent",
      materia: "Auto-Eval",
      edges: [
        { when: "satisfied", to: "Socket-4" },
        { when: "not_satisfied", to: "Socket-3", maxTraversals: 3 },
      ],
    };

    const result = stageValidatedPipelineGraphChange(graph, (draft) => {
      const retryEdge = draft.sockets["Socket-5"].edges?.[1];
      if (retryEdge) retryEdge.when = "satisfied";
    });

    expect(validatePipelineGraph(graph)).toEqual({ ok: true, errors: [] });
    expect(result.ok).toBe(true);
    expect(result.graph.sockets["Socket-5"].edges?.[1]?.when).toBe("satisfied");
  });

  test("accepts intentional iterative workflow loops bounded by runtime traversal limits", () => {
    const graph = validGraph();
    graph.sockets["Socket-3"].next = "Socket-5";
    graph.sockets["Socket-5"] = {
      type: "agent",
      materia: "Auto-Eval",
      edges: [
        { when: "satisfied", to: "Socket-4" },
        { when: "not_satisfied", to: "Socket-3", maxTraversals: 3 },
      ],
    };
    graph.sockets["Socket-4"].next = "Socket-3";
    graph.loops = {
      taskIteration: {
        label: "Build → Eval → Maintain until complete",
        sockets: ["Socket-3", "Socket-5", "Socket-4"],
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
    graph.loops = { bad: { sockets: ["Socket-3", "Socket-9"], exit: { from: "Socket-9", when: "done" as never, to: "Socket-10" } } };

    const result = validatePipelineGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("unknown-endpoint");
    expect(result.errors.map((error) => error.code)).toContain("invalid-edge-condition");
  });

  test("rejects loop exits whose source is not a loop member", () => {
    const graph = validGraph();
    graph.loops = { bad: { sockets: ["Socket-3"], exit: { from: "Socket-4", when: "satisfied", to: "end" } } };

    const result = validatePipelineGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "invalid-loop", source: "loops.bad.exit.from" }));
  });

  test("accepts canonical loop-owned exit routes without normal outgoing edges", () => {
    const graph = validGraph();
    graph.sockets["Socket-3"] = { type: "agent", materia: "Socket-3" };
    graph.sockets["Socket-4"] = { type: "agent", materia: "Socket-4" };
    graph.loops = {
      taskIteration: {
        sockets: ["Socket-2", "Socket-3"],
        exits: [
          { id: "route-summary", from: "Socket-3", condition: "always", targetSocketId: "Socket-4" },
          { id: "route-satisfied", from: "Socket-3", condition: "satisfied", targetSocketId: "Socket-4" },
          { id: "route-not-satisfied", from: "Socket-3", condition: "not_satisfied", targetSocketId: "Socket-1" },
        ],
      },
    };

    const result = validatePipelineGraph(graph);

    expect(result).toEqual({ ok: true, errors: [] });
    expect(normalizePipelineGraph(graph).sockets["Socket-3"].edges).toBeUndefined();
    expect(normalizePipelineGraph(graph).loops?.taskIteration.exits?.[0]).toEqual({ id: "route-summary", from: "Socket-3", condition: "always", targetSocketId: "Socket-4" });
  });

  test("rejects malformed loop-owned exit routes", () => {
    const graph = validGraph();
    graph.loops = {
      bad: {
        sockets: ["Socket-3"],
        exits: [
          { id: "", from: "Socket-3", condition: "always", targetSocketId: "Socket-4" },
          { id: "dup", from: "Socket-3", condition: "done" as never, targetSocketId: "Socket-4" },
          { id: "dup", from: "Socket-4", condition: "satisfied", targetSocketId: "Socket-4" },
          { id: "unknown-target", from: "Socket-3", condition: "not_satisfied", targetSocketId: "Socket-9" },
          { id: "duplicate-condition", from: "Socket-3", condition: "not_satisfied", targetSocketId: "Socket-4" },
          { id: "terminal", from: "Socket-3", condition: "satisfied", targetSocketId: "end" },
        ],
      },
    };

    const result = validatePipelineGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid-loop", source: "loops.bad.exits[0].id" }),
      expect.objectContaining({ code: "invalid-edge-condition", source: "loops.bad.exits[1].condition" }),
      expect.objectContaining({ code: "invalid-loop", source: "loops.bad.exits[2].id" }),
      expect.objectContaining({ code: "invalid-loop", source: "loops.bad.exits[2].from" }),
      expect.objectContaining({ code: "unknown-endpoint", source: "loops.bad.exits[3].targetSocketId" }),
      expect.objectContaining({ code: "invalid-loop", source: "loops.bad.exits[4].condition" }),
    ]));
    expect(formatGraphValidationErrors(result.errors)).toContain("Only one route per condition per loop exit source is allowed");
  });

  test("validates executable loop semantics before UI-created loops are accepted", () => {
    const graph = validGraph();
    graph.sockets["Socket-1"] = { type: "agent", materia: "planner", edges: [{ when: "always", to: "Socket-3" }] };
    graph.sockets["Socket-3"] = { type: "agent", materia: "Build", edges: [{ when: "always", to: "Socket-4" }] };
    graph.sockets["Socket-4"] = { type: "agent", materia: "Maintain", parse: "text", edges: [{ when: "always", to: "Socket-3" }] };
    graph.loops = {
      loopSelection: {
        sockets: ["Socket-3", "Socket-4"],
        consumes: { from: "Socket-1", output: "workItems" },
        exit: { from: "Socket-4", when: "satisfied", to: "end" },
      },
    };

    const result = validatePipelineGraph(graph, { isGeneratorSocket: (socketId) => socketId === "Socket-1" });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ source: "Socket-4.parse" }));
    expect(formatGraphValidationErrors(result.errors)).toContain('field parse has current value "text", expected "json"');
    expect(formatGraphValidationErrors(result.errors)).toContain("Suggested fix: set Socket-4.parse to \"json\"");
  });

  test("rejects consumed loops that cannot advance safely or continue non-final items", () => {
    const graph = validGraph();
    graph.sockets["Socket-1"] = { type: "agent", materia: "planner", edges: [{ when: "always", to: "Socket-3" }] };
    graph.sockets["Socket-3"] = { type: "agent", materia: "Build", edges: [{ when: "always", to: "Socket-4" }] };
    graph.sockets["Socket-4"] = { type: "agent", materia: "Maintain", parse: "json", advance: { cursor: "taskIndex", items: "state.tasks", done: "Socket-3", when: "not_satisfied" } };
    graph.loops = {
      loopSelection: {
        sockets: ["Socket-3", "Socket-4"],
        consumes: { from: "Socket-1", output: "workItems" },
        exit: { from: "Socket-4", when: "satisfied", to: "end" },
      },
    };

    const result = validatePipelineGraph(graph, { isGeneratorSocket: (socketId) => socketId === "Socket-1" });
    const message = formatGraphValidationErrors(result.errors);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "Socket-4.advance.cursor" }),
      expect.objectContaining({ source: "Socket-4.advance.items" }),
      expect.objectContaining({ source: "Socket-4.advance.when" }),
      expect.objectContaining({ source: "Socket-4.edges" }),
    ]));
    expect(result.errors).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "Socket-4.advance.done" }),
    ]));
    expect(message).toContain('field advance.cursor has current value "taskIndex", expected "workItemIndex"');
    expect(message).toContain("has no outgoing route back into loop members");
  });

  test("accepts consumed loop advance without route-bearing advance.done", () => {
    const graph = validGraph();
    graph.sockets["Socket-1"] = { type: "agent", materia: "planner", edges: [{ when: "always", to: "Socket-3" }] };
    graph.sockets["Socket-2"] = { type: "agent", materia: "summary" };
    graph.sockets["Socket-3"] = { type: "agent", materia: "Build", edges: [{ when: "always", to: "Socket-4" }] };
    graph.sockets["Socket-4"] = {
      type: "agent",
      materia: "Maintain",
      parse: "json",
      advance: { cursor: "workItemIndex", items: "state.workItems", when: "satisfied" },
      edges: [{ when: "not_satisfied", to: "Socket-3" }],
    };
    graph.loops = {
      loopSelection: {
        sockets: ["Socket-3", "Socket-4"],
        consumes: { from: "Socket-1", output: "workItems" },
        exit: { from: "Socket-4", when: "satisfied", to: "end" },
        exits: [{ id: "post-loop", from: "Socket-4", condition: "satisfied", targetSocketId: "Socket-2" }],
      },
    };

    const result = validatePipelineGraph(graph, { isGeneratorSocket: (socketId) => socketId === "Socket-1" });

    expect(result).toEqual({ ok: true, errors: [] });
  });

  test("validates opposite-condition retry routes for conditional loop continuations", () => {
    const graph = validGraph();
    graph.sockets["Socket-1"] = { type: "agent", materia: "planner", edges: [{ when: "always", to: "Socket-3" }] };
    graph.sockets["Socket-3"] = { type: "agent", materia: "Build", edges: [{ when: "always", to: "Socket-4" }] };
    graph.sockets["Socket-4"] = { type: "agent", materia: "Maintain", parse: "json", edges: [{ when: "satisfied", to: "Socket-3" }] };
    graph.loops = {
      loopSelection: {
        sockets: ["Socket-3", "Socket-4"],
        consumes: { from: "Socket-1", output: "workItems" },
        exit: { from: "Socket-4", when: "satisfied", to: "end" },
      },
    };

    const result = validatePipelineGraph(graph, { isGeneratorSocket: (socketId) => socketId === "Socket-1" });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ source: "Socket-4.edges" }));
    expect(formatGraphValidationErrors(result.errors)).toContain("has no not_satisfied route back into the loop");
  });

  test("normalizes legacy next and flow edges into canonical always edges", () => {
    const graph = validGraph();
    graph.sockets["Socket-1"].edges = [{ to: "Socket-4" } as never, { when: "Flow" as never, to: "Socket-2" }];

    const normalized = normalizePipelineGraph(graph);

    expect(normalized.sockets["Socket-1"].next).toBeUndefined();
    expect(normalized.sockets["Socket-1"].edges).toEqual([
      { to: "Socket-4", when: "always" },
      { to: "Socket-2", when: "always" },
      { when: "always", to: "Socket-2" },
    ]);
  });

  test("stages valid graph mutations and leaves the original graph unchanged on validation errors", () => {
    const graph = validGraph();
    const accepted = stageValidatedPipelineGraphChange(graph, (draft) => {
      draft.sockets["Socket-2"].edges = [{ when: "satisfied", to: "Socket-4" }];
    });

    expect(accepted.ok).toBe(true);
    expect(accepted.graph).not.toBe(graph);
    expect(accepted.graph.sockets["Socket-2"].edges).toHaveLength(1);
    expect(graph.sockets["Socket-2"].edges).toHaveLength(2);

    const acceptedLoop = stageValidatedPipelineGraphChange(graph, (draft) => {
      draft.sockets["Socket-4"].next = "Socket-3";
    });

    expect(acceptedLoop.ok).toBe(true);
    expect(acceptedLoop.graph.sockets["Socket-4"].edges).toEqual([{ when: "always", to: "Socket-3" }]);

    const rejected = stageValidatedPipelineGraphChange(graph, (draft) => {
      draft.sockets["Socket-4"].next = "MissingTarget";
    });

    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toContainEqual(expect.objectContaining({ code: "invalid-socket-id" }));
    expect(rejected.graph).toBe(graph);
    expect(graph.sockets["Socket-4"].next).toBeUndefined();
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
