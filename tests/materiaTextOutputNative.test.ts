import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import piMateria from "../src/index.js";
import { FakePiHarness } from "./fakePi.js";
import { MATERIA_TEXT_OUTPUT_EVENT_TYPE } from "../src/presentation/textOutput.js";

interface PiMateriaMessage {
  customType?: string;
  content?: string | unknown[];
  display?: boolean;
  details?: Record<string, unknown>;
}

function narrateConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "Socket-1",
        sockets: {
          "Socket-1": {
            materia: "Narrate",
            parse: "json",
            assign: { narration: "$.text" },
            edges: [{ when: "always", to: "end" }],
          },
        },
      },
    },
    materia: {
      Narrate: { type: "agent", label: "Narrate", tools: "none", prompt: "Narrate {{request}}" },
    },
  };
}

async function makeHarness(config: unknown): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-text-output-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(config, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

function materiaTextMessages(harness: FakePiHarness): PiMateriaMessage[] {
  return harness.sentMessages
    .map(({ message }) => message as PiMateriaMessage)
    .filter((message) => message.customType === "pi-materia" && message.details?.eventType === MATERIA_TEXT_OUTPUT_EVENT_TYPE);
}

describe("materia text output native rendering", () => {
  test("emits a clean prose display message for JSON text payloads", async () => {
    const harness = await makeHarness(narrateConfig());

    await harness.runCommand("materia", "cast describe the change");
    harness.appendAssistantMessage(
      JSON.stringify({
        workItems: [{ title: "feat: x", context: "implementation notes" }],
        satisfied: true,
        context: "internal handoff context",
        text: "## Summary\n\nClean narration prose for the user.   ",
      }),
      { usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.01 } } },
    );
    await harness.emit("agent_end", { messages: [] });

    const textMessages = materiaTextMessages(harness);
    expect(textMessages).toHaveLength(1);
    const message = textMessages[0];
    expect(message?.display).toBe(true);
    // Only the prose is rendered; transport metadata is hidden.
    expect(message?.content).toBe("## Summary\n\nClean narration prose for the user.");
    expect(message?.details).toMatchObject({
      prefix: "materia",
      eventType: MATERIA_TEXT_OUTPUT_EVENT_TYPE,
      socketId: "Socket-1",
      materiaName: "Narrate",
      socketOrdinal: 1,
    });
    expect(JSON.stringify(message?.content)).not.toContain("implementation notes");
    expect(JSON.stringify(message?.details)).not.toContain("internal handoff context");
  });

  test("does not emit a text-output message when no text payload is present", async () => {
    const harness = await makeHarness(narrateConfig());

    await harness.runCommand("materia", "cast describe the change");
    harness.appendAssistantMessage(
      JSON.stringify({ satisfied: true, context: "no narration here" }),
      { usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.01 } } },
    );
    await harness.emit("agent_end", { messages: [] });

    expect(materiaTextMessages(harness)).toHaveLength(0);
  });

  test("keeps the authoritative text payload available for downstream materia without mirroring it into envelope state", async () => {
    const harness = await makeHarness(narrateConfig());

    await harness.runCommand("materia", "cast describe the change");
    harness.appendAssistantMessage(
      JSON.stringify({ satisfied: true, text: "Authoritative narration payload." }),
      { usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.01 } } },
    );
    await harness.emit("agent_end", { messages: [] });

    // Rendering is a one-way presentation layer: the raw parsed payload remains
    // the authoritative source (kept in lastJson for replay/debugging and to
    // drive rendering), but renderable text is NOT mirrored into durable
    // envelope state. Downstream materia consume it via explicit assignment.
    const castStates = harness.appendedEntries
      .filter((entry) => entry.customType === "pi-materia-cast-state")
      .map((entry) => entry.data as { lastJson?: { text?: unknown }; data?: { envelope?: Record<string, unknown> } });
    const latest = castStates[castStates.length - 1];
    expect(latest?.lastJson).toMatchObject({ text: "Authoritative narration payload." });
    expect(latest?.data?.envelope).not.toHaveProperty("text");

    expect(materiaTextMessages(harness)).toHaveLength(1);
    expect(materiaTextMessages(harness)[0]?.content).toBe("Authoritative narration payload.");
  });
});
