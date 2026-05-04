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

function multiTurnConfig(role: Record<string, unknown> = {}) {
  return {
    artifactDir: ".pi/pi-materia",
    pipeline: {
      entry: "plan",
      nodes: {
        plan: { type: "agent", role: "Plan", parse: "json", assign: { tasks: "$.tasks" } },
      },
    },
    roles: { Plan: { tools: "readOnly", systemPrompt: "Collaborative planner", multiTurn: true, ...role } },
  };
}

function singleTurnConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    pipeline: {
      entry: "plan",
      nodes: {
        plan: { type: "agent", role: "Plan", parse: "json", assign: { tasks: "$.tasks" }, next: "build" },
        build: { type: "agent", role: "Build", prompt: "Build {{state.tasks.0.title}}" },
      },
    },
    roles: {
      Plan: { tools: "readOnly", systemPrompt: "Plan once" },
      Build: { tools: "coding", systemPrompt: "Build once" },
    },
  };
}

function multiTurnWithDownstreamConfig(parse: "json" | "text") {
  const plan = parse === "json"
    ? { type: "agent", role: "Plan", parse: "json", assign: { tasks: "$.tasks" }, next: "build" }
    : { type: "agent", role: "Plan", parse: "text", assign: { summary: "$" }, next: "build" };
  return {
    artifactDir: ".pi/pi-materia",
    pipeline: {
      entry: "plan",
      nodes: {
        plan,
        build: { type: "agent", role: "Build", prompt: "Tasks={{state.tasks}} Summary={{state.summary}} Last={{lastOutput}}" },
      },
    },
    roles: {
      Plan: { tools: "readOnly", systemPrompt: "Collaborative planner", multiTurn: true },
      Build: { tools: "coding", systemPrompt: "Build downstream" },
    },
  };
}

function loadoutSwitchingConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Single",
    loadouts: {
      Single: {
        entry: "plan",
        nodes: { plan: { type: "agent", role: "PlanSingle", parse: "json", assign: { tasks: "$.tasks" } } },
      },
      Interactive: {
        entry: "plan",
        nodes: { plan: { type: "agent", role: "PlanInteractive", parse: "json", assign: { tasks: "$.tasks" } } },
      },
    },
    roles: {
      PlanSingle: { tools: "readOnly", systemPrompt: "Plan once" },
      PlanInteractive: { tools: "readOnly", systemPrompt: "Plan with refinements", multiTurn: true },
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
    expect(state.currentNode).toBe("build");
    expect(state.nodeState).toBe("awaiting_agent_response");
    expect(state.awaitingResponse).toBe(true);
    expect(state.data.tasks).toEqual([{ id: "1", title: "Ship it" }]);
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(2);
  });

  test("bundled Planning-Consult pauses after planner output until readiness advances to Build", async () => {
    const harness = await makeBundledDefaultHarness();
    const finalPlan = '{"tasks":[{"id":"1","title":"Ship it","description":"Do the work","acceptance":["Done"]}]}';

    await harness.runCommand("materia", "loadout Planning-Consult");
    expect(JSON.parse(await readFile(path.join(harness.cwd, ".pi", "pi-materia.json"), "utf8"))).toEqual({ activeLoadout: "Planning-Consult" });

    await harness.runCommand("materia", "cast build the feature");
    const plannerStartedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(plannerStartedState.currentNode).toBe("planner");
    expect(plannerStartedState.currentRole).toBe("interactivePlan");
    expect(plannerStartedState.nodeState).toBe("awaiting_agent_response");
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(1);
    const firstPrompt = harness.sentMessages.find((sent) => (sent.message as any).customType === "pi-materia-prompt")?.message as any;
    expect(firstPrompt.content).toContain("Collaboratively refine an implementation plan");
    expect(firstPrompt.content).toContain("normal conversation");
    expect(firstPrompt.content).toContain("Do not emit the structured task JSON during refinement");
    expect(firstPrompt.content).toContain("Only after the user explicitly indicates consensus, readiness to continue, or asks to finalize");
    expect(firstPrompt.content).not.toContain("Return only JSON");

    harness.appendAssistantMessage("I understand the feature. A good first cut is to update the prompt and cover it with tests. Should docs be included too?");
    await harness.emit("agent_end", { messages: [] });

    const pausedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(pausedState.active).toBe(true);
    expect(pausedState.currentNode).toBe("planner");
    expect(pausedState.currentRole).toBe("interactivePlan");
    expect(pausedState.nodeState).toBe("awaiting_user_refinement");
    expect(pausedState.awaitingResponse).toBe(false);
    expect(pausedState.data.tasks).toBeUndefined();
    expect(pausedState.lastAssistantText).toContain("Should docs be included too?");
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(1);
    expect(harness.sentMessages.map(({ message }) => (message as any).content).join("\n")).not.toContain("Task 1: Ship it");

    harness.appendUserMessage("Yes, include docs and finalize the task artifacts.");
    harness.appendAssistantMessage(finalPlan);
    await harness.emit("agent_end", { messages: [] });

    const finalizedButPausedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(finalizedButPausedState.active).toBe(true);
    expect(finalizedButPausedState.currentNode).toBe("planner");
    expect(finalizedButPausedState.nodeState).toBe("awaiting_user_refinement");
    expect(finalizedButPausedState.data.tasks).toBeUndefined();
    expect(finalizedButPausedState.lastAssistantText).toBe(finalPlan);

    const inputResults = await harness.emit("input", { text: "ready to continue", source: "interactive" });
    expect(inputResults.at(-1)).toEqual({ action: "handled" });

    const buildState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(buildState.active).toBe(true);
    expect(buildState.currentNode).toBe("Build");
    expect(buildState.currentRole).toBe("Build");
    expect(buildState.nodeState).toBe("awaiting_agent_response");
    expect(buildState.data.tasks).toEqual([{ id: "1", title: "Ship it", description: "Do the work", acceptance: ["Done"] }]);
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(2);
    expect((harness.sentMessages.at(-1)?.message as any).content).toContain("Task 1: Ship it");
  });

  test("loadout switching changes multi-turn behavior only by selecting a multi-turn role", async () => {
    const harness = await makeHarness(loadoutSwitchingConfig());
    const finalPlan = '{"tasks":[{"id":"1","title":"Ship it"}]}';

    await harness.runCommand("materia", "cast plan once");
    harness.appendAssistantMessage(finalPlan);
    await harness.emit("agent_end", { messages: [] });

    const singleState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(singleState.active).toBe(false);
    expect(singleState.currentNode).toBe("plan");
    expect(singleState.currentRole).toBe("PlanSingle");
    expect(singleState.nodeState).toBe("complete");
    expect(singleState.data.tasks).toEqual([{ id: "1", title: "Ship it" }]);

    await harness.runCommand("materia", "loadout Interactive");
    await harness.runCommand("materia", "cast refine the plan");
    harness.appendAssistantMessage(finalPlan);
    await harness.emit("agent_end", { messages: [] });

    const interactiveState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(interactiveState.active).toBe(true);
    expect(interactiveState.currentNode).toBe("plan");
    expect(interactiveState.currentRole).toBe("PlanInteractive");
    expect(interactiveState.nodeState).toBe("awaiting_user_refinement");
    expect(interactiveState.data.tasks).toBeUndefined();
  });

  test("multi-turn agent output pauses without parsing or advancing until readiness", async () => {
    const harness = await makeHarness(multiTurnConfig());

    await harness.runCommand("materia", "cast refine a plan");
    harness.appendAssistantMessage("not json yet");
    await harness.emit("agent_end", { messages: [] });

    const pausedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(pausedState.active).toBe(true);
    expect(pausedState.awaitingResponse).toBe(false);
    expect(pausedState.nodeState).toBe("awaiting_user_refinement");
    expect(pausedState.currentNode).toBe("plan");
    expect(pausedState.lastJson).toBeUndefined();

    await harness.runCommand("materia", "status");
    expect(harness.widgets.get("materia-status")?.content).toContain("waiting: user refinement, or say you are ready to continue/finalize this multi-turn node");

    const inputResults = await harness.emit("input", { text: "ready to continue", source: "interactive" });
    expect(inputResults.at(-1)).toEqual({ action: "handled" });
    const failedState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(failedState.active).toBe(false);
    expect(failedState.nodeState).toBe("failed");
    expect(harness.notifications.at(-1)?.message).toContain("Invalid JSON output for node \"plan\"");
  });

  test("paused refinement turns keep the active role prompt, tools, model, and isolated context", async () => {
    const harness = await makeHarness(multiTurnConfig({ model: "test/refiner", thinking: "high" }));
    harness.models = [{ provider: "test", id: "refiner", name: "Refiner", api: "fake" }];

    await harness.runCommand("materia", "cast refine a plan");
    harness.appendAssistantMessage("draft response");
    await harness.emit("agent_end", { messages: [] });

    const triggeredTurnsBeforeRefinement = harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn).length;
    const inputResults = await harness.emit("input", { text: "refine this plan", source: "interactive" });
    expect(inputResults.at(-1)).toEqual({ action: "continue" });
    expect(harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toHaveLength(triggeredTurnsBeforeRefinement);
    const afterInputState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(afterInputState.nodeState).toBe("awaiting_user_refinement");
    expect(afterInputState.awaitingResponse).toBe(false);

    harness.activeTools = ["read", "grep", "find", "ls", "bash", "edit", "write"];
    const beforeResults = await harness.emit("before_agent_start", { systemPrompt: "Base system" });
    const refinementTurnState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(refinementTurnState.nodeState).toBe("awaiting_agent_response");
    expect(refinementTurnState.awaitingResponse).toBe(true);
    expect((beforeResults.at(-1) as any).systemPrompt).toContain("Materia active role (plan):\nCollaborative planner");
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
    expect(synthetic).toContain("Current node: plan");
    expect(synthetic).toContain("Current role: Plan");
    expect(synthetic).toContain("Artifact directory:");
    expect(synthetic).toContain("Previous output:\ndraft response");
    expect(synthetic).toContain("Mode: multi-turn refinement (awaiting_agent_response)");
    expect(JSON.stringify(isolated)).not.toContain("unrelated earlier transcript");
    expect(JSON.stringify(isolated)).toContain("refine this plan");
  });

  test("status and command help do not instruct users to run /materia continue", async () => {
    const harness = await makeHarness(multiTurnConfig());
    expect(harness.commands.get("materia")?.description).not.toContain("/materia continue");
    expect(harness.commands.get("materia")?.description).not.toContain("continue");

    await harness.runCommand("materia", "cast refine a plan");
    harness.appendAssistantMessage("draft response");
    await harness.emit("agent_end", { messages: [] });

    await harness.runCommand("materia", "status");
    const statusText = (harness.widgets.get("materia-status")?.content ?? []).join("\n");
    expect(statusText).toContain("say you are ready to continue/finalize");
    expect(statusText).not.toContain("/materia continue");

    await harness.runCommand("materia", "unknown");
    expect(harness.notifications.at(-1)?.message).toContain("Usage:");
    expect(harness.notifications.at(-1)?.message).not.toContain("/materia continue");
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
    const inputResults = await harness.emit("input", { text: "ready to continue", source: "interactive" });
    expect(inputResults.at(-1)).toEqual({ action: "handled" });

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
    expect(usage.tokens.total).toBe(26);
    expect(usage.turns).toHaveLength(2);
    expect(usage.modelSelections.length).toBeGreaterThanOrEqual(2);
  });

  test("natural-language readiness finalizes the latest multi-turn assistant output", async () => {
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
    expect(inputResults.at(-1)).toEqual({ action: "handled" });
    const completeState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(completeState.active).toBe(false);
    expect(completeState.nodeState).toBe("complete");
    expect(completeState.data.tasks).toEqual([{ id: "1", title: "Ship it" }]);

    const castDir = path.join(harness.cwd, ".pi", "pi-materia", completeState.castId);
    const manifest = JSON.parse(await readFile(path.join(castDir, "manifest.json"), "utf8"));
    const artifacts = manifest.entries.map((entry: any) => entry.artifact).filter(Boolean);
    expect(artifacts.some((artifact: string) => artifact.includes(".refinement-"))).toBe(true);
    expect(artifacts).toContain(path.join("nodes", "plan", "1.md"));
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
    await harness.emit("input", { text: "ready to continue", source: "interactive" });

    const state = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(state.active).toBe(true);
    expect(state.currentNode).toBe("build");
    expect(state.nodeState).toBe("awaiting_agent_response");
    expect(state.data.tasks).toEqual([{ id: "1", title: "Ship it" }]);
    expect(state.lastJson).toEqual({ tasks: [{ id: "1", title: "Ship it" }] });

    const castDir = path.join(harness.cwd, ".pi", "pi-materia", state.castId);
    expect(await readFile(path.join(castDir, "nodes", "plan", "1.md"), "utf8")).toBe(finalJson);
    expect(JSON.parse(await readFile(path.join(castDir, "nodes", "plan", "1.json"), "utf8"))).toEqual({ tasks: [{ id: "1", title: "Ship it" }] });

    const manifest = JSON.parse(await readFile(path.join(castDir, "manifest.json"), "utf8"));
    const nodeOutput = manifest.entries.find((entry: any) => entry.kind === "node_output" && entry.node === "plan");
    expect(nodeOutput.artifact).toBe(path.join("nodes", "plan", "1.md"));
    expect(nodeOutput.finalized).toBe(true);
    expect(nodeOutput.refinementTurn).toBe(2);

    const events = (await readFile(path.join(castDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const completeEvent = events.find((event: any) => event.type === "node_complete" && event.data.node === "plan");
    expect(completeEvent.data.artifact).toBe(path.join("nodes", "plan", "1.md"));
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
    await harness.emit("input", { text: "continue", source: "interactive" });

    const state = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(state.active).toBe(true);
    expect(state.currentNode).toBe("build");
    expect(state.data.summary).toBe(finalText);
    expect(state.lastJson).toBeUndefined();

    const castDir = path.join(harness.cwd, ".pi", "pi-materia", state.castId);
    expect(await readFile(path.join(castDir, "nodes", "plan", "1.md"), "utf8")).toBe(finalText);
    const manifest = JSON.parse(await readFile(path.join(castDir, "manifest.json"), "utf8"));
    const nodeOutput = manifest.entries.find((entry: any) => entry.kind === "node_output" && entry.node === "plan");
    expect(nodeOutput.artifact).toBe(path.join("nodes", "plan", "1.md"));
    expect(nodeOutput.finalized).toBe(true);
    expect(nodeOutput.kind).toBe("node_output");

    const buildPrompt = harness.sentMessages.at(-1)?.message as any;
    expect(buildPrompt.content).toContain("Summary=Final text plan");
    expect(buildPrompt.content).toContain("Last=Final text plan");
  });
});
