import { describe, expect, test } from "bun:test";
import { activeMateriaSystemPrompt, nativeTestInternals } from "../src/native.js";
import { resolvePipeline } from "../src/pipeline.js";
import type { MateriaCastState, PiMateriaConfig, ResolvedMateriaNode } from "../src/types.js";

function makeState(overrides: Partial<MateriaCastState> = {}): MateriaCastState {
  return {
    version: 1,
    active: true,
    castId: "test-cast",
    request: "build the thing",
    configSource: "test",
    configHash: "hash",
    cwd: "/tmp/project",
    runDir: "/tmp/project/.pi/pi-materia/test-cast",
    artifactRoot: "/tmp/project/.pi/pi-materia",
    phase: "hello",
    currentNode: "hello",
    currentMateria: "utility",
    awaitingResponse: false,
    startedAt: 0,
    updatedAt: 0,
    data: {
      nested: { value: 42 },
      items: [{ id: "one", title: "First item" }],
      item: { id: "one", title: "First item", meta: { done: true } },
    },
    cursors: { itemCursor: 1 },
    visits: {},
    edgeTraversals: {},
    lastOutput: "previous text",
    lastJson: { route: "next", count: 2, nested: { ok: true } },
    runState: {
      runId: "test-cast",
      startedAt: 0,
      runDir: "/tmp/project/.pi/pi-materia/test-cast",
      eventsFile: "/tmp/project/.pi/pi-materia/test-cast/events.jsonl",
      usageFile: "/tmp/project/.pi/pi-materia/test-cast/usage.json",
      usage: {
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        byMateria: {},
        byNode: {},
        byTask: {},
        byAttempt: {},
      },
      budgetWarned: false,
    },
    pipeline: { entry: undefined as never, nodes: {} },
    ...overrides,
  };
}

