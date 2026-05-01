import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
    pipeline: { entry: "agent", nodes: { agent: { type: "agent", role: "Build", ...node } } },
    roles: { Build: { tools: "coding", systemPrompt: "Build role", ...role } },
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

  test("explicit role model and thinking are applied before tools and agent turn", async () => {
    const harness = await makeHarness(agentConfig({ model: "anthropic/claude-test", thinking: "high" }));

    await harness.runCommand("materia", "cast explicit model");

    expect(harness.setModelCalls).toEqual([{ provider: "anthropic", id: "claude-test", name: "Claude Test", api: "anthropic" }]);
    expect(harness.setThinkingLevelCalls).toEqual(["high"]);
    expect(harness.operationLog.indexOf("setModel")).toBeLessThan(harness.operationLog.indexOf("setActiveTools"));
    expect(harness.operationLog.indexOf("setThinkingLevel")).toBeLessThan(harness.operationLog.indexOf("setActiveTools"));
    expect(harness.operationLog.indexOf("setActiveTools")).toBeLessThan(harness.operationLog.indexOf("triggerTurn"));
  });

  test("utility nodes do not apply role model settings", async () => {
    const harness = await makeHarness({
      artifactDir: ".pi/pi-materia",
      pipeline: { entry: "utility", nodes: { utility: { type: "utility", utility: "echo", params: { text: "done" } } } },
      roles: { Build: { tools: "coding", systemPrompt: "Build role", model: "anthropic/claude-test", thinking: "high" } },
    });

    await harness.runCommand("materia", "cast utility only");

    expect(harness.setModelCalls).toHaveLength(0);
    expect(harness.setThinkingLevelCalls).toHaveLength(0);
    expect(harness.operationLog).not.toContain("setActiveTools");
    expect(harness.sentMessages.some(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toBe(false);
  });
});
