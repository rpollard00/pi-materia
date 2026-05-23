import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import piMateria from "../src/index.js";
import { FakePiHarness } from "./fakePi.js";

async function makeHarness(config: unknown): Promise<FakePiHarness> {
  process.env.PI_MATERIA_PROFILE_DIR = await mkdtemp(path.join(tmpdir(), "pi-materia-prompt-profile-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-prompt-contract-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(config, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

async function makeDefaultHarness(): Promise<FakePiHarness> {
  process.env.PI_MATERIA_PROFILE_DIR = await mkdtemp(path.join(tmpdir(), "pi-materia-prompt-profile-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-default-prompt-contract-"));
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

async function flushDeferredDispatch(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function expectPromptIncludesConciseJsonFinalInstruction(prompt: string): void {
  expect(prompt).toContain("Final output format: Return only one top-level JSON object");
  expect(prompt).toContain("Emit only the fields relevant to this socket's configured placement, routing, and assignments");
  expect(prompt).not.toContain("pi-materia canonical handoff JSON contract:");
  expect(prompt).not.toContain('"tasks":');
  expect(prompt).not.toContain("tasks:");
}

function expectPromptOmitsJsonOnlyHandoffContract(prompt: string): void {
  expect(prompt).not.toContain("pi-materia canonical handoff JSON contract:");
  expect(prompt).not.toContain("pi-materia canonical handoff JSON contract");
  expect(prompt).not.toContain("generic handoff envelope");
  expect(prompt).not.toContain("Final output format: Return only one top-level JSON object");
  expect(prompt).not.toContain("Canonical handoff contract context:");
}

describe("native JSON prompt handoff contract guidance", () => {
  test("bundled default JSON materia receive the central handoff contract at prompt assembly time", async () => {
    const harness = await makeDefaultHarness();

    await harness.runCommand("materia", "cast verify bundled contract");

    const [prompt] = promptMessages(harness);
    expect(prompt).toContain("You are the pi-materia planning materia");
    expect(prompt).toContain("compact JSON containing only plan fields relevant to the socket");
    expectPromptIncludesConciseJsonFinalInstruction(prompt);
    expect(prompt).toContain("Final output format: Return only one top-level JSON object");
    expect(prompt).toContain("Emit top-level workItems");
  });

  test("injects current workItem and global guidance into plain-text agent socket prompts", async () => {
    const harness = await makeHarness({
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Test",
      loadouts: {
        Test: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": {
              materia: "Seed",
              edges: [{ when: "always", to: "Socket-2" }],
            },
            "Socket-2": { materia: "Build", parse: "text", foreach: { items: "state.workItems", as: "workItem", cursor: "workItemIndex", done: "end" } },
          },
        },
      },
      materia: {
        Seed: {
          type: "utility",
          utility: "echo",
          parse: "json",
          params: {
            output: {
              summary: "seeded plan",
              workItems: [{ id: "one", title: "One", description: "Do one", acceptance: ["done"], context: { architecture: "adapter owned", constraints: [], dependencies: [], risks: [] } }],
              guidance: { architecture: "reuse materia; sockets adapt placement" },
              decisions: [],
              risks: [],
              satisfied: true,
              feedback: "",
              missing: [],
            },
          },
        },
        Build: { tools: "readOnly", prompt: "Build prompt body." },
      },
    });

    await harness.runCommand("materia", "cast adapter context");

    const prompt = promptMessages(harness).at(-1) ?? "";
    expect(prompt).toContain("Build prompt body.");
    expect(prompt).toContain("Socket adapter context");
    expect(prompt).toContain("Current workItem JSON");
    expect(prompt).toContain('"id": "one"');
    expect(prompt).toContain("Global guidance JSON");
    expect(prompt).toContain("reuse materia; sockets adapt placement");
    expect(prompt).toContain("return a concise implementation summary");
  });

  test("generator-to-generator JSON prompts include canonical output requirements and upstream workItems", async () => {
    const harness = await makeHarness({
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Test",
      loadouts: {
        Test: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { materia: "Plan", parse: "json", assign: { workItems: "$.workItems" }, edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { materia: "Architect", parse: "json", assign: { workItems: "$.workItems" }, edges: [{ when: "always", to: "end" }] },
          },
        },
      },
      materia: {
        Plan: { tools: "readOnly", prompt: "Create initial work items.", generator: true },
        Architect: { tools: "readOnly", prompt: "Refine upstream work items.", generator: true },
      },
    });

    await harness.runCommand("materia", "cast chain generators");

    const firstPrompt = promptMessages(harness).at(-1) ?? "";
    expect(firstPrompt).toContain("Generator socket adapter context");
    expect(firstPrompt).toContain("generated-output stage");
    expect(firstPrompt).toContain("Return JSON only and expose generated output as workItems");
    expect(firstPrompt).toContain("expose generated output as workItems");
    expect(firstPrompt).toContain("must come from $.workItems");
    expect(firstPrompt).toContain("Emit top-level workItems");
    expect(firstPrompt).not.toContain("Reserved evaluator/route fields");
    expect(firstPrompt).not.toContain("Compatibility note: any legacy generates metadata is obsolete");
    expectPromptIncludesConciseJsonFinalInstruction(firstPrompt);

    harness.appendAssistantMessage(JSON.stringify({
      summary: "planned",
      workItems: [{ id: "api", title: "API", description: "Design API", acceptance: ["schema agreed"], context: { architecture: "upstream", constraints: [], dependencies: [], risks: [] } }],
      guidance: {},
      decisions: [],
      risks: [],
      satisfied: true,
      feedback: "",
      missing: [],
    }));
    await harness.emit("agent_end", { messages: [] });
    await flushDeferredDispatch();

    const secondPrompt = promptMessages(harness).at(-1) ?? "";
    expect(secondPrompt).toContain("Refine upstream work items.");
    expect(secondPrompt).toContain("Upstream generated workItems JSON for this generator stage");
    expect(secondPrompt).toContain('"id": "api"');
    expect(secondPrompt).toContain("transform/refine them into a new top-level workItems array");
    expect(secondPrompt).not.toContain("must still output another JSON-parsed canonical handoff envelope with workItems");
    expect(secondPrompt).not.toContain('"tasks":');
  });

  test("Yolo-style generator-to-generator loadouts normalize at cast start without Socket-2 validation failures", async () => {
    const harness = await makeHarness({
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Yolo",
      loadouts: {
        Yolo: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { materia: "Plan", edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { materia: "Architect", assign: { tasks: "$.tasks" }, edges: [{ when: "always", to: "end" }] },
          },
        },
      },
      materia: {
        Plan: { tools: "readOnly", prompt: "Create initial work items.", generator: true },
        Architect: { tools: "readOnly", prompt: "Consume and refine generated work items.", generator: true },
      },
    });

    await expect(harness.runCommand("materia", "cast yolo generator chain")).resolves.toBeUndefined();

    const firstPrompt = promptMessages(harness).at(-1) ?? "";
    expect(firstPrompt).toContain("Generator socket adapter context");
    expect(firstPrompt).toContain("expose generated output as workItems");
    expect(firstPrompt).toContain("must come from $.workItems");
    expect(firstPrompt).not.toContain("Generator pipeline slot \"Socket-2\"");
  });

  test("appends the central handoff contract to single-turn JSON agent sockets", async () => {
    const harness = await makeHarness({
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Test",
      loadouts: {
        Test: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { materia: "Check", parse: "json" },
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
    expectPromptIncludesConciseJsonFinalInstruction(prompt);
    expect(prompt).not.toContain("generic handoff envelope");
    expect(prompt).not.toContain("emit generated work units as workItems");
    expect(prompt).toContain("Emit only the fields relevant to this socket's configured placement, routing, and assignments");
    expect(prompt).not.toContain('"satisfied" is the canonical boolean control field');
  });

  test("injects the central handoff contract only on multi-turn JSON finalization", async () => {
    const harness = await makeHarness({
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Test",
      loadouts: {
        Test: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { materia: "Plan", parse: "json" },
          },
        },
      },
      materia: {
        Plan: { tools: "readOnly", prompt: "Plan collaboratively.", multiTurn: true },
      },
    });

    await harness.runCommand("materia", "cast refine before final JSON");

    const refinementPrompt = promptMessages(harness).at(-1) ?? "";
    expect(refinementPrompt).toContain("Plan collaboratively.");
    expect(refinementPrompt).toContain("Current multi-turn mode: refinement conversation");
    expect(refinementPrompt).toContain("do not emit final JSON");
    expectPromptOmitsJsonOnlyHandoffContract(refinementPrompt);

    harness.appendAssistantMessage("Let's refine the plan before finalizing.");
    await harness.emit("agent_end", { messages: [] });
    await harness.runCommand("materia", "continue");

    const finalizationPrompt = promptMessages(harness).at(-1) ?? "";
    expect(finalizationPrompt).toContain("Command-triggered finalization");
    expect(finalizationPrompt).toContain("Canonical handoff contract context:");
    expect(finalizationPrompt).toContain("Synthetic context exposure policy");
    expect(finalizationPrompt).toContain("Do not expose it during multi-turn refinement");
    expectPromptIncludesConciseJsonFinalInstruction(finalizationPrompt);
    expect(finalizationPrompt).toContain("Final output format: Return only one top-level JSON object");
    expect(finalizationPrompt).toContain("Generated units of work use workItems, not tasks");
  });

  test("does not append JSON handoff contract guidance to plain-text agent sockets", async () => {
    const harness = await makeHarness({
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Test",
      loadouts: {
        Test: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { materia: "Speak" },
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
    expectPromptOmitsJsonOnlyHandoffContract(prompt);
  });
});
