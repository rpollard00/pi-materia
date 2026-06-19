import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import piMateria from "../src/index.js";
import type { MateriaCastState } from "../src/types.js";
import { FakePiHarness } from "./fakePi.js";
import { MATERIA_TEXT_OUTPUT_EVENT_TYPE } from "../src/presentation/textOutput.js";

const previousProfileDir = process.env.PI_MATERIA_PROFILE_DIR;

afterEach(() => {
  if (previousProfileDir === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
  else process.env.PI_MATERIA_PROFILE_DIR = previousProfileDir;
});

/**
 * Two-socket loadout that exercises the renderable text handoff flow end to
 * end: Narrate emits structured renderable text, the TUI renderer shows it as
 * clean prose, and PR-Notes consumes the raw payload via a dedicated explicit
 * assignment (`assign: { narration: "$.text" }`).
 */
function textConsumptionConfig() {
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
            edges: [{ when: "always", to: "Socket-2" }],
          },
          "Socket-2": { materia: "PR-Notes", parse: "json" },
        },
      },
    },
    materia: {
      Narrate: { type: "agent", tools: "readOnly", prompt: "Narrate {{request}}" },
      "PR-Notes": { type: "agent", tools: "readOnly", prompt: "Turn narration into PR notes.\n\nUpstream narration:\n{{state.narration}}" },
    },
  };
}

