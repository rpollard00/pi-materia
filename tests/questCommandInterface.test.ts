import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import piMateria from "../src/index.js";
import { FakePiHarness } from "./fakePi.js";

async function makeHarness(config: unknown = questConfig()): Promise<FakePiHarness> {
  process.env.PI_MATERIA_PROFILE_DIR = await mkdtemp(path.join(tmpdir(), "pi-materia-quest-profile-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-quest-command-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(config, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

function questConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Done" } } },
      Other: { entry: "Socket-1", sockets: { "Socket-1": { materia: "OtherDone" } } },
    },
    materia: {
      Done: { type: "utility", utility: "echo", params: { text: "done" } },
      OtherDone: { type: "utility", utility: "echo", params: { text: "other" } },
    },
  };
}

function latestMateriaMessage(harness: FakePiHarness): string {
  const messages = harness.sentMessages.map(({ message }) => message as { customType?: string; content?: unknown }).filter((message) => message.customType === "pi-materia");
  return String(messages.at(-1)?.content ?? "");
}

async function readBoard(harness: FakePiHarness): Promise<any> {
  return JSON.parse(await readFile(path.join(harness.cwd, ".pi", "pi-materia", "quest-board.json"), "utf8"));
}

describe("/materia quest command interface", () => {
  test("registers quest in description and completions", async () => {
    const harness = await makeHarness();
    const command = harness.commands.get("materia");

    expect(command?.description).toContain("quest");
    expect(harness.getCommandCompletions("materia", "q")?.map((completion) => completion.value)).toContain("quest");
    expect(harness.getCommandCompletions("materia", "quest ")?.map((completion) => completion.value)).toContain("quest add");
  });

  test("status shows board details and does not wait for idle", async () => {
    const harness = await makeHarness();
    harness.idle = false;

    await harness.runCommand("materia", "quest status");

    expect(harness.waitForIdleCalls).toBe(0);
    expect(latestMateriaMessage(harness)).toContain("pi-materia quest board");
    expect(latestMateriaMessage(harness)).toContain("Runner: stopped");
    expect(latestMateriaMessage(harness)).toContain("Storage:");
    expect(latestMateriaMessage(harness)).toContain("Help: /materia quest add");
  });

  test("adds a pending quest with optional loadout override", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "quest add --loadout Other Implement the thing");

    const board = await readBoard(harness);
    expect(board.quests).toHaveLength(1);
    expect(board.quests[0]).toMatchObject({ title: "Implement the thing", prompt: "Implement the thing", status: "pending", loadoutOverride: "Other" });
    expect(latestMateriaMessage(harness)).toContain("Added quest");
  });

  test("run launches the next quest once without enabling the runner after waiting for idle", async () => {
    const harness = await makeHarness();
    await harness.runCommand("materia", "quest add Build this feature");
    const waitsBeforeRun = harness.waitForIdleCalls;

    await harness.runCommand("materia", "quest run");

    const board = await readBoard(harness);
    expect(harness.waitForIdleCalls).toBe(waitsBeforeRun + 1);
    expect(board.runner.enabled).toBe(false);
    expect(board.quests[0].attempts).toBe(1);
    expect(board.quests[0].lastCastId).toBeTruthy();
    expect(latestMateriaMessage(harness)).toContain("Launched quest");
  });

  test("start enables runner after waiting for idle and stop disables it without waiting", async () => {
    const harness = await makeHarness();
    await harness.runCommand("materia", "quest add Build this feature");
    const waitsBeforeStart = harness.waitForIdleCalls;
    await harness.runCommand("materia", "quest start");
    expect(harness.waitForIdleCalls).toBe(waitsBeforeStart + 1);
    harness.idle = false;
    const waitsBeforeStop = harness.waitForIdleCalls;

    await harness.runCommand("materia", "quest stop");

    const board = await readBoard(harness);
    expect(board.runner.enabled).toBe(false);
    expect(harness.waitForIdleCalls).toBe(waitsBeforeStop);
    expect(harness.operationLog).not.toContain("abort");
    expect(latestMateriaMessage(harness)).toContain("Active casts are not aborted");
  });

  test("run and start do not launch quests when waiting for idle fails", async () => {
    const runHarness = await makeHarness();
    await runHarness.runCommand("materia", "quest add Build while busy");
    runHarness.idle = false;
    runHarness.waitForIdleError = new Error("session is busy");

    await expect(runHarness.runCommand("materia", "quest run")).rejects.toThrow("session is busy");
    let board = await readBoard(runHarness);
    expect(runHarness.waitForIdleCalls).toBe(2);
    expect(board.quests[0]).toMatchObject({ status: "pending", attempts: 0 });
    expect(runHarness.operationLog).not.toContain("triggerTurn");

    const startHarness = await makeHarness();
    await startHarness.runCommand("materia", "quest add Build while busy");
    startHarness.idle = false;
    startHarness.waitForIdleError = new Error("session is busy");

    await expect(startHarness.runCommand("materia", "quest start")).rejects.toThrow("session is busy");
    board = await readBoard(startHarness);
    expect(startHarness.waitForIdleCalls).toBe(2);
    expect(board.runner.enabled).toBe(false);
    expect(board.quests[0]).toMatchObject({ status: "pending", attempts: 0 });
    expect(startHarness.operationLog).not.toContain("triggerTurn");
  });

  test("reports clear quest command errors", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "quest run");
    await harness.runCommand("materia", "quest add --loadout");
    await harness.runCommand("materia", "quest add --loadout Missing Build with missing loadout");
    await harness.runCommand("materia", "quest run missing-id");

    const errors = harness.notifications.filter((notification) => notification.type === "error").map((notification) => notification.message);
    expect(errors.some((message) => message.includes("quest board is empty"))).toBe(true);
    expect(errors.some((message) => message.includes("Usage: /materia quest add"))).toBe(true);
    expect(errors.some((message) => message.includes('Unknown Materia loadout override "Missing"'))).toBe(true);
    expect(errors.some((message) => message.includes("No pending pi-materia quest found with id missing-id"))).toBe(true);
  });

  test("reports no pending quests after a one-shot utility quest completes", async () => {
    const harness = await makeHarness();
    await harness.runCommand("materia", "quest add Build once");
    await harness.runCommand("materia", "quest run");

    await harness.runCommand("materia", "quest run");

    const board = await readBoard(harness);
    expect(board.quests[0].status).toBe("succeeded");
    const errors = harness.notifications.filter((notification) => notification.type === "error").map((notification) => notification.message);
    expect(errors.some((message) => message.includes("No pending pi-materia quests"))).toBe(true);
  });
});
