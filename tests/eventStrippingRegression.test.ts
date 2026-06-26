import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { buildSyntheticCastContext } from "../src/application/promptAssembly.js";
import { EVENT_SIDECHANNEL_FIELD } from "../src/domain/eventing.js";
import { FakePiHarness } from "./fakePi.js";

async function makeHarness(config: unknown): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-event-strip-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(config, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

/** Flush deferred prompt dispatch (setTimeout(0)) so a routed target socket's prompt is sent before its response is simulated. */
async function flushDeferredDispatch(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Single JSON agent socket that routes to end.
 */
function singleAgentJsonConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "Socket-1",
        sockets: {
          "Socket-1": { materia: "Agent", parse: "json" },
        },
      },
    },
    materia: { Agent: { type: "agent", tools: "readOnly", prompt: "Do the work." } },
  };
}

/**
 * JSON agent socket with satisfied routing to second agent socket.
 */
function agentSatisfiedRoutingConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "Socket-1",
        sockets: {
          "Socket-1": { materia: "Plan", parse: "json", assign: { workItems: "$.workItems" }, edges: [{ when: "satisfied", to: "Socket-2" }, { when: "not_satisfied", to: "end" }] },
          "Socket-2": { materia: "Build", parse: "json" },
        },
      },
    },
    materia: {
      Plan: { type: "agent", tools: "readOnly", prompt: "Plan" },
      Build: { type: "agent", tools: "coding", prompt: "Build" },
    },
  };
}

/**
 * JSON agent socket with workItems assignment and downstream text socket.
 */
function agentWithDownstreamConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "Socket-1",
        sockets: {
          "Socket-1": { materia: "Plan", parse: "json", assign: { workItems: "$.workItems", summary: "$.summary" }, edges: [{ when: "always", to: "Socket-2" }] },
          "Socket-2": { materia: "Build" },
        },
      },
    },
    materia: {
      Plan: { type: "agent", tools: "readOnly", prompt: "Plan" },
      Build: { type: "agent", tools: "coding", prompt: "Build downstream" },
    },
  };
}

function lastState(harness: FakePiHarness): any {
  return harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data;
}

