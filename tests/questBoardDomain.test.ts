import { describe, expect, test } from "bun:test";
import {
  addQuest,
  completeQuest,
  createQuestBoard,
  enableQuestRunner,
  failRunningQuest,
  createShortRandomQuestId,
  findNextPendingQuest,
  generateUniqueQuestId,
  getOrderedQuestView,
  movePendingQuest,
  normalizeQuestBoard,
  requeueQuest,
  resolveQuestRef,
  startQuest,
  stopQuestRunner,
  updatePendingQuest,
  validateQuestBoard,
  type QuestBoard,
} from "../src/domain/index.js";

const t0 = "2026-01-01T00:00:00.000Z";
const t1 = "2026-01-01T00:01:00.000Z";
const t2 = "2026-01-01T00:02:00.000Z";
const t3 = "2026-01-01T00:03:00.000Z";

describe("quest board domain", () => {
  test("creates an empty board with runner state", () => {
    const board = createQuestBoard({ now: t0 });

    expect(board).toEqual({
      version: 1,
      createdAt: t0,
      updatedAt: t0,
      runner: { enabled: false },
      quests: [],
    });
    expect(validateQuestBoard(board).ok).toBe(true);
  });

  test("adds ordered pending quests without generating ids or timestamps", () => {
    const board = createQuestBoard({ now: t0 });
    const first = addQuest(board, { id: "q-1", title: "First", prompt: "Do the first thing", now: t1, loadoutOverride: "autonomous" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = addQuest(first.value, { id: "q-2", title: "Second", prompt: "Do the second thing", now: t2 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.value.quests.map((quest) => quest.id)).toEqual(["q-1", "q-2"]);
    expect(second.value.quests[0]).toMatchObject({
      id: "q-1",
      status: "pending",
      attempts: 0,
      loadoutOverride: "autonomous",
      createdAt: t1,
      updatedAt: t1,
    });
    expect(findNextPendingQuest(second.value)?.id).toBe("q-1");
  });

  test("creates short random quest ids suitable for display", () => {
    expect(createShortRandomQuestId()).toMatch(/^quest-[0-9a-z]{8}$/);
  });

  test("generates collision-checked short random quest ids", () => {
    const board = boardWithTwoQuests();
    const generated = generateUniqueQuestId(board, { nextId: sequence("q-1", "quest-ab12cd34") });

    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(generated.value).toBe("quest-ab12cd34");
  });

  test("fails quest id generation after repeated collisions", () => {
    const board = boardWithTwoQuests();
    const generated = generateUniqueQuestId(board, { nextId: () => "q-1", maxAttempts: 2 });

    expect(generated.ok).toBe(false);
    if (!generated.ok) expect(generated.issues[0]?.message).toContain("could not generate a unique quest id");
  });

  test("resolves quest references by exact id, displayed short id, and unique prefix", () => {
    const board = createQuestBoard({ now: t0 });
    const first = addQuest(board, { id: "quest-ab12cd34", title: "Short", prompt: "Do it", now: t1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = addQuest(first.value, { id: "legacy-full-id", title: "Legacy", prompt: "Do more", now: t1 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(resolveQuestRef(second.value, "quest-ab12cd34")).toMatchObject({ ok: true, value: { id: "quest-ab12cd34" } });
    expect(resolveQuestRef(second.value, "ab12cd34")).toMatchObject({ ok: true, value: { id: "quest-ab12cd34" } });
    expect(resolveQuestRef(second.value, "legacy-full")).toMatchObject({ ok: true, value: { id: "legacy-full-id" } });
  });

  test("rejects ambiguous and missing quest references with clear matches", () => {
    const board = createQuestBoard({ now: t0 });
    const first = addQuest(board, { id: "quest-ab12cd34", title: "First", prompt: "Do it", now: t1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = addQuest(first.value, { id: "quest-ab99zz00", title: "Second", prompt: "Do more", now: t1 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const ambiguous = resolveQuestRef(second.value, "ab");
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.issues[0]?.message).toContain("quest-ab12cd34, quest-ab99zz00");

    const missing = resolveQuestRef(second.value, "missing");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues[0]?.message).toContain("no quest matches");
  });

  test("rejects duplicate quest ids", () => {
    const added = addQuest(createQuestBoard({ now: t0 }), { id: "q-1", title: "First", prompt: "Do it", now: t1 });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const duplicate = addQuest(added.value, { id: "q-1", title: "Again", prompt: "Do again", now: t2 });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.issues[0]?.path).toBe("quest.id");
  });

  test("updates pending quest content while preserving order and audit data", () => {
    const board = boardWithTwoQuests();
    const updated = updatePendingQuest(board, { questId: "q-1", title: "Updated title", prompt: "Updated prompt", loadoutOverride: "Full-Auto", now: t3 });

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.updatedAt).toBe(t3);
    expect(updated.value.quests.map((quest) => quest.id)).toEqual(["q-1", "q-2"]);
    expect(updated.value.quests[0]).toMatchObject({ id: "q-1", title: "Updated title", prompt: "Updated prompt", status: "pending", createdAt: t1, updatedAt: t3, attempts: 0, loadoutOverride: "Full-Auto" });
    expect(updated.value.quests[1]).toEqual(board.quests[1]);
  });

  test("clears pending quest loadout override and rejects invalid updates", () => {
    const withLoadout = addQuest(createQuestBoard({ now: t0 }), { id: "q-1", title: "First", prompt: "Do one", now: t1, loadoutOverride: "Full-Auto" });
    expect(withLoadout.ok).toBe(true);
    if (!withLoadout.ok) return;
    const cleared = updatePendingQuest(withLoadout.value, { questId: "q-1", title: "First", prompt: "Do one updated", now: t2 });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.value.quests[0]?.loadoutOverride).toBeUndefined();

    const blank = updatePendingQuest(withLoadout.value, { questId: "q-1", title: "First", prompt: "", now: t2 });
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.issues[0]).toMatchObject({ path: "quest.prompt", message: "prompt is required" });

    const started = startQuest(withLoadout.value, { questId: "q-1", castId: "cast-1", now: t2 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const nonPending = updatePendingQuest(started.value, { questId: "q-1", title: "First", prompt: "Do one updated", now: t3 });
    expect(nonPending.ok).toBe(false);
    if (!nonPending.ok) expect(nonPending.issues[0]?.message).toContain("not pending");
  });

  test("starts a pending quest and prevents a second running quest", () => {
    const board = boardWithTwoQuests();
    const started = startQuest(board, { questId: "q-1", castId: "cast-1", now: t2 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(started.value.runner.activeQuestId).toBe("q-1");
    expect(started.value.quests[0]).toMatchObject({
      status: "running",
      currentCastId: "cast-1",
      lastCastId: "cast-1",
      attempts: 1,
    });

    const secondStart = startQuest(started.value, { questId: "q-2", castId: "cast-2", now: t3 });
    expect(secondStart.ok).toBe(false);
    if (!secondStart.ok) expect(secondStart.issues[0]?.message).toContain("already running");
  });

  test("does not start non-pending quests", () => {
    const board = boardWithTwoQuests();
    const started = startQuest(board, { questId: "q-1", castId: "cast-1", now: t2 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const completed = completeQuest(started.value, { questId: "q-1", castId: "cast-1", now: t3, result: { status: "succeeded" } });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;

    const restart = startQuest(completed.value, { questId: "q-1", castId: "cast-2", now: t3 });
    expect(restart.ok).toBe(false);
    if (!restart.ok) expect(restart.issues[0]?.message).toContain("not pending");
  });

  test("completes running quests only with matching cast ids", () => {
    const board = boardWithTwoQuests();
    const started = startQuest(board, { questId: "q-1", castId: "cast-1", now: t2 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const wrongCast = completeQuest(started.value, { questId: "q-1", castId: "other-cast", now: t3, result: { status: "succeeded" } });
    expect(wrongCast.ok).toBe(false);
    if (!wrongCast.ok) expect(wrongCast.issues[0]?.path).toBe("castId");

    const completed = completeQuest(started.value, {
      questId: "q-1",
      castId: "cast-1",
      now: t3,
      result: { status: "succeeded", message: "done", artifactDirectory: ".pi/pi-materia/run" },
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.runner.activeQuestId).toBeUndefined();
    expect(completed.value.quests[0]).toMatchObject({
      status: "succeeded",
      currentCastId: undefined,
      lastCastId: "cast-1",
      lastResult: { status: "succeeded", castId: "cast-1", finishedAt: t3, message: "done" },
    });
  });

  test("records failed or blocked terminal metadata for running quest startup/lifecycle failures", () => {
    const board = boardWithTwoQuests();
    const started = startQuest(board, { questId: "q-1", castId: "cast-1", now: t2 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const blocked = failRunningQuest(started.value, { questId: "q-1", castId: "cast-1", now: t3, status: "blocked", message: "stale after restart", code: "stale" });
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) return;
    expect(blocked.value.quests[0]).toMatchObject({
      status: "blocked",
      currentCastId: undefined,
      lastError: { message: "stale after restart", occurredAt: t3, castId: "cast-1", code: "stale" },
      lastResult: { status: "blocked", castId: "cast-1", finishedAt: t3, error: "stale after restart" },
    });
  });

  test("requeues failed quests to pending at the bottom while preserving audit history", () => {
    const board = boardWithTwoQuests();
    const started = startQuest(board, { questId: "q-1", castId: "cast-1", now: t2 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const failed = completeQuest(started.value, {
      questId: "q-1",
      castId: "cast-1",
      now: t3,
      result: { status: "failed", error: "boom", requestedLoadoutOverride: "default:full-auto", metadata: { reason: "test" } },
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    const withLoadout = { ...failed.value, quests: [{ ...failed.value.quests[0]!, loadoutOverride: "autonomous" }, failed.value.quests[1]!] };
    const originalFailedQuest = withLoadout.quests[0]!;

    const requeued = requeueQuest(withLoadout, { questId: "q-1", now: "2026-01-01T00:04:00.000Z" });

    expect(requeued.ok).toBe(true);
    if (!requeued.ok) return;
    expect(requeued.value).not.toBe(withLoadout);
    expect(requeued.value.updatedAt).toBe("2026-01-01T00:04:00.000Z");
    expect(requeued.value.quests.map((quest) => quest.id)).toEqual(["q-2", "q-1"]);
    expect(findNextPendingQuest(requeued.value)?.id).toBe("q-2");
    expect(getOrderedQuestView(requeued.value).map((quest) => quest.id)).toEqual(["q-2", "q-1"]);

    const requeuedQuest = requeued.value.quests.find((quest) => quest.id === "q-1");
    expect(requeuedQuest).toMatchObject({
      id: "q-1",
      title: "First",
      prompt: "Do one",
      status: "pending",
      createdAt: t1,
      updatedAt: "2026-01-01T00:04:00.000Z",
      attempts: 1,
      loadoutOverride: "autonomous",
      lastCastId: "cast-1",
      lastResult: { status: "failed", castId: "cast-1", finishedAt: t3, error: "boom", requestedLoadoutOverride: "default:full-auto", metadata: { reason: "test" } },
      lastError: { message: "boom", occurredAt: t3, castId: "cast-1" },
    });
    expect(requeuedQuest).toBeDefined();
    if (!requeuedQuest) return;
    expect(requeuedQuest).not.toBe(originalFailedQuest);
    expect(Object.hasOwn(requeuedQuest, "currentCastId")).toBe(false);
    expect(withLoadout.quests.map((quest) => quest.id)).toEqual(["q-1", "q-2"]);
    expect(withLoadout.quests[0]).toBe(originalFailedQuest);
    expect(originalFailedQuest).toMatchObject({ status: "failed", updatedAt: t3, attempts: 1 });
    expect(validateQuestBoard(requeued.value).ok).toBe(true);
  });

  test("requeues blocked quests and allows them to be started again", () => {
    const board = boardWithTwoQuests();
    const started = startQuest(board, { questId: "q-1", castId: "cast-1", now: t2 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const blocked = failRunningQuest(started.value, { questId: "q-1", castId: "cast-1", now: t3, status: "blocked", message: "needs credentials" });
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) return;

    const requeued = requeueQuest(blocked.value, { questId: "q-1", now: "2026-01-01T00:04:00.000Z" });
    expect(requeued.ok).toBe(true);
    if (!requeued.ok) return;
    expect(requeued.value.quests.map((quest) => quest.id)).toEqual(["q-2", "q-1"]);
    const requeuedQuest = requeued.value.quests.find((quest) => quest.id === "q-1");
    expect(requeuedQuest).toMatchObject({ status: "pending", updatedAt: "2026-01-01T00:04:00.000Z" });
    expect(findNextPendingQuest(requeued.value)?.id).toBe("q-2");
    expect(getOrderedQuestView(requeued.value).map((quest) => quest.id)).toEqual(["q-2", "q-1"]);
    expect(validateQuestBoard(requeued.value).ok).toBe(true);

    const restarted = startQuest(requeued.value, { questId: "q-1", castId: "cast-2", now: "2026-01-01T00:05:00.000Z" });
    expect(restarted.ok).toBe(true);
    if (!restarted.ok) return;
    const restartedQuest = restarted.value.quests.find((quest) => quest.id === "q-1");
    expect(restartedQuest).toMatchObject({ status: "running", currentCastId: "cast-2", attempts: 2 });
  });

  test("rejects requeue for missing quests, invalid statuses, and empty timestamps", () => {
    const board = boardWithTwoQuests();
    const running = startQuest(board, { questId: "q-1", castId: "cast-1", now: t2 });
    expect(running.ok).toBe(true);
    if (!running.ok) return;
    const succeeded = completeQuest(running.value, { questId: "q-1", castId: "cast-1", now: t3, result: { status: "succeeded" } });

    const pendingRequeue = requeueQuest(board, { questId: "q-1", now: t3 });
    expect(pendingRequeue.ok).toBe(false);
    if (!pendingRequeue.ok) expect(pendingRequeue.issues[0]?.message).toContain("not failed or blocked");

    const runningRequeue = requeueQuest(running.value, { questId: "q-1", now: t3 });
    expect(runningRequeue.ok).toBe(false);
    if (!runningRequeue.ok) expect(runningRequeue.issues[0]?.message).toContain("running, not failed or blocked");

    expect(succeeded.ok).toBe(true);
    if (succeeded.ok) {
      const succeededRequeue = requeueQuest(succeeded.value, { questId: "q-1", now: t3 });
      expect(succeededRequeue.ok).toBe(false);
      if (!succeededRequeue.ok) expect(succeededRequeue.issues[0]?.message).toContain("succeeded, not failed or blocked");
    }

    const missing = requeueQuest(board, { questId: "missing", now: t3 });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues[0]?.message).toContain("does not exist");

    const emptyTimestamp = requeueQuest(board, { questId: "q-1", now: "" });
    expect(emptyTimestamp.ok).toBe(false);
    if (!emptyTimestamp.ok) expect(emptyTimestamp.issues[0]?.message).toContain("timestamp is required");
  });

  test("omits stale current cast id when requeueing terminal quests", () => {
    const base = boardWithTwoQuests();
    const board: QuestBoard = {
      ...base,
      quests: [{ ...base.quests[0]!, status: "failed", attempts: 1, currentCastId: "stale-cast", lastCastId: "stale-cast" }, base.quests[1]!],
    };

    const requeued = requeueQuest(board, { questId: "q-1", now: t3 });

    expect(requeued.ok).toBe(true);
    if (!requeued.ok) return;
    expect(requeued.value.quests.map((quest) => quest.id)).toEqual(["q-2", "q-1"]);
    const requeuedQuest = requeued.value.quests.find((quest) => quest.id === "q-1");
    expect(requeuedQuest?.status).toBe("pending");
    expect(requeuedQuest).toBeDefined();
    if (!requeuedQuest) return;
    expect(Object.hasOwn(requeuedQuest, "currentCastId")).toBe(false);
    expect(validateQuestBoard(requeued.value).ok).toBe(true);
  });

  test("toggles runner state without aborting active quest state", () => {
    const board = boardWithTwoQuests();
    const enabled = enableQuestRunner(board, t1);
    expect(enabled.runner).toMatchObject({ enabled: true, lastStartedAt: t1 });

    const started = startQuest(enabled, { questId: "q-1", castId: "cast-1", now: t2 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const stopped = stopQuestRunner(started.value, t3);

    expect(stopped.runner.enabled).toBe(false);
    expect(stopped.runner.activeQuestId).toBe("q-1");
    expect(stopped.quests[0]?.status).toBe("running");
  });

  test("normalizes array-backed boards without adding a parallel order store", () => {
    const board = boardWithThreeQuests();
    const normalized = normalizeQuestBoard(board);

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.quests.map((quest) => quest.id)).toEqual(["q-1", "q-2", "q-3"]);
    expect("pendingOrder" in normalized.value).toBe(false);
  });

  test("migrates legacy board shapes by preserving array order and ignoring orphan order fields", () => {
    const board = {
      ...boardWithThreeQuests(),
      pendingOrder: ["orphan", "q-3", "q-1", "q-1"],
    } as QuestBoard & { pendingOrder: string[] };

    const normalized = normalizeQuestBoard(board);

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.quests.map((quest) => quest.id)).toEqual(["q-1", "q-2", "q-3"]);
    expect("pendingOrder" in normalized.value).toBe(false);
  });

  test("ordered quest view pins the active quest before canonical pending order", () => {
    const board = boardWithThreeQuests();
    const started = startQuest(board, { questId: "q-2", castId: "cast-2", now: t2 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(getOrderedQuestView(started.value).map((quest) => quest.id)).toEqual(["q-2", "q-1", "q-3"]);
  });

  test("moves pending quests within the canonical quest array order", () => {
    const board = boardWithThreeQuests();
    const movedAfter = movePendingQuest(board, { questId: "q-1", placement: "after", targetId: "q-3", now: t3 });
    expect(movedAfter.ok).toBe(true);
    if (!movedAfter.ok) return;
    expect(movedAfter.value.quests.map((quest) => quest.id)).toEqual(["q-2", "q-3", "q-1"]);
    expect(movedAfter.value.updatedAt).toBe(t3);

    const movedBefore = movePendingQuest(movedAfter.value, { questId: "q-1", placement: "before", targetId: "q-2", now: t3 });
    expect(movedBefore.ok).toBe(true);
    if (!movedBefore.ok) return;
    expect(movedBefore.value.quests.map((quest) => quest.id)).toEqual(["q-1", "q-2", "q-3"]);

    const movedFirst = movePendingQuest(movedBefore.value, { questId: "q-3", placement: "first", now: t3 });
    expect(movedFirst.ok).toBe(true);
    if (!movedFirst.ok) return;
    expect(movedFirst.value.quests.map((quest) => quest.id)).toEqual(["q-3", "q-1", "q-2"]);
  });

  test("handles no-op pending moves deterministically", () => {
    const board = boardWithThreeQuests();
    const moved = movePendingQuest(board, { questId: "q-1", placement: "first", now: t3 });

    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.value.quests.map((quest) => quest.id)).toEqual(["q-1", "q-2", "q-3"]);
    expect(moved.value.updatedAt).toBe(board.updatedAt);
  });

  test("rejects invalid pending quest moves without mutating the board", () => {
    const board = boardWithThreeQuests();
    const started = startQuest(board, { questId: "q-1", castId: "cast-1", now: t2 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const activeMove = movePendingQuest(started.value, { questId: "q-1", placement: "first", now: t3 });
    expect(activeMove.ok).toBe(false);
    if (!activeMove.ok) expect(activeMove.issues[0]?.message).toContain("not pending");
    expect(started.value.quests.map((quest) => quest.id)).toEqual(["q-1", "q-2", "q-3"]);

    const missingTarget = movePendingQuest(started.value, { questId: "q-2", placement: "before", targetId: "missing", now: t3 });
    expect(missingTarget.ok).toBe(false);
    if (!missingTarget.ok) expect(missingTarget.issues[0]?.path).toBe("targetId");

    const nonPendingTarget = movePendingQuest(started.value, { questId: "q-2", placement: "after", targetId: "q-1", now: t3 });
    expect(nonPendingTarget.ok).toBe(false);
    if (!nonPendingTarget.ok) expect(nonPendingTarget.issues.map((issue) => issue.path)).toContain("target.status");

    const duplicateBoard: QuestBoard = { ...board, quests: [board.quests[0]!, { ...board.quests[0]! }] };
    const duplicateMove = movePendingQuest(duplicateBoard, { questId: "q-1", placement: "first", now: t3 });
    expect(duplicateMove.ok).toBe(false);
    if (!duplicateMove.ok) expect(duplicateMove.issues.map((issue) => issue.message).join(" ")).toContain("duplicate quest id");
  });

  test("serializes and validates a completed quest board round trip", () => {
    const board = boardWithTwoQuests();
    const started = startQuest(board, { questId: "q-1", castId: "cast-1", now: t2 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const completed = completeQuest(started.value, {
      questId: "q-1",
      castId: "cast-1",
      now: t3,
      result: { status: "succeeded", message: "done", runDirectory: ".pi/pi-materia/cast-1", metadata: { immediateTerminal: true } },
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;

    const parsed = JSON.parse(JSON.stringify(completed.value));
    const validated = validateQuestBoard(parsed);

    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.value).toEqual(completed.value);
  });

  test("validates malformed persisted board shapes and invalid running invariants", () => {
    const board = boardWithTwoQuests();
    const startedOne = startQuest(board, { questId: "q-1", castId: "cast-1", now: t2 });
    expect(startedOne.ok).toBe(true);
    if (!startedOne.ok) return;
    const invalid: QuestBoard = {
      ...startedOne.value,
      runner: { enabled: true, activeQuestId: "q-2" },
      quests: [
        { ...startedOne.value.quests[0]!, attempts: -1, lastResult: { status: "running" as never, castId: "", finishedAt: "" } },
        { ...startedOne.value.quests[1]!, status: "running", currentCastId: "cast-2", attempts: 1 },
      ],
    };

    const validated = validateQuestBoard(invalid);
    expect(validated.ok).toBe(false);
    if (!validated.ok) {
      expect(validated.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
        "questBoard.quests",
        "questBoard.quests.0.attempts",
        "questBoard.quests.0.lastResult.status",
        "questBoard.quests.0.lastResult.castId",
      ]));
    }
  });
});

function boardWithTwoQuests(): QuestBoard {
  const first = addQuest(createQuestBoard({ now: t0 }), { id: "q-1", title: "First", prompt: "Do one", now: t1 });
  if (!first.ok) throw new Error("failed to add first quest");
  const second = addQuest(first.value, { id: "q-2", title: "Second", prompt: "Do two", now: t1 });
  if (!second.ok) throw new Error("failed to add second quest");
  return second.value;
}

function sequence(...values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

function boardWithThreeQuests(): QuestBoard {
  const board = boardWithTwoQuests();
  const third = addQuest(board, { id: "q-3", title: "Third", prompt: "Do three", now: t1 });
  if (!third.ok) throw new Error("failed to add third quest");
  return third.value;
}
