import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { FakePiHarness } from "./fakePi.js";

async function makeHarness(config: unknown): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-attempt-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(config, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

async function readUsage(harness: FakePiHarness): Promise<any> {
  const castRoot = path.join(harness.cwd, ".pi", "pi-materia");
  const castDir = path.join(castRoot, (await readdir(castRoot))[0]);
  return JSON.parse(await readFile(path.join(castDir, "usage.json"), "utf8"));
}

function attemptConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "Socket-1",
        nodes: {
          "Socket-1": {
            type: "utility",
            utility: "echo",
            parse: "json",
            params: { output: { items: [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta" }] } },
            assign: { items: "$.items" },
            next: "Socket-2",
          },
          "Socket-2": {
            type: "agent",
            materia: "Build",
            parse: "json",
            foreach: { items: "state.items", as: "workItem", cursor: "itemCursor", done: "Socket-3" },
            advance: { cursor: "itemCursor", items: "state.items", when: "$.done == true", done: "Socket-3" },
            next: "Socket-2",
            limits: { maxVisits: 5 },
          },
          "Socket-3": { type: "agent", materia: "Build" },
        },
      },
    },
    materia: { Build: { tools: "coding", prompt: "Build materia" } },
  };
}

describe("native attempt identity", () => {
  test("attempts are per exact node and foreach item task", async () => {
    const harness = await makeHarness(attemptConfig());

    await harness.runCommand("materia", "cast attempt semantics");

    harness.appendAssistantMessage('{"done":false}', { usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.01 } } });
    await harness.emit("agent_end", { messages: [] });

    harness.appendAssistantMessage('{"done":true}', { usage: { input: 2, output: 1, totalTokens: 3, cost: { total: 0.02 } } });
    await harness.emit("agent_end", { messages: [] });

    harness.appendAssistantMessage('{"done":true}', { usage: { input: 3, output: 1, totalTokens: 4, cost: { total: 0.03 } } });
    await harness.emit("agent_end", { messages: [] });

    harness.appendAssistantMessage("review complete", { usage: { input: 4, output: 1, totalTokens: 5, cost: { total: 0.04 } } });
    await harness.emit("agent_end", { messages: [] });

    const usage = await readUsage(harness);
    expect(usage.turns.map((turn: { node: string; taskId?: string; attempt?: number }) => ({ node: turn.node, taskId: turn.taskId, attempt: turn.attempt }))).toEqual([
      { node: "Socket-2", taskId: "a", attempt: 1 },
      { node: "Socket-2", taskId: "a", attempt: 2 },
      { node: "Socket-2", taskId: "b", attempt: 1 },
      { node: "Socket-3", taskId: undefined, attempt: 1 },
    ]);
    expect(Object.keys(usage.byAttempt).sort()).toEqual(["a:1", "a:2", "b:1"]);
  });
});
