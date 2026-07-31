import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { MATERIA_PRESENTATION_ENTRY_TYPE } from "../src/presentation/materiaPresentation.js";
import type { MateriaCastState } from "../src/types.js";
import { FakePiHarness } from "./fakePi.js";

async function makeHarness(): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-budget-command-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify({
    artifactDir: ".pi/pi-materia",
    budget: { maxTokens: 100 },
    activeLoadout: "Test",
    loadouts: { Test: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Build" } } } },
    materia: { Build: { type: "agent", tools: "none", prompt: "Build the request." } },
  }, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

function latestState(harness: FakePiHarness): MateriaCastState {
  const entry = harness.appendedEntries.filter((item) => item.customType === "pi-materia-cast-state").at(-1);
  if (!entry?.data) throw new Error("No cast state was appended");
  return entry.data as MateriaCastState;
}

function latestBudgetPresentation(harness: FakePiHarness): string {
  const entry = harness.appendedEntries
    .filter((candidate) => candidate.customType === MATERIA_PRESENTATION_ENTRY_TYPE)
    .map((candidate) => candidate.data as { content?: unknown; details?: { prefix?: string } })
    .filter((candidate) => candidate.details?.prefix === "budget")
    .at(-1);
  return String(entry?.content ?? "");
}

function materiaMessages(harness: FakePiHarness): unknown[] {
  return harness.sentMessages
    .map(({ message }) => message as { customType?: string })
    .filter((message) => message.customType === "pi-materia");
}

describe("/materia budget command", () => {
  test("is discoverable and query/update are non-blocking for an active cast", async () => {
    const harness = await makeHarness();
    const command = harness.commands.get("materia");
    expect(command?.description).toContain("/materia budget [<tokens>]");
    expect(harness.getCommandCompletions("materia", "bud")?.map((completion) => completion.value)).toContain("budget");

    await harness.runCommand("materia", "cast active budget cast");
    const started = latestState(harness);
    const consumed = structuredClone(started) as MateriaCastState;
    consumed.runState.usage.tokens.total = 12;
    harness.pi.appendEntry("pi-materia-cast-state", consumed);

    harness.idle = false;
    const waitsBefore = harness.waitForIdleCalls;
    const materiaMessagesBeforeQuery = materiaMessages(harness).length;
    const triggerTurnsBeforeQuery = harness.operationLog.filter((operation) => operation === "triggerTurn").length;
    await harness.runCommand("materia", "budget");
    expect(harness.waitForIdleCalls).toBe(waitsBefore);
    expect(harness.operationLog.filter((operation) => operation === "triggerTurn").length).toBe(triggerTurnsBeforeQuery);
    expect(latestBudgetPresentation(harness)).toContain(`cast id: ${started.castId}`);
    expect(latestBudgetPresentation(harness)).toContain("consumed tokens: 12");
    expect(latestBudgetPresentation(harness)).toContain("current token limit: 100");
    expect(materiaMessages(harness)).toHaveLength(materiaMessagesBeforeQuery);

    const triggerTurnsBefore = harness.operationLog.filter((operation) => operation === "triggerTurn").length;
    const materiaMessagesBeforeUpdate = materiaMessages(harness).length;
    await harness.runCommand("materia", "budget 150");
    expect(harness.waitForIdleCalls).toBe(waitsBefore);
    expect(latestBudgetPresentation(harness)).toContain("pi-materia budget updated.");
    expect(latestBudgetPresentation(harness)).toContain("current token limit: 150");
    expect(materiaMessages(harness)).toHaveLength(materiaMessagesBeforeUpdate);
    expect(harness.operationLog.filter((operation) => operation === "triggerTurn").length).toBe(triggerTurnsBefore);
  });

  test("updates the latest resumable cast without recasting it", async () => {
    const harness = await makeHarness();
    await harness.runCommand("materia", "cast resumable budget cast");
    const running = latestState(harness);
    const failed = structuredClone(running) as MateriaCastState;
    failed.active = false;
    failed.awaitingResponse = false;
    failed.phase = "failed";
    failed.socketState = "failed";
    failed.failedReason = "test failure";
    failed.runState.usage.tokens.total = 20;
    harness.pi.appendEntry("pi-materia-cast-state", failed);

    const triggerTurnsBefore = harness.operationLog.filter((operation) => operation === "triggerTurn").length;
    const materiaMessagesBeforeUpdate = materiaMessages(harness).length;
    await harness.runCommand("materia", "budget 25");
    expect(latestBudgetPresentation(harness)).toContain(`cast id: ${running.castId}`);
    expect(latestBudgetPresentation(harness)).toContain("current token limit: 25");
    expect(materiaMessages(harness)).toHaveLength(materiaMessagesBeforeUpdate);
    expect(harness.operationLog.filter((operation) => operation === "triggerTurn").length).toBe(triggerTurnsBefore);

    const resolvedConfig = JSON.parse(await readFile(path.join(failed.runDir, "config.resolved.json"), "utf8")) as { budget?: { maxTokens?: number } };
    expect(resolvedConfig.budget?.maxTokens).toBe(25);

    await harness.runCommand("materia", `recast ${running.castId}`);
    expect(latestState(harness).active).toBe(true);
    const recastConfig = JSON.parse(await readFile(path.join(failed.runDir, "config.resolved.json"), "utf8")) as { budget?: { maxTokens?: number } };
    expect(recastConfig.budget?.maxTokens).toBe(25);
  });

  test("reports no-cast and validation errors without mutation", async () => {
    const empty = await makeHarness();
    empty.idle = false;
    await empty.runCommand("materia", "budget");
    expect(empty.waitForIdleCalls).toBe(0);
    expect(empty.notifications.at(-1)).toMatchObject({ type: "error" });
    expect(empty.notifications.at(-1)?.message).toContain("No active or resumable");

    const harness = await makeHarness();
    await harness.runCommand("materia", "cast validate budget");
    const running = latestState(harness);
    const consumed = structuredClone(running) as MateriaCastState;
    consumed.runState.usage.tokens.total = 40;
    harness.pi.appendEntry("pi-materia-cast-state", consumed);
    const stateCountBefore = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").length;
    const configBefore = await readFile(path.join(running.runDir, "config.resolved.json"), "utf8");

    await harness.runCommand("materia", "budget 39");
    expect(harness.notifications.at(-1)?.message).toContain("cannot be lower than the 40 consumed tokens");
    expect(harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state")).toHaveLength(stateCountBefore);
    expect(await readFile(path.join(running.runDir, "config.resolved.json"), "utf8")).toBe(configBefore);

    await harness.runCommand("materia", "budget 40.5");
    expect(harness.notifications.at(-1)?.message).toContain("non-negative safe whole number");
  });
});
