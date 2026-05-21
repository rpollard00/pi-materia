import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { QUEST_BOARD_SCHEMA_VERSION, addQuest, createQuestBoard, movePendingQuest, requeueQuest, type QuestBoard } from "../src/domain/questBoard.js";
import { issuesToMessage } from "../src/domain/result.js";
import { createMateriaWebUiServer, type MateriaAddQuestInput, type MateriaAddQuestResult, type MateriaReorderQuestInput, type MateriaReorderQuestResult, type MateriaRequeueQuestInput, type MateriaRequeueQuestResult } from "../src/webui/server/index.js";

type StartedServer = ReturnType<typeof createMateriaWebUiServer>["server"];

const servers: StartedServer[] = [];
const NOW = "2026-05-19T19:00:00.000Z";

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function questBoardFixture(): QuestBoard {
  return {
    version: QUEST_BOARD_SCHEMA_VERSION,
    createdAt: NOW,
    updatedAt: "2026-05-19T19:07:00.000Z",
    runner: { enabled: true, activeQuestId: "quest-active", lastStartedAt: "2026-05-19T19:00:30.000Z" },
    quests: [
      { id: "quest-active", title: "Defeat the dragon", prompt: "Defeat the dragon in the old keep", status: "running", createdAt: NOW, updatedAt: "2026-05-19T19:01:00.000Z", attempts: 1, loadoutOverride: "Full-Auto", currentCastId: "cast-active", lastCastId: "cast-active" },
      { id: "quest-pending-1", title: "Gather moon herbs", prompt: "Gather moon herbs", status: "pending", createdAt: "2026-05-19T19:02:00.000Z", updatedAt: "2026-05-19T19:02:00.000Z", attempts: 0 },
      { id: "quest-pending-2", title: "Forge silver key", prompt: "Forge silver key", status: "pending", createdAt: "2026-05-19T19:03:00.000Z", updatedAt: "2026-05-19T19:03:00.000Z", attempts: 0 },
      { id: "quest-complete", title: "Light the beacon", prompt: "Light the beacon", status: "succeeded", createdAt: "2026-05-19T19:04:00.000Z", updatedAt: "2026-05-19T19:05:00.000Z", attempts: 1, lastCastId: "cast-complete", lastResult: { status: "succeeded", castId: "cast-complete", finishedAt: "2026-05-19T19:05:00.000Z", message: "Beacon lit" } },
      { id: "quest-failed", title: "Sneak past sentries", prompt: "Sneak past sentries", status: "failed", createdAt: "2026-05-19T19:06:00.000Z", updatedAt: "2026-05-19T19:07:00.000Z", attempts: 1, lastCastId: "cast-failed", lastError: { message: "Guard spotted the party", occurredAt: "2026-05-19T19:07:00.000Z", castId: "cast-failed", code: "spotted" } },
      { id: "quest-blocked", title: "Open sealed gate", prompt: "Open sealed gate", status: "blocked", createdAt: "2026-05-19T19:08:00.000Z", updatedAt: "2026-05-19T19:09:00.000Z", attempts: 1, lastCastId: "cast-blocked", lastResult: { status: "blocked", castId: "cast-blocked", finishedAt: "2026-05-19T19:09:00.000Z", error: "Needs a moon key" } },
    ],
  };
}

