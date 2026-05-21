import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { FakePiHarness } from "./fakePi.js";

async function makeHarness(config: unknown): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-multiturn-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(config, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

async function makeBundledDefaultHarness(options?: ConstructorParameters<typeof FakePiHarness>[1]): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-bundled-"));
  const harness = new FakePiHarness(cwd, options);
  piMateria(harness.pi);
  return harness;
}

async function flushDeferredDispatch(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function readRunEvents(state: { runDir: string }): Promise<any[]> {
  return (await readFile(path.join(state.runDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

function advancementStages(events: any[]): string[] {
  return events.filter((event) => event.type === "advancement_lifecycle").map((event) => event.data.stage);
}

function multiTurnConfig(overrides: Record<string, unknown> = {}) {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "Socket-1",
        sockets: {
          "Socket-1": { materia: "Plan", parse: "json", assign: { tasks: "$.tasks" } },
        },
      },
    },
    materia: { Plan: { type: "agent", tools: "readOnly", prompt: "Collaborative planner", multiTurn: true, ...overrides } },
  };
}

function singleTurnConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "Socket-1",
        sockets: {
          "Socket-1": { materia: "Plan", parse: "json", assign: { tasks: "$.tasks" }, edges: [{ when: 'always', to: 'Socket-2' }] },
          "Socket-2": { materia: "Build" },
        },
      },
    },
    materia: {
      Plan: { type: "agent", tools: "readOnly", prompt: "Plan once" },
      Build: { type: "agent", tools: "coding", prompt: "Build once\n\nBuild {{state.tasks.0.title}}" },
    },
  };
}

function multiTurnWithDownstreamConfig(parse: "json" | "text") {
  const plan = parse === "json"
    ? { materia: "Plan", parse: "json", assign: { tasks: "$.tasks" }, edges: [{ when: 'always', to: 'Socket-2' }] }
    : { materia: "Plan", parse: "text", assign: { summary: "$" }, edges: [{ when: 'always', to: 'Socket-2' }] };
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "Socket-1",
        sockets: {
          "Socket-1": plan,
          "Socket-2": { materia: "Build" },
        },
      },
    },
    materia: {
      Plan: { type: "agent", tools: "readOnly", prompt: "Collaborative planner", multiTurn: true },
      Build: { type: "agent", tools: "coding", prompt: "Build downstream\n\nTasks={{state.tasks}} Summary={{state.summary}} Last={{lastOutput}}" },
    },
  };
}

function interactivePlanToBuildConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Planning-Consult",
    loadouts: {
      "Planning-Consult": {
        entry: "Socket-3",
        sockets: {
          "Socket-3": { materia: "Interactive-Plan", parse: "json", assign: { workItems: "$.workItems" }, edges: [{ when: "always", to: "Socket-4" }] },
          "Socket-4": { materia: "Build" },
        },
      },
    },
    materia: {
      "Interactive-Plan": { type: "agent", tools: "readOnly", prompt: "Collaboratively refine an implementation plan", multiTurn: true },
      Build: { type: "agent", tools: "coding", prompt: "Build now\n\nWork items={{state.workItems}} Last={{lastOutput}}" },
    },
  };
}

function loadoutSwitchingConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Single",
    loadouts: {
      Single: {
        entry: "Socket-1",
        sockets: { "Socket-1": { materia: "PlanSingle", parse: "json", assign: { tasks: "$.tasks" } } },
      },
      Interactive: {
        entry: "Socket-1",
        sockets: { "Socket-1": { materia: "PlanInteractive", parse: "json", assign: { tasks: "$.tasks" } } },
      },
    },
    materia: {
      PlanSingle: { type: "agent", tools: "readOnly", prompt: "Plan once" },
      PlanInteractive: { type: "agent", tools: "readOnly", prompt: "Plan with refinements", multiTurn: true },
    },
  };
}