describe("event stripping regression — agent JSON sockets", () => {
  test("event field is stripped from state.lastJson after agent completion", async () => {
    const harness = await makeHarness(singleAgentJsonConfig());

    await harness.runCommand("materia", "cast strip event from agent");
    harness.appendAssistantMessage(JSON.stringify({
      workItems: [{ title: "Done", context: "All good." }],
      satisfied: true,
      context: "Work complete.",
      [EVENT_SIDECHANNEL_FIELD]: [{ type: "result.pr_created", message: "PR created" }],
    }));
    await harness.emit("agent_end", { messages: [] });

    const state = lastState(harness);
    expect(state.phase).toBe("complete");
    expect(state.lastJson).not.toHaveProperty(EVENT_SIDECHANNEL_FIELD);
    expect(state.lastJson).toMatchObject({ workItems: [{ title: "Done", context: "All good." }], satisfied: true, context: "Work complete." });
  });

  test("event field does not leak into state.data.envelope", async () => {
    const harness = await makeHarness(singleAgentJsonConfig());

    await harness.runCommand("materia", "cast no leak envelope");
    harness.appendAssistantMessage(JSON.stringify({
      workItems: [{ title: "Done", context: "All good." }],
      satisfied: true,
      context: "Work complete.",
      [EVENT_SIDECHANNEL_FIELD]: [{ type: "result.pr_created", message: "PR created" }],
    }));
    await harness.emit("agent_end", { messages: [] });

    const state = lastState(harness);
    expect(state.phase).toBe("complete");
    expect(state.data).toBeDefined();
    expect(state.data.envelope).toBeDefined();
    expect(state.data.envelope).not.toHaveProperty(EVENT_SIDECHANNEL_FIELD);
    // Envelope should contain canonical handoff fields only
    expect(state.data.envelope).toMatchObject({ workItems: [{ title: "Done", context: "All good." }], satisfied: true, context: "Work complete." });
    expect(Object.keys(state.data.envelope).sort()).toEqual(["context", "satisfied", "workItems"]);
  });

  test("event field does not leak into state.data.workItems", async () => {
    const harness = await makeHarness(agentWithDownstreamConfig());

    await harness.runCommand("materia", "cast no leak workItems");
    harness.appendAssistantMessage(JSON.stringify({
      workItems: [{ title: "Task 1", context: "Do task 1." }],
      summary: "Plan summary",
      satisfied: true,
      [EVENT_SIDECHANNEL_FIELD]: [{ type: "status.progress", message: "Planning done" }],
    }));
    await harness.emit("agent_end", { messages: [] });

    const state = lastState(harness);
    expect(state.data.workItems).toEqual([{ title: "Task 1", context: "Do task 1." }]);
    // workItems should be clean - no event leakage
    for (const item of state.data.workItems) {
      expect(item).not.toHaveProperty(EVENT_SIDECHANNEL_FIELD);
      expect(item).not.toHaveProperty("event");
    }
    // summary should be assigned from parsed (which had event stripped)
    expect(state.data.summary).toBe("Plan summary");
  });

  test("event field is stripped from parsed JSON artifact", async () => {
    const harness = await makeHarness(singleAgentJsonConfig());

    await harness.runCommand("materia", "cast strip from artifact");
    harness.appendAssistantMessage(JSON.stringify({
      workItems: [{ title: "Done", context: "All good." }],
      satisfied: true,
      context: "Work complete.",
      [EVENT_SIDECHANNEL_FIELD]: [{ type: "result.branch_pushed", message: "Branch pushed" }],
    }));
    await harness.emit("agent_end", { messages: [] });

    const state = lastState(harness);
    const parsedArtifact = JSON.parse(await readFile(path.join(state.runDir, "sockets", "Socket-1", "1.json"), "utf8"));
    expect(parsedArtifact).not.toHaveProperty(EVENT_SIDECHANNEL_FIELD);
    expect(parsedArtifact).toMatchObject({ workItems: [{ title: "Done", context: "All good." }], satisfied: true, context: "Work complete." });
  });

  test("empty event array is a no-op and stripped", async () => {
    const harness = await makeHarness(singleAgentJsonConfig());

    await harness.runCommand("materia", "cast empty event array");
    harness.appendAssistantMessage(JSON.stringify({
      workItems: [{ title: "Done", context: "All good." }],
      satisfied: true,
      context: "Work complete.",
      [EVENT_SIDECHANNEL_FIELD]: [],
    }));
    await harness.emit("agent_end", { messages: [] });

    const state = lastState(harness);
    expect(state.phase).toBe("complete");
    expect(state.lastJson).not.toHaveProperty(EVENT_SIDECHANNEL_FIELD);
    expect(state.lastJson).toMatchObject({ workItems: [{ title: "Done", context: "All good." }], satisfied: true, context: "Work complete." });
  });

  test("agent output without event field works normally (no regression)", async () => {
    const harness = await makeHarness(singleAgentJsonConfig());

    await harness.runCommand("materia", "cast no event field");
    harness.appendAssistantMessage(JSON.stringify({
      workItems: [{ title: "Done", context: "All good." }],
      satisfied: true,
      context: "Work complete.",
    }));
    await harness.emit("agent_end", { messages: [] });

    const state = lastState(harness);
    expect(state.phase).toBe("complete");
    expect(state.lastJson).toMatchObject({ workItems: [{ title: "Done", context: "All good." }], satisfied: true, context: "Work complete." });
    expect(state.lastJson).not.toHaveProperty(EVENT_SIDECHANNEL_FIELD);
  });
});