describe("generic engine helper mechanics", () => {
  test("renders templates from request, state, item, cursors, and last output/json", () => {
    const state = makeState();

    expect(nativeTestInternals.renderTemplate(
      "{{ request }} | {{ state.nested.value }} | {{ item.title }} | {{ cursor.itemCursor }} | {{ lastOutput }} | {{ lastJson.route }} | {{ missing }}",
      state,
    )).toBe("build the thing | 42 | First item | 1 | previous text | next | ");
    expect(nativeTestInternals.renderTemplate("state={{stateJson}}\nitem={{itemJson}}", state)).toContain('"value": 42');
  });

  test("resolves minimal JSON paths and edge expressions used by utility routing", () => {
    const state = makeState();
    const parsed = { route: "next", ok: true, count: 2, list: [{ label: "zero" }] };

    expect(nativeTestInternals.resolveValue("$", state, parsed)).toEqual(parsed);
    expect(nativeTestInternals.resolveValue("$.list.0.label", state, parsed)).toBe("zero");
    expect(nativeTestInternals.resolveValue("state.nested.value", state, parsed)).toBe(42);
    expect(nativeTestInternals.resolveValue("item.meta.done", state, parsed)).toBe(true);
    expect(nativeTestInternals.resolveValue("lastJson.nested.ok", state, parsed)).toBe(true);
    expect(nativeTestInternals.evaluateCondition("$.route == 'next'", state, parsed)).toBe(true);
    expect(nativeTestInternals.evaluateCondition("$.count != 3", state, parsed)).toBe(true);
    expect(nativeTestInternals.evaluateCondition("exists($.ok)", state, parsed)).toBe(true);
    expect(nativeTestInternals.evaluateCondition("!exists($.missing)", state, parsed)).toBe(true);
  });

  test("routes canonical always/satisfied/not_satisfied edges and legacy next with one handoff contract", () => {
    const state = makeState();
    const config = { limits: { maxEdgeTraversals: 5 } } as PiMateriaConfig;
    const node = {
      id: "Check",
      node: {
        type: "agent",
        materia: "Check",
        edges: [
          { when: "satisfied", to: "Done" },
          { when: "not_satisfied", to: "Build" },
          { when: "always", to: "Fallback" },
        ],
      },
      materia: { tools: "none", prompt: "check" },
    } satisfies ResolvedMateriaNode;

    expect(nativeTestInternals.selectNextTarget(state, node, { satisfied: true }, config)).toBe("Done");
    expect(nativeTestInternals.selectNextTarget(state, node, { satisfied: false }, config)).toBe("Build");
    expect(nativeTestInternals.selectNextTarget(state, node, {}, config)).toBe("Fallback");
    expect(nativeTestInternals.selectNextTarget(state, { ...node, node: { ...node.node, edges: undefined, next: "Legacy" } }, {}, config)).toBe("Legacy");
  });

  test("sets nested assignment paths", () => {
    const target: Record<string, unknown> = {};
    nativeTestInternals.setPath(target, "utility.result.value", 7);
    expect(target).toEqual({ utility: { result: { value: 7 } } });
  });

  test("preserves and augments the generic handoff envelope from JSON node output", () => {
    const state = makeState({
      data: {
        envelope: {
          summary: "existing summary",
          workItems: [],
          guidance: { framework: "keep" },
          decisions: ["keep decision"],
          risks: [],
          satisfied: false,
          feedback: "old feedback",
          missing: ["old missing"],
        },
        guidance: { framework: "keep", style: "concise" },
      },
    });
    const parsed = {
      summary: "updated summary",
      workItems: [
        {
          id: "stable-id",
          title: "Short title",
          description: "Actionable work",
          acceptance: ["observable criterion"],
          context: { architecture: "adapter-owned flow", constraints: ["no tasks"], dependencies: [], risks: ["drift"] },
        },
      ],
      guidance: { style: "detailed", testCommand: "bun test" },
      decisions: ["use generic envelope"],
      risks: ["routing regression"],
      satisfied: true,
      feedback: "looks good",
      missing: [],
    };

    nativeTestInternals.applyGenericHandoffEnvelope(state, parsed);

    expect(state.data.envelope).toMatchObject(parsed);
    expect(state.data.workItems).toEqual(parsed.workItems);
    expect(state.data.guidance).toEqual({ framework: "keep", style: "detailed", testCommand: "bun test" });
    expect(state.data.summary).toBe("updated summary");
    expect(state.data.decisions).toEqual(["use generic envelope"]);
    expect(state.data.risks).toEqual(["routing regression"]);
    expect(state.data).not.toHaveProperty("tasks");
  });

  test("does not let evaluator context workItems replace the generated iterator list", () => {
    const generatedWorkItems = [
      { id: "one", title: "First", description: "Do first", acceptance: ["first done"], context: { constraints: [], dependencies: [], risks: [] } },
      { id: "two", title: "Second", description: "Do second", acceptance: ["second done"], context: { constraints: [], dependencies: [], risks: [] } },
    ];
    const echoedCurrentWorkItem = [generatedWorkItems[0]];
    const state = makeState({ data: { workItems: generatedWorkItems } });
    const evaluator = {
      id: "Socket-5",
      node: { type: "agent", materia: "Auto-Eval", parse: "json" },
      materia: { tools: "coding", prompt: "evaluate" },
    } satisfies ResolvedMateriaNode;

    nativeTestInternals.applyGenericHandoffEnvelope(state, { workItems: echoedCurrentWorkItem, satisfied: true }, evaluator);

    expect(state.data.envelope).toMatchObject({ workItems: echoedCurrentWorkItem, satisfied: true });
    expect(state.data.workItems).toEqual(generatedWorkItems);
  });

  test("assigns generated workItems, iterates current workItem, and advances on satisfied", () => {
    const workItems = [
      { id: "one", title: "First", description: "Do first", acceptance: ["first done"], context: { constraints: [], dependencies: [], risks: [] } },
      { id: "two", title: "Second", description: "Do second", acceptance: ["second done"], context: { constraints: [], dependencies: [], risks: [] } },
    ];
    const state = makeState({ data: {}, cursors: {}, currentItemKey: undefined, currentItemLabel: undefined });
    const planner = {
      id: "Socket-3",
      node: { type: "agent", materia: "planner", parse: "json", assign: { workItems: "$.workItems" } },
      materia: { tools: "readOnly", prompt: "plan" },
    } satisfies ResolvedMateriaNode;
    const builder = {
      id: "Socket-4",
      node: { type: "agent", materia: "Build", parse: "text", foreach: { items: "state.workItems", as: "workItem", cursor: "workItemIndex", done: "end" } },
      materia: { tools: "coding", prompt: "build {{item.id}}" },
    } satisfies ResolvedMateriaNode;
    const maintainer = {
      id: "Socket-6",
      node: { type: "agent", materia: "Maintain", parse: "json", advance: { cursor: "workItemIndex", items: "state.workItems", done: "end", when: "satisfied" } },
      materia: { tools: "coding", prompt: "maintain" },
    } satisfies ResolvedMateriaNode;

    nativeTestInternals.applyAssignments(state, planner, { workItems });
    expect(state.data.workItems).toEqual(workItems);

    expect(nativeTestInternals.setCurrentItem(state, builder)).toBe(true);
    expect(state.data.item).toEqual(workItems[0]);
    expect(state.data.workItem).toEqual(workItems[0]);
    expect(state.data.currentWorkItem).toEqual(workItems[0]);
    expect(state.currentItemKey).toBe("one");
    expect(state.currentItemLabel).toBe("First");

    expect(nativeTestInternals.applyAdvance(state, maintainer, { satisfied: false })).toBeUndefined();
    expect(state.cursors.workItemIndex).toBe(0);
    expect(nativeTestInternals.applyAdvance(state, maintainer, { satisfied: true })).toBeUndefined();
    expect(state.cursors.workItemIndex).toBe(1);
    expect(nativeTestInternals.setCurrentItem(state, builder)).toBe(true);
    expect(state.data.workItem).toEqual(workItems[1]);
    expect(nativeTestInternals.applyAdvance(state, maintainer, { satisfied: true })).toBe("end");
  });

  test("builder text prompt includes adapter-provided current workItem and global guidance", () => {
    const workItem = {
      id: "validate-generic-handoff-flow",
      title: "Validate handoff flow with tests or fixtures",
      description: "Add tests for generic handoff flow.",
      acceptance: ["builder consumes current workItem plus guidance"],
      context: { constraints: ["small safe edits"], dependencies: [], risks: [] },
    };
    const state = makeState({
      currentNode: "Socket-4",
      currentMateria: "Build",
      data: { item: workItem, workItem, guidance: { testCommand: "bun test", architecture: "materia are reusable behavior" } },
      pipeline: {
        entry: undefined as never,
        nodes: {
          "Socket-4": {
            id: "Socket-4",
            node: { type: "agent", materia: "Build", parse: "text" },
            materia: { tools: "coding", prompt: "Build {{item.id}} with {{state.guidance.testCommand}}." },
          },
        },
      },
    });

    const prompt = activeMateriaSystemPrompt(state, { tools: "coding", prompt: "Build {{item.id}} with {{state.guidance.testCommand}}." });

    expect(prompt).toContain("Build validate-generic-handoff-flow with bun test.");
    expect(prompt).toContain("Node/socket adapter context");
    expect(prompt).toContain("Current workItem JSON");
    expect(prompt).toContain("Global guidance JSON");
    expect(prompt).toContain("materia are reusable behavior");
    expect(prompt).toContain("return a concise implementation summary");
    expect(prompt).not.toContain("Final output format: Return only JSON");
  });
});

