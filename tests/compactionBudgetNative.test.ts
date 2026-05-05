import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { FakePiHarness } from "./fakePi.js";

async function makeHarness(config: unknown): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-budget-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(config, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

function singleAgentConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: { Test: { entry: "work", nodes: { work: { type: "agent", role: "Build", next: "end" } } } },
    roles: { Build: { tools: "coding", systemPrompt: "Build role prompt" } },
  };
}

describe("native compaction request budgeting audit", () => {
  test("pre-turn usage can be below threshold while isolated prompt/context add large request material", async () => {
    const harness = await makeHarness(singleAgentConfig());
    const largeGrepLikeOutput = [
      "grep /getArgumentCompletions/ in ~/.nvm/versions/node/v22.15.0/lib/node_modules/@mariozechner/pi-coding-agent (**/*.{ts,md}) limit 50",
      "dist/core/extensions/types.d.ts:772: getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;",
      "docs/extensions.md:1395: getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {",
      "x".repeat(50_000),
    ].join("\n");

    harness.contextUsage = { tokens: 20_789, contextWindow: 272_000, percent: (20_789 / 272_000) * 100 };
    await harness.runCommand("materia", `cast ${largeGrepLikeOutput}`);

    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);

    const hiddenPrompt = harness.sentMessages.map(({ message }) => message as any).find((message) => message.customType === "pi-materia-prompt")?.content as string;
    expect(hiddenPrompt.length).toBeGreaterThan(50_000);
    expect(hiddenPrompt).toContain("getArgumentCompletions");

    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    const contextResult = (await harness.emit("context", {
      messages: [
        { role: "user", content: [{ type: "text", text: "older unrelated transcript" }] },
        { role: "user", content: [{ type: "text", text: hiddenPrompt }] },
      ],
    })) as any[];
    const isolatedMessages = contextResult[0].messages as Array<{ role: string; content: string | Array<{ type: "text"; text: string }> }>;
    expect(isolatedMessages).toHaveLength(2);
    expect(isolatedMessages[0].role).toBe("user");
    expect(isolatedMessages[0].content as string).toContain("Materia isolated context.");
    expect(isolatedMessages[0].content as string).toContain("getArgumentCompletions");
    expect(JSON.stringify(latestState.request).length).toBeGreaterThan(50_000);

    const beforeStartResult = (await harness.emit("before_agent_start", { systemPrompt: "Base system prompt" })) as any[];
    expect(beforeStartResult[0].systemPrompt).toContain("Base system prompt");
    expect(beforeStartResult[0].systemPrompt).toContain("Materia active role (work)");

    const castRoot = path.join(harness.cwd, ".pi", "pi-materia");
    expect(await readdir(castRoot)).toHaveLength(1);
  });

  test("context isolation retains large active-turn tool results after a below-threshold usage snapshot", async () => {
    const harness = await makeHarness(singleAgentConfig());
    harness.contextUsage = { tokens: 20_789, contextWindow: 272_000, percent: (20_789 / 272_000) * 100 };

    await harness.runCommand("materia", "cast audit compaction with active tool output");
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);

    const hiddenPrompt = harness.sentMessages.map(({ message }) => message as any).find((message) => message.customType === "pi-materia-prompt")?.content as string;
    const largeToolResult = [
      "grep /getArgumentCompletions/ in ~/.nvm/versions/node/v22.15.0/lib/node_modules/@mariozechner/pi-coding-agent (**/*.{ts,md}) limit 50",
      "dist/core/extensions/types.d.ts:772: getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;",
      "docs/extensions.md:1395: getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {",
      "tool-result-body".repeat(4_000),
    ].join("\n");

    const contextResult = (await harness.emit("context", {
      messages: [
        { role: "user", content: [{ type: "text", text: "older unrelated transcript" }] },
        { role: "custom", customType: "pi-materia-prompt", content: hiddenPrompt, display: false },
        { role: "assistant", content: [{ type: "toolCall", name: "grep", arguments: { pattern: "getArgumentCompletions" } }] },
        { role: "toolResult", content: largeToolResult },
      ],
    })) as any[];

    const isolatedMessages = contextResult[0].messages as Array<{ role: string; content: unknown }>;
    expect(isolatedMessages).toHaveLength(4);
    expect(isolatedMessages[0].role).toBe("user");
    expect(isolatedMessages[0].content as string).toContain("Materia isolated context.");
    expect(isolatedMessages[1]).toMatchObject({ role: "custom", customType: "pi-materia-prompt" });
    expect(isolatedMessages[2].role).toBe("assistant");
    expect(isolatedMessages[3].role).toBe("toolResult");
    expect(isolatedMessages[3].content as string).toContain("getArgumentCompletions");
    expect((isolatedMessages[3].content as string).length).toBeGreaterThan(50_000);
  });
});