describe("event stripping regression — routing and advancement", () => {
  test("satisfied routing still works when event is present", async () => {
    const harness = await makeHarness(agentSatisfiedRoutingConfig());

    await harness.runCommand("materia", "cast event with routing");
    harness.appendAssistantMessage(JSON.stringify({
      workItems: [{ title: "Task", context: "Do it." }],
      satisfied: true,
      [EVENT_SIDECHANNEL_FIELD]: [{ type: "status.progress", message: "Planning done", payload: { phase: "plan" } }],
    }));
    await harness.emit("agent_end", { messages: [] });

    const state = lastState(harness);
    // Should have advanced to Socket-2 (Build) because satisfied=true
    expect(state.active).toBe(true);
    expect(state.currentSocketId).toBe("Socket-2");
    expect(state.currentMateria).toBe("Build");
    // Event should not leak into state
    expect(state.lastJson).not.toHaveProperty(EVENT_SIDECHANNEL_FIELD);
    expect(state.data.envelope).not.toHaveProperty(EVENT_SIDECHANNEL_FIELD);
  });

  test("not_satisfied routing still works when event is present", async () => {
    const harness = await makeHarness(agentSatisfiedRoutingConfig());

    await harness.runCommand("materia", "cast not satisfied with event");
    harness.appendAssistantMessage(JSON.stringify({
      workItems: [{ title: "Task", context: "Do it." }],
      satisfied: false,
      [EVENT_SIDECHANNEL_FIELD]: [{ type: "status.info", message: "Needs more work" }],
    }));
    await harness.emit("agent_end", { messages: [] });

    const state = lastState(harness);
    // Should have gone to end because not_satisfied → end
    expect(state.phase).toBe("complete");
    expect(state.lastJson).not.toHaveProperty(EVENT_SIDECHANNEL_FIELD);
  });
});

function utilityEchoJsonConfig(output: unknown, assign?: Record<string, string>) {
  const materiaId = "Utility-Echo";
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "Socket-1",
        sockets: {
          "Socket-1": { materia: materiaId },
        },
      },
    },
    materia: {
      [materiaId]: { type: "utility", utility: "echo", parse: "json", params: { output }, ...(assign ? { assign } : {}) },
    },
  };
}

describe("event stripping regression — utility JSON sockets", () => {
  test("event field is stripped from utility JSON output", async () => {
    const output = { satisfied: true, feedback: "ok", value: 42, [EVENT_SIDECHANNEL_FIELD]: [{ type: "result.pr_created", message: "PR created" }] };
    const harness = await makeHarness(utilityEchoJsonConfig(output, { answer: "$.value" }));

    await harness.runCommand("materia", "cast utility with event");

    const state = lastState(harness);
    expect(state.phase).toBe("complete");
    expect(state.lastJson).not.toHaveProperty(EVENT_SIDECHANNEL_FIELD);
    expect(state.lastJson).toMatchObject({ satisfied: true, feedback: "ok", value: 42 });
    expect(state.data?.answer).toBe(42);
  });

  test("utility state patch does not include event field", async () => {
    const output = {
      satisfied: true,
      state: { blackbeltGhPr: { ok: true, prUrl: "https://github.com/org/repo/pull/42", prNumber: 42 } },
      [EVENT_SIDECHANNEL_FIELD]: [{ type: "result.pr_created", message: "PR #42 created", payload: { prUrl: "https://github.com/org/repo/pull/42" } }],
    };
    const harness = await makeHarness(utilityEchoJsonConfig(output));

    await harness.runCommand("materia", "cast utility state patch no event");

    const state = lastState(harness);
    expect(state.phase).toBe("complete");
    // Event stripped from top-level
    expect(state.lastJson).not.toHaveProperty(EVENT_SIDECHANNEL_FIELD);
    // State patch applied
    expect(state.data?.blackbeltGhPr).toEqual({ ok: true, prUrl: "https://github.com/org/repo/pull/42", prNumber: 42 });
    // Event should not be in state.data at top level
    expect(state.data).not.toHaveProperty(EVENT_SIDECHANNEL_FIELD);
    expect(state.data).not.toHaveProperty("event");
  });
});

