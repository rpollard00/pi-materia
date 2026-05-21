import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { FakePiHarness } from "./fakePi.js";

const previousProfileDir = process.env.PI_MATERIA_PROFILE_DIR;

afterEach(() => {
  if (previousProfileDir === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
  else process.env.PI_MATERIA_PROFILE_DIR = previousProfileDir;
});

async function makeHarness(config: unknown): Promise<FakePiHarness> {
  process.env.PI_MATERIA_PROFILE_DIR = await mkdtemp(path.join(tmpdir(), "pi-materia-model-profile-"));
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

function agentConfig(overrides: Record<string, unknown> = {}, socket: Record<string, unknown> = {}) {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: { Test: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Build", ...socket } } } },
    materia: { Build: { tools: "coding", prompt: "Build materia", ...overrides } },
  };
}

async function readCastFile(harness: FakePiHarness, relativePath: string): Promise<string> {
  const castRoot = path.join(harness.cwd, ".pi", "pi-materia");
  const castDir = path.join(castRoot, (await readdir(castRoot))[0]);
  return readFile(path.join(castDir, relativePath), "utf8");
}

async function readUsage(harness: FakePiHarness): Promise<any> {
  return JSON.parse(await readCastFile(harness, "usage.json"));
}

async function flushDeferredDispatch(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function twoAgentConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "Socket-1",
        sockets: {
          "Socket-1": { materia: "Build", edges: [{ when: 'always', to: 'Socket-2' }] },
          "Socket-2": { materia: "Review" },
        },
      },
    },
    materia: {
      Build: { tools: "coding", prompt: "Build materia", model: "anthropic/claude-test", thinking: "high" },
      Review: { tools: "readOnly", prompt: "Review materia", model: "openai/gpt-test", thinking: "low" },
    },
  };
}