async function makeHarness(config: unknown): Promise<FakePiHarness> {
  process.env.PI_MATERIA_PROFILE_DIR = await mkdtemp(path.join(tmpdir(), "pi-materia-text-flow-profile-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-text-flow-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(config, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

async function flushDeferredDispatch(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

interface PiMateriaMessage {
  customType?: string;
  content?: string | unknown[];
  display?: boolean;
  details?: Record<string, unknown>;
}

function materiaTextMessages(harness: FakePiHarness): PiMateriaMessage[] {
  return harness.sentMessages
    .map(({ message }) => message as PiMateriaMessage)
    .filter((message) => message.customType === "pi-materia" && message.details?.eventType === MATERIA_TEXT_OUTPUT_EVENT_TYPE);
}

function promptMessages(harness: FakePiHarness): string[] {
  return harness.sentMessages
    .map(({ message }) => message as PiMateriaMessage)
    .filter((message) => message.customType === "pi-materia-prompt")
    .map((message) => String(message.content));
}

function castStates(harness: FakePiHarness): MateriaCastState[] {
  return harness.appendedEntries
    .filter((entry) => entry.customType === "pi-materia-cast-state")
    .map((entry) => entry.data as MateriaCastState);
}

function latestState(harness: FakePiHarness): MateriaCastState {
  const states = castStates(harness);
  const latest = states[states.length - 1];
  if (!latest) throw new Error("No materia cast state was appended");
  return latest;
}

const NARRATION_PROSE = "## Summary\n\nAdded the retry toggle and covered it with tests.";
// A raw payload with surrounding whitespace, used to prove the authoritative
// JSON is preserved verbatim while the TUI renderer normalizes for display.
const RAW_NARRATION = `  ${NARRATION_PROSE}  `;

describe("renderable text consumption flow", () => {
  test("a text-like materia emits structured text, the TUI renders it as prose, and a following materia consumes the raw payload via explicit assignment", async () => {
    const harness = await makeHarness(textConsumptionConfig());

    await harness.runCommand("materia", "cast add retry toggle");
    harness.appendAssistantMessage(
      JSON.stringify({ satisfied: true, context: "internal handoff notes only", text: NARRATION_PROSE }),
      { usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.01 } } },
    );
    await harness.emit("agent_end", { messages: [] });
    await flushDeferredDispatch();

    // 1. The TUI renderer surfaces the prose as a clean materia_text display
    //    message, hiding transport metadata (workItems/satisfied/context).
    const textMessages = materiaTextMessages(harness);
    expect(textMessages).toHaveLength(1);
    expect(textMessages[0]?.display).toBe(true);
    expect(textMessages[0]?.content).toBe(NARRATION_PROSE);
    expect(JSON.stringify(textMessages[0]?.details)).not.toContain("internal handoff notes only");

    // 2. The raw JSON remains authoritative for replay/debugging in lastJson,
    //    but renderable text is no longer mirrored into durable shared state:
    //    state.data.envelope has no text and nothing is accumulated under texts.
    const state = latestState(harness);
    expect(state.lastJson).toMatchObject({ text: NARRATION_PROSE });
    expect(state.data.envelope).not.toHaveProperty("text");
    expect(state.data.texts).toBeUndefined();

    // 3. The dedicated explicit assignment captures the raw payload into a
    //    named state slot so a following materia can consume it without
    //    hard-coding Narrate.
    expect(state.data.narration).toBe(NARRATION_PROSE);

    // 4. The following socket (PR-Notes) receives the resolved narration in its
    //    dispatched prompt via {{state.narration}} — the only durable handoff
    //    path for renderable text.
    const prompts = promptMessages(harness);
    expect(prompts).toHaveLength(2);
    const prNotesPrompt = prompts[1];
    expect(prNotesPrompt).toContain("Turn narration into PR notes");
    expect(prNotesPrompt).toContain(NARRATION_PROSE);

    // 5. Unassigned renderable text is not leaked into following prompts as a
    //    synthetic prior-text context section.
    expect(prNotesPrompt).not.toContain("Prior renderable text payloads:");
  });

  test("rendering is a one-way presentation layer that does not replace or mutate the underlying JSON handoff", async () => {
    const harness = await makeHarness(textConsumptionConfig());

    await harness.runCommand("materia", "cast add retry toggle");
    harness.appendAssistantMessage(
      JSON.stringify({ satisfied: true, context: "handoff context must survive rendering", text: RAW_NARRATION }),
      { usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.01 } } },
    );
    await harness.emit("agent_end", { messages: [] });

    const state = latestState(harness);
    const textMessages = materiaTextMessages(harness);

    // The authoritative parsed payload (state.lastJson) preserves the raw text
    // verbatim (including surrounding whitespace), while the rendered display
    // message normalizes it for presentation. They intentionally differ:
    // rendering is a one-way presentation layer and must not replace or mutate
    // the JSON handoff.
    expect(textMessages).toHaveLength(1);
    expect(state.lastJson).toMatchObject({ text: RAW_NARRATION });
    expect(textMessages[0]?.content).toBe(NARRATION_PROSE);
    expect(textMessages[0]?.content).not.toBe((state.lastJson as { text?: string }).text);

    // Renderable text is never mirrored into durable envelope state, and no
    // accumulation collection is populated.
    expect(state.data.envelope).not.toHaveProperty("text");
    expect(state.data.texts).toBeUndefined();

    // The agent's `context` handoff field is still mirrored (not overwritten by
    // the narration rendering), confirming rendering touches only presentation.
    expect(state.data.envelope?.context).toBe("handoff context must survive rendering");

    // No duplicate raw-text output: exactly one materia_text display message and
    // no second display emission of the prose as plain text.
    expect(materiaTextMessages(harness)).toHaveLength(1);
    const proseDisplays = harness.sentMessages
      .map(({ message }) => message as PiMateriaMessage)
      .filter((message) => message.customType === "pi-materia" && message.display === true && message.content === NARRATION_PROSE);
    expect(proseDisplays).toHaveLength(1);
  });

  test("sockets without a text payload render normally and expose no text state", async () => {
    const harness = await makeHarness(textConsumptionConfig());

    await harness.runCommand("materia", "cast no narration");
    harness.appendAssistantMessage(
      JSON.stringify({ satisfied: true, context: "no text payload here" }),
      { usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.01 } } },
    );
    await harness.emit("agent_end", { messages: [] });

    // No materia_text display message is emitted when there is no text payload.
    expect(materiaTextMessages(harness)).toHaveLength(0);

    const state = latestState(harness);
    // Renderable text is never mirrored into durable state or accumulated.
    expect(state.data.envelope).not.toHaveProperty("text");
    expect(state.data.texts).toBeUndefined();
  });
});
