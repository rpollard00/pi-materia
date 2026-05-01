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

function multiTurnConfig(role: Record<string, unknown> = {}) {
  return {
    artifactDir: ".pi/pi-materia",
    pipeline: {
      entry: "plan",
      nodes: {
        plan: { type: "agent", role: "Plan", multiTurn: true, parse: "json", assign: { tasks: "$.tasks" } },
      },
    },
    roles: { Plan: { tools: "readOnly", systemPrompt: "Collaborative planner", ...role } },
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

    const inputResults = await harness.emit("input", { text: "refine this plan", source: "interactive" });
    expect(inputResults.at(-1)).toEqual({ action: "continue" });

    harness.activeTools = ["read", "grep", "find", "ls", "bash", "edit", "write"];
    const beforeResults = await harness.emit("before_agent_start", { systemPrompt: "Base system" });
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
});
