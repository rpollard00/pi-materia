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

function agentQuestConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Build" } } },
    },
    materia: {
      Build: { type: "agent", tools: "none", prompt: "Build {{request}}" },
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
    const questCompletions = harness.getCommandCompletions("materia", "quest ")?.map((completion) => completion.value);
    expect(questCompletions).toContain("quest add");
    expect(questCompletions).toContain("quest runonce");
  });

  test("status shows board details and does not wait for idle", async () => {
    const harness = await makeHarness();
    harness.idle = false;

    await harness.runCommand("materia", "quest status");

    expect(harness.waitForIdleCalls).toBe(0);
    expect(latestMateriaMessage(harness)).toContain("pi-materia quest board");
    expect(latestMateriaMessage(harness)).toContain("Runner: stopped");
    expect(latestMateriaMessage(harness)).toContain("Storage:");
    expect(latestMateriaMessage(harness)).toContain("Commands: /materia quest add");
    expect(latestMateriaMessage(harness)).toContain("runonce launches one pending quest only");
  });

  test("adds a pending quest with optional loadout override", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "quest add --loadout Other Implement the thing");

    const board = await readBoard(harness);
    expect(board.quests).toHaveLength(1);
    expect(board.quests[0]).toMatchObject({ title: "Implement the thing", prompt: "Implement the thing", status: "pending", loadoutOverride: "Other" });
    expect(latestMateriaMessage(harness)).toContain("Added quest");
  });

  test("run enables the runner and launches the next quest after waiting for idle", async () => {
    const harness = await makeHarness();
    await harness.runCommand("materia", "quest add Build this feature");
    const waitsBeforeRun = harness.waitForIdleCalls;

    await harness.runCommand("materia", "quest run");

    const board = await readBoard(harness);
    expect(harness.waitForIdleCalls).toBe(waitsBeforeRun + 1);
    expect(board.runner.enabled).toBe(true);
    expect(board.quests[0].attempts).toBe(1);
    expect(board.quests[0].lastCastId).toBeTruthy();
    expect(latestMateriaMessage(harness)).toContain("Started continuous quest runner and launched");
    expect(latestMateriaMessage(harness)).toContain("Mode: continuous run");
  });

  test("run drains immediate quests back to back while runner remains enabled", async () => {
    const harness = await makeHarness();
    await harness.runCommand("materia", "quest add First immediate quest");
    const seededBoard = await readBoard(harness);
    seededBoard.quests.push({ ...seededBoard.quests[0], id: "quest-second", title: "Second immediate quest", prompt: "Second immediate quest" });
    await writeFile(path.join(harness.cwd, ".pi", "pi-materia", "quest-board.json"), JSON.stringify(seededBoard, null, 2));

    await harness.runCommand("materia", "quest run");

    const board = await readBoard(harness);
    expect(board.runner.enabled).toBe(true);
    expect(board.quests.map((quest: any) => quest.status)).toEqual(["succeeded", "succeeded"]);
    expect(board.quests.map((quest: any) => quest.attempts)).toEqual([1, 1]);
    expect(harness.notifications.some((notification) => notification.message.includes("auto-launched"))).toBe(true);
  });

  test("run with no pending quests enables runner and reports waiting", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "quest run");

    const board = await readBoard(harness);
    expect(board.runner.enabled).toBe(true);
    expect(harness.notifications.some((notification) => notification.type === "info" && notification.message.includes("quest runner enabled and waiting"))).toBe(true);
  });

  test("adding a quest wakes an enabled idle runner", async () => {
    const harness = await makeHarness();
    await harness.runCommand("materia", "quest run");

    await harness.runCommand("materia", "quest add Wake the runner");

    const board = await readBoard(harness);
    expect(board.runner.enabled).toBe(true);
    expect(board.quests[0]).toMatchObject({ status: "succeeded", attempts: 1 });
    expect(harness.notifications.some((notification) => notification.message.includes("auto-launched"))).toBe(true);
  });

  test("runonce with no pending quests reports unavailable without enabling runner", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "quest runonce");

    const board = await readBoard(harness);
    expect(board.runner.enabled).toBe(false);
    expect(harness.notifications.some((notification) => notification.type === "error" && notification.message.includes("quest board is empty"))).toBe(true);
  });

  test("runonce launches exactly one quest without changing runner state", async () => {
    const harness = await makeHarness();
    await harness.runCommand("materia", "quest add Build this feature");
    const seededBoard = await readBoard(harness);
    seededBoard.quests.push({ ...seededBoard.quests[0], id: "quest-second", title: "Second pending quest", prompt: "Second pending quest" });
    await writeFile(path.join(harness.cwd, ".pi", "pi-materia", "quest-board.json"), JSON.stringify(seededBoard, null, 2));
    const waitsBeforeRun = harness.waitForIdleCalls;

    await harness.runCommand("materia", "quest runonce");

    const board = await readBoard(harness);
    expect(harness.waitForIdleCalls).toBe(waitsBeforeRun + 1);
    expect(board.runner.enabled).toBe(false);
    expect(board.quests.map((quest: any) => quest.status)).toEqual(["succeeded", "pending"]);
    expect(board.quests.map((quest: any) => quest.attempts)).toEqual([1, 0]);
    expect(board.quests[0].lastCastId).toBeTruthy();
    expect(board.quests[1].lastCastId).toBeUndefined();
    expect(latestMateriaMessage(harness)).toContain("Launched quest");
  });

  test("stop disables continuous runner without aborting active quest cast or launching later pending quests", async () => {
    const harness = await makeHarness(agentQuestConfig());
    await harness.runCommand("materia", "quest add First active quest");
    const seededBoard = await readBoard(harness);
    seededBoard.quests.push({ ...seededBoard.quests[0], id: "quest-second", title: "Second pending quest", prompt: "Second pending quest" });
    await writeFile(path.join(harness.cwd, ".pi", "pi-materia", "quest-board.json"), JSON.stringify(seededBoard, null, 2));

    await harness.runCommand("materia", "quest run");
    let board = await readBoard(harness);
    expect(board.runner.enabled).toBe(true);
    expect(board.quests.map((quest: any) => quest.status)).toEqual(["running", "pending"]);
    expect(harness.operationLog).toContain("triggerTurn");
    const waitsBeforeStop = harness.waitForIdleCalls;

    await harness.runCommand("materia", "quest stop");

    board = await readBoard(harness);
    expect(harness.waitForIdleCalls).toBe(waitsBeforeStop);
    expect(board.runner.enabled).toBe(false);
    expect(board.quests.map((quest: any) => quest.status)).toEqual(["running", "pending"]);
    expect(harness.operationLog).not.toContain("abort");

    harness.appendAssistantMessage("done");
    await harness.emit("agent_end", { messages: [] });

    board = await readBoard(harness);
    expect(board.runner.enabled).toBe(false);
    expect(board.quests.map((quest: any) => quest.status)).toEqual(["succeeded", "pending"]);
    expect(board.quests.map((quest: any) => quest.attempts)).toEqual([1, 0]);
    expect(harness.operationLog.filter((operation) => operation === "triggerTurn")).toHaveLength(1);
    expect(harness.operationLog).not.toContain("abort");
  });

  test("start enables runner after waiting for idle and stop disables it without waiting", async () => {
    const harness = await makeHarness();
    await harness.runCommand("materia", "quest add Build this feature");
    const waitsBeforeStart = harness.waitForIdleCalls;
    await harness.runCommand("materia", "quest start");
    expect(harness.waitForIdleCalls).toBe(waitsBeforeStart + 1);
    expect(latestMateriaMessage(harness)).toContain("start alias");
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

    await harness.runCommand("materia", "quest runonce");
    await harness.runCommand("materia", "quest add --loadout");
    await harness.runCommand("materia", "quest add --loadout Missing Build with missing loadout");
    await harness.runCommand("materia", "quest run missing-id");
    await harness.runCommand("materia", "quest wat");

    const errors = harness.notifications.filter((notification) => notification.type === "error").map((notification) => notification.message);
    expect(errors.some((message) => message.includes("quest board is empty"))).toBe(true);
    expect(errors.some((message) => message.includes("Usage: /materia quest add"))).toBe(true);
    expect(errors.some((message) => message.includes('Unknown Materia loadout override "Missing"'))).toBe(true);
    expect(errors.some((message) => message.includes("No pending pi-materia quest found with id missing-id"))).toBe(true);
    expect(errors.some((message) => message.includes("/materia quest runonce [id]"))).toBe(true);
  });

  test("reports no pending quests after a one-shot utility quest completes", async () => {
    const harness = await makeHarness();
    await harness.runCommand("materia", "quest add Build once");
    await harness.runCommand("materia", "quest runonce");

    await harness.runCommand("materia", "quest runonce");

    const board = await readBoard(harness);
    expect(board.quests[0].status).toBe("succeeded");
    const errors = harness.notifications.filter((notification) => notification.type === "error").map((notification) => notification.message);
    expect(errors.some((message) => message.includes("No pending pi-materia quests"))).toBe(true);
  });
});
