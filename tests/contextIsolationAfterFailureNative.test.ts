import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { FakePiHarness } from "./fakePi.js";

const STRUCTURED_PROVIDER_ERROR = 'Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"connection terminated"}}';

function buildaConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "Socket-4",
        sockets: {
          "Socket-4": { materia: "Builda", edges: [{ when: "always", to: "end" }] },
        },
      },
    },
    materia: { Builda: { tools: "coding", prompt: "Builda materia" } },
  };
}

async function makeHarness(): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-post-failure-context-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(buildaConfig(), null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

function latestState(harness: FakePiHarness): any {
  return harness.appendedEntries
    .filter((entry) => entry.customType === "pi-materia-cast-state")
    .at(-1)?.data as any;
}

function latestMateriaPrompt(harness: FakePiHarness): Record<string, unknown> {
  const message = harness.sentMessages
    .map(({ message }) => message as Record<string, unknown>)
    .filter((candidate) => candidate.customType === "pi-materia-prompt")
    .at(-1);
  if (!message) throw new Error("expected a pi-materia-prompt message");
  return { role: "custom", ...message };
}

async function isolatedContext(harness: FakePiHarness, messages: unknown[]): Promise<unknown[] | undefined> {
  const result = (await harness.emit("context", { messages })).at(-1) as { messages?: unknown[] } | undefined;
  return result?.messages;
}

describe("context isolation after turn failure", () => {
  test("terminated mid-Builda-turn preserves awaiting state and isolates Pi's retry", async () => {
    const harness = await makeHarness();
    await harness.runCommand("materia", "cast reproduce transport drop");
    const prompt = latestMateriaPrompt(harness);
    const rawMessages = [
      { role: "user", content: [{ type: "text", text: "large unrelated native transcript" }] },
      prompt,
      { role: "assistant", content: [{ type: "text", text: "partial Builda work" }] },
      { role: "toolResult", content: [{ type: "text", text: "isolated tool result" }] },
    ];

    const failedEntry = harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "terminated" });
    await harness.emit("agent_end", { messages: [] });

    const state = latestState(harness);
    expect(state.active).toBe(true);
    expect(state.awaitingResponse).toBe(true);
    expect(state.socketState).toBe("awaiting_agent_response");
    expect(state.currentSocketId).toBe("Socket-4");
    expect(state.currentMateria).toBe("Builda");
    expect(state.lastProcessedEntryId).toBe(failedEntry.id);
    expect(state.failedReason).toBeUndefined();

    const isolated = await isolatedContext(harness, rawMessages);
    expect(isolated).toBeDefined();
    const serialized = JSON.stringify(isolated);
    const guard = String((isolated as Array<{ content?: unknown }>)[0]?.content);
    expect(guard).toContain("Materia isolated context.");
    expect(guard).toContain("Original request: reproduce transport drop");
    expect(serialized).not.toContain("large unrelated native transcript");
    expect(serialized).toContain("pi-materia-prompt");
    expect(serialized).toContain("partial Builda work");
    expect(serialized).toContain("isolated tool result");
  });

  test("failed inactive casts retain prompt-anchored isolation but pass through after anchor compaction", async () => {
    const harness = await makeHarness();
    await harness.runCommand("materia", "cast fail without transcript fanout");
    const prompt = latestMateriaPrompt(harness);

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: STRUCTURED_PROVIDER_ERROR });
    await harness.emit("agent_end", { messages: [] });

    const state = latestState(harness);
    expect(state.active).toBe(false);
    expect(state.phase).toBe("failed");
    expect(state.socketState).toBe("failed");
    expect(state.failedReason).toContain("server_error");

    const rawMessages = [
      { role: "user", content: [{ type: "text", text: "entire unrelated native session" }] },
      prompt,
      { role: "assistant", content: [{ type: "text", text: "partial failed-turn work" }] },
      { role: "toolResult", content: [{ type: "text", text: "failed-turn tool result" }] },
      {
        role: "custom",
        customType: "pi-materia",
        content: "display-only failure card",
        display: true,
        details: { orchestration: true, prefix: "materia", eventType: "status" },
      },
    ];
    const isolated = await isolatedContext(harness, rawMessages);

    expect(isolated).toBeDefined();
    const serialized = JSON.stringify(isolated);
    const guard = String((isolated as Array<{ content?: unknown }>)[0]?.content);
    expect(guard).toContain("Materia isolated context.");
    expect(guard).toContain("Do not rely on unrelated earlier visible transcript messages.");
    expect(guard).not.toContain("Original request:");
    expect(serialized).not.toContain("entire unrelated native session");
    expect(serialized).not.toContain("display-only failure card");
    expect(serialized).toContain("pi-materia-prompt");
    expect(serialized).toContain("partial failed-turn work");
    expect(serialized).toContain("failed-turn tool result");

    const compactedWithoutAnchor = [
      { role: "user", content: [{ type: "text", text: "compacted conversation" }] },
      { role: "assistant", content: [{ type: "text", text: "compacted summary" }] },
    ];
    expect(await isolatedContext(harness, compactedWithoutAnchor)).toBeUndefined();
  });

  test("completed casts pass through even while their materia prompt remains in the transcript", async () => {
    const harness = await makeHarness();
    await harness.runCommand("materia", "cast complete normally");
    const prompt = latestMateriaPrompt(harness);

    harness.appendAssistantMessage("Builda complete");
    await harness.emit("agent_end", { messages: [] });

    const state = latestState(harness);
    expect(state.active).toBe(false);
    expect(state.phase).toBe("complete");
    expect(state.socketState).toBe("complete");

    const messages = [
      { role: "user", content: [{ type: "text", text: "ordinary conversation" }] },
      prompt,
      { role: "assistant", content: [{ type: "text", text: "Builda complete" }] },
    ];
    expect(await isolatedContext(harness, messages)).toBeUndefined();
  });
});