async function startTestServer(options: {
  board?: QuestBoard;
  addQuest?: (input: MateriaAddQuestInput) => Promise<MateriaAddQuestResult>;
  reorderQuest?: (input: MateriaReorderQuestInput) => Promise<MateriaReorderQuestResult>;
  requeueQuest?: (input: MateriaRequeueQuestInput) => Promise<MateriaRequeueQuestResult>;
  includeRequeueQuest?: boolean;
  getQuestBoardThrows?: boolean;
} = {}) {
  const projectDir = await mkdtemp(path.join(tmpdir(), "pi-materia-webui-quests-"));
  let board = options.board ?? questBoardFixture();
  const boardPath = path.join(projectDir, ".pi", "pi-materia", "quest-board.json");
  const created = createMateriaWebUiServer({
    staticDir: projectDir,
    session: {
      key: "test-session",
      cwd: projectDir,
      sessionFile: `${projectDir}/session.jsonl`,
      sessionId: "test-session-id",
      startedAt: Date.now(),
      getSnapshot: async () => ({ ok: true, scope: "session", service: "pi-materia-webui", sessionKey: "test-session", cwd: projectDir, sessionFile: `${projectDir}/session.jsonl`, sessionId: "test-session-id", uiStartedAt: Date.now(), now: Date.now() }),
      getQuestBoard: async () => {
        if (options.getQuestBoardThrows) throw new Error("quest board read failed");
        return { boardPath, board };
      },
      addQuest: options.addQuest ?? (async (input) => {
        if (input.loadoutOverride && input.loadoutOverride !== "Full-Auto") return { ok: false, code: "invalid_loadout", message: `Unknown Materia loadout \"${input.loadoutOverride}\".` };
        const result = addQuest(board, { id: "quest-created", title: input.prompt, prompt: input.prompt, now: "2026-05-19T20:00:00.000Z", ...(input.loadoutOverride ? { loadoutOverride: input.loadoutOverride } : {}) });
        if (!result.ok) return { ok: false, code: "validation_failed", message: "domain validation failed" };
        board = result.value;
        return { ok: true, boardPath, board, quest: board.quests.at(-1)! };
      }),
      reorderQuest: options.reorderQuest ?? (async (input) => {
        const result = movePendingQuest(board, { ...input, now: "2026-05-19T20:01:00.000Z" });
        if (!result.ok) return { ok: false, code: "validation_failed", message: issuesToMessage(result.issues) };
        board = result.value;
        const quest = board.quests.find((candidate) => candidate.id === input.questId)!;
        const target = input.targetId ? board.quests.find((candidate) => candidate.id === input.targetId) : undefined;
        return { ok: true, boardPath, board, quest, ...(target ? { target } : {}) };
      }),
      ...(options.includeRequeueQuest === false ? {} : {
        requeueQuest: options.requeueQuest ?? (async (input) => {
          const result = requeueQuest(board, { ...input, now: "2026-05-19T20:02:00.000Z" });
          if (!result.ok) return { ok: false, code: "validation_failed", message: issuesToMessage(result.issues) };
          board = result.value;
          const quest = board.quests.find((candidate) => candidate.id === input.questId)!;
          return { ok: true, boardPath, board, quest };
        }),
      }),
    },
  });
  await new Promise<void>((resolve, reject) => {
    created.server.once("error", reject);
    created.server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push(created.server);
  const address = created.server.address();
  if (!address || typeof address !== "object") throw new Error("test server did not bind to a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

describe("GET /api/quests", () => {
  test("returns grouped quest board data in execution order", async () => {
    const baseUrl = await startTestServer();

    const response = await fetch(`${baseUrl}/api/quests`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.boardPath).toContain(path.join(".pi", "pi-materia", "quest-board.json"));
    expect(body.activeQuest.id).toBe("quest-active");
    expect(body.runningQuest.id).toBe("quest-active");
    expect(body.pendingQuests.map((quest: { id: string }) => quest.id)).toEqual(["quest-pending-1", "quest-pending-2"]);
    expect(body.completedQuests.map((quest: { id: string }) => quest.id)).toEqual(["quest-complete"]);
    expect(body.failedQuests.map((quest: { id: string }) => quest.id)).toEqual(["quest-failed", "quest-blocked"]);
    expect(body.counts).toMatchObject({ total: 6, pending: 2, running: 1, succeeded: 1, failed: 1, blocked: 1, completed: 1, terminal: 3 });
  });

  test("returns a safe error envelope when quest board reads fail", async () => {
    const baseUrl = await startTestServer({ getQuestBoardThrows: true });

    const response = await fetch(`${baseUrl}/api/quests`);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ ok: false, error: "quest board read failed" });
  });
});

describe("POST /api/quests", () => {
  test("adds a pending quest with an optional loadout override", async () => {
    const baseUrl = await startTestServer({ board: createQuestBoard({ now: NOW }) });

    const response = await fetch(`${baseUrl}/api/quests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: " Rescue the villager ", loadoutOverride: "Full-Auto" }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.quest).toMatchObject({ id: "quest-created", title: "Rescue the villager", prompt: "Rescue the villager", status: "pending", loadoutOverride: "Full-Auto" });
    expect(body.board.pendingQuests.map((quest: { id: string }) => quest.id)).toEqual(["quest-created"]);
  });

  test("returns 400 for invalid JSON and blank prompts", async () => {
    const baseUrl = await startTestServer({ board: createQuestBoard({ now: NOW }) });

    const invalidJson = await fetch(`${baseUrl}/api/quests`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(invalidJson.status).toBe(400);
    expect((await invalidJson.json()).ok).toBe(false);

    const blankPrompt = await fetch(`${baseUrl}/api/quests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "   " }) });
    expect(blankPrompt.status).toBe(400);
    expect(await blankPrompt.json()).toEqual({ ok: false, error: "Quest prompt is required." });
  });

  test("returns 400 for invalid loadout overrides", async () => {
    const baseUrl = await startTestServer({ board: createQuestBoard({ now: NOW }) });

    const response = await fetch(`${baseUrl}/api/quests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "Scout the ruins", loadoutOverride: "Missing" }) });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, code: "invalid_loadout", error: "Unknown Materia loadout \"Missing\"." });
  });
});

describe("POST /api/quests/reorder", () => {
  test("moves a pending quest and returns the canonical board response", async () => {
    const baseUrl = await startTestServer();

    const response = await fetch(`${baseUrl}/api/quests/reorder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ questId: "quest-pending-2", placement: "first" }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.pendingQuests.map((quest: { id: string }) => quest.id)).toEqual(["quest-pending-2", "quest-pending-1"]);
    expect(body.quests.map((quest: { id: string }) => quest.id)).toEqual(["quest-active", "quest-pending-2", "quest-pending-1", "quest-complete", "quest-failed", "quest-blocked"]);
    expect(body.status.updatedAt).toBe("2026-05-19T20:01:00.000Z");
  });

  test("moves a pending quest after another pending quest", async () => {
    const baseUrl = await startTestServer();

    const response = await fetch(`${baseUrl}/api/quests/reorder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ questId: "quest-pending-1", placement: "after", targetId: "quest-pending-2" }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.pendingQuests.map((quest: { id: string }) => quest.id)).toEqual(["quest-pending-2", "quest-pending-1"]);
  });

  test("rejects invalid reorder requests without modifying board order", async () => {
    const baseUrl = await startTestServer();

    const invalid = await fetch(`${baseUrl}/api/quests/reorder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ questId: "quest-active", placement: "before", targetId: "quest-pending-1" }) });
    const invalidBody = await invalid.json();
    const missing = await fetch(`${baseUrl}/api/quests/reorder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ questId: "quest-missing", placement: "after", targetId: "quest-pending-1" }) });
    const missingBody = await missing.json();
    const missingTarget = await fetch(`${baseUrl}/api/quests/reorder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ questId: "quest-pending-1", placement: "before", targetId: "quest-missing" }) });
    const missingTargetBody = await missingTarget.json();
    const after = await fetch(`${baseUrl}/api/quests`);
    const afterBody = await after.json();

    expect(invalid.status).toBe(400);
    expect(invalidBody).toEqual({ ok: false, code: "validation_failed", error: "quest.status: quest 'quest-active' is running, not pending" });
    expect(missing.status).toBe(400);
    expect(missingBody).toEqual({ ok: false, code: "validation_failed", error: "questId: quest 'quest-missing' does not exist" });
    expect(missingTarget.status).toBe(400);
    expect(missingTargetBody).toEqual({ ok: false, code: "validation_failed", error: "targetId: quest 'quest-missing' does not exist" });
    expect(afterBody.pendingQuests.map((quest: { id: string }) => quest.id)).toEqual(["quest-pending-1", "quest-pending-2"]);
  });

  test("surfaces an unavailable reorder callback without returning a partial board", async () => {
    const baseUrl = await startTestServer({ reorderQuest: async () => ({ ok: false, code: "unavailable", message: "Quest reorder API is unavailable." }) });

    const response = await fetch(`${baseUrl}/api/quests/reorder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ questId: "quest-pending-1", placement: "first" }) });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ ok: false, code: "unavailable", error: "Quest reorder API is unavailable." });
    expect(body.quests).toBeUndefined();
  });

  test("validates reorder request shape before calling the mutation callback", async () => {
    let called = false;
    const baseUrl = await startTestServer({ reorderQuest: async () => { called = true; return { ok: false, code: "unavailable", message: "should not be called" }; } });

    const missingTarget = await fetch(`${baseUrl}/api/quests/reorder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ questId: "quest-pending-1", placement: "sideways" }) });
    const getNotAllowed = await fetch(`${baseUrl}/api/quests/reorder`);

    expect(missingTarget.status).toBe(400);
    expect(await missingTarget.json()).toEqual({ ok: false, error: "Quest placement must be first, before, or after." });
    expect(getNotAllowed.status).toBe(405);
    expect(called).toBe(false);
  });
});

