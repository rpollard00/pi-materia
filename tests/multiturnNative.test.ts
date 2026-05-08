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

async function makeBundledDefaultHarness(): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-bundled-"));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

function multiTurnConfig(overrides: Record<string, unknown> = {}) {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "Socket-1",
        nodes: {
          "Socket-1": { type: "agent", materia: "Plan", parse: "json", assign: { tasks: "$.tasks" } },
        },
      },
    },
    materia: { Plan: { tools: "readOnly", prompt: "Collaborative planner", multiTurn: true, ...overrides } },
  };
}

function singleTurnConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "Socket-1",
        nodes: {
          "Socket-1": { type: "agent", materia: "Plan", parse: "json", assign: { tasks: "$.tasks" }, next: "Socket-2" },
          "Socket-2": { type: "agent", materia: "Build" },
        },
      },
    },
    materia: {
      Plan: { tools: "readOnly", prompt: "Plan once" },
      Build: { tools: "coding", prompt: "Build once\n\nBuild {{state.tasks.0.title}}" },
    },
  };
}

function multiTurnWithDownstreamConfig(parse: "json" | "text") {
  const plan = parse === "json"
    ? { type: "agent", materia: "Plan", parse: "json", assign: { tasks: "$.tasks" }, next: "Socket-2" }
    : { type: "agent", materia: "Plan", parse: "text", assign: { summary: "$" }, next: "Socket-2" };
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "Socket-1",
        nodes: {
          "Socket-1": plan,
          "Socket-2": { type: "agent", materia: "Build" },
        },
      },
    },
    materia: {
      Plan: { tools: "readOnly", prompt: "Collaborative planner", multiTurn: true },
      Build: { tools: "coding", prompt: "Build downstream\n\nTasks={{state.tasks}} Summary={{state.summary}} Last={{lastOutput}}" },
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
        nodes: { "Socket-1": { type: "agent", materia: "PlanSingle", parse: "json", assign: { tasks: "$.tasks" } } },
      },
      Interactive: {
        entry: "Socket-1",
        nodes: { "Socket-1": { type: "agent", materia: "PlanInteractive", parse: "json", assign: { tasks: "$.tasks" } } },
      },
    },
    materia: {
      PlanSingle: { tools: "readOnly", prompt: "Plan once" },
      PlanInteractive: { tools: "readOnly", prompt: "Plan with refinements", multiTurn: true },
    },
  };
}