describe("event stripping regression — downstream context", () => {
  test("event does not leak into downstream socket prompt context", async () => {
    const harness = await makeHarness(agentWithDownstreamConfig());

    await harness.runCommand("materia", "cast event no leak downstream");

    // First socket: emit event
    harness.appendAssistantMessage(JSON.stringify({
      workItems: [{ title: "Task 1", context: "Do task 1." }],
      summary: "Plan completed",
      satisfied: true,
      [EVENT_SIDECHANNEL_FIELD]: [{ type: "result.pr_created", message: "PR #42 created", payload: { prUrl: "https://example.com/pr/42" } }],
    }));
    await harness.emit("agent_end", { messages: [] });

    // Second socket: verify prompt doesn't contain event data
    const state = lastState(harness);
    expect(state.active).toBe(true);
    expect(state.currentSocketId).toBe("Socket-2");

    // The downstream prompt context is built from state.data, which should not contain event
    // state.data.envelope should only have canonical fields
    expect(state.data.envelope).toBeDefined();
    expect(JSON.stringify(state.data)).not.toContain("result.pr_created");
    expect(JSON.stringify(state.data)).not.toContain("pr_created");
    expect(JSON.stringify(state.data)).not.toContain(EVENT_SIDECHANNEL_FIELD);
  });

  test("cast context in state.data stays clean after multiple event-emitting sockets", async () => {
    const harness = await makeHarness(agentSatisfiedRoutingConfig());

    await harness.runCommand("materia", "cast multi socket event clean");

    // Socket-1 (Plan): emit event
    harness.appendAssistantMessage(JSON.stringify({
      workItems: [{ title: "Task", context: "Do it." }],
      satisfied: true,
      [EVENT_SIDECHANNEL_FIELD]: [{ type: "status.progress", message: "Planning done" }],
    }));
    await harness.emit("agent_end", { messages: [] });

    let state = lastState(harness);
    expect(state.currentSocketId).toBe("Socket-2");
    expect(JSON.stringify(state.data)).not.toContain(EVENT_SIDECHANNEL_FIELD);

    // The routed Socket-2 prompt is dispatched on a deferred (setTimeout 0)
    // boundary; flush it so Socket-2's response arrives after its prompt, as it
    // would in real Pi (and so active-turn provenance points at Socket-2).
    await flushDeferredDispatch();

    // Socket-2 (Build): emit another event
    harness.appendAssistantMessage(JSON.stringify({
      workItems: [],
      satisfied: true,
      context: "Build done.",
      [EVENT_SIDECHANNEL_FIELD]: [{ type: "result.branch_pushed", message: "Branch pushed" }],
    }));
    await harness.emit("agent_end", { messages: [] });

    state = lastState(harness);
    expect(state.phase).toBe("complete");
    // Ensure no event leaked into state after either socket
    expect(JSON.stringify(state.data)).not.toContain(EVENT_SIDECHANNEL_FIELD);
    expect(state.lastJson).not.toHaveProperty(EVENT_SIDECHANNEL_FIELD);
  });

  test("state.lastJson is never stale — even after utility+agent sequence", async () => {
    const utilityOut = { satisfied: true, workItems: [{ title: "Ship it", context: "Do it." }] };
    const echoMateriaId = "Utility-Echo";
    const sequenceConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Test",
      loadouts: {
        Test: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { materia: echoMateriaId, edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { materia: "Agent", parse: "json" },
          },
        },
      },
      materia: {
        [echoMateriaId]: { type: "utility", utility: "echo", parse: "json", params: { output: utilityOut }, assign: { workItems: "$.workItems" } },
        Agent: { type: "agent", tools: "readOnly", prompt: "Do the work." },
      },
    };
    const harness = await makeHarness(sequenceConfig);

    await harness.runCommand("materia", "cast utility agent sequence");

    // After utility runs, the agent socket starts
    const stateAfterUtility = lastState(harness);
    expect(stateAfterUtility.active).toBe(true);
    expect(stateAfterUtility.currentSocketId).toBe("Socket-2");
    expect(stateAfterUtility.currentMateria).toBe("Agent");
    // lastJson from utility should not have event (echo utility doesn't emit it)
    expect(stateAfterUtility.lastJson).not.toHaveProperty(EVENT_SIDECHANNEL_FIELD);

    // Agent responds with event
    harness.appendAssistantMessage(JSON.stringify({
      workItems: [],
      satisfied: true,
      context: "Agent done.",
      [EVENT_SIDECHANNEL_FIELD]: [{ type: "status.progress", message: "Agent progress" }],
    }));
    await harness.emit("agent_end", { messages: [] });

    const finalState = lastState(harness);
    expect(finalState.phase).toBe("complete");
    expect(finalState.lastJson).not.toHaveProperty(EVENT_SIDECHANNEL_FIELD);
    expect(JSON.stringify(finalState.data)).not.toContain(EVENT_SIDECHANNEL_FIELD);
  });
});

