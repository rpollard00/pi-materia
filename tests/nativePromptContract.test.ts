import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import piMateria from "../src/index.js";
import { HANDOFF_CONTRACT_PROMPT_TEXT } from "../src/handoffContract.js";
import { FakePiHarness } from "./fakePi.js";

async function makeHarness(config: unknown): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-prompt-contract-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(config, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

function promptMessages(harness: FakePiHarness): string[] {
  return harness.sentMessages
    .map(({ message }) => message as { customType?: string; content?: unknown })
    .filter((message) => message.customType === "pi-materia-prompt")
    .map((message) => String(message.content));
}

describe("native JSON prompt handoff contract guidance", () => {
  test("appends the central handoff contract to single-turn JSON agent nodes", async () => {
    const harness = await makeHarness({
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Test",
      loadouts: {
        Test: {
          entry: "check",
          nodes: {
            check: { type: "agent", materia: "Check", parse: "json" },
          },
        },
      },
      materia: {
        Check: { tools: "readOnly", prompt: "Return { \"satisfied\": true }." },
      },
    });

    await harness.runCommand("materia", "cast verify contract injection");

    const [prompt] = promptMessages(harness);
    expect(prompt).toContain("Return { \"satisfied\": true }.");
    expect(prompt).toContain(HANDOFF_CONTRACT_PROMPT_TEXT);
    expect(prompt).toContain("generic handoff envelope");
    expect(prompt).toContain("emit generated work units as workItems");
    expect(prompt).toContain("Preserve and augment useful existing envelope context");
    expect(prompt).toContain('"satisfied" is the canonical boolean control field');
    expect(prompt).toContain('Legacy names such as "passed" are not canonical handoff fields');
  });

  test("does not append JSON handoff contract guidance to plain-text agent nodes", async () => {
    const harness = await makeHarness({
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Test",
      loadouts: {
        Test: {
          entry: "speak",
          nodes: {
            speak: { type: "agent", materia: "Speak" },
          },
        },
      },
      materia: {
        Speak: { tools: "readOnly", prompt: "Respond in prose." },
      },
    });

    await harness.runCommand("materia", "cast plain output");

    const [prompt] = promptMessages(harness);
    expect(prompt).toContain("Respond in prose.");
    expect(prompt).not.toContain(HANDOFF_CONTRACT_PROMPT_TEXT);
  });
});
