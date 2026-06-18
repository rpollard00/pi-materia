import { describe, expect, test } from "bun:test";
import { activeMateriaSystemPrompt, nativeTestInternals } from "../src/castRuntime.js";
import { applyGenericHandoffEnvelope } from "../src/application/handoff.js";
import { applyAdvance, applyAssignments, evaluateCondition, resolveValue, selectNextTarget, setCurrentItem, setPath } from "../src/application/workflowTransitions.js";
import { resolvePipeline } from "../src/runtime/pipeline.js";
import type { MateriaCastState, PiMateriaConfig, ResolvedMateriaSocket } from "../src/types.js";

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
    currentSocketId: "hello",
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
        bySocket: {},
        byTask: {},
        byAttempt: {},
      },
      budgetWarned: false,
    },
    pipeline: { entry: undefined as never, sockets: {} },
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

    expect(resolveValue("$", state, parsed)).toEqual(parsed);
    expect(resolveValue("$.list.0.label", state, parsed)).toBe("zero");
    expect(resolveValue("state.nested.value", state, parsed)).toBe(42);
    expect(resolveValue("item.meta.done", state, parsed)).toBe(true);
    expect(resolveValue("lastJson.nested.ok", state, parsed)).toBe(true);
    expect(evaluateCondition("$.route == 'next'", state, parsed)).toBe(true);
    expect(evaluateCondition("$.count != 3", state, parsed)).toBe(true);
    expect(evaluateCondition("exists($.ok)", state, parsed)).toBe(true);
    expect(evaluateCondition("!exists($.missing)", state, parsed)).toBe(true);
  });

  test("routes canonical always/satisfied/not_satisfied edges with one handoff contract", () => {
    const state = makeState();
    const config = { limits: { maxEdgeTraversals: 5 } } as PiMateriaConfig;
    const socket = {
      id: "Check",
      socket: {
        materia: "Check",
        edges: [
          { when: "satisfied", to: "Done" },
          { when: "not_satisfied", to: "Build" },
          { when: "always", to: "Fallback" },
        ],
      },
      materia: { tools: "none", prompt: "check" },
    } satisfies ResolvedMateriaSocket;

    expect(selectNextTarget(state, socket, { satisfied: true }, config)).toBe("Done");
    expect(selectNextTarget(state, socket, { satisfied: false }, config)).toBe("Build");
    expect(selectNextTarget(state, socket, {}, config)).toBe("Fallback");
    expect(selectNextTarget(state, { ...socket, socket: { ...socket.socket, edges: undefined } }, {}, config)).toBe("end");
  });

  test("advances loop completion through loop-owned exit routes without materialized edges", () => {
    const socket = {
      id: "Socket-2",
      socket: {
        utility: "echo",
        advance: { cursor: "itemCursor", items: "state.items", done: "Socket-9", when: "always" },
      },
      materia: { utility: "echo" },
    } satisfies ResolvedMateriaSocket;
    const state = makeState({
      cursors: { itemCursor: 0 },
      pipeline: {
        entry: "Socket-1",
        sockets: {},
        loops: {
          work: {
            sockets: ["Socket-2"],
            exit: { from: "Socket-2", when: "satisfied", to: "Socket-9" },
            exits: [
              { id: "always-summary", from: "Socket-2", condition: "always", targetSocketId: "Socket-5" },
              { id: "done-summary", from: "Socket-2", condition: "satisfied", targetSocketId: "Socket-3" },
              { id: "retry-summary", from: "Socket-2", condition: "not_satisfied", targetSocketId: "Socket-4" },
            ],
          },
        },
      },
    });

    expect(applyAdvance(state, socket, { satisfied: true })).toBe("Socket-3");
    state.cursors.itemCursor = 0;
    expect(applyAdvance(state, socket, { satisfied: false })).toBe("Socket-4");
    state.cursors.itemCursor = 0;
    expect(applyAdvance(state, socket, {})).toBe("Socket-5");
    expect(socket.socket).not.toHaveProperty("edges");
  });

  test("canonical loop completion falls through to end when no loop-exit route matches", () => {
    const socket = {
      id: "Socket-2",
      socket: {
        utility: "echo",
        advance: { cursor: "itemCursor", items: "state.items", done: "Socket-9", when: "always" },
      },
      materia: { utility: "echo" },
    } satisfies ResolvedMateriaSocket;
    const state = makeState({
      cursors: { itemCursor: 0 },
      pipeline: {
        entry: "Socket-1",
        sockets: {},
        loops: {
          work: {
            sockets: ["Socket-2"],
            exit: { from: "Socket-2", when: "satisfied", to: "Socket-9" },
            exits: [{ id: "satisfied-only", from: "Socket-2", condition: "satisfied", targetSocketId: "Socket-3" }],
          },
        },
      },
    });

    expect(applyAdvance(state, socket, { satisfied: false })).toBe("end");
  });

  test("sets nested assignment paths", () => {
    const target: Record<string, unknown> = {};
    setPath(target, "utility.result.value", 7);
    expect(target).toEqual({ utility: { result: { value: 7 } } });
  });

  test("captures renderable text payloads into the handoff envelope", () => {
    const state = makeState({ data: { envelope: { satisfied: false }, context: "existing context" } });
    const parsed = {
      text: "## Summary\n\nNarration prose for downstream consumption.",
      satisfied: true,
    };

    applyGenericHandoffEnvelope(state, parsed);

    expect(state.data.envelope).toMatchObject(parsed);
    expect(state.data.envelope?.text).toBe(parsed.text);
    // Raw JSON remains authoritative: prose is not spread into top-level state keys.
    expect(state.data).not.toHaveProperty("text");
  });

  test("preserves small handoff fields from JSON socket output", () => {
    const state = makeState({ data: { envelope: { satisfied: false }, context: "existing context" } });
    const parsed = {
      workItems: [{ title: "Short title", context: "Actionable work. Acceptance: observable criterion." }],
      context: "updated downstream context",
      satisfied: true,
    };

    applyGenericHandoffEnvelope(state, parsed);

    expect(state.data.envelope).toMatchObject(parsed);
    expect(state.data.workItems).toEqual(parsed.workItems);
    expect(state.data.context).toContain("existing context");
    expect(state.data.context).toContain("[handoff context] updated downstream context");
    expect(state.data).not.toHaveProperty("summary");
    expect(state.data).not.toHaveProperty("tasks");
  });

  test("shallow-merges utility state patches without adopting utility control fields", () => {
    const state = makeState({
      data: {
        existing: true,
        nested: { preserved: true },
        workItems: [{ title: "Keep", context: "Original generated list." }],
      },
    });
    const utility = {
      id: "Socket-Util",
      socket: { materia: "Detect-VCS", parse: "json" },
      materiaId: "Detect-VCS",
      materia: { type: "utility", utility: "detect-vcs" },
    } satisfies ResolvedMateriaSocket;

    applyGenericHandoffEnvelope(state, {
      state: {
        vcs: { kind: "jj", root: "/repo" },
        nested: { replacement: true },
        workItems: [{ title: "Do not adopt", context: "Utility state cannot replace workItems." }],
        satisfied: false,
      },
      satisfied: true,
    }, utility);

    expect(state.data.existing).toBe(true);
    expect(state.data.vcs).toEqual({ kind: "jj", root: "/repo" });
    expect(state.data.nested).toEqual({ replacement: true });
    expect(state.data.workItems).toEqual([{ title: "Keep", context: "Original generated list." }]);
    expect(state.data).not.toHaveProperty("satisfied");
    expect(state.data.envelope).toEqual({ satisfied: true });
  });

  test("does not let evaluator context workItems replace the generated iterator list", () => {
    const generatedWorkItems = [
      { title: "First", context: "Do first until first done." },
      { title: "Second", context: "Do second until second done." },
    ];
    const echoedCurrentWorkItem = [generatedWorkItems[0]];
    const state = makeState({ data: { workItems: generatedWorkItems } });
    const evaluator = {
      id: "Socket-5",
      socket: { materia: "Auto-Eval", parse: "json" },
      materia: { tools: "coding", prompt: "evaluate" },
    } satisfies ResolvedMateriaSocket;

    applyGenericHandoffEnvelope(state, { workItems: echoedCurrentWorkItem, satisfied: true }, evaluator);

    expect(state.data.envelope).toMatchObject({ workItems: echoedCurrentWorkItem, satisfied: true });
    expect(state.data.workItems).toEqual(generatedWorkItems);
  });

  test("assigns generated workItems, iterates current workItem, and advances on satisfied", () => {
    const workItems = [
      { title: "First", context: "Do first; first done." },
      { title: "Second", context: "Do second; second done." },
    ];
    const state = makeState({ data: {}, cursors: {}, currentItemKey: undefined, currentItemLabel: undefined });
    const planner = {
      id: "Socket-3",
      socket: { materia: "planner", parse: "json", assign: { workItems: "$.workItems" } },
      materia: { tools: "readOnly", prompt: "plan" },
    } satisfies ResolvedMateriaSocket;
    const builder = {
      id: "Socket-4",
      socket: { materia: "Build", parse: "text", foreach: { items: "state.workItems", as: "workItem", cursor: "workItemIndex", done: "end" } },
      materia: { tools: "coding", prompt: "build {{item.title}}" },
    } satisfies ResolvedMateriaSocket;
    const maintainer = {
      id: "Socket-6",
      socket: { materia: "Maintain", parse: "json", advance: { cursor: "workItemIndex", items: "state.workItems", done: "end", when: "satisfied" } },
      materia: { tools: "coding", prompt: "maintain" },
    } satisfies ResolvedMateriaSocket;

    applyAssignments(state, planner, { workItems });
    expect(state.data.workItems).toEqual(workItems);

    expect(setCurrentItem(state, builder)).toBe(true);
    expect(state.data.item).toEqual(workItems[0]);
    expect(state.data.workItem).toEqual(workItems[0]);
    expect(state.data.currentWorkItem).toEqual(workItems[0]);
    expect(state.currentItemKey).toBe("WI-1");
    expect(state.currentItemLabel).toBe("First");

    expect(applyAdvance(state, maintainer, { satisfied: false })).toBeUndefined();
    expect(state.cursors.workItemIndex).toBe(0);
    expect(applyAdvance(state, maintainer, { satisfied: true })).toBeUndefined();
    expect(state.cursors.workItemIndex).toBe(1);
    expect(setCurrentItem(state, builder)).toBe(true);
    expect(state.data.workItem).toEqual(workItems[1]);
    expect(applyAdvance(state, maintainer, { satisfied: true })).toBe("end");
  });

  test("builder text prompt includes adapter-provided current workItem and global guidance", () => {
    const workItem = {
      title: "Validate handoff flow with tests or fixtures",
      context: "Add tests for generic handoff flow. Acceptance: builder consumes current workItem plus guidance. Constraints: small safe edits.",
    };
    const state = makeState({
      currentSocketId: "Socket-4",
      currentMateria: "Build",
      data: { item: workItem, workItem, guidance: { testCommand: "bun test", architecture: "materia are reusable behavior" } },
      pipeline: {
        entry: undefined as never,
        sockets: {
          "Socket-4": {
            id: "Socket-4",
            socket: { materia: "Build", parse: "text" },
            materia: { tools: "coding", prompt: "Build {{item.title}} with {{state.guidance.testCommand}}." },
          },
        },
      },
    });

    const prompt = activeMateriaSystemPrompt(state, { tools: "coding", prompt: "Build {{item.title}} with {{state.guidance.testCommand}}." });

    expect(prompt).toContain("Build Validate handoff flow with tests or fixtures with bun test.");
    expect(prompt).toContain("Socket adapter context");
    expect(prompt).toContain("Current workItem:");
    expect(prompt).toContain("Title: Validate handoff flow with tests or fixtures");
    expect(prompt).toContain("Context:\nAdd tests for generic handoff flow.");
    expect(prompt).toContain("Global guidance JSON");
    expect(prompt).toContain("materia are reusable behavior");
    expect(prompt).toContain("return a concise implementation summary");
    expect(prompt).not.toContain("Final output format: Return only JSON");
  });
});

