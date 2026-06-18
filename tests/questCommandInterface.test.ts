import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import piMateria, { parseQuestListArgs, parseQuestMoveArgs } from "../src/index.js";
import { loadActiveCastState } from "../src/castRuntime.js";
import { findNextPendingQuest, type Quest, type QuestBoard, type QuestStatus } from "../src/domain/questBoard.js";
import { renderQuestList, renderQuestStatus, selectQuestList } from "../src/presentation/questBoard.js";
import { FakePiHarness, type FakePiHarnessOptions } from "./fakePi.js";

async function makeHarness(config: unknown = questConfig(), options: FakePiHarnessOptions = {}): Promise<FakePiHarness> {
  process.env.PI_MATERIA_PROFILE_DIR = await mkdtemp(path.join(tmpdir(), "pi-materia-quest-profile-"));
  await writeFile(path.join(process.env.PI_MATERIA_PROFILE_DIR, "config.json"), JSON.stringify({ questDefaultLoadoutId: null }, null, 2));
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-quest-command-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(config, null, 2));
  const harness = new FakePiHarness(cwd, options);
  piMateria(harness.pi);
  return harness;
}

function questConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    questDefaultLoadoutId: null,
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
    questDefaultLoadoutId: null,
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

function questCardSends(harness: FakePiHarness, eventType: string): Array<{ message: any; options?: any }> {
  return harness.sentMessages.filter(({ message }) => {
    const details = (message as any)?.details;
    return (message as any)?.customType === "pi-materia" && details?.prefix === "quest" && details?.eventType === eventType;
  });
}