describe("native multi-turn runtime", () => {
  test("single-turn agent sockets still parse, assign, and advance automatically", async () => {
    const harness = await makeHarness(singleTurnConfig());

    await harness.runCommand("materia", "cast make a plan");
    const promptsBeforeAgentEnd = harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn).length;
    harness.appendAssistantMessage('{"tasks":[{"id":"1","title":"Ship it"}]}');
    await harness.emit("agent_end", { messages: [] });

    const state = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(state.active).toBe(true);
    expect(state.currentSocketId).toBe("Socket-2");
    expect(state.currentMateria).toBe("Build");
    expect(state.socketState).toBe("awaiting_agent_response");
    expect(state.awaitingResponse).toBe(true);
    expect(state.data.tasks).toEqual([{ id: "1", title: "Ship it" }]);
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(promptsBeforeAgentEnd);

    await flushDeferredDispatch();
    const triggeredMessages = harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn);
    expect(triggeredMessages).toHaveLength(promptsBeforeAgentEnd + 1);
    expect((triggeredMessages.at(-1)?.message as any).details).toMatchObject({ socketId: "Socket-2", materiaName: "Build" });
  });

  test("stale finalization flag does not affect single-turn completion", async () => {
    const harness = await makeHarness(singleTurnConfig());

    await harness.runCommand("materia", "cast make a plan");
    const startedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    harness.pi.appendEntry("pi-materia-cast-state", { ...startedState, multiTurnFinalizing: true });

    const promptsBeforeAgentEnd = harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn).length;
    harness.appendAssistantMessage('{"tasks":[{"id":"1","title":"Ship it"}]}');
    await harness.emit("agent_end", { messages: [] });

    const state = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(state.active).toBe(true);
    expect(state.currentSocketId).toBe("Socket-2");
    expect(state.currentMateria).toBe("Build");
    expect(state.socketState).toBe("awaiting_agent_response");
    expect(state.awaitingResponse).toBe(true);
    expect(state.multiTurnFinalizing).not.toBe(true);
    expect(state.data.tasks).toEqual([{ id: "1", title: "Ship it" }]);
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(promptsBeforeAgentEnd);

    await flushDeferredDispatch();
    const triggeredMessages = harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn);
    expect(triggeredMessages).toHaveLength(promptsBeforeAgentEnd + 1);
    expect((triggeredMessages.at(-1)?.message as any).details).toMatchObject({ socketId: "Socket-2", materiaName: "Build" });
  });

  test("bundled Full-Auto advances from Auto-Plan to Auto-Architect without interactive input", async () => {
    const harness = await makeBundledDefaultHarness();
    const workItem = {
      id: "WI-1",
      title: "Ship it",
      description: "Implement the requested feature",
      acceptance: ["Feature is implemented", "Regression test passes"],
      context: { architecture: "Keep it simple", constraints: [], dependencies: [], risks: [] },
    };
    const autoPlanEnvelope = {
      summary: "Plan",
      workItems: [workItem],
      guidance: { note: "Use top-level workItems" },
      decisions: [],
      risks: [],
      satisfied: true,
      feedback: "",
      missing: [],
    };
    expect(autoPlanEnvelope).toHaveProperty("workItems");
    expect(autoPlanEnvelope).not.toHaveProperty("tasks");

    await harness.runCommand("materia", "cast build the feature");
    const autoPlanStartedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(autoPlanStartedState.active).toBe(true);
    expect(autoPlanStartedState.currentSocketId).toBe("Socket-3");
    expect(autoPlanStartedState.currentMateria).toBe("Auto-Plan");
    expect(autoPlanStartedState.socketState).toBe("awaiting_agent_response");
    expect(autoPlanStartedState.awaitingResponse).toBe(true);
    expect(autoPlanStartedState.multiTurnFinalizing).not.toBe(true);
    const autoPlanPrompt = harness.sentMessages
      .map(({ message }) => message as any)
      .find((message) => message.customType === "pi-materia-prompt" && message.details?.socketId === "Socket-3" && message.details?.materiaName === "Auto-Plan");
    expect(autoPlanPrompt?.content).not.toContain("/materia continue");
    expect(harness.notifications.map(({ message }) => message).join("\n")).not.toContain("/materia continue");

    harness.appendAssistantMessage(JSON.stringify(autoPlanEnvelope));
    await harness.emit("agent_end", { messages: [] });

    const autoArchitectState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(autoArchitectState.active).toBe(true);
    expect(autoArchitectState.currentSocketId).toBe("Socket-8");
    expect(autoArchitectState.currentMateria).toBe("Auto-Architect");
    expect(autoArchitectState.socketState).toBe("awaiting_agent_response");
    expect(autoArchitectState.awaitingResponse).toBe(true);
    expect(autoArchitectState.multiTurnFinalizing).not.toBe(true);
    expect(autoArchitectState.data.workItems).toEqual([workItem]);
    expect(autoArchitectState.data.tasks).toBeUndefined();
    expect(harness.notifications.map(({ message }) => message).join("\n")).not.toContain("/materia continue");

    const statesAfterPlan = harness.appendedEntries
      .filter((entry) => entry.customType === "pi-materia-cast-state")
      .map((entry) => entry.data as any);
    expect(statesAfterPlan.some((state) => state.currentSocketId === "Socket-3" && state.socketState === "awaiting_user_refinement")).toBe(false);
    expect(statesAfterPlan.some((state) => state.currentSocketId === "Socket-8" && state.socketState === "awaiting_user_refinement")).toBe(false);
    expect(statesAfterPlan.some((state) => ["Socket-3", "Socket-8"].includes(state.currentSocketId) && state.multiTurnFinalizing === true)).toBe(false);
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(1);

    await flushDeferredDispatch();
    const autoArchitectPrompts = harness.sentMessages.filter(({ message }) => {
      const details = (message as any).details;
      return (message as any).customType === "pi-materia-prompt" && details?.socketId === "Socket-8" && details?.materiaName === "Auto-Architect";
    });
    expect(autoArchitectPrompts).toHaveLength(1);
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(2);

    harness.appendAssistantMessage(JSON.stringify({ ...autoPlanEnvelope, summary: "Architected plan", decisions: ["Keep boundaries small"] }));
    await harness.emit("agent_end", { messages: [] });

    const buildState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(buildState.active).toBe(true);
    expect(buildState.currentSocketId).toBe("Socket-4");
    expect(buildState.currentMateria).toBe("Build");
    expect(buildState.socketState).toBe("awaiting_agent_response");
    expect(buildState.awaitingResponse).toBe(true);
    expect(buildState.currentItemKey).toBe("WI-1");
    expect(buildState.currentItemLabel).toBe("Ship it");
    expect(buildState.data.currentWorkItem).toEqual(workItem);
    expect(buildState.data.workItem).toEqual(workItem);
    expect(buildState.multiTurnFinalizing).not.toBe(true);

    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(2);
    expect(harness.sentMessages.filter(({ message }) => {
      const details = (message as any).details;
      return (message as any).customType === "pi-materia-prompt" && details?.socketId === "Socket-4" && details?.materiaName === "Build";
    })).toHaveLength(0);

    await flushDeferredDispatch();
    const buildPrompts = harness.sentMessages.filter(({ message }) => {
      const details = (message as any).details;
      return (message as any).customType === "pi-materia-prompt" && details?.socketId === "Socket-4" && details?.materiaName === "Build";
    });
    expect(buildPrompts).toHaveLength(1);
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(3);
    expect(harness.userMessages).toHaveLength(0);
    expect(harness.operationLog).not.toContain("waitForIdle");
    expect(harness.notifications.map(({ message }) => message).join("\n")).not.toContain("/materia continue");
  });

  test("strict Full-Auto dispatches Build after Auto-Architect without an external wakeup", async () => {
    const harness = await makeBundledDefaultHarness({ strictTriggerTurnDuringAgentEnd: true });
    const workItem = {
      id: "WI-1",
      title: "Ship it",
      description: "Implement the requested feature",
      acceptance: ["Feature is implemented", "Regression test passes"],
      context: { architecture: "Keep it simple", constraints: [], dependencies: [], risks: [] },
    };
    const autoPlanEnvelope = {
      summary: "Plan",
      workItems: [workItem],
      guidance: { note: "Use top-level workItems" },
      decisions: [],
      risks: [],
      satisfied: true,
      feedback: "",
      missing: [],
    };
    const architectEnvelope = { ...autoPlanEnvelope, summary: "Architected plan", decisions: ["Keep boundaries small"] };

    await harness.runCommand("materia", "cast build the feature");
    harness.appendAssistantMessage(JSON.stringify(autoPlanEnvelope));
    await harness.emit("agent_end", { messages: [] });

    const autoArchitectState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(autoArchitectState.active).toBe(true);
    expect(autoArchitectState.currentSocketId).toBe("Socket-8");
    expect(autoArchitectState.currentMateria).toBe("Auto-Architect");
    expect(autoArchitectState.socketState).toBe("awaiting_agent_response");
    expect(autoArchitectState.awaitingResponse).toBe(true);
    expect(autoArchitectState.multiTurnFinalizing).not.toBe(true);
    const statesAfterPlan = harness.appendedEntries
      .filter((entry) => entry.customType === "pi-materia-cast-state")
      .map((entry) => entry.data as any);
    expect(statesAfterPlan.some((state) => state.currentSocketId === "Socket-3" && state.socketState === "awaiting_user_refinement")).toBe(false);
    expect(statesAfterPlan.some((state) => state.currentSocketId === "Socket-8" && state.socketState === "awaiting_user_refinement")).toBe(false);
    expect(statesAfterPlan.some((state) => ["Socket-3", "Socket-8"].includes(state.currentSocketId) && state.multiTurnFinalizing === true)).toBe(false);
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(1);

    await flushDeferredDispatch();
    const autoArchitectPrompts = harness.sentMessages.filter(({ message }) => {
      const prompt = message as any;
      return prompt.customType === "pi-materia-prompt" && prompt.details?.socketId === "Socket-8" && prompt.details?.materiaName === "Auto-Architect";
    });
    expect(autoArchitectPrompts).toHaveLength(1);
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(2);

    harness.appendAssistantMessage(JSON.stringify(architectEnvelope));
    await harness.emit("agent_end", { messages: [] });

    const buildState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(buildState.active).toBe(true);
    expect(buildState.currentSocketId).toBe("Socket-4");
    expect(buildState.currentMateria).toBe("Build");
    expect(buildState.socketState).toBe("awaiting_agent_response");
    expect(buildState.awaitingResponse).toBe(true);
    expect(buildState.currentItemKey).toBe("WI-1");
    expect(buildState.data.currentWorkItem).toEqual(workItem);
    expect(buildState.data.workItem).toEqual(workItem);
    expect(buildState.multiTurnFinalizing).not.toBe(true);
    const statesAfterArchitect = harness.appendedEntries
      .filter((entry) => entry.customType === "pi-materia-cast-state")
      .map((entry) => entry.data as any);
    expect(statesAfterArchitect.some((state) => state.currentSocketId === "Socket-4" && state.socketState === "awaiting_user_refinement")).toBe(false);
    expect(statesAfterArchitect.some((state) => ["Socket-3", "Socket-8", "Socket-4"].includes(state.currentSocketId) && state.multiTurnFinalizing === true)).toBe(false);

    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(2);
    expect(harness.sentMessages.filter(({ message }) => {
      const prompt = message as any;
      return prompt.customType === "pi-materia-prompt" && prompt.details?.socketId === "Socket-4" && prompt.details?.materiaName === "Build";
    })).toHaveLength(0);
    expect(harness.suppressedTriggerTurnSends).toHaveLength(0);

    await flushDeferredDispatch();
    const buildPrompts = harness.sentMessages.filter(({ message }) => {
      const prompt = message as any;
      return prompt.customType === "pi-materia-prompt" && prompt.details?.socketId === "Socket-4" && prompt.details?.materiaName === "Build";
    });
    expect(buildPrompts).toHaveLength(1);
    expect((buildPrompts[0].options as { triggerTurn?: boolean } | undefined)?.triggerTurn).toBe(true);
    expect((buildPrompts[0].message as any).details).toMatchObject({ socketId: "Socket-4", materiaName: "Build" });
    expect(harness.userMessages).toHaveLength(0);
    expect(harness.waitForIdleCalls).toBe(0);
    expect(harness.operationLog).not.toContain("waitForIdle");
    expect(harness.userMessages.map(({ content }) => content)).not.toContain(".");
    expect(harness.notifications.map(({ message }) => message).join("\n")).not.toContain("/materia continue");
  });

  test("finalized Interactive-Plan /materia continue auto-dispatches the Build prompt", async () => {
    const harness = await makeHarness(interactivePlanToBuildConfig());
    const finalPlan = JSON.stringify({
      summary: "Plan",
      workItems: [{ id: "WI-1", title: "Ship it", description: "Do the work", acceptance: ["Done"], context: { architecture: "", constraints: [], dependencies: [], risks: [] } }],
      guidance: {},
      decisions: [],
      risks: [],
      satisfied: true,
      feedback: "",
      missing: [],
    });

    await harness.runCommand("materia", "cast build the feature");
    harness.appendAssistantMessage("Draft plan that still needs refinement.");
    await harness.emit("agent_end", { messages: [] });

    const pausedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(pausedState.currentSocketId).toBe("Socket-3");
    expect(pausedState.currentMateria).toBe("Interactive-Plan");
    expect(pausedState.socketState).toBe("awaiting_user_refinement");

    await harness.runCommand("materia", "continue");
    const promptsBeforeFinalAgentEnd = harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn).length;
    expect(promptsBeforeFinalAgentEnd).toBe(2);
    harness.appendAssistantMessage(finalPlan);
    await harness.emit("agent_end", { messages: [] });

    const buildState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(buildState.active).toBe(true);
    expect(buildState.currentSocketId).toBe("Socket-4");
    expect(buildState.currentMateria).toBe("Build");
    expect(buildState.socketState).toBe("awaiting_agent_response");
    expect(buildState.awaitingResponse).toBe(true);
    expect(buildState.multiTurnFinalizing).not.toBe(true);
    expect(buildState.data.workItems).toEqual([{ id: "WI-1", title: "Ship it", description: "Do the work", acceptance: ["Done"], context: { architecture: "", constraints: [], dependencies: [], risks: [] } }]);
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(promptsBeforeFinalAgentEnd);

    await flushDeferredDispatch();
    const triggeredMessages = harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn);
    expect(triggeredMessages).toHaveLength(promptsBeforeFinalAgentEnd + 1);
    const buildPrompt = triggeredMessages.at(-1)?.message as any;
    expect(buildPrompt.customType).toBe("pi-materia-prompt");
    expect(buildPrompt.details).toMatchObject({ socketId: "Socket-4", materiaName: "Build" });
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(promptsBeforeFinalAgentEnd + 1);
    expect(harness.userMessages).toHaveLength(0);

    const events = await readRunEvents(buildState);
    const socketComplete = events.find((event) => event.type === "socket_complete" && event.data.socket === "Socket-3");
    expect(socketComplete?.data).toMatchObject({ parsed: true, finalizedRefinement: true, artifact: "sockets/Socket-3/1.md" });
    expect(await readFile(path.join(buildState.runDir, "sockets", "Socket-3", "1.md"), "utf8")).toBe(finalPlan);
    expect(JSON.parse(await readFile(path.join(buildState.runDir, "sockets", "Socket-3", "1.json"), "utf8"))).toMatchObject({ summary: "Plan", satisfied: true });
    const stages = advancementStages(events);
    expect(stages).toEqual(expect.arrayContaining([
      "finalized_multi_turn_handle_entry",
      "socket_completion_exit",
      "socket_advancement_entry",
      "next_socket_start_entry",
      "dispatch_scheduling",
      "deferred_dispatch_execution",
      "dispatch_execution_entry",
      "dispatch_execution_exit",
      "finalized_multi_turn_handle_exit",
    ]));
    expect(stages.indexOf("dispatch_scheduling")).toBeGreaterThan(stages.indexOf("next_socket_start_entry"));
    expect(stages.indexOf("deferred_dispatch_execution")).toBeGreaterThan(stages.indexOf("dispatch_scheduling"));
  });

  test("duplicate finalized agent_end callbacks schedule only one deferred Build prompt", async () => {
    const harness = await makeHarness(interactivePlanToBuildConfig());
    const finalPlan = JSON.stringify({
      summary: "Plan",
      workItems: [{ id: "WI-1", title: "Ship it", description: "Do the work", acceptance: ["Done"], context: { architecture: "", constraints: [], dependencies: [], risks: [] } }],
      guidance: {},
      decisions: [],
      risks: [],
      satisfied: true,
      feedback: "",
      missing: [],
    });

    await harness.runCommand("materia", "cast build the feature");
    harness.appendAssistantMessage("Draft plan.");
    await harness.emit("agent_end", { messages: [] });
    await harness.runCommand("materia", "continue");
    const promptsBeforeFinalAgentEnd = harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn).length;
    harness.appendAssistantMessage(finalPlan);

    const handlers = harness.events.get("agent_end") ?? [];
    expect(handlers).toHaveLength(1);
    await Promise.all(handlers.map((handler) => Promise.all([handler({ messages: [] } as never, harness.ctx), handler({ messages: [] } as never, harness.ctx)])));
    await flushDeferredDispatch();

    const triggeredMessages = harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn);
    expect(triggeredMessages).toHaveLength(promptsBeforeFinalAgentEnd + 1);
    const buildPrompts = triggeredMessages.filter(({ message }) => {
      const prompt = message as any;
      return prompt.customType === "pi-materia-prompt" && prompt.details?.socketId === "Socket-4" && prompt.details?.materiaName === "Build";
    });
    expect(buildPrompts).toHaveLength(1);

    const state = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    const events = await readRunEvents(state);
    const duplicateSkips = events.filter((event: any) => event.type === "deferred_dispatch_duplicate_skipped");
    expect(duplicateSkips).toHaveLength(1);
    expect(duplicateSkips[0].data).toMatchObject({ castId: state.castId, socket: "Socket-4", materia: "Build", sourceSocketId: "Socket-3", sourceSocketVisit: 1 });
    expect(duplicateSkips[0].data.idempotencyKey).toContain(`${state.castId}:Socket-3:1:Socket-4`);
  });

  test("bundled Planning-Consult pauses after planner output until /materia continue advances to Build", async () => {
    const harness = await makeBundledDefaultHarness();
    const finalPlan = '{"summary":"Plan","workItems":[{"id":"1","title":"Ship it","description":"Do the work","acceptance":["Done"],"context":{"architecture":"","constraints":[],"dependencies":[],"risks":[]}}],"guidance":{},"decisions":[],"risks":[],"satisfied":true,"feedback":"","missing":[]}';

    await harness.runCommand("materia", "loadout Planning-Consult");
    const savedLoadoutChoice = JSON.parse(await readFile(path.join(harness.cwd, ".pi", "pi-materia.json"), "utf8"));
    expect(savedLoadoutChoice).toMatchObject({ activeLoadout: "Planning-Consult", activeLoadoutId: "default:planning-consult" });
    expect(savedLoadoutChoice.piMateria).toBeUndefined();

    await harness.runCommand("materia", "cast build the feature");
    const plannerStartedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(plannerStartedState.currentSocketId).toBe("Socket-3");
    expect(plannerStartedState.currentMateria).toBe("Interactive-Plan");
    expect(plannerStartedState.socketState).toBe("awaiting_agent_response");
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(1);
    const firstPrompt = harness.sentMessages.find((sent) => (sent.message as any).customType === "pi-materia-prompt")?.message as any;
    expect(firstPrompt.content).toContain("Collaboratively refine an implementation plan");
    expect(firstPrompt.content).toContain("normal conversation");
    expect(firstPrompt.content).toContain("Do not emit the structured workItems JSON during refinement");
    expect(firstPrompt.content).toContain("/materia continue is the only way to finalize this multi-turn socket");
    expect(firstPrompt.content).toContain("do not emit final JSON");
    expect(firstPrompt.content).not.toContain("Return only JSON");

    harness.appendAssistantMessage("I understand the feature. A good first cut is to update the prompt and cover it with tests. Should docs be included too?");
    await harness.emit("agent_end", { messages: [] });

    const pausedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(pausedState.active).toBe(true);
    expect(pausedState.currentSocketId).toBe("Socket-3");
    expect(pausedState.currentMateria).toBe("Interactive-Plan");
    expect(pausedState.socketState).toBe("awaiting_user_refinement");
    expect(pausedState.awaitingResponse).toBe(false);
    expect(pausedState.multiTurnFinalizing).not.toBe(true);
    expect(pausedState.data.workItems).toBeUndefined();
    expect(pausedState.lastAssistantText).toContain("Should docs be included too?");
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(1);
    expect(harness.sentMessages.map(({ message }) => (message as any).content).join("\n")).not.toContain("Task 1: Ship it");

    harness.appendUserMessage("Yes, include docs and finalize the work item artifacts.");
    harness.appendAssistantMessage(finalPlan);
    await harness.emit("agent_end", { messages: [] });

    const finalizedButPausedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(finalizedButPausedState.active).toBe(true);
    expect(finalizedButPausedState.currentSocketId).toBe("Socket-3");
    expect(finalizedButPausedState.socketState).toBe("awaiting_user_refinement");
    expect(finalizedButPausedState.data.workItems).toBeUndefined();
    expect(finalizedButPausedState.lastAssistantText).toBe(finalPlan);

    const statesBeforePlainText = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").length;
    const promptsBeforePlainText = harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn).length;
    const inputResults = await harness.emit("input", { text: "ready to continue", source: "interactive" });
    expect(inputResults.at(-1)).toBeUndefined();
    const stillPausedAfterInput = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(stillPausedAfterInput.active).toBe(true);
    expect(stillPausedAfterInput.currentSocketId).toBe("Socket-3");
    expect(stillPausedAfterInput.socketState).toBe("awaiting_user_refinement");
    expect(stillPausedAfterInput.awaitingResponse).toBe(false);
    expect(stillPausedAfterInput.multiTurnFinalizing).not.toBe(true);
    expect(stillPausedAfterInput.data.workItems).toBeUndefined();
    expect(harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state")).toHaveLength(statesBeforePlainText);
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(promptsBeforePlainText);

    await harness.runCommand("materia", "continue");
    const commandFinalizingState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(commandFinalizingState.active).toBe(true);
    expect(commandFinalizingState.currentSocketId).toBe("Socket-3");
    expect(commandFinalizingState.socketState).toBe("awaiting_agent_response");
    expect(commandFinalizingState.awaitingResponse).toBe(true);
    expect(commandFinalizingState.multiTurnFinalizing).toBe(true);
    const finalPrompt = harness.sentMessages.at(-1)?.message as any;
    expect(finalPrompt.content).toContain("Command-triggered finalization");
    expect(finalPrompt.content).toContain("Return only JSON");
    harness.appendAssistantMessage(finalPlan);
    await harness.emit("agent_end", { messages: [] });

    const buildState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(buildState.active).toBe(true);
    expect(buildState.currentSocketId).toBe("Socket-4");
    expect(buildState.currentMateria).toBe("Build");
    expect(buildState.socketState).toBe("awaiting_agent_response");
    expect(buildState.awaitingResponse).toBe(true);
    expect(buildState.multiTurnFinalizing).not.toBe(true);
    expect(buildState.data.workItems).toEqual([{ id: "1", title: "Ship it", description: "Do the work", acceptance: ["Done"], context: { architecture: "", constraints: [], dependencies: [], risks: [] } }]);
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(2);

    await flushDeferredDispatch();
    const downstreamBuildPrompts = harness.sentMessages.filter(({ message }) => {
      const details = (message as any).details;
      return (message as any).customType === "pi-materia-prompt" && details?.socketId === "Socket-4" && details?.materiaName === "Build";
    });
    expect(downstreamBuildPrompts).toHaveLength(1);
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(3);
    expect((downstreamBuildPrompts[0].message as any).details).toMatchObject({ socketId: "Socket-4", materiaName: "Build" });

    const events = await readRunEvents(buildState);
    expect(events.find((event) => event.type === "socket_complete" && event.data.socket === "Socket-3")?.data).toMatchObject({ parsed: true, finalizedRefinement: true });
    expect(advancementStages(events)).toEqual(expect.arrayContaining(["dispatch_scheduling", "deferred_dispatch_execution", "dispatch_execution_exit"]));
    expect(await readFile(path.join(buildState.runDir, "sockets", "Socket-3", "1.md"), "utf8")).toBe(finalPlan);
    expect(JSON.parse(await readFile(path.join(buildState.runDir, "sockets", "Socket-3", "1.json"), "utf8"))).toMatchObject({ summary: "Plan", satisfied: true });
  });

  test("loadout switching changes multi-turn behavior only by selecting multi-turn materia", async () => {
    const harness = await makeHarness(loadoutSwitchingConfig());
    const finalPlan = '{"tasks":[{"id":"1","title":"Ship it"}]}';

    await harness.runCommand("materia", "cast plan once");
    harness.appendAssistantMessage(finalPlan);
    await harness.emit("agent_end", { messages: [] });

    const singleState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(singleState.active).toBe(false);
    expect(singleState.currentSocketId).toBe("Socket-1");
    expect(singleState.currentMateria).toBe("PlanSingle");
    expect(singleState.socketState).toBe("complete");
    expect(singleState.data.tasks).toEqual([{ id: "1", title: "Ship it" }]);

    await harness.runCommand("materia", "loadout Interactive");
    await harness.runCommand("materia", "cast refine the plan");
    harness.appendAssistantMessage(finalPlan);
    await harness.emit("agent_end", { messages: [] });

    const interactiveState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(interactiveState.active).toBe(true);
    expect(interactiveState.currentSocketId).toBe("Socket-1");
    expect(interactiveState.currentMateria).toBe("PlanInteractive");
    expect(interactiveState.socketState).toBe("awaiting_user_refinement");
    expect(interactiveState.data.tasks).toBeUndefined();
  });

  test("multi-turn agent output pauses without parsing or advancing until /materia continue", async () => {
    const harness = await makeHarness(multiTurnConfig());

    await harness.runCommand("materia", "cast refine a plan");
    harness.appendAssistantMessage("not json yet");
    await harness.emit("agent_end", { messages: [] });

    const pausedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(pausedState.active).toBe(true);
    expect(pausedState.awaitingResponse).toBe(false);
    expect(pausedState.socketState).toBe("awaiting_user_refinement");
    expect(pausedState.currentSocketId).toBe("Socket-1");
    expect(pausedState.lastJson).toBeUndefined();

    await harness.runCommand("materia", "status");
    expect(harness.widgets.get("materia")?.content).toContain("› waiting for refinement; /materia continue to finalize");

    const inputResults = await harness.emit("input", { text: "ready to continue", source: "interactive" });
    expect(inputResults.at(-1)).toBeUndefined();
    const stillPausedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(stillPausedState.active).toBe(true);
    expect(stillPausedState.socketState).toBe("awaiting_user_refinement");
    expect(stillPausedState.multiTurnFinalizing).not.toBe(true);

    await harness.runCommand("materia", "continue");
    const finalizingState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(finalizingState.active).toBe(true);
    expect(finalizingState.socketState).toBe("awaiting_agent_response");
    expect(finalizingState.multiTurnFinalizing).toBe(true);
    expect(harness.statuses.get("materia")).toBe("Plan");
    expect((harness.widgets.get("materia")?.content ?? []).join("\n")).toContain("› Plan active");
    expect((harness.widgets.get("materia")?.content ?? []).join("\n")).not.toContain("waiting for refinement");
    expect((harness.sentMessages.at(-1)?.message as any).content).toContain("Return only JSON");
    harness.appendAssistantMessage("still not json");
    await harness.emit("agent_end", { messages: [] });
    const retryingState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(retryingState.active).toBe(true);
    expect(retryingState.awaitingResponse).toBe(true);
    expect(retryingState.socketState).toBe("awaiting_agent_response");
    expect(retryingState.multiTurnFinalizing).toBe(true);
    expect(retryingState.currentSocketId).toBe("Socket-1");
    expect(retryingState.lastJson).toBeUndefined();
    expect(retryingState.data.tasks).toBeUndefined();
    expect(harness.notifications.some((notification) => notification.type === "warning" && notification.message.includes("previous JSON output was invalid"))).toBe(true);
    expect((harness.sentMessages.at(-1)?.message as any).content).toContain("Your previous final JSON response was invalid");
    expect((harness.sentMessages.at(-1)?.message as any).content).toContain("Return only corrected JSON");
    const retryEvents = await readRunEvents(retryingState);
    expect(retryEvents.filter((event) => event.type === "socket_complete")).toHaveLength(0);
    expect(retryEvents.some((event) => event.type === "same_socket_recovery_start" && event.data.recoveryKind === "json_output_repair" && event.data.validationKind === "json_parse")).toBe(true);

    harness.appendAssistantMessage('{"tasks":[{"title":"fixed"}]}');
    await harness.emit("agent_end", { messages: [] });
    const completedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(completedState.active).toBe(false);
    expect(completedState.socketState).toBe("complete");
    expect(completedState.data.tasks[0].title).toBe("fixed");
  });

  test("/materia continue bypasses the generic idle wait only for paused multi-turn finalization", async () => {
    const harness = await makeHarness(multiTurnConfig());

    await harness.runCommand("materia", "cast refine a plan");
    harness.appendAssistantMessage("ready for your refinement");
    await harness.emit("agent_end", { messages: [] });

    const pausedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(pausedState.active).toBe(true);
    expect(pausedState.socketState).toBe("awaiting_user_refinement");
    expect(pausedState.awaitingResponse).toBe(false);

    harness.idle = false;
    harness.waitForIdleError = new Error("ambiguous non-idle state");
    const waitCallsBeforeStatus = harness.waitForIdleCalls;
    await expect(harness.runCommand("materia", "status")).rejects.toThrow("ambiguous non-idle state");
    expect(harness.waitForIdleCalls).toBe(waitCallsBeforeStatus + 1);

    const waitCallsBeforeContinue = harness.waitForIdleCalls;
    await harness.runCommand("materia", "continue");
    expect(harness.waitForIdleCalls).toBe(waitCallsBeforeContinue);

    const finalizingState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(finalizingState.active).toBe(true);
    expect(finalizingState.socketState).toBe("awaiting_agent_response");
    expect(finalizingState.awaitingResponse).toBe(true);
    expect(finalizingState.multiTurnFinalizing).toBe(true);
    expect((harness.sentMessages.at(-1)?.message as any).content).toContain("Command-triggered finalization");
  });

  test("/materia continue reports an error instead of interrupting an active agent response", async () => {
    const harness = await makeHarness(multiTurnConfig());

    await harness.runCommand("materia", "cast refine a plan");
    const startedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(startedState.active).toBe(true);
    expect(startedState.socketState).toBe("awaiting_agent_response");
    expect(startedState.awaitingResponse).toBe(true);

    harness.idle = false;
    harness.waitForIdleError = new Error("ambiguous non-idle state");
    const waitCallsBeforeContinue = harness.waitForIdleCalls;
    await harness.runCommand("materia", "continue");
    expect(harness.waitForIdleCalls).toBe(waitCallsBeforeContinue);

    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.socketState).toBe("awaiting_agent_response");
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.multiTurnFinalizing).not.toBe(true);
    expect(harness.notifications.at(-1)).toMatchObject({
      type: "error",
      message: "pi-materia continue failed: Materia is already awaiting a Pi agent response.",
    });
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(1);
  });

  test("normal CRT refinement text does not finalize or parse paused JSON multi-turn output", async () => {
    const harness = await makeHarness(multiTurnConfig());
    const crtRefinement = "Lets do a full CRT inspired shader, we should give it some phosphor glow, and some fading to make it look like a worn out tube.";
    const plaintextAssistantRefinement = [
      "Sounds good — we’ll make the visual treatment a first-class feature rather than just a simple tint.",
      "Updated plan detail for the retro visuals:",
      "- Full-screen CRT-inspired shader/post-process effect.",
      "- Include scanlines, phosphor glow, and faded/worn tube styling.",
    ].join("\n");

    await harness.runCommand("materia", "cast refine a plan");
    harness.appendAssistantMessage("One clarification before finalizing: full-screen CRT effect, or simpler material effect?");
    await harness.emit("agent_end", { messages: [] });

    const pausedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(pausedState.active).toBe(true);
    expect(pausedState.socketState).toBe("awaiting_user_refinement");
    expect(pausedState.awaitingResponse).toBe(false);
    expect(pausedState.data.tasks).toBeUndefined();
    expect(pausedState.lastJson).toBeUndefined();
    const errorNotificationsBeforeInput = harness.notifications.filter((notification) => notification.type === "error").length;

    const inputResults = await harness.emit("input", { text: crtRefinement, source: "interactive" });
    expect(inputResults.at(-1)).toBeUndefined();

    const afterInputState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(afterInputState.active).toBe(true);
    expect(afterInputState.socketState).toBe("awaiting_user_refinement");
    expect(afterInputState.awaitingResponse).toBe(false);
    expect(afterInputState.data.tasks).toBeUndefined();
    expect(afterInputState.lastJson).toBeUndefined();
    expect(afterInputState.failedReason).toBeUndefined();
    expect(harness.notifications.filter((notification) => notification.type === "error")).toHaveLength(errorNotificationsBeforeInput);

    harness.appendUserMessage(crtRefinement);
    await harness.emit("before_agent_start", { systemPrompt: "Base system" });
    harness.appendAssistantMessage(plaintextAssistantRefinement);
    await harness.emit("agent_end", { messages: [] });

    const refinedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(refinedState.active).toBe(true);
    expect(refinedState.socketState).toBe("awaiting_user_refinement");
    expect(refinedState.awaitingResponse).toBe(false);
    expect(refinedState.data.tasks).toBeUndefined();
    expect(refinedState.lastJson).toBeUndefined();
    expect(refinedState.failedReason).toBeUndefined();
    expect(refinedState.lastAssistantText).toBe(plaintextAssistantRefinement);
    expect(harness.notifications.filter((notification) => notification.type === "error")).toHaveLength(errorNotificationsBeforeInput);

    const castDir = path.join(harness.cwd, ".pi", "pi-materia", refinedState.castId);
    const manifestBeforeCommand = JSON.parse(await readFile(path.join(castDir, "manifest.json"), "utf8"));
    expect(manifestBeforeCommand.entries.some((entry: any) => entry.kind === "socket_output" && entry.socket === "Socket-1")).toBe(false);

    const commandLikeTextResults = await harness.emit("input", { text: "ready to continue", source: "interactive" });
    expect(commandLikeTextResults.at(-1)).toBeUndefined();
    const afterCommandLikeTextState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(afterCommandLikeTextState.active).toBe(true);
    expect(afterCommandLikeTextState.socketState).toBe("awaiting_user_refinement");
    expect(afterCommandLikeTextState.multiTurnFinalizing).not.toBe(true);

    await harness.runCommand("materia", "continue");
    const finalizingState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(finalizingState.active).toBe(true);
    expect(finalizingState.socketState).toBe("awaiting_agent_response");
    expect(finalizingState.multiTurnFinalizing).toBe(true);
    expect((harness.sentMessages.at(-1)?.message as any).content).toContain("Return only JSON");
  });

  test("stale finalization flag cannot complete a paused refinement turn", async () => {
    const harness = await makeHarness(multiTurnConfig());
    const plaintextAssistantRefinement = "Plaintext refinement response, definitely not JSON.";

    await harness.runCommand("materia", "cast refine a plan");
    harness.appendAssistantMessage("Initial plaintext planning question.");
    await harness.emit("agent_end", { messages: [] });

    const pausedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(pausedState.active).toBe(true);
    expect(pausedState.socketState).toBe("awaiting_user_refinement");
    expect(pausedState.awaitingResponse).toBe(false);

    // Simulate a stale/racy flag left behind while the socket is still paused.
    harness.pi.appendEntry("pi-materia-cast-state", { ...pausedState, multiTurnFinalizing: true });
    harness.appendAssistantMessage(plaintextAssistantRefinement);
    await harness.emit("agent_end", { messages: [] });

    const refinedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(refinedState.active).toBe(true);
    expect(refinedState.socketState).toBe("awaiting_user_refinement");
    expect(refinedState.awaitingResponse).toBe(false);
    expect(refinedState.multiTurnFinalizing).toBe(false);
    expect(refinedState.data.tasks).toBeUndefined();
    expect(refinedState.lastJson).toBeUndefined();
    expect(refinedState.failedReason).toBeUndefined();
    expect(harness.notifications.filter((notification) => notification.type === "error")).toHaveLength(0);

    const castDir = path.join(harness.cwd, ".pi", "pi-materia", refinedState.castId);
    const manifest = JSON.parse(await readFile(path.join(castDir, "manifest.json"), "utf8"));
    expect(manifest.entries.some((entry: any) => entry.kind === "socket_refinement" && entry.artifact.includes(".refinement-2-"))).toBe(true);
    expect(manifest.entries.some((entry: any) => entry.kind === "socket_output" && entry.socket === "Socket-1")).toBe(false);
  });

  test("multi-turn input finalizes only on explicit /materia continue command", async () => {
    const normalInputs = [
      "Lets do a full CRT inspired shader, we should give it some phosphor glow, and some fading to make it look like a worn out tube.",
      "continue with the full CRT shader details",
      "How should we proceed with scoring?",
      "looks good",
      "ready to continue",
      "finalize",
      "looks good, proceed",
      "done",
    ];

    const refinementHarness = await makeHarness(multiTurnConfig());
    await refinementHarness.runCommand("materia", "cast refine a plan");
    refinementHarness.appendAssistantMessage("plain text draft, not final JSON");
    await refinementHarness.emit("agent_end", { messages: [] });

    const errorsBeforeInput = refinementHarness.notifications.filter((notification) => notification.type === "error").length;
    const triggeredTurnsBeforeInput = refinementHarness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn).length;
    for (const text of normalInputs) {
      const inputResults = await refinementHarness.emit("input", { text, source: "interactive" });
      expect(inputResults.at(-1)).toBeUndefined();
      const state = refinementHarness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
      expect(state.active).toBe(true);
      expect(state.socketState).toBe("awaiting_user_refinement");
      expect(state.multiTurnFinalizing).not.toBe(true);
      expect(state.data.tasks).toBeUndefined();
      expect(state.lastJson).toBeUndefined();
    }
    expect(refinementHarness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(triggeredTurnsBeforeInput);
    expect(refinementHarness.notifications.filter((notification) => notification.type === "error")).toHaveLength(errorsBeforeInput);

    await refinementHarness.runCommand("materia", "continue");
    let state = refinementHarness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(state.active).toBe(true);
    expect(state.socketState).toBe("awaiting_agent_response");
    expect(state.multiTurnFinalizing).toBe(true);
    expect((refinementHarness.sentMessages.at(-1)?.message as any).content).toContain("Command-triggered finalization");
    refinementHarness.appendAssistantMessage('{"tasks":[{"id":"1","title":"Ship it"}]}');
    await refinementHarness.emit("agent_end", { messages: [] });
    state = refinementHarness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(state.active).toBe(false);
    expect(state.socketState).toBe("complete");
    expect(state.data.tasks).toEqual([{ id: "1", title: "Ship it" }]);
  });

  test("paused refinement turns keep the active materia prompt, tools, model, and isolated context", async () => {
    const harness = await makeHarness(multiTurnConfig({ model: "test/refiner", thinking: "high" }));
    harness.models = [{ provider: "test", id: "refiner", name: "Refiner", api: "fake" }];

    await harness.runCommand("materia", "cast refine a plan");
    harness.appendAssistantMessage("draft response");
    await harness.emit("agent_end", { messages: [] });

    const triggeredTurnsBeforeRefinement = harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn).length;
    const inputResults = await harness.emit("input", { text: "refine this plan", source: "interactive" });
    expect(inputResults.at(-1)).toBeUndefined();
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(triggeredTurnsBeforeRefinement);
    const afterInputState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(afterInputState.socketState).toBe("awaiting_user_refinement");
    expect(afterInputState.awaitingResponse).toBe(false);

    harness.activeTools = ["read", "grep", "find", "ls", "bash", "edit", "write"];
    const beforeResults = await harness.emit("before_agent_start", { systemPrompt: "Base system" });
    const refinementTurnState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(refinementTurnState.socketState).toBe("awaiting_agent_response");
    expect(refinementTurnState.awaitingResponse).toBe(true);
    expect(harness.statuses.get("materia")).toBe("Plan");
    expect((harness.widgets.get("materia")?.content ?? []).join("\n")).toContain("› Plan active");
    expect((harness.widgets.get("materia")?.content ?? []).join("\n")).not.toContain("waiting for refinement");
    expect((beforeResults.at(-1) as any).systemPrompt).toContain("Materia active materia (Socket-1):\nCollaborative planner");
    expect(harness.activeTools).toEqual(["read", "grep", "find", "ls"]);
    expect(harness.setModelCalls.length).toBeGreaterThanOrEqual(2);
    expect(harness.setThinkingLevelCalls.at(-1)).toBe("high");

    const prompt = harness.sentMessages.find((sent) => (sent.message as any).customType === "pi-materia-prompt")?.message as any;
    const messages = [
      { role: "user", content: [{ type: "text", text: "unrelated earlier transcript" }] },
      { role: "user", content: [{ type: "text", text: prompt.content }] },
      { role: "assistant", content: [{ type: "text", text: "draft response" }] },
      { role: "user", content: [{ type: "text", text: "refine this plan" }] },
    ];
    const contextResults = await harness.emit("context", { messages });
    const isolated = (contextResults.at(-1) as any).messages;
    const synthetic = isolated[0].content as string;
    expect(synthetic).toContain("Current socket: Socket-1");
    expect(synthetic).toContain("Current materia: Plan");
    expect(synthetic).toContain("Artifact directory:");
    expect(synthetic).toContain("Previous output:\ndraft response");
    expect(synthetic).toContain("Mode: multi-turn refinement (awaiting_agent_response)");
    expect(JSON.stringify(isolated)).not.toContain("unrelated earlier transcript");
    expect(JSON.stringify(isolated)).toContain("refine this plan");
  });

  test("status and command help instruct users to run /materia continue", async () => {
    const harness = await makeHarness(multiTurnConfig());
    expect(harness.commands.get("materia")?.description).toContain("continue");

    await harness.runCommand("materia", "cast refine a plan");
    harness.appendAssistantMessage("draft response");
    await harness.emit("agent_end", { messages: [] });

    await harness.runCommand("materia", "status");
    const statusText = (harness.widgets.get("materia")?.content ?? []).join("\n");
    expect(statusText).toContain("/materia continue");
    expect(statusText).not.toContain("say you are ready to continue/finalize");

    await harness.runCommand("materia", "unknown");
    expect(harness.notifications.at(-1)?.message).toContain("Usage:");
    expect(harness.notifications.at(-1)?.message).toContain("/materia continue");
  });

  test("records refinement artifacts, context prompts, events, finalization metadata, and usage", async () => {
    const harness = await makeHarness(multiTurnConfig({ model: "test/refiner" }));
    harness.models = [{ provider: "test", id: "refiner", name: "Refiner", api: "fake" }];

    await harness.runCommand("materia", "cast refine a plan");
    harness.appendAssistantMessage("not json yet", { usage: { inputTokens: 3, outputTokens: 5 } });
    await harness.emit("agent_end", { messages: [] });
    harness.appendUserMessage("make it final JSON");
    await harness.emit("before_agent_start", { systemPrompt: "Base system" });
    harness.appendAssistantMessage('{"tasks":[{"id":"1","title":"Ship it"}]}', { usage: { inputTokens: 7, outputTokens: 11 } });
    await harness.emit("agent_end", { messages: [] });
    await harness.runCommand("materia", "continue");
    const finalizingState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(finalizingState.socketState).toBe("awaiting_agent_response");
    expect(finalizingState.multiTurnFinalizing).toBe(true);
    harness.appendAssistantMessage('{"tasks":[{"id":"1","title":"Ship it"}]}', { usage: { inputTokens: 7, outputTokens: 11 } });
    await harness.emit("agent_end", { messages: [] });

    const completeState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    const castDir = path.join(harness.cwd, ".pi", "pi-materia", completeState.castId);
    const manifest = JSON.parse(await readFile(path.join(castDir, "manifest.json"), "utf8"));
    const refinements = manifest.entries.filter((entry: any) => entry.kind === "socket_refinement");
    expect(refinements.map((entry: any) => entry.refinementTurn)).toEqual([1, 2]);
    expect(new Set(refinements.map((entry: any) => entry.artifact)).size).toBe(2);
    expect(refinements.every((entry: any) => entry.artifact.includes(".refinement-"))).toBe(true);
    expect(manifest.entries.some((entry: any) => entry.kind === "context_refinement" && entry.refinementTurn === 2)).toBe(true);
    expect(manifest.entries.some((entry: any) => entry.kind === "socket_output" && entry.finalized === true && entry.refinementTurn === 2)).toBe(true);

    const events = (await readFile(path.join(castDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.filter((event: any) => event.type === "socket_refinement").map((event: any) => event.data.refinementTurn)).toEqual([1, 2]);
    expect(events.some((event: any) => event.type === "context_refinement" && event.data.refinementTurn === 2)).toBe(true);
    expect(events.some((event: any) => event.type === "socket_complete" && event.data.finalizedRefinement === true && event.data.refinementTurn === 2)).toBe(true);

    const usage = JSON.parse(await readFile(path.join(castDir, "usage.json"), "utf8"));
    expect(usage.tokens.total).toBe(44);
    expect(usage.turns).toHaveLength(3);
    expect(usage.modelSelections.length).toBeGreaterThanOrEqual(2);
  });

  test("/materia continue finalizes the latest multi-turn assistant output", async () => {
    const harness = await makeHarness(multiTurnConfig());

    await harness.runCommand("materia", "cast refine a plan");
    harness.appendAssistantMessage("not json yet");
    await harness.emit("agent_end", { messages: [] });
    harness.appendUserMessage("make it final JSON");
    harness.appendAssistantMessage('{"tasks":[{"id":"1","title":"Ship it"}]}');
    await harness.emit("agent_end", { messages: [] });

    const stillPausedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(stillPausedState.active).toBe(true);
    expect(stillPausedState.socketState).toBe("awaiting_user_refinement");
    expect(stillPausedState.lastAssistantText).toContain("Ship it");

    const inputResults = await harness.emit("input", { text: "that looks good, finalize it", source: "interactive" });
    expect(inputResults.at(-1)).toBeUndefined();
    const afterNaturalLanguageState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(afterNaturalLanguageState.socketState).toBe("awaiting_user_refinement");
    expect(afterNaturalLanguageState.multiTurnFinalizing).not.toBe(true);

    await harness.runCommand("materia", "continue");
    const finalizingState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(finalizingState.socketState).toBe("awaiting_agent_response");
    expect(finalizingState.multiTurnFinalizing).toBe(true);
    harness.appendAssistantMessage('{"tasks":[{"id":"1","title":"Ship it"}]}');
    await harness.emit("agent_end", { messages: [] });
    const completeState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(completeState.active).toBe(false);
    expect(completeState.socketState).toBe("complete");
    expect(completeState.data.tasks).toEqual([{ id: "1", title: "Ship it" }]);

    const castDir = path.join(harness.cwd, ".pi", "pi-materia", completeState.castId);
    const manifest = JSON.parse(await readFile(path.join(castDir, "manifest.json"), "utf8"));
    const artifacts = manifest.entries.map((entry: any) => entry.artifact).filter(Boolean);
    expect(artifacts.some((artifact: string) => artifact.includes(".refinement-"))).toBe(true);
    expect(artifacts).toContain(path.join("sockets", "Socket-1", "1.md"));
  });

  test("finalized multi-turn JSON artifacts and downstream state match single-turn shape", async () => {
    const harness = await makeHarness(multiTurnWithDownstreamConfig("json"));
    const finalJson = '{"tasks":[{"id":"1","title":"Ship it"}]}';

    await harness.runCommand("materia", "cast refine a plan");
    harness.appendAssistantMessage("draft");
    await harness.emit("agent_end", { messages: [] });
    harness.appendUserMessage("make it final JSON");
    harness.appendAssistantMessage(finalJson);
    await harness.emit("agent_end", { messages: [] });
    await harness.runCommand("materia", "continue");
    const promptsBeforeFinalAgentEnd = harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn).length;
    harness.appendAssistantMessage(finalJson);
    await harness.emit("agent_end", { messages: [] });

    const state = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(state.active).toBe(true);
    expect(state.currentSocketId).toBe("Socket-2");
    expect(state.currentMateria).toBe("Build");
    expect(state.socketState).toBe("awaiting_agent_response");
    expect(state.data.tasks).toEqual([{ id: "1", title: "Ship it" }]);
    expect(state.lastJson).toEqual({ tasks: [{ id: "1", title: "Ship it" }] });
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(promptsBeforeFinalAgentEnd);

    const castDir = path.join(harness.cwd, ".pi", "pi-materia", state.castId);
    expect(await readFile(path.join(castDir, "sockets", "Socket-1", "1.md"), "utf8")).toBe(finalJson);
    expect(JSON.parse(await readFile(path.join(castDir, "sockets", "Socket-1", "1.json"), "utf8"))).toEqual({ tasks: [{ id: "1", title: "Ship it" }] });

    const manifest = JSON.parse(await readFile(path.join(castDir, "manifest.json"), "utf8"));
    const socketOutput = manifest.entries.find((entry: any) => entry.kind === "socket_output" && entry.socket === "Socket-1");
    expect(socketOutput.artifact).toBe(path.join("sockets", "Socket-1", "1.md"));
    expect(socketOutput.finalized).toBe(true);
    expect(socketOutput.refinementTurn).toBe(2);

    const events = (await readFile(path.join(castDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const completeEvent = events.find((event: any) => event.type === "socket_complete" && event.data.socket === "Socket-1");
    expect(completeEvent.data.artifact).toBe(path.join("sockets", "Socket-1", "1.md"));
    expect(completeEvent.data.parsed).toBe(true);
    expect(completeEvent.data.finalizedRefinement).toBe(true);

    await flushDeferredDispatch();
    const triggeredMessages = harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn);
    expect(triggeredMessages).toHaveLength(promptsBeforeFinalAgentEnd + 1);
    const buildPrompt = triggeredMessages.at(-1)?.message as any;
    expect(buildPrompt.customType).toBe("pi-materia-prompt");
    expect(buildPrompt.details).toMatchObject({ socketId: "Socket-2", materiaName: "Build" });
  });

  test("finalized multi-turn text artifacts and downstream state match single-turn shape", async () => {
    const harness = await makeHarness(multiTurnWithDownstreamConfig("text"));
    const finalText = "Final text plan";

    await harness.runCommand("materia", "cast refine text");
    harness.appendAssistantMessage("draft text");
    await harness.emit("agent_end", { messages: [] });
    harness.appendAssistantMessage(finalText);
    await harness.emit("agent_end", { messages: [] });
    await harness.runCommand("materia", "continue");
    const promptsBeforeFinalAgentEnd = harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn).length;
    harness.appendAssistantMessage(finalText);
    await harness.emit("agent_end", { messages: [] });

    const state = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(state.active).toBe(true);
    expect(state.currentSocketId).toBe("Socket-2");
    expect(state.currentMateria).toBe("Build");
    expect(state.socketState).toBe("awaiting_agent_response");
    expect(state.data.summary).toBe(finalText);
    expect(state.lastJson).toBeUndefined();
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(promptsBeforeFinalAgentEnd);

    const castDir = path.join(harness.cwd, ".pi", "pi-materia", state.castId);
    expect(await readFile(path.join(castDir, "sockets", "Socket-1", "1.md"), "utf8")).toBe(finalText);
    const manifest = JSON.parse(await readFile(path.join(castDir, "manifest.json"), "utf8"));
    const socketOutput = manifest.entries.find((entry: any) => entry.kind === "socket_output" && entry.socket === "Socket-1");
    expect(socketOutput.artifact).toBe(path.join("sockets", "Socket-1", "1.md"));
    expect(socketOutput.finalized).toBe(true);
    expect(socketOutput.kind).toBe("socket_output");

    await flushDeferredDispatch();
    const triggeredMessages = harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn);
    expect(triggeredMessages).toHaveLength(promptsBeforeFinalAgentEnd + 1);
    const buildPrompt = triggeredMessages.at(-1)?.message as any;
    expect(buildPrompt.customType).toBe("pi-materia-prompt");
    expect(buildPrompt.details).toMatchObject({ socketId: "Socket-2", materiaName: "Build" });
  });
});