describe("event stripping regression — raw state fields", () => {
  test("state.lastOutput does not contain event after JSON agent completion", async () => {
    const harness = await makeHarness(singleAgentJsonConfig());

    await harness.runCommand("materia", "cast strip lastOutput");
    harness.appendAssistantMessage(JSON.stringify({
      workItems: [{ title: "Done", context: "All good." }],
      satisfied: true,
      context: "Work complete.",
      [EVENT_SIDECHANNEL_FIELD]: [{ type: "result.pr_created", message: "PR #42 created", payload: { prUrl: "https://example.com/pr/42" } }],
    }));
    await harness.emit("agent_end", { messages: [] });

    const state = lastState(harness);
    expect(state.phase).toBe("complete");

    // state.lastOutput must be valid JSON without the event side-channel field
    expect(state.lastOutput).toBeString();
    const parsed = JSON.parse(state.lastOutput);
    expect(parsed).not.toHaveProperty(EVENT_SIDECHANNEL_FIELD);
    expect(state.lastOutput).not.toContain("result.pr_created");
    expect(state.lastOutput).not.toContain("https://example.com/pr/42");

    // But canonical handoff fields must be present
    expect(parsed).toHaveProperty("workItems");
    expect(parsed).toHaveProperty("satisfied", true);
    expect(parsed).toHaveProperty("context", "Work complete.");
  });

  test("state.lastAssistantText does not contain event after JSON agent completion", async () => {
    const harness = await makeHarness(singleAgentJsonConfig());

    await harness.runCommand("materia", "cast strip lastAssistantText");
    harness.appendAssistantMessage(JSON.stringify({
      workItems: [{ title: "Done", context: "All good." }],
      satisfied: true,
      context: "Work complete.",
      [EVENT_SIDECHANNEL_FIELD]: [{ type: "result.branch_pushed", message: "Branch pushed to origin" }],
    }));
    await harness.emit("agent_end", { messages: [] });

    const state = lastState(harness);
    expect(state.phase).toBe("complete");

    // state.lastAssistantText must be valid JSON without event data
    expect(state.lastAssistantText).toBeString();
    const parsed = JSON.parse(state.lastAssistantText);
    expect(parsed).not.toHaveProperty(EVENT_SIDECHANNEL_FIELD);
    expect(state.lastAssistantText).not.toContain("result.branch_pushed");
    expect(state.lastAssistantText).not.toContain("Branch pushed to origin");

    // Canonical fields present
    expect(parsed).toHaveProperty("context", "Work complete.");
  });

  test("buildSyntheticCastContext does not contain event data", async () => {
    const harness = await makeHarness(agentWithDownstreamConfig());

    await harness.runCommand("materia", "cast check synthetic context");

    // First socket: emit event with rich payload
    harness.appendAssistantMessage(JSON.stringify({
      workItems: [{ title: "Task 1", context: "Do task 1." }],
      summary: "Plan completed",
      satisfied: true,
      [EVENT_SIDECHANNEL_FIELD]: [{ type: "result.pr_created", message: "PR #99 created", payload: { prUrl: "https://github.com/org/repo/pull/99", branchName: "agent/fix-bug" } }],
    }));
    await harness.emit("agent_end", { messages: [] });

    const state = lastState(harness);
    expect(state.active).toBe(true);
    expect(state.currentSocketId).toBe("Socket-2");

    // Build the synthetic context that the next socket would receive
    const context = buildSyntheticCastContext(state);
    expect(context).toBeString();

    // Event data must not appear in the synthetic context.
    // Check for specific event payload values, not the generic word "event"
    // which might appear in request text or field names.
    expect(context).not.toContain("result.pr_created");
    expect(context).not.toContain("PR #99 created");
    expect(context).not.toContain("https://github.com/org/repo/pull/99");
    expect(context).not.toContain("agent/fix-bug");

    // The JSON key "event": must not appear anywhere in the Previous output section
    const prevOutputStart = context.indexOf("Previous output:");
    if (prevOutputStart >= 0) {
      const prevOutputSection = context.slice(prevOutputStart);
      expect(prevOutputSection).not.toContain(`"${EVENT_SIDECHANNEL_FIELD}"`);
    }

    // Canonical content should be present in the context
    expect(context).toContain("Plan completed");
  });

  test("state.lastOutput does not contain event when event array is empty", async () => {
    const harness = await makeHarness(singleAgentJsonConfig());

    await harness.runCommand("materia", "cast empty event lastOutput");
    harness.appendAssistantMessage(JSON.stringify({
      workItems: [{ title: "Done", context: "All good." }],
      satisfied: true,
      context: "Work complete.",
      [EVENT_SIDECHANNEL_FIELD]: [],
    }));
    await harness.emit("agent_end", { messages: [] });

    const state = lastState(harness);
    expect(state.phase).toBe("complete");

    // Even empty event array must not appear in lastOutput
    expect(state.lastOutput).toBeString();
    const parsed = JSON.parse(state.lastOutput);
    expect(parsed).not.toHaveProperty(EVENT_SIDECHANNEL_FIELD);
    expect(parsed).toHaveProperty("context", "Work complete.");
  });

  test("state.lastOutput unchanged for text (non-JSON) agent sockets", async () => {
    const harness = await makeHarness({
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Test",
      loadouts: {
        Test: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { materia: "Agent", parse: "text" },
          },
        },
      },
      materia: { Agent: { type: "agent", tools: "readOnly", prompt: "Do the work." } },
    });

    await harness.runCommand("materia", "cast text socket lastOutput");
    harness.appendAssistantMessage("Task completed successfully. Changes pushed.");
    await harness.emit("agent_end", { messages: [] });

    const state = lastState(harness);
    expect(state.phase).toBe("complete");
    // Text sockets keep raw output exactly as-is
    expect(state.lastOutput).toBe("Task completed successfully. Changes pushed.");
  });
});