describe("agent and utility validation", () => {
  test("accepts a valid agent node and rejects an agent node with an unknown materia", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Test",
      loadouts: { Test: { entry: "planner", nodes: { planner: { type: "agent", materia: "planner", parse: "text" } } } },
      materia: { planner: { tools: "readOnly", prompt: "Plan." } },
    };

    expect(resolvePipeline(config).entry.node.type).toBe("agent");
    expect(() => resolvePipeline({ ...config, materia: {} })).toThrow(/unknown materia "planner"/);
  });

  test("accepts utility command and alias nodes and rejects malformed utility configuration", () => {
    expect(resolvePipeline({
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Test",
      loadouts: {
        Test: {
          entry: "cmd",
          nodes: {
            cmd: { type: "utility", command: ["node", "script.js"], next: "alias" },
            alias: { type: "utility", utility: "project.ensureIgnored", parse: "json" },
          },
        },
      },
      materia: {},
    }).nodes.alias.node.type).toBe("utility");

    expect(() => resolvePipeline({ artifactDir: ".pi/pi-materia", activeLoadout: "Test", loadouts: { Test: { entry: "bad", nodes: { bad: { type: "utility" } } } }, materia: {} })).toThrow(/must configure either "utility" or "command"/);
    expect(() => resolvePipeline({ artifactDir: ".pi/pi-materia", activeLoadout: "Test", loadouts: { Test: { entry: "bad", nodes: { bad: { type: "utility", command: [] } } } }, materia: {} })).toThrow(/Expected at least one command element/);
  });
});