describe("native multi-turn runtime", () => {
  test("single-turn agent nodes still parse, assign, and advance automatically", async () => {
    const harness = await makeHarness(singleTurnConfig());

    await harness.runCommand("materia", "cast make a plan");
    harness.appendAssistantMessage('{"tasks":[{"id":"1","title":"Ship it"}]}');
    await harness.emit("agent_end", { messages: [] });

    const state = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(state.active).toBe(true);
    expect(state.currentNode).toBe("Socket-2");
    expect(state.nodeState).toBe("awaiting_agent_response");
    expect(state.awaitingResponse).toBe(true);
    expect(state.data.tasks).toEqual([{ id: "1", title: "Ship it" }]);
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(2);
  });

  test("bundled Planning-Consult pauses after planner output until /materia continue advances to Build", async () => {
    const harness = await makeBundledDefaultHarness();
    const finalPlan = '{"summary":"Plan","workItems":[{"id":"1","title":"Ship it","description":"Do the work","acceptance":["Done"],"context":{"architecture":"","constraints":[],"dependencies":[],"risks":[]}}],"guidance":{},"decisions":[],"risks":[],"satisfied":true,"feedback":"","missing":[]}';

    await harness.runCommand("materia", "loadout Planning-Consult");
    expect(JSON.parse(await readFile(path.join(harness.cwd, ".pi", "pi-materia.json"), "utf8"))).toEqual({ activeLoadout: "Planning-Consult" });

    await harness.runCommand("materia", "cast build the feature");
    const plannerStartedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(plannerStartedState.currentNode).toBe("Socket-3");
    expect(plannerStartedState.currentMateria).toBe("interactivePlan");
    expect(plannerStartedState.nodeState).toBe("awaiting_agent_response");
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(1);
    const firstPrompt = harness.sentMessages.find((sent) => (sent.message as any).customType === "pi-materia-prompt")?.message as any;
    expect(firstPrompt.content).toContain("Collaboratively refine an implementation plan");
    expect(firstPrompt.content).toContain("normal conversation");
    expect(firstPrompt.content).toContain("Do not emit the structured workItems JSON during refinement");
    expect(firstPrompt.content).toContain("/materia continue is the only way to finalize this multi-turn node");
    expect(firstPrompt.content).toContain("do not emit final JSON");
    expect(firstPrompt.content).not.toContain("Return only JSON");

    harness.appendAssistantMessage("I understand the feature. A good first cut is to update the prompt and cover it with tests. Should docs be included too?");
    await harness.emit("agent_end", { messages: [] });

    const pausedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(pausedState.active).toBe(true);
    expect(pausedState.currentNode).toBe("Socket-3");
    expect(pausedState.currentMateria).toBe("interactivePlan");
    expect(pausedState.nodeState).toBe("awaiting_user_refinement");
    expect(pausedState.awaitingResponse).toBe(false);
    expect(pausedState.data.workItems).toBeUndefined();
    expect(pausedState.lastAssistantText).toContain("Should docs be included too?");
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(1);
    expect(harness.sentMessages.map(({ message }) => (message as any).content).join("\n")).not.toContain("Task 1: Ship it");

    harness.appendUserMessage("Yes, include docs and finalize the work item artifacts.");
    harness.appendAssistantMessage(finalPlan);
    await harness.emit("agent_end", { messages: [] });

    const finalizedButPausedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(finalizedButPausedState.active).toBe(true);
    expect(finalizedButPausedState.currentNode).toBe("Socket-3");
    expect(finalizedButPausedState.nodeState).toBe("awaiting_user_refinement");
    expect(finalizedButPausedState.data.workItems).toBeUndefined();
    expect(finalizedButPausedState.lastAssistantText).toBe(finalPlan);

    const inputResults = await harness.emit("input", { text: "ready to continue", source: "interactive" });
    expect(inputResults.at(-1)).toBeUndefined();
    const stillPausedAfterInput = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(stillPausedAfterInput.nodeState).toBe("awaiting_user_refinement");
    expect(stillPausedAfterInput.multiTurnFinalizing).not.toBe(true);

    await harness.runCommand("materia", "continue");
    const commandFinalizingState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(commandFinalizingState.nodeState).toBe("awaiting_agent_response");
    expect(commandFinalizingState.multiTurnFinalizing).toBe(true);
    const finalPrompt = harness.sentMessages.at(-1)?.message as any;
    expect(finalPrompt.content).toContain("Command-triggered finalization");
    expect(finalPrompt.content).toContain("Return only JSON");
    harness.appendAssistantMessage(finalPlan);
    await harness.emit("agent_end", { messages: [] });

    const buildState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(buildState.active).toBe(true);
    expect(buildState.currentNode).toBe("Socket-4");
    expect(buildState.currentMateria).toBe("Build");
    expect(buildState.nodeState).toBe("awaiting_agent_response");
    expect(buildState.data.workItems).toEqual([{ id: "1", title: "Ship it", description: "Do the work", acceptance: ["Done"], context: { architecture: "", constraints: [], dependencies: [], risks: [] } }]);
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(3);
    expect((harness.sentMessages.at(-1)?.message as any).content).toContain("Work item 1: Ship it");
  });

  test("loadout switching changes multi-turn behavior only by selecting multi-turn materia", async () => {
    const harness = await makeHarness(loadoutSwitchingConfig());
    const finalPlan = '{"tasks":[{"id":"1","title":"Ship it"}]}';

    await harness.runCommand("materia", "cast plan once");
    harness.appendAssistantMessage(finalPlan);
    await harness.emit("agent_end", { messages: [] });

    const singleState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(singleState.active).toBe(false);
    expect(singleState.currentNode).toBe("Socket-1");
    expect(singleState.currentMateria).toBe("PlanSingle");
    expect(singleState.nodeState).toBe("complete");
    expect(singleState.data.tasks).toEqual([{ id: "1", title: "Ship it" }]);

    await harness.runCommand("materia", "loadout Interactive");
    await harness.runCommand("materia", "cast refine the plan");
    harness.appendAssistantMessage(finalPlan);
    await harness.emit("agent_end", { messages: [] });

    const interactiveState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(interactiveState.active).toBe(true);
    expect(interactiveState.currentNode).toBe("Socket-1");
    expect(interactiveState.currentMateria).toBe("PlanInteractive");
    expect(interactiveState.nodeState).toBe("awaiting_user_refinement");
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
    expect(pausedState.nodeState).toBe("awaiting_user_refinement");
    expect(pausedState.currentNode).toBe("Socket-1");
    expect(pausedState.lastJson).toBeUndefined();

    await harness.runCommand("materia", "status");
    expect(harness.widgets.get("materia")?.content).toContain("› waiting for refinement; /materia continue to finalize");

    const inputResults = await harness.emit("input", { text: "ready to continue", source: "interactive" });
    expect(inputResults.at(-1)).toBeUndefined();
    const stillPausedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(stillPausedState.active).toBe(true);
    expect(stillPausedState.nodeState).toBe("awaiting_user_refinement");
    expect(stillPausedState.multiTurnFinalizing).not.toBe(true);

    await harness.runCommand("materia", "continue");
    const finalizingState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(finalizingState.active).toBe(true);
    expect(finalizingState.nodeState).toBe("awaiting_agent_response");
    expect(finalizingState.multiTurnFinalizing).toBe(true);
    expect((harness.sentMessages.at(-1)?.message as any).content).toContain("Return only JSON");
    harness.appendAssistantMessage("still not json");
    await harness.emit("agent_end", { messages: [] });
    const failedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(failedState.active).toBe(false);
    expect(failedState.nodeState).toBe("failed");
    expect(harness.notifications.at(-1)?.message).toContain("Invalid JSON output for node \"Socket-1\"");
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
    expect(pausedState.nodeState).toBe("awaiting_user_refinement");
    expect(pausedState.awaitingResponse).toBe(false);
    expect(pausedState.data.tasks).toBeUndefined();
    expect(pausedState.lastJson).toBeUndefined();
    const errorNotificationsBeforeInput = harness.notifications.filter((notification) => notification.type === "error").length;

    const inputResults = await harness.emit("input", { text: crtRefinement, source: "interactive" });
    expect(inputResults.at(-1)).toBeUndefined();

    const afterInputState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(afterInputState.active).toBe(true);
    expect(afterInputState.nodeState).toBe("awaiting_user_refinement");
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
    expect(refinedState.nodeState).toBe("awaiting_user_refinement");
    expect(refinedState.awaitingResponse).toBe(false);
    expect(refinedState.data.tasks).toBeUndefined();
    expect(refinedState.lastJson).toBeUndefined();
    expect(refinedState.failedReason).toBeUndefined();
    expect(refinedState.lastAssistantText).toBe(plaintextAssistantRefinement);
    expect(harness.notifications.filter((notification) => notification.type === "error")).toHaveLength(errorNotificationsBeforeInput);

    const castDir = path.join(harness.cwd, ".pi", "pi-materia", refinedState.castId);
    const manifestBeforeCommand = JSON.parse(await readFile(path.join(castDir, "manifest.json"), "utf8"));
    expect(manifestBeforeCommand.entries.some((entry: any) => entry.kind === "node_output" && entry.node === "Socket-1")).toBe(false);

    const commandLikeTextResults = await harness.emit("input", { text: "ready to continue", source: "interactive" });
    expect(commandLikeTextResults.at(-1)).toBeUndefined();
    const afterCommandLikeTextState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(afterCommandLikeTextState.active).toBe(true);
    expect(afterCommandLikeTextState.nodeState).toBe("awaiting_user_refinement");
    expect(afterCommandLikeTextState.multiTurnFinalizing).not.toBe(true);

    await harness.runCommand("materia", "continue");
    const finalizingState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(finalizingState.active).toBe(true);
    expect(finalizingState.nodeState).toBe("awaiting_agent_response");
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
    expect(pausedState.nodeState).toBe("awaiting_user_refinement");
    expect(pausedState.awaitingResponse).toBe(false);

    // Simulate a stale/racy flag left behind while the node is still paused.
    harness.pi.appendEntry("pi-materia-cast-state", { ...pausedState, multiTurnFinalizing: true });
    harness.appendAssistantMessage(plaintextAssistantRefinement);
    await harness.emit("agent_end", { messages: [] });

    const refinedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(refinedState.active).toBe(true);
    expect(refinedState.nodeState).toBe("awaiting_user_refinement");
    expect(refinedState.awaitingResponse).toBe(false);
    expect(refinedState.multiTurnFinalizing).toBe(false);
    expect(refinedState.data.tasks).toBeUndefined();
    expect(refinedState.lastJson).toBeUndefined();
    expect(refinedState.failedReason).toBeUndefined();
    expect(harness.notifications.filter((notification) => notification.type === "error")).toHaveLength(0);

    const castDir = path.join(harness.cwd, ".pi", "pi-materia", refinedState.castId);
    const manifest = JSON.parse(await readFile(path.join(castDir, "manifest.json"), "utf8"));
    expect(manifest.entries.some((entry: any) => entry.kind === "node_refinement" && entry.artifact.includes(".refinement-2-"))).toBe(true);
    expect(manifest.entries.some((entry: any) => entry.kind === "node_output" && entry.node === "Socket-1")).toBe(false);
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
      expect(state.nodeState).toBe("awaiting_user_refinement");
      expect(state.multiTurnFinalizing).not.toBe(true);
      expect(state.data.tasks).toBeUndefined();
      expect(state.lastJson).toBeUndefined();
    }
    expect(refinementHarness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(triggeredTurnsBeforeInput);
    expect(refinementHarness.notifications.filter((notification) => notification.type === "error")).toHaveLength(errorsBeforeInput);

    await refinementHarness.runCommand("materia", "continue");
    let state = refinementHarness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(state.active).toBe(true);
    expect(state.nodeState).toBe("awaiting_agent_response");
    expect(state.multiTurnFinalizing).toBe(true);
    expect((refinementHarness.sentMessages.at(-1)?.message as any).content).toContain("Command-triggered finalization");
    refinementHarness.appendAssistantMessage('{"tasks":[{"id":"1","title":"Ship it"}]}');
    await refinementHarness.emit("agent_end", { messages: [] });
    state = refinementHarness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(state.active).toBe(false);
    expect(state.nodeState).toBe("complete");
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
    expect(afterInputState.nodeState).toBe("awaiting_user_refinement");
    expect(afterInputState.awaitingResponse).toBe(false);

    harness.activeTools = ["read", "grep", "find", "ls", "bash", "edit", "write"];
    const beforeResults = await harness.emit("before_agent_start", { systemPrompt: "Base system" });
    const refinementTurnState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(refinementTurnState.nodeState).toBe("awaiting_agent_response");
    expect(refinementTurnState.awaitingResponse).toBe(true);
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
    expect(synthetic).toContain("Current node: Socket-1");
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
    expect(finalizingState.nodeState).toBe("awaiting_agent_response");
    expect(finalizingState.multiTurnFinalizing).toBe(true);
    harness.appendAssistantMessage('{"tasks":[{"id":"1","title":"Ship it"}]}', { usage: { inputTokens: 7, outputTokens: 11 } });
    await harness.emit("agent_end", { messages: [] });

    const completeState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    const castDir = path.join(harness.cwd, ".pi", "pi-materia", completeState.castId);
    const manifest = JSON.parse(await readFile(path.join(castDir, "manifest.json"), "utf8"));
    const refinements = manifest.entries.filter((entry: any) => entry.kind === "node_refinement");
    expect(refinements.map((entry: any) => entry.refinementTurn)).toEqual([1, 2]);
    expect(new Set(refinements.map((entry: any) => entry.artifact)).size).toBe(2);
    expect(refinements.every((entry: any) => entry.artifact.includes(".refinement-"))).toBe(true);
    expect(manifest.entries.some((entry: any) => entry.kind === "context_refinement" && entry.refinementTurn === 2)).toBe(true);
    expect(manifest.entries.some((entry: any) => entry.kind === "node_output" && entry.finalized === true && entry.refinementTurn === 2)).toBe(true);

    const events = (await readFile(path.join(castDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.filter((event: any) => event.type === "node_refinement").map((event: any) => event.data.refinementTurn)).toEqual([1, 2]);
    expect(events.some((event: any) => event.type === "context_refinement" && event.data.refinementTurn === 2)).toBe(true);
    expect(events.some((event: any) => event.type === "node_complete" && event.data.finalizedRefinement === true && event.data.refinementTurn === 2)).toBe(true);

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
    expect(stillPausedState.nodeState).toBe("awaiting_user_refinement");
    expect(stillPausedState.lastAssistantText).toContain("Ship it");

    const inputResults = await harness.emit("input", { text: "that looks good, finalize it", source: "interactive" });
    expect(inputResults.at(-1)).toBeUndefined();
    const afterNaturalLanguageState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(afterNaturalLanguageState.nodeState).toBe("awaiting_user_refinement");
    expect(afterNaturalLanguageState.multiTurnFinalizing).not.toBe(true);

    await harness.runCommand("materia", "continue");
    const finalizingState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(finalizingState.nodeState).toBe("awaiting_agent_response");
    expect(finalizingState.multiTurnFinalizing).toBe(true);
    harness.appendAssistantMessage('{"tasks":[{"id":"1","title":"Ship it"}]}');
    await harness.emit("agent_end", { messages: [] });
    const completeState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(completeState.active).toBe(false);
    expect(completeState.nodeState).toBe("complete");
    expect(completeState.data.tasks).toEqual([{ id: "1", title: "Ship it" }]);

    const castDir = path.join(harness.cwd, ".pi", "pi-materia", completeState.castId);
    const manifest = JSON.parse(await readFile(path.join(castDir, "manifest.json"), "utf8"));
    const artifacts = manifest.entries.map((entry: any) => entry.artifact).filter(Boolean);
    expect(artifacts.some((artifact: string) => artifact.includes(".refinement-"))).toBe(true);
    expect(artifacts).toContain(path.join("nodes", "Socket-1", "1.md"));
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
    harness.appendAssistantMessage(finalJson);
    await harness.emit("agent_end", { messages: [] });

    const state = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(state.active).toBe(true);
    expect(state.currentNode).toBe("Socket-2");
    expect(state.nodeState).toBe("awaiting_agent_response");
    expect(state.data.tasks).toEqual([{ id: "1", title: "Ship it" }]);
    expect(state.lastJson).toEqual({ tasks: [{ id: "1", title: "Ship it" }] });

    const castDir = path.join(harness.cwd, ".pi", "pi-materia", state.castId);
    expect(await readFile(path.join(castDir, "nodes", "Socket-1", "1.md"), "utf8")).toBe(finalJson);
    expect(JSON.parse(await readFile(path.join(castDir, "nodes", "Socket-1", "1.json"), "utf8"))).toEqual({ tasks: [{ id: "1", title: "Ship it" }] });

    const manifest = JSON.parse(await readFile(path.join(castDir, "manifest.json"), "utf8"));
    const nodeOutput = manifest.entries.find((entry: any) => entry.kind === "node_output" && entry.node === "Socket-1");
    expect(nodeOutput.artifact).toBe(path.join("nodes", "Socket-1", "1.md"));
    expect(nodeOutput.finalized).toBe(true);
    expect(nodeOutput.refinementTurn).toBe(2);

    const events = (await readFile(path.join(castDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const completeEvent = events.find((event: any) => event.type === "node_complete" && event.data.node === "Socket-1");
    expect(completeEvent.data.artifact).toBe(path.join("nodes", "Socket-1", "1.md"));
    expect(completeEvent.data.parsed).toBe(true);
    expect(completeEvent.data.finalizedRefinement).toBe(true);

    const buildPrompt = harness.sentMessages.at(-1)?.message as any;
    expect(buildPrompt.customType).toBe("pi-materia-prompt");
    expect(buildPrompt.content).toContain("Tasks=[\n  {\n    \"id\": \"1\",\n    \"title\": \"Ship it\"\n  }\n]");
    expect(buildPrompt.content).toContain(`Last=${finalJson}`);
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
    harness.appendAssistantMessage(finalText);
    await harness.emit("agent_end", { messages: [] });

    const state = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(state.active).toBe(true);
    expect(state.currentNode).toBe("Socket-2");
    expect(state.data.summary).toBe(finalText);
    expect(state.lastJson).toBeUndefined();

    const castDir = path.join(harness.cwd, ".pi", "pi-materia", state.castId);
    expect(await readFile(path.join(castDir, "nodes", "Socket-1", "1.md"), "utf8")).toBe(finalText);
    const manifest = JSON.parse(await readFile(path.join(castDir, "manifest.json"), "utf8"));
    const nodeOutput = manifest.entries.find((entry: any) => entry.kind === "node_output" && entry.node === "Socket-1");
    expect(nodeOutput.artifact).toBe(path.join("nodes", "Socket-1", "1.md"));
    expect(nodeOutput.finalized).toBe(true);
    expect(nodeOutput.kind).toBe("node_output");

    const buildPrompt = harness.sentMessages.at(-1)?.message as any;
    expect(buildPrompt.content).toContain("Summary=Final text plan");
    expect(buildPrompt.content).toContain("Last=Final text plan");
  });
});