describe("event stripping regression — invalid event handling", () => {
  test("agent socket with invalid event (null) triggers JSON repair", async () => {
    const harness = await makeHarness(singleAgentJsonConfig());

    await harness.runCommand("materia", "cast invalid event null");
    harness.appendAssistantMessage(JSON.stringify({
      workItems: [{ title: "Done", context: "All good." }],
      satisfied: true,
      context: "Work complete.",
      [EVENT_SIDECHANNEL_FIELD]: null,
    }));
    await harness.emit("agent_end", { messages: [] });

    const state = lastState(harness);
    // Should trigger JSON repair, not complete successfully
    expect(state.jsonOutputRepair).toBeDefined();
    expect(state.jsonOutputRepair.validationKind).toBe("handoff_validation");
  });

  test("agent socket with invalid event (scalar) triggers JSON repair", async () => {
    const harness = await makeHarness(singleAgentJsonConfig());

    await harness.runCommand("materia", "cast invalid event scalar");
    harness.appendAssistantMessage(JSON.stringify({
      workItems: [{ title: "Done", context: "All good." }],
      satisfied: true,
      context: "Work complete.",
      [EVENT_SIDECHANNEL_FIELD]: "not-an-array",
    }));
    await harness.emit("agent_end", { messages: [] });

    const state = lastState(harness);
    // Should trigger JSON repair
    expect(state.jsonOutputRepair).toBeDefined();
  });

  test("agent socket with missing type in event triggers JSON repair", async () => {
    const harness = await makeHarness(singleAgentJsonConfig());

    await harness.runCommand("materia", "cast event missing type");
    harness.appendAssistantMessage(JSON.stringify({
      workItems: [{ title: "Done", context: "All good." }],
      satisfied: true,
      context: "Work complete.",
      [EVENT_SIDECHANNEL_FIELD]: [{ message: "No type field" }],
    }));
    await harness.emit("agent_end", { messages: [] });

    const state = lastState(harness);
    expect(state.jsonOutputRepair).toBeDefined();
  });
});