describe("POST /api/quests/requeue", () => {
  test("requeues a failed quest and returns the canonical board response", async () => {
    const baseUrl = await startTestServer();

    const response = await fetch(`${baseUrl}/api/quests/requeue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ questId: "quest-failed" }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.pendingQuests.map((quest: { id: string }) => quest.id)).toEqual(["quest-pending-1", "quest-pending-2", "quest-failed"]);
    expect(body.failedQuests.map((quest: { id: string }) => quest.id)).toEqual(["quest-blocked"]);
    expect(body.quests.find((quest: { id: string; status: string; lastError?: unknown }) => quest.id === "quest-failed")).toMatchObject({ id: "quest-failed", status: "pending", lastError: { message: "Guard spotted the party" } });
    expect(body.status.updatedAt).toBe("2026-05-19T20:02:00.000Z");
  });

  test("requeues a blocked quest", async () => {
    const baseUrl = await startTestServer();

    const response = await fetch(`${baseUrl}/api/quests/requeue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ questId: "quest-blocked" }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.pendingQuests.map((quest: { id: string }) => quest.id)).toEqual(["quest-pending-1", "quest-pending-2", "quest-blocked"]);
  });

  test("returns 400 for missing quests and invalid quest statuses", async () => {
    const baseUrl = await startTestServer();

    const missing = await fetch(`${baseUrl}/api/quests/requeue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ questId: "quest-missing" }) });
    const invalidStatus = await fetch(`${baseUrl}/api/quests/requeue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ questId: "quest-pending-1" }) });

    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ ok: false, code: "validation_failed", error: "questId: quest 'quest-missing' does not exist" });
    expect(invalidStatus.status).toBe(400);
    expect(await invalidStatus.json()).toEqual({ ok: false, code: "validation_failed", error: "quest.status: quest 'quest-pending-1' is pending, not failed or blocked" });
  });

  test("returns 503 when the requeue callback is unavailable", async () => {
    const baseUrl = await startTestServer({ includeRequeueQuest: false });

    const response = await fetch(`${baseUrl}/api/quests/requeue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ questId: "quest-failed" }) });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "Quest requeue API is unavailable for this server." });
  });

  test("validates requeue request shape before calling the mutation callback", async () => {
    let called = false;
    const baseUrl = await startTestServer({ requeueQuest: async () => { called = true; return { ok: false, code: "unavailable", message: "should not be called" }; } });

    const invalidJson = await fetch(`${baseUrl}/api/quests/requeue`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    const arrayBody = await fetch(`${baseUrl}/api/quests/requeue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(["quest-failed"]) });
    const missingQuestId = await fetch(`${baseUrl}/api/quests/requeue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ questId: "   " }) });
    const getNotAllowed = await fetch(`${baseUrl}/api/quests/requeue`);

    expect(invalidJson.status).toBe(400);
    expect((await invalidJson.json()).ok).toBe(false);
    expect(arrayBody.status).toBe(400);
    expect(await arrayBody.json()).toEqual({ ok: false, error: "Expected JSON object body." });
    expect(missingQuestId.status).toBe(400);
    expect(await missingQuestId.json()).toEqual({ ok: false, error: "Quest id is required." });
    expect(getNotAllowed.status).toBe(405);
    expect(await getNotAllowed.json()).toEqual({ ok: false, error: "Use POST to requeue quests." });
    expect(called).toBe(false);
  });
});