describe("agent and utility validation", () => {
  test("accepts a valid agent socket and rejects an agent socket with an unknown materia", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Test",
      loadouts: { Test: { entry: "Socket-1", sockets: { "Socket-1": { materia: "planner", parse: "text" } } } },
      materia: { planner: { tools: "readOnly", prompt: "Plan." } },
    };

    expect(resolvePipeline(config).entry.socket).toEqual(expect.objectContaining({ materia: "planner" }));
    expect(() => resolvePipeline({ ...config, materia: {} })).toThrow(/unknown materia "planner"/);
  });

  test("accepts utility materia references and rejects obsolete inline utility configuration", () => {
    expect(resolvePipeline({
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Test",
      loadouts: {
        Test: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { materia: "Script", edges: [{ when: 'always', to: 'Socket-2' }] },
            "Socket-2": { materia: "Ignore-Artifacts" },
          },
        },
      },
      materia: {
        Script: { command: ["node", "script.js"] },
        "Ignore-Artifacts": { type: "utility", utility: "project.ensureIgnored", parse: "json" },
      },
    }).sockets["Socket-2"].socket).toEqual(expect.objectContaining({ materia: "Ignore-Artifacts" }));

    expect(() => resolvePipeline({ artifactDir: ".pi/pi-materia", activeLoadout: "Test", loadouts: { Test: { entry: "Socket-1", sockets: { "Socket-1": {} as never } } }, materia: {} })).toThrow(/must reference materia/);
    expect(() => resolvePipeline({ artifactDir: ".pi/pi-materia", activeLoadout: "Test", loadouts: { Test: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Bad", command: [] } } } }, materia: { Bad: { utility: "noop" } } })).toThrow(/obsolete socket field "command"/);
  });
});
