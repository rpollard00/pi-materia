import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { FakePiHarness } from "./fakePi.js";

async function makeHarness(config: unknown): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-model-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(config, null, 2));
  const harness = new FakePiHarness(cwd);
  harness.models = [
    { provider: "anthropic", id: "claude-test", name: "Claude Test", api: "anthropic" },
    { provider: "openai", id: "gpt-test", name: "GPT Test", api: "openai" },
  ];
  piMateria(harness.pi);
  return harness;
}

function agentConfig(role: Record<string, unknown> = {}, node: Record<string, unknown> = {}) {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: { Test: { entry: "agent", nodes: { agent: { type: "agent", role: "Build", ...node } } } },
    roles: { Build: { tools: "coding", systemPrompt: "Build role", ...role } },
  };
}

function twoAgentConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "build",
        nodes: {
          build: { type: "agent", role: "Build", next: "review" },
          review: { type: "agent", role: "Review" },
        },
      },
    },
    roles: {
      Build: { tools: "coding", systemPrompt: "Build role", model: "anthropic/claude-test", thinking: "high" },
      Review: { tools: "readOnly", systemPrompt: "Review role", model: "openai/gpt-test", thinking: "low" },
    },
  };
}

describe("native per-role model settings", () => {
  test("omitted model and thinking preserve the active Pi model without switching", async () => {
    const harness = await makeHarness(agentConfig());

    await harness.runCommand("materia", "cast no explicit model");

    expect(harness.setModelCalls).toHaveLength(0);
    expect(harness.setThinkingLevelCalls).toHaveLength(0);
    expect(harness.sentMessages.some(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toBe(true);
  });

  test("cast state distinguishes awaiting agent response and completed states", async () => {
    const harness = await makeHarness(agentConfig());

    await harness.runCommand("materia", "cast state model");
    const activeState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as { active?: boolean; awaitingResponse?: boolean; nodeState?: string; phase?: string };
    expect(activeState.active).toBe(true);
    expect(activeState.awaitingResponse).toBe(true);
    expect(activeState.nodeState).toBe("awaiting_agent_response");

    harness.appendAssistantMessage("done");
    await harness.emit("agent_end", { messages: [] });
    const completeState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as { active?: boolean; awaitingResponse?: boolean; nodeState?: string; phase?: string };
    expect(completeState.active).toBe(false);
    expect(completeState.awaitingResponse).toBe(false);
    expect(completeState.nodeState).toBe("complete");
    expect(completeState.phase).toBe("complete");
  });

  test("explicit role model and thinking are applied before tools and agent turn", async () => {
    const harness = await makeHarness(agentConfig({ model: "anthropic/claude-test", thinking: "high" }));

    await harness.runCommand("materia", "cast explicit model");

    expect(harness.setModelCalls).toEqual([{ provider: "anthropic", id: "claude-test", name: "Claude Test", api: "anthropic" }]);
    expect(harness.setThinkingLevelCalls).toEqual(["high"]);
    expect(harness.operationLog.indexOf("setModel")).toBeLessThan(harness.operationLog.indexOf("setActiveTools"));
    expect(harness.operationLog.indexOf("setThinkingLevel")).toBeLessThan(harness.operationLog.indexOf("setActiveTools"));
    expect(harness.operationLog.indexOf("setActiveTools")).toBeLessThan(harness.operationLog.indexOf("triggerTurn"));
  });

  test("different roles apply different model settings across one cast", async () => {
    const harness = await makeHarness(twoAgentConfig());

    await harness.runCommand("materia", "cast mixed role models");
    harness.appendAssistantMessage("build complete");
    await harness.emit("agent_end", { messages: [] });

    expect(harness.setModelCalls).toEqual([
      { provider: "anthropic", id: "claude-test", name: "Claude Test", api: "anthropic" },
      { provider: "openai", id: "gpt-test", name: "GPT Test", api: "openai" },
    ]);
    expect(harness.setThinkingLevelCalls).toEqual(["high", "low"]);
    expect(harness.operationLog).toEqual([
      "setModel",
      "setThinkingLevel",
      "setActiveTools",
      "triggerTurn",
      "setModel",
      "setThinkingLevel",
      "setActiveTools",
      "triggerTurn",
    ]);
    const rolePromptMessages = harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn);
    expect(rolePromptMessages).toHaveLength(2);
  });

  test("unsupported model switching APIs fail with a role-specific diagnostic", async () => {
    const harness = await makeHarness(agentConfig({ model: "anthropic/claude-test" }));
    delete (harness.pi as unknown as { setModel?: unknown }).setModel;

    await harness.runCommand("materia", "cast unsupported model api");

    expect(harness.setModelCalls).toHaveLength(0);
    expect(harness.sentMessages.some(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toBe(false);
    expect(harness.notifications.at(-1)).toEqual({
      message: 'pi-materia cast failed to start: Role "Build" model setting is unsupported: this Pi runtime does not expose pi.setModel(model)',
      type: "error",
    });
  });

  test("records effective role model settings in context, manifest, events, and usage", async () => {
    const harness = await makeHarness(agentConfig({ model: "anthropic/claude-test", thinking: "high" }));

    await harness.runCommand("materia", "cast record model metadata");
    harness.appendAssistantMessage("done", {
      usage: { input: 3, output: 4, totalTokens: 7, cost: { total: 0.01 } },
      model: { provider: "anthropic", id: "claude-test", api: "anthropic" },
      thinkingLevel: "high",
    });
    await harness.emit("agent_end", { messages: [] });

    const castDir = path.join(harness.cwd, ".pi", "pi-materia", (await readdir(path.join(harness.cwd, ".pi", "pi-materia")))[0]);
    const context = await readFile(path.join(castDir, "contexts", "agent-1.md"), "utf8");
    expect(context).toContain("model: anthropic/claude-test");
    expect(context).toContain("thinking: high");
    const manifest = JSON.parse(await readFile(path.join(castDir, "manifest.json"), "utf8"));
    expect(manifest.entries.some((entry: any) => entry.roleModel?.model === "claude-test" && entry.roleModel?.thinking === "high")).toBe(true);
    const events = (await readFile(path.join(castDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.some((event) => event.type === "role_model_settings" && event.data.roleModel.model === "claude-test")).toBe(true);
    const usage = JSON.parse(await readFile(path.join(castDir, "usage.json"), "utf8"));
    expect(usage.tokens.total).toBe(7);
    expect(usage.modelSelections[0]).toMatchObject({ node: "agent", role: "Build", model: "claude-test", provider: "anthropic", api: "anthropic", thinking: "high" });
    expect(usage.turns[0]).toMatchObject({ node: "agent", role: "Build", model: "claude-test", provider: "anthropic", api: "anthropic", thinking: "high" });
  });

  test("fallback model metadata is labeled as the active Pi model", async () => {
    const harness = await makeHarness(agentConfig());
    harness.activeModel = { provider: "openai", id: "gpt-test", name: "GPT Test", api: "openai" };
    (harness.ctx as unknown as { model: unknown }).model = harness.activeModel;

    await harness.runCommand("materia", "cast fallback model metadata");

    const castDir = path.join(harness.cwd, ".pi", "pi-materia", (await readdir(path.join(harness.cwd, ".pi", "pi-materia")))[0]);
    const context = await readFile(path.join(castDir, "contexts", "agent-1.md"), "utf8");
    expect(context).toContain("model: openai/gpt-test");
    expect(context).toContain("model source: active Pi model fallback");
    const events = (await readFile(path.join(castDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.some((event) => event.type === "role_model_settings" && event.data.roleModel.source === "active" && event.data.roleModel.label === "openai/gpt-test")).toBe(true);
  });

  test("utility nodes do not apply role model settings", async () => {
    const harness = await makeHarness({
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Test",
      loadouts: { Test: { entry: "utility", nodes: { utility: { type: "utility", utility: "echo", params: { text: "done" } } } } },
      roles: { Build: { tools: "coding", systemPrompt: "Build role", model: "anthropic/claude-test", thinking: "high" } },
    });

    await harness.runCommand("materia", "cast utility only");

    expect(harness.setModelCalls).toHaveLength(0);
    expect(harness.setThinkingLevelCalls).toHaveLength(0);
    expect(harness.operationLog).not.toContain("setActiveTools");
    expect(harness.sentMessages.some(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toBe(false);
  });
});
