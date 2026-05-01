import { describe, expect, test } from "bun:test";
import { nativeTestInternals } from "../src/native.js";
import { resolvePipeline } from "../src/pipeline.js";
import type { MateriaCastState, PiMateriaConfig } from "../src/types.js";

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
    currentRole: "utility",
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
        byRole: {},
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

  test("sets nested assignment paths", () => {
    const target: Record<string, unknown> = {};
    nativeTestInternals.setPath(target, "utility.result.value", 7);
    expect(target).toEqual({ utility: { result: { value: 7 } } });
  });
});

describe("agent and utility validation", () => {
  test("accepts a valid agent node and rejects an agent node with an unknown role", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      pipeline: { entry: "planner", nodes: { planner: { type: "agent", role: "planner", parse: "text" } } },
      roles: { planner: { tools: "readOnly", systemPrompt: "Plan." } },
    };

    expect(resolvePipeline(config).entry.node.type).toBe("agent");
    expect(() => resolvePipeline({ ...config, roles: {} })).toThrow(/unknown materia role "planner"/);
  });

  test("accepts utility command and alias nodes and rejects malformed utility configuration", () => {
    expect(resolvePipeline({
      artifactDir: ".pi/pi-materia",
      pipeline: {
        entry: "cmd",
        nodes: {
          cmd: { type: "utility", command: ["node", "script.js"], next: "alias" },
          alias: { type: "utility", utility: "project.ensureIgnored", parse: "json" },
        },
      },
      roles: {},
    }).nodes.alias.node.type).toBe("utility");

    expect(() => resolvePipeline({ artifactDir: ".pi/pi-materia", pipeline: { entry: "bad", nodes: { bad: { type: "utility" } } }, roles: {} })).toThrow(/must configure either "utility" or "command"/);
    expect(() => resolvePipeline({ artifactDir: ".pi/pi-materia", pipeline: { entry: "bad", nodes: { bad: { type: "utility", command: [] } } }, roles: {} })).toThrow(/Expected at least one command element/);
  });
});