async function flushDeferredDispatch(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function triggeredPromptMessages(harness: FakePiHarness): any[] {
  return harness.sentMessages
    .filter(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn === true)
    .map(({ message }) => message)
    .filter((message) => (message as { customType?: string }).customType === "pi-materia-prompt");
}

async function readBoard(harness: FakePiHarness): Promise<any> {
  return JSON.parse(await readFile(path.join(harness.cwd, ".pi", "pi-materia", "quest-board.json"), "utf8"));
}

function makeQuest(id: string, status: QuestStatus, title = id): Quest {
  const timestamp = "2026-05-19T00:00:00.000Z";
  return {
    id,
    title,
    prompt: title,
    status,
    createdAt: timestamp,
    updatedAt: timestamp,
    attempts: status === "pending" ? 0 : 1,
    ...(status === "running" ? { currentCastId: `cast-${id}`, lastCastId: `cast-${id}` } : {}),
    ...(status === "succeeded" || status === "failed" || status === "blocked" ? { lastCastId: `cast-${id}` } : {}),
  };
}

function makeQuestBoard(quests: Quest[]): QuestBoard {
  const runningQuest = quests.find((quest) => quest.status === "running");
  return {
    version: 1,
    createdAt: "2026-05-19T00:00:00.000Z",
    updatedAt: "2026-05-19T00:00:00.000Z",
    runner: { enabled: false, ...(runningQuest ? { activeQuestId: runningQuest.id } : {}) },
    quests,
  };
}

async function seedBoard(harness: FakePiHarness, quests: Quest[]): Promise<void> {
  const boardDir = path.join(harness.cwd, ".pi", "pi-materia");
  await mkdir(boardDir, { recursive: true });
  await writeFile(path.join(boardDir, "quest-board.json"), JSON.stringify(makeQuestBoard(quests), null, 2));
}

function listEntryLines(message: string): string[] {
  return message.split("\n").filter((line) => line.startsWith("- quest-"));
}

function expectQuestAddDidNotLaunch(harness: FakePiHarness, board: any): void {
  expect(board.runner.activeQuestId).toBeUndefined();
  expect(board.quests).toHaveLength(1);
  expect(board.quests[0]).toMatchObject({ status: "pending", attempts: 0 });
  expect(board.quests[0].currentCastId).toBeUndefined();
  expect(board.quests[0].lastCastId).toBeUndefined();
  expect(triggeredPromptMessages(harness)).toHaveLength(0);
  expect(harness.operationLog).not.toContain("triggerTurn");
  expect(harness.notifications.some((notification) => notification.message.includes("auto-launched"))).toBe(false);
  expect(latestMateriaMessage(harness)).not.toContain("Started continuous quest runner");
}

describe("/materia quest move parsing", () => {
  test("accepts exactly one placement option", () => {
    expect(parseQuestMoveArgs(["quest-a", "--first"])).toEqual({ ok: true, args: { questRef: "quest-a", placement: "first" } });
    expect(parseQuestMoveArgs(["abc", "--before", "def"])).toEqual({ ok: true, args: { questRef: "abc", placement: "before", targetRef: "def" } });
    expect(parseQuestMoveArgs(["abc", "--onto=def"])).toEqual({ ok: true, args: { questRef: "abc", placement: "after", targetRef: "def" } });
    expect(parseQuestMoveArgs(["abc", "--first", "--onto", "def"]).ok).toBe(false);
    expect(parseQuestMoveArgs(["abc", "--onto"]).ok).toBe(false);
    expect(parseQuestMoveArgs(["abc"]).ok).toBe(false);
  });
});

describe("/materia quest list parsing", () => {
  test("defaults to pending with limit 10", () => {
    expect(parseQuestListArgs([])).toEqual({ ok: true, args: { filter: "pending", limit: 10 } });
  });

  test("accepts explicit filters and limit forms", () => {
    expect(parseQuestListArgs(["pending"])).toEqual({ ok: true, args: { filter: "pending", limit: 10 } });
    expect(parseQuestListArgs(["all", "--limit", "25"])).toEqual({ ok: true, args: { filter: "all", limit: 25 } });
    expect(parseQuestListArgs(["--limit=3", "succeeded"])).toEqual({ ok: true, args: { filter: "succeeded", limit: 3 } });
    expect(parseQuestListArgs(["failed", "--limit=1"])).toEqual({ ok: true, args: { filter: "failed", limit: 1 } });
  });

  test("rejects unknown filters, unknown options, and invalid limits", () => {
    expect(parseQuestListArgs(["blocked"]).ok).toBe(false);
    expect(parseQuestListArgs(["--foo"]).ok).toBe(false);
    expect(parseQuestListArgs(["--limit", "0"]).ok).toBe(false);
    expect(parseQuestListArgs(["--limit=-1"]).ok).toBe(false);
    expect(parseQuestListArgs(["--limit", "1.5"]).ok).toBe(false);
    expect(parseQuestListArgs(["--limit", String(Number.MAX_SAFE_INTEGER + 1)]).ok).toBe(false);
  });
});

describe("quest list selection", () => {
  test("filters, limits, and orders pending quests using the next pending selector", () => {
    const board = makeQuestBoard([
      makeQuest("quest-succeeded", "succeeded", "Already done"),
      makeQuest("quest-next", "pending", "Next pending quest"),
      makeQuest("quest-later", "pending", "Later pending quest"),
      makeQuest("quest-failed", "failed", "Failed quest"),
      makeQuest("quest-blocked", "blocked", "Blocked quest"),
      makeQuest("quest-running", "running", "Running quest"),
    ]);

    const next = findNextPendingQuest(board);
    const pending = selectQuestList(board, { filter: "pending", limit: 10 });
    expect(next?.id).toBe("quest-next");
    expect(pending.quests.map((quest) => quest.id)).toEqual(["quest-next", "quest-later"]);
    expect(pending.quests[0]?.id).toBe(next?.id);
    expect(pending.totalMatchingCount).toBe(2);

    expect(selectQuestList(board, { filter: "pending", limit: 1 }).quests.map((quest) => quest.id)).toEqual(["quest-next"]);
    expect(selectQuestList(board, { filter: "all", limit: 10 }).quests.map((quest) => quest.status)).toEqual(["succeeded", "pending", "pending", "failed", "blocked", "running"]);
    expect(selectQuestList(board, { filter: "succeeded", limit: 10 }).quests.map((quest) => quest.id)).toEqual(["quest-succeeded"]);
    expect(selectQuestList(board, { filter: "failed", limit: 10 }).quests.map((quest) => quest.id)).toEqual(["quest-failed"]);
  });
});

describe("quest presentation", () => {
  test("status recent results prefer completion result cast over last cast", () => {
    const completed = {
      ...makeQuest("quest-done", "succeeded", "Completed quest"),
      lastCastId: "cast-started-before-retry",
      lastResult: {
        status: "succeeded" as const,
        castId: "cast-completed-result",
        finishedAt: "2026-05-19T00:30:00.000Z",
      },
      updatedAt: "2026-05-19T00:30:00.000Z",
    };
    const board = makeQuestBoard([completed]);

    const message = renderQuestStatus({ board, boardPath: "/tmp/quest-board.json", pendingCount: 0 }).join("\n");

    expect(message).toContain("Recent results:");
    expect(message).toContain("- quest-done [succeeded] Completed quest (cast cast-completed-result) at 2026-05-19T00:30:00.000Z");
    expect(message).not.toContain("cast-started-before-retry");
  });

  test("list summaries use current casts for running quests and result casts for terminal quests", () => {
    const running = {
      ...makeQuest("quest-running", "running", "Running quest"),
      currentCastId: "cast-current-running",
      lastCastId: "cast-previous-running",
    };
    const succeeded = {
      ...makeQuest("quest-succeeded", "succeeded", "Succeeded quest"),
      lastCastId: "cast-fallback-succeeded",
      lastResult: {
        status: "succeeded" as const,
        castId: "cast-result-succeeded",
        finishedAt: "2026-05-19T00:30:00.000Z",
      },
    };
    const failed = {
      ...makeQuest("quest-failed", "failed", "Failed quest"),
      lastCastId: "cast-fallback-failed",
      lastResult: {
        status: "failed" as const,
        castId: "cast-result-failed",
        finishedAt: "2026-05-19T00:40:00.000Z",
      },
    };
    const pending = makeQuest("quest-pending", "pending", "Pending quest");
    const board = makeQuestBoard([running, succeeded, failed, pending]);

    const allMessage = renderQuestList({ board, boardPath: "/tmp/quest-board.json", pendingCount: 1, activeQuest: running }, { filter: "all", limit: 10 }).join("\n");
    const succeededMessage = renderQuestList({ board, boardPath: "/tmp/quest-board.json", pendingCount: 1, activeQuest: running }, { filter: "succeeded", limit: 10 }).join("\n");

    expect(allMessage).toContain("- quest-running [running] Running quest (cast cast-current-running)");
    expect(allMessage).toContain("- quest-succeeded [succeeded] Succeeded quest (cast cast-result-succeeded)");
    expect(allMessage).toContain("- quest-failed [failed] Failed quest (cast cast-result-failed)");
    expect(allMessage).toContain("- quest-pending [pending] Pending quest");
    expect(succeededMessage).toContain("- quest-succeeded [succeeded] Succeeded quest (cast cast-result-succeeded)");
    expect(allMessage).not.toContain("cast-previous-running");
    expect(allMessage).not.toContain("cast-fallback-succeeded");
    expect(allMessage).not.toContain("cast-fallback-failed");
    expect(allMessage.match(/\(cast cast-result-succeeded\)/g)).toHaveLength(1);
  });
});

describe("/materia quest command interface", () => {
  test("registers quest in description and completions", async () => {
    const harness = await makeHarness();
    const command = harness.commands.get("materia");

    expect(command?.description).toContain("quest");
    expect(harness.getCommandCompletions("materia", "q")?.map((completion) => completion.value)).toContain("quest");
    const questCompletions = harness.getCommandCompletions("materia", "quest ")?.map((completion) => completion.value);
    expect(questCompletions).toContain("quest add");
    expect(questCompletions).toContain("quest runonce");
    expect(questCompletions).toContain("quest requeue");
    expect(questCompletions).toContain("quest unblock");
    expect(questCompletions).toContain("quest unfail");
  });

  test("list defaults to pending quests with limit 10 and does not wait for idle", async () => {
    const harness = await makeHarness();
    harness.idle = false;
    await seedBoard(
      harness,
      Array.from({ length: 12 }, (_, index) => makeQuest(`quest-pending-${index + 1}`, "pending", `Pending quest ${index + 1}`)),
    );

    await harness.runCommand("materia", "quest list");

    const message = latestMateriaMessage(harness);
    expect(harness.waitForIdleCalls).toBe(0);
    expect(message).toContain("pi-materia quest list");
    expect(message).toContain("Filter: pending");
    expect(message).toContain("Showing: 10 of 12 matching quest(s) (limit 10)");
    expect(listEntryLines(message)).toHaveLength(10);
    expect(message).toContain("quest-pending-1 [pending] Pending quest 1");
    expect(message).toContain("quest-pending-10 [pending] Pending quest 10");
    expect(message).not.toContain("quest-pending-11 [pending] Pending quest 11");
  });

  test("list supports explicit filters", async () => {
    const harness = await makeHarness();
    await seedBoard(harness, [
      makeQuest("quest-pending", "pending", "Pending quest"),
      makeQuest("quest-succeeded", "succeeded", "Succeeded quest"),
      makeQuest("quest-failed", "failed", "Failed quest"),
      makeQuest("quest-blocked", "blocked", "Blocked quest"),
      makeQuest("quest-running", "running", "Running quest"),
    ]);

    await harness.runCommand("materia", "quest list pending");
    expect(latestMateriaMessage(harness)).toContain("Showing: 1 of 1 matching quest(s) (limit 10)");
    expect(latestMateriaMessage(harness)).toContain("quest-pending [pending] Pending quest");

    await harness.runCommand("materia", "quest list succeeded");
    expect(latestMateriaMessage(harness)).toContain("quest-succeeded [succeeded] Succeeded quest");
    expect(latestMateriaMessage(harness)).not.toContain("quest-failed [failed] Failed quest");

    await harness.runCommand("materia", "quest list failed");
    expect(latestMateriaMessage(harness)).toContain("quest-failed [failed] Failed quest");
    expect(latestMateriaMessage(harness)).not.toContain("quest-blocked [blocked] Blocked quest");

    await harness.runCommand("materia", "quest list all");
    const allMessage = latestMateriaMessage(harness);
    expect(allMessage).toContain("Filter: all");
    expect(allMessage).toContain("Showing: 5 of 5 matching quest(s) (limit 10)");
    expect(allMessage).toContain("quest-pending [pending] Pending quest");
    expect(allMessage).toContain("quest-succeeded [succeeded] Succeeded quest");
    expect(allMessage).toContain("quest-failed [failed] Failed quest");
    expect(allMessage).toContain("quest-blocked [blocked] Blocked quest");
    expect(allMessage).toContain("quest-running [running] Running quest");
  });

  test("list applies custom limit after filtering and pending ordering", async () => {
    const harness = await makeHarness();
    await seedBoard(harness, [
      makeQuest("quest-done", "succeeded", "Done quest"),
      makeQuest("quest-next", "pending", "Next pending quest"),
      makeQuest("quest-later", "pending", "Later pending quest"),
      makeQuest("quest-last", "pending", "Last pending quest"),
    ]);

    await harness.runCommand("materia", "quest list pending --limit 2");

    const message = latestMateriaMessage(harness);
    expect(message).toContain("Showing: 2 of 3 matching quest(s) (limit 2)");
    expect(listEntryLines(message)).toEqual([
      "- quest-next [pending] Next pending quest",
      "- quest-later [pending] Later pending quest",
    ]);
  });

  test("list reports invalid filter and invalid limit notifications", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "quest list blocked");
    await harness.runCommand("materia", "quest list --limit nope");

    const errors = harness.notifications.filter((notification) => notification.type === "error").map((notification) => notification.message);
    expect(errors.some((message) => message.includes("Unknown /materia quest list filter blocked"))).toBe(true);
    expect(errors.some((message) => message.includes("Limit must be a positive safe integer"))).toBe(true);
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

  test("shows, sets, clears, and reports errors for quest default-loadout independently", async () => {
    const harness = await makeHarness();

    expect(harness.getCommandCompletions("materia", "quest d")?.map((completion) => completion.value)).toContain("quest default-loadout");
    expect(harness.getCommandCompletions("materia", "quest default-loadout ")?.map((completion) => completion.value)).toContain("quest default-loadout --clear");

    await harness.runCommand("materia", "quest default-loadout");
    expect(latestMateriaMessage(harness)).toContain("pi-materia quest default loadout");
    expect(latestMateriaMessage(harness)).toContain("Quest default loadout: cleared");

    await harness.runCommand("materia", "quest default-loadout Other");
    expect(latestMateriaMessage(harness)).toContain("Quest default loadout: project:other");
    expect(harness.notifications.some((notification) => notification.message.includes("quest default loadout set to project:other"))).toBe(true);

    await harness.runCommand("materia", "quest status");
    expect(latestMateriaMessage(harness)).toContain("Active loadout: Test");
    expect(latestMateriaMessage(harness)).toContain("Regular default loadout:");
    expect(latestMateriaMessage(harness)).toContain("Quest default loadout: project:other");

    await harness.runCommand("materia", "quest default-loadout Missing");
    expect(harness.notifications.at(-1)).toMatchObject({ type: "error" });
    expect(harness.notifications.at(-1)?.message).toContain('Unknown quest default Materia loadout "Missing"');

    await harness.runCommand("materia", "quest default-loadout --clear");
    expect(latestMateriaMessage(harness)).toContain("Quest default loadout: cleared");
  });

  test("adds a pending quest to a stopped board without launching it", async () => {
    const harness = await makeHarness(agentQuestConfig());

    await harness.runCommand("materia", "quest add --loadout Test Implement the thing");

    const board = await readBoard(harness);
    expect(board.runner.enabled).toBe(false);
    expect(board.quests[0]).toMatchObject({ title: "Implement the thing", prompt: "Implement the thing", loadoutOverride: "Test" });
    expectQuestAddDidNotLaunch(harness, board);
    expect(latestMateriaMessage(harness)).toContain("Added quest");
  });

  test("quest add does not wait for idle while enqueuing", async () => {
    const harness = await makeHarness(agentQuestConfig());
    harness.idle = false;
    harness.waitForIdleError = new Error("session is busy");

    await harness.runCommand("materia", "quest add Queue while busy");

    const board = await readBoard(harness);
    expect(harness.waitForIdleCalls).toBe(0);
    expect(harness.operationLog).not.toContain("waitForIdle");
    expect(board.quests[0]).toMatchObject({ title: "Queue while busy", prompt: "Queue while busy" });
    expectQuestAddDidNotLaunch(harness, board);
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

  test("continuous runner defers the next agent quest triggerTurn when auto-advancing from agent_end", async () => {
    const harness = await makeHarness(agentQuestConfig(), { strictTriggerTurnDuringAgentEnd: true });
    await harness.runCommand("materia", "quest add First agent quest");
    await harness.runCommand("materia", "quest add Second agent quest");
    const waitsBeforeRun = harness.waitForIdleCalls;

    await harness.runCommand("materia", "quest run");

    expect(harness.waitForIdleCalls).toBe(waitsBeforeRun + 1);
    const promptsBeforeAgentEnd = triggeredPromptMessages(harness).length;
    expect(promptsBeforeAgentEnd).toBe(1);

    harness.appendAssistantMessage("first quest complete");
    await harness.emit("agent_end", { messages: [] });

    const board = await readBoard(harness);
    expect(board.runner.enabled).toBe(true);
    expect(board.runner.activeQuestId).toBe(board.quests[1].id);
    expect(board.quests.map((quest: any) => quest.status)).toEqual(["succeeded", "running"]);
    expect(board.quests[0].currentCastId).toBeUndefined();
    expect(board.quests[0].lastCastId).toBeTruthy();
    expect(board.quests[1].currentCastId).toBeTruthy();
    expect(board.quests[1].lastCastId).toBe(board.quests[1].currentCastId);

    const activeState = loadActiveCastState(harness.ctx);
    expect(activeState?.castId).toBe(board.quests[1].currentCastId);
    expect(activeState?.currentSocketId).toBe("Socket-1");
    expect(activeState?.currentMateria).toBe("Build");
    expect(activeState?.socketState).toBe("awaiting_agent_response");
    expect(activeState?.awaitingResponse).toBe(true);
    expect(activeState?.multiTurnFinalizing).not.toBe(true);
    expect(activeState?.data.quest).toMatchObject({ questId: board.quests[1].id, title: "Second agent quest" });
    expect(activeState?.currentItemKey).toBe(board.quests[1].id);
    expect(activeState?.currentItemLabel).toBe("Second agent quest");

    expect(triggeredPromptMessages(harness)).toHaveLength(promptsBeforeAgentEnd);
    expect(harness.suppressedTriggerTurnSends).toHaveLength(0);
    expect(harness.userMessages).toHaveLength(0);
    expect(harness.waitForIdleCalls).toBe(waitsBeforeRun + 1);
    expect(harness.operationLog.filter((operation) => operation === "waitForIdle")).toHaveLength(waitsBeforeRun + 1);

    await flushDeferredDispatch();

    const boardAfterDispatch = await readBoard(harness);
    const activeStateAfterDispatch = loadActiveCastState(harness.ctx);
    expect(boardAfterDispatch.runner.activeQuestId).toBe(board.quests[1].id);
    expect(boardAfterDispatch.quests.map((quest: any) => quest.status)).toEqual(["succeeded", "running"]);
    expect(boardAfterDispatch.quests[0].currentCastId).toBeUndefined();
    expect(boardAfterDispatch.quests[1].currentCastId).toBe(board.quests[1].currentCastId);
    expect(activeStateAfterDispatch?.castId).toBe(boardAfterDispatch.quests[1].currentCastId);
    expect(activeStateAfterDispatch?.socketState).toBe("awaiting_agent_response");

    const triggeredPrompts = triggeredPromptMessages(harness);
    expect(triggeredPrompts).toHaveLength(promptsBeforeAgentEnd + 1);
    const secondQuestPrompts = triggeredPrompts.filter((message) => {
      const details = (message as any).details;
      return details?.socketId === "Socket-1" && details?.materiaName === "Build" && details?.itemLabel === "Second agent quest";
    });
    expect(secondQuestPrompts).toHaveLength(1);
    expect(harness.suppressedTriggerTurnSends).toHaveLength(0);
    expect(harness.userMessages).toHaveLength(0);
    expect(harness.waitForIdleCalls).toBe(waitsBeforeRun + 1);
  });

  test("run with no pending quests enables runner and reports waiting", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "quest run");

    const board = await readBoard(harness);
    expect(board.runner.enabled).toBe(true);
    expect(harness.notifications.some((notification) => notification.type === "info" && notification.message.includes("quest runner enabled and waiting"))).toBe(true);
  });

  test("adding a quest to an enabled idle runner only enqueues it", async () => {
    const harness = await makeHarness(agentQuestConfig());
    await harness.runCommand("materia", "quest run");
    const waitsBeforeAdd = harness.waitForIdleCalls;
    const notificationsBeforeAdd = harness.notifications.length;

    await harness.runCommand("materia", "quest add Wake the runner");

    const board = await readBoard(harness);
    expect(harness.waitForIdleCalls).toBe(waitsBeforeAdd);
    expect(board.runner.enabled).toBe(true);
    expectQuestAddDidNotLaunch(harness, board);
    const addNotifications = harness.notifications.slice(notificationsBeforeAdd);
    expect(addNotifications.some((notification) => notification.message.includes("auto-launched"))).toBe(false);
  });

  test("requeues failed and blocked quests by id or unambiguous prefix at the queue bottom", async () => {
    const harness = await makeHarness();
    await seedBoard(harness, [
      { ...makeQuest("quest-failedabcd", "failed", "Failed quest"), lastError: { message: "old failure", occurredAt: "2026-05-19T00:05:00.000Z" } },
      makeQuest("quest-pendingabcd", "pending", "Existing pending quest"),
      makeQuest("quest-blockedwxyz", "blocked", "Blocked quest"),
    ]);

    await harness.runCommand("materia", "quest requeue faileda");
    await harness.runCommand("materia", "quest unblock quest-blockedwxyz");

    const board = await readBoard(harness);
    expect(board.quests.map((quest: any) => quest.id)).toEqual(["quest-pendingabcd", "quest-failedabcd", "quest-blockedwxyz"]);
    expect(board.quests.map((quest: any) => quest.status)).toEqual(["pending", "pending", "pending"]);
    const failedQuest = board.quests.find((quest: any) => quest.id === "quest-failedabcd");
    expect(failedQuest.attempts).toBe(1);
    expect(failedQuest.lastCastId).toBe("cast-quest-failedabcd");
    expect(failedQuest.lastError).toEqual({ message: "old failure", occurredAt: "2026-05-19T00:05:00.000Z" });
    expect(failedQuest.currentCastId).toBeUndefined();
    expect(latestMateriaMessage(harness)).toContain("Requeued quest quest-blockedwxyz");
    expect(latestMateriaMessage(harness)).toContain("bottom of the queue");
    expect(harness.notifications.some((notification) => notification.message.includes("Requeued pi-materia quest quest-failedabcd"))).toBe(true);
  });

  test("unfail alias requeues and an enabled runner auto-advances", async () => {
    const harness = await makeHarness();
    await seedBoard(harness, [makeQuest("quest-failedabcd", "failed", "Failed quest")]);
    const seededBoard = await readBoard(harness);
    seededBoard.runner.enabled = true;
    await writeFile(path.join(harness.cwd, ".pi", "pi-materia", "quest-board.json"), JSON.stringify(seededBoard, null, 2));

    await harness.runCommand("materia", "quest unfail faileda");

    const board = await readBoard(harness);
    expect(board.runner.enabled).toBe(true);
    expect(board.quests[0]).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(harness.notifications.some((notification) => notification.message.includes("auto-launched"))).toBe(true);
  });

  test("requeue rejects invalid arity, invalid statuses, and ambiguous prefixes", async () => {
    const harness = await makeHarness();
    await seedBoard(harness, [
      makeQuest("quest-pendingabcd", "pending", "Pending quest"),
      makeQuest("quest-failedabcd", "failed", "Failed quest"),
      makeQuest("quest-failedabzz", "failed", "Other failed quest"),
    ]);

    await harness.runCommand("materia", "quest requeue");
    await harness.runCommand("materia", "quest requeue pendinga");
    await harness.runCommand("materia", "quest requeue failedab");

    const board = await readBoard(harness);
    expect(board.quests.map((quest: any) => quest.status)).toEqual(["pending", "failed", "failed"]);
    const errors = harness.notifications.filter((notification) => notification.type === "error").map((notification) => notification.message);
    expect(errors.some((message) => message.includes("Usage: /materia quest requeue <quest-id-or-prefix>"))).toBe(true);
    expect(errors.some((message) => message.includes("quest 'quest-pendingabcd' is pending, not failed or blocked"))).toBe(true);
    expect(errors.some((message) => message.includes("ambiguous") && message.includes("quest-failedabcd") && message.includes("quest-failedabzz"))).toBe(true);
  });

  test("requeue waits for idle because it may auto-advance", async () => {
    const harness = await makeHarness();
    await seedBoard(harness, [makeQuest("quest-failedabcd", "failed", "Failed quest")]);
    const waitsBefore = harness.waitForIdleCalls;

    await harness.runCommand("materia", "quest requeue faileda");

    expect(harness.waitForIdleCalls).toBe(waitsBefore + 1);
  });

  test("moves pending quests using unambiguous quest prefixes", async () => {
    const harness = await makeHarness();
    await seedBoard(harness, [
      makeQuest("quest-ab12cd34", "pending", "First quest"),
      makeQuest("quest-cd34ef56", "pending", "Second quest"),
      makeQuest("quest-ef56gh78", "pending", "Third quest"),
    ]);

    await harness.runCommand("materia", "quest move ab12 --onto cd34");

    let board = await readBoard(harness);
    expect(board.quests.map((quest: any) => quest.id)).toEqual(["quest-cd34ef56", "quest-ab12cd34", "quest-ef56gh78"]);
    expect(latestMateriaMessage(harness)).toContain("Moved quest quest-ab12cd34 after quest-cd34ef56");

    await harness.runCommand("materia", "quest move ef56 --first");
    board = await readBoard(harness);
    expect(board.quests.map((quest: any) => quest.id)).toEqual(["quest-ef56gh78", "quest-cd34ef56", "quest-ab12cd34"]);

    await harness.runCommand("materia", "quest move ab12 --before cd34");
    board = await readBoard(harness);
    expect(board.quests.map((quest: any) => quest.id)).toEqual(["quest-ef56gh78", "quest-ab12cd34", "quest-cd34ef56"]);
    expect(latestMateriaMessage(harness)).toContain("Moved quest quest-ab12cd34 before quest-cd34ef56");
  });

  test("move rejects mutually exclusive placement options before writing", async () => {
    const harness = await makeHarness();
    await seedBoard(harness, [
      makeQuest("quest-ab12cd34", "pending", "First quest"),
      makeQuest("quest-cd34ef56", "pending", "Second quest"),
    ]);

    await harness.runCommand("materia", "quest move ab12 --first --onto cd34");

    const board = await readBoard(harness);
    expect(board.quests.map((quest: any) => quest.id)).toEqual(["quest-ab12cd34", "quest-cd34ef56"]);
    const errors = harness.notifications.filter((notification) => notification.type === "error").map((notification) => notification.message);
    expect(errors.some((message) => message.includes("exactly one placement option"))).toBe(true);
  });

  test("move rejects ambiguous, missing, and non-pending quest references without writing", async () => {
    const harness = await makeHarness();
    await seedBoard(harness, [
      makeQuest("quest-ab12cd34", "pending", "First quest"),
      makeQuest("quest-ab99zz00", "pending", "Second quest"),
      makeQuest("quest-done", "succeeded", "Done quest"),
    ]);

    await harness.runCommand("materia", "quest move ab --first");
    await harness.runCommand("materia", "quest move missing --first");
    await harness.runCommand("materia", "quest move ab12 --before done");

    const board = await readBoard(harness);
    expect(board.quests.map((quest: any) => quest.id)).toEqual(["quest-ab12cd34", "quest-ab99zz00", "quest-done"]);
    const errors = harness.notifications.filter((notification) => notification.type === "error").map((notification) => notification.message);
    expect(errors.some((message) => message.includes("ambiguous") && message.includes("quest-ab12cd34") && message.includes("quest-ab99zz00"))).toBe(true);
    expect(errors.some((message) => message.includes("no quest matches reference 'missing'"))).toBe(true);
    expect(errors.some((message) => message.includes("quest 'quest-done' is succeeded, not pending"))).toBe(true);
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
    expect(runHarness.waitForIdleCalls).toBe(1);
    expect(board.quests[0]).toMatchObject({ status: "pending", attempts: 0 });
    expect(runHarness.operationLog).not.toContain("triggerTurn");

    const startHarness = await makeHarness();
    await startHarness.runCommand("materia", "quest add Build while busy");
    startHarness.idle = false;
    startHarness.waitForIdleError = new Error("session is busy");

    await expect(startHarness.runCommand("materia", "quest start")).rejects.toThrow("session is busy");
    board = await readBoard(startHarness);
    expect(startHarness.waitForIdleCalls).toBe(1);
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
    await harness.runCommand("materia", "quest list blocked");
    await harness.runCommand("materia", "quest list --limit 0");
    await harness.runCommand("materia", "quest wat");

    const errors = harness.notifications.filter((notification) => notification.type === "error").map((notification) => notification.message);
    expect(errors.some((message) => message.includes("quest board is empty"))).toBe(true);
    expect(errors.some((message) => message.includes("Usage: /materia quest add"))).toBe(true);
    expect(errors.some((message) => message.includes('Unknown Materia loadout override "Missing"'))).toBe(true);
    expect(errors.some((message) => message.includes("No pending pi-materia quest found with id missing-id"))).toBe(true);
    expect(errors.some((message) => message.includes("Unknown /materia quest list filter blocked"))).toBe(true);
    expect(errors.some((message) => message.includes("Limit must be a positive safe integer"))).toBe(true);
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

  test("runner control cards stay user-visible but are marked orchestration-only and never trigger a turn", async () => {
    // run + auto-advance: the continuous runner drains two utility quests back to back.
    const runHarness = await makeHarness();
    await runHarness.runCommand("materia", "quest add First immediate quest");
    const seededRunBoard = await readBoard(runHarness);
    seededRunBoard.quests.push({ ...seededRunBoard.quests[0], id: "quest-second", title: "Second immediate quest", prompt: "Second immediate quest" });
    await writeFile(path.join(runHarness.cwd, ".pi", "pi-materia", "quest-board.json"), JSON.stringify(seededRunBoard, null, 2));
    await runHarness.runCommand("materia", "quest run");

    const runCards = questCardSends(runHarness, "run");
    expect(runCards).toHaveLength(1);
    expect(runCards[0].message.display).toBe(true);
    expect(runCards[0].message.content).toContain("Started continuous quest runner and launched");
    expect(runCards[0].message.details.orchestration).toBe(true);
    expect(runCards[0].message.details.prefix).toBe("quest");
    expect(runCards[0].options?.triggerTurn).not.toBe(true);

    const autoCards = questCardSends(runHarness, "auto-advance");
    expect(autoCards.length).toBeGreaterThanOrEqual(1);
    expect(autoCards[0].message.display).toBe(true);
    expect(autoCards[0].message.details.orchestration).toBe(true);
    expect(autoCards[0].options?.triggerTurn).not.toBe(true);

    // runonce: one-shot launch emits the runonce runner card.
    const onceHarness = await makeHarness();
    await onceHarness.runCommand("materia", "quest add Build once");
    await onceHarness.runCommand("materia", "quest runonce");
    const runonceCards = questCardSends(onceHarness, "runonce");
    expect(runonceCards).toHaveLength(1);
    expect(runonceCards[0].message.display).toBe(true);
    expect(runonceCards[0].message.content).toContain("Launched quest");
    expect(runonceCards[0].message.details.orchestration).toBe(true);
    expect(runonceCards[0].options?.triggerTurn).not.toBe(true);

    // stop: disabling the runner emits the stop runner card.
    const stopHarness = await makeHarness();
    await stopHarness.runCommand("materia", "quest run");
    await stopHarness.runCommand("materia", "quest stop");
    const stopCards = questCardSends(stopHarness, "stop");
    expect(stopCards).toHaveLength(1);
    expect(stopCards[0].message.display).toBe(true);
    expect(stopCards[0].message.content).toContain("Quest runner stopped");
    expect(stopCards[0].message.details.orchestration).toBe(true);
    expect(stopCards[0].options?.triggerTurn).not.toBe(true);
  });

  test("context hook strips the quest runner card from isolated agent context after /materia quest run", async () => {
    // Use an agent quest loadout so /materia quest run launches a real agent cast
    // (hidden materia prompt + triggerTurn) that stays active and awaiting
    // response, which is exactly when context isolation engages. The explicit
    // --loadout Test override guarantees the user-facing card renders a Loadout
    // line so the regression covers every orchestration string from the bug.
    const harness = await makeHarness(agentQuestConfig());
    await harness.runCommand("materia", "quest add --loadout Test Filter the materia palette on the loadout page");
    await harness.runCommand("materia", "quest run");

    // Sanity: the runner launched the agent cast and it is active and awaiting
    // response, so emitting the context hook will go through isolation.
    const activeState = loadActiveCastState(harness.ctx);
    expect(activeState?.active).toBe(true);
    expect(activeState?.awaitingResponse).toBe(true);

    const hiddenPromptMessage = harness.sentMessages
      .map(({ message }) => message as { customType?: string; content?: string })
      .find((message) => message.customType === "pi-materia-prompt");
    const runCardMessage = questCardSends(harness, "run").at(-1)?.message as
      | { content?: string; details?: { orchestration?: true; prefix?: string; eventType?: string } }
      | undefined;
    expect(hiddenPromptMessage).toBeDefined();
    expect(runCardMessage).toBeDefined();
    expect(hiddenPromptMessage!.content).toContain("<materia-instructions>");
    expect(runCardMessage!.details?.orchestration).toBe(true);
    expect(runCardMessage!.details?.prefix).toBe("quest");

    // The real user-facing card carries every orchestration string we must isolate.
    const cardContent = String(runCardMessage!.content);
    expect(cardContent).toContain("Started continuous quest runner");
    expect(cardContent).toContain("Runner:");
    expect(cardContent).toContain("Loadout:");
    expect(cardContent).toContain("Mode: continuous run");

    // Simulate the transcript Pi passes to the context hook: earlier unrelated
    // user text, then the hidden materia prompt, then the user-facing quest
    // runner card appended AFTER the prompt (the leaked-context bug scenario).
    const messages = [
      { role: "user", content: [{ type: "text", text: "unrelated earlier transcript" }] },
      { role: "custom", customType: "pi-materia-prompt", content: hiddenPromptMessage!.content, display: false, details: { phase: "Socket-1", socketId: "Socket-1", materiaName: "Build" } },
      { role: "custom", customType: "pi-materia", content: cardContent, display: true, details: runCardMessage!.details },
    ];

    const contextResults = await harness.emit("context", { messages });
    const isolated = (contextResults.at(-1) as { messages?: unknown[] } | undefined)?.messages;
    expect(isolated).toBeDefined();
    const serialized = JSON.stringify(isolated);
    const syntheticContent = String((isolated as Array<{ content?: unknown }>)[0].content);

    // Synthetic cast context replaces the earlier transcript and remains present.
    expect((isolated as Array<{ role?: string }>)[0]).toMatchObject({ role: "user" });
    expect(syntheticContent).toContain("Materia isolated context.");
    expect(syntheticContent).toContain("Cast id:");
    expect(serialized).not.toContain("unrelated earlier transcript");

    // The hidden materia prompt must survive isolation.
    expect(serialized).toContain("<materia-instructions>");
    expect(serialized).toContain("</materia-instructions>");

    // The quest runner orchestration card must be fully removed even though it
    // was appended after the hidden materia prompt. The card's own Mode line
    // ("Mode: continuous run") is distinct from the synthetic context's own
    // legitimate "Mode: awaiting_agent_response" line checked below.
    expect(serialized).not.toContain("Started continuous quest runner");
    expect(serialized).not.toContain("Runner:");
    expect(serialized).not.toContain("Loadout:");
    expect(serialized).not.toContain("Mode: continuous run");
    expect(serialized).not.toContain("auto-advances while enabled");
    expect(syntheticContent).toContain("Mode: awaiting_agent_response");
  });

  test("explicit quest command cards stay user-visible without the orchestration-only flag", async () => {
    const harness = await makeHarness();
    await harness.runCommand("materia", "quest add Build something");
    const addCards = questCardSends(harness, "add");
    expect(addCards).toHaveLength(1);
    expect(addCards[0].message.display).toBe(true);
    expect(addCards[0].message.details.orchestration).toBeUndefined();
    expect(addCards[0].message.details.prefix).toBe("quest");

    await harness.runCommand("materia", "quest status");
    const statusCards = questCardSends(harness, "status");
    expect(statusCards.at(-1)?.message.display).toBe(true);
    expect(statusCards.at(-1)?.message.details.orchestration).toBeUndefined();
  });
});