describe("native per-materia model settings", () => {
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
    const activeState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as { active?: boolean; awaitingResponse?: boolean; socketState?: string; phase?: string };
    expect(activeState.active).toBe(true);
    expect(activeState.awaitingResponse).toBe(true);
    expect(activeState.socketState).toBe("awaiting_agent_response");

    harness.appendAssistantMessage("done");
    await harness.emit("agent_end", { messages: [] });
    const completeState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as { active?: boolean; awaitingResponse?: boolean; socketState?: string; phase?: string };
    expect(completeState.active).toBe(false);
    expect(completeState.awaitingResponse).toBe(false);
    expect(completeState.socketState).toBe("complete");
    expect(completeState.phase).toBe("complete");
  });

  test("explicit materia model and thinking are applied before tools and agent turn", async () => {
    const harness = await makeHarness(agentConfig({ model: "anthropic/claude-test", thinking: "high" }));

    await harness.runCommand("materia", "cast explicit model");

    expect(harness.setModelCalls).toEqual([{ provider: "anthropic", id: "claude-test", name: "Claude Test", api: "anthropic" }]);
    expect(harness.setThinkingLevelCalls).toEqual(["high"]);
    expect(harness.operationLog.indexOf("setModel")).toBeLessThan(harness.operationLog.indexOf("setActiveTools"));
    expect(harness.operationLog.indexOf("setThinkingLevel")).toBeLessThan(harness.operationLog.indexOf("setActiveTools"));
    expect(harness.operationLog.indexOf("setActiveTools")).toBeLessThan(harness.operationLog.indexOf("triggerTurn"));
    expect(harness.notifications.some((notification) => notification.type === "warning")).toBe(false);
    const usage = await readUsage(harness);
    expect(usage.modelSelections[0]).toMatchObject({
      requestedModel: "anthropic/claude-test",
      requestedThinking: "high",
      effectiveModel: "anthropic/claude-test",
      effectiveThinking: "high",
      model: "claude-test",
      provider: "anthropic",
      thinking: "high",
      source: "configured",
    });
    expect(usage.modelSelections[0].fallbackReason).toBeUndefined();
  });

  test("different materia apply different model settings across one cast", async () => {
    const harness = await makeHarness(twoAgentConfig());

    await harness.runCommand("materia", "cast mixed materia models");
    harness.appendAssistantMessage("build complete");
    await harness.emit("agent_end", { messages: [] });
    await flushDeferredDispatch();

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
    const materiaPromptMessages = harness.sentMessages.filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn);
    expect(materiaPromptMessages).toHaveLength(2);
  });

  test("unsupported model switching APIs fail with a materia-specific diagnostic", async () => {
    const harness = await makeHarness(agentConfig({ model: "anthropic/claude-test" }));
    delete (harness.pi as unknown as { setModel?: unknown }).setModel;

    await harness.runCommand("materia", "cast unsupported model api");

    expect(harness.setModelCalls).toHaveLength(0);
    expect(harness.sentMessages.some(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toBe(false);
    expect(harness.notifications.at(-1)).toEqual({
      message: 'pi-materia cast failed to start: Materia "Build" model setting is unsupported: this Pi runtime does not expose pi.setModel(model)',
      type: "error",
    });
  });

  test("records effective materia model settings in context, manifest, events, and usage", async () => {
    const harness = await makeHarness(agentConfig({ model: "anthropic/claude-test", thinking: "high" }));

    await harness.runCommand("materia", "cast record model metadata");
    harness.appendAssistantMessage("done", {
      usage: { input: 3, output: 4, totalTokens: 7, cost: { total: 0.01 } },
      model: { provider: "anthropic", id: "claude-test", api: "anthropic" },
      thinkingLevel: "high",
    });
    await harness.emit("agent_end", { messages: [] });

    const castDir = path.join(harness.cwd, ".pi", "pi-materia", (await readdir(path.join(harness.cwd, ".pi", "pi-materia")))[0]);
    const context = await readFile(path.join(castDir, "contexts", "Socket-1-1.md"), "utf8");
    expect(context).toContain("model: anthropic/claude-test");
    expect(context).toContain("thinking: high");
    const manifest = JSON.parse(await readFile(path.join(castDir, "manifest.json"), "utf8"));
    expect(manifest.entries.some((entry: any) => entry.materiaModel?.model === "claude-test" && entry.materiaModel?.thinking === "high")).toBe(true);
    const events = (await readFile(path.join(castDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.some((event) => event.type === "materia_model_settings" && event.data.materiaModel.model === "claude-test")).toBe(true);
    const usage = JSON.parse(await readFile(path.join(castDir, "usage.json"), "utf8"));
    expect(usage.tokens.total).toBe(7);
    expect(usage.modelSelections[0]).toMatchObject({ socket: "Socket-1", materia: "Build", model: "claude-test", provider: "anthropic", api: "anthropic", thinking: "high" });
    expect(usage.turns[0]).toMatchObject({ socket: "Socket-1", materia: "Build", model: "claude-test", provider: "anthropic", api: "anthropic", thinking: "high" });
  });

  test("fallback model metadata is labeled as the active Pi model", async () => {
    const harness = await makeHarness(agentConfig());
    harness.activeModel = { provider: "openai", id: "gpt-test", name: "GPT Test", api: "openai" };
    (harness.ctx as unknown as { model: unknown }).model = harness.activeModel;

    await harness.runCommand("materia", "cast fallback model metadata");

    const castDir = path.join(harness.cwd, ".pi", "pi-materia", (await readdir(path.join(harness.cwd, ".pi", "pi-materia")))[0]);
    const context = await readFile(path.join(castDir, "contexts", "Socket-1-1.md"), "utf8");
    expect(context).toContain("model: openai/gpt-test");
    expect(context).toContain("model source: active Pi model fallback");
    const events = (await readFile(path.join(castDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.some((event) => event.type === "materia_model_settings" && event.data.materiaModel.source === "active" && event.data.materiaModel.label === "openai/gpt-test")).toBe(true);
  });

  test("blank model override uses the active Pi model without warning or switching", async () => {
    const harness = await makeHarness(agentConfig({ model: "   " }));
    harness.activeModel = { provider: "openai", id: "gpt-test", name: "GPT Test", api: "openai" };
    (harness.ctx as unknown as { model: unknown }).model = harness.activeModel;

    await harness.runCommand("materia", "cast blank model override");

    expect(harness.setModelCalls).toHaveLength(0);
    expect(harness.notifications.some((notification) => notification.type === "warning")).toBe(false);
    const usage = await readUsage(harness);
    expect(usage.modelSelections[0]).toMatchObject({ model: "gpt-test", provider: "openai", source: "active" });
    expect(usage.modelSelections[0].requestedModel).toBeUndefined();
  });

  test("unknown configured model warns and falls back to the active Pi model", async () => {
    const harness = await makeHarness(agentConfig({ model: "unknown/nope" }));
    harness.activeModel = { provider: "openai", id: "gpt-test", name: "GPT Test", api: "openai" };
    (harness.ctx as unknown as { model: unknown }).model = harness.activeModel;

    await harness.runCommand("materia", "cast unknown model fallback");

    expect(harness.setModelCalls).toHaveLength(0);
    expect(harness.sentMessages.some(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toBe(true);
    expect(harness.notifications.some((notification) => notification.type === "warning" && notification.message.includes('configured model "unknown/nope"') && notification.message.includes("using the active Pi session model (openai/gpt-test)"))).toBe(true);
    const usage = await readUsage(harness);
    expect(usage.modelSelections[0]).toMatchObject({ requestedModel: "unknown/nope", model: "gpt-test", provider: "openai", effectiveModel: "openai/gpt-test", modelFallbackReason: "unknown_model", fallbackReason: "unknown_model", source: "active" });
    const context = await readCastFile(harness, "contexts/Socket-1-1.md");
    expect(context).toContain('model source: active Pi model fallback (configured model "unknown/nope" unavailable: unknown_model)');
  });

  test("credential-missing configured model warns and falls back without failing the cast", async () => {
    const harness = await makeHarness(agentConfig({ model: "anthropic/claude-test" }));
    harness.activeModel = { provider: "openai", id: "gpt-test", name: "GPT Test", api: "openai" };
    (harness.ctx as unknown as { model: unknown }).model = harness.activeModel;
    (harness.pi as unknown as { setModel: (model: unknown) => Promise<boolean> }).setModel = async (model: unknown) => {
      harness.operationLog.push("setModel");
      harness.setModelCalls.push(model);
      return false;
    };

    await harness.runCommand("materia", "cast credential fallback");

    expect(harness.setModelCalls).toEqual([{ provider: "anthropic", id: "claude-test", name: "Claude Test", api: "anthropic" }]);
    expect(harness.sentMessages.some(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toBe(true);
    expect(harness.notifications.some((notification) => notification.type === "warning" && notification.message.includes('configured model "anthropic/claude-test"') && notification.message.includes("no configured API key or credentials"))).toBe(true);
    const usage = await readUsage(harness);
    expect(usage.modelSelections[0]).toMatchObject({ requestedModel: "anthropic/claude-test", model: "gpt-test", provider: "openai", modelFallbackReason: "credentials_missing", fallbackReason: "credentials_missing", source: "active" });
  });

  test("unsupported configured thinking falls back to a supported thinking level", async () => {
    const harness = await makeHarness(agentConfig({ model: "local/no-think", thinking: "high" }));
    harness.models = [{ provider: "local", id: "no-think", name: "No Think", api: "openai", reasoning: false }];
    harness.thinkingLevel = "high";

    await harness.runCommand("materia", "cast unsupported thinking fallback");

    expect(harness.setModelCalls).toEqual([{ provider: "local", id: "no-think", name: "No Think", api: "openai", reasoning: false }]);
    expect(harness.setThinkingLevelCalls).toEqual(["off"]);
    expect(harness.notifications.some((notification) => notification.type === "warning" && notification.message.includes('configured thinking "high"') && notification.message.includes("using off instead"))).toBe(true);
    const usage = await readUsage(harness);
    expect(usage.modelSelections[0]).toMatchObject({ requestedThinking: "high", thinking: "off", thinkingFallbackReason: "unsupported_thinking", fallbackReason: "unsupported_thinking" });
    const context = await readCastFile(harness, "contexts/Socket-1-1.md");
    expect(context).toContain('thinking source: safe thinking fallback (configured thinking "high" unsupported: unsupported_thinking)');
  });

  test("utility sockets do not apply materia model settings", async () => {
    const harness = await makeHarness({
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Test",
      loadouts: { Test: { entry: "Socket-1", sockets: { "Socket-1": { utility: "echo", params: { text: "done" } } } } },
      materia: { Build: { tools: "coding", prompt: "Build materia", model: "anthropic/claude-test", thinking: "high" } },
    });

    await harness.runCommand("materia", "cast utility only");

    expect(harness.setModelCalls).toHaveLength(0);
    expect(harness.setThinkingLevelCalls).toHaveLength(0);
    expect(harness.operationLog).not.toContain("setActiveTools");
    expect(harness.sentMessages.some(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toBe(false);
  });
});
