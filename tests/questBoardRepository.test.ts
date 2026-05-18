import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { addQuest } from "../src/domain/questBoard.js";
import { FileQuestBoardRepository, getProjectQuestBoardPath, QuestBoardPersistenceError } from "../src/infrastructure/questBoardRepository.js";

async function tempProject(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "pi-materia-quest-board-"));
}

describe("quest board file repository", () => {
  test("uses the stable project-local quest board path", async () => {
    const cwd = await tempProject();
    const repo = new FileQuestBoardRepository(cwd, { now: () => "2026-05-18T00:00:00.000Z" });

    expect(repo.boardPath).toBe(path.join(cwd, ".pi", "pi-materia", "quest-board.json"));
    expect(getProjectQuestBoardPath(cwd)).toBe(repo.boardPath);
  });

  test("creates .pi/pi-materia and an initial empty board when missing", async () => {
    const cwd = await tempProject();
    const repo = new FileQuestBoardRepository(cwd, { now: () => "2026-05-18T00:00:00.000Z" });

    const board = await repo.loadOrCreate();

    expect(board).toEqual({
      version: 1,
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z",
      runner: { enabled: false },
      quests: [],
    });
    expect(JSON.parse(await readFile(repo.boardPath, "utf8"))).toEqual(board);
  });

  test("loads and validates an existing quest board", async () => {
    const cwd = await tempProject();
    const repo = new FileQuestBoardRepository(cwd, { now: () => "2026-05-18T00:00:00.000Z" });
    const initial = await repo.loadOrCreate();
    const added = addQuest(initial, { id: "q1", title: "One", prompt: "Do one", now: "2026-05-18T00:01:00.000Z" });
    if (!added.ok) throw new Error("expected add quest to succeed");
    await repo.save(added.value);

    const loaded = await new FileQuestBoardRepository(cwd).loadOrCreate();

    expect(loaded.quests.map((quest) => quest.id)).toEqual(["q1"]);
  });

  test("malformed JSON reports the file path and is not overwritten", async () => {
    const cwd = await tempProject();
    const file = getProjectQuestBoardPath(cwd);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{ not json", "utf8");
    const repo = new FileQuestBoardRepository(cwd, { now: () => "ignored" });

    await expect(repo.loadOrCreate()).rejects.toThrow(QuestBoardPersistenceError);
    await expect(repo.loadOrCreate()).rejects.toThrow(file);
    expect(await readFile(file, "utf8")).toBe("{ not json");
  });

  test("schema-invalid JSON reports path-specific errors and is not overwritten", async () => {
    const cwd = await tempProject();
    const file = getProjectQuestBoardPath(cwd);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, createdAt: "x", updatedAt: "x", runner: { enabled: "yes" }, quests: [] }), "utf8");
    const repo = new FileQuestBoardRepository(cwd, { now: () => "ignored" });

    await expect(repo.loadOrCreate()).rejects.toThrow(`${file} is invalid`);
    await expect(repo.loadOrCreate()).rejects.toThrow("questBoard.runner.enabled");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, createdAt: "x", updatedAt: "x", runner: { enabled: "yes" }, quests: [] });
  });

  test("save validates before writing and uses temp-file plus rename without leftovers", async () => {
    const cwd = await tempProject();
    const repo = new FileQuestBoardRepository(cwd, { now: () => "2026-05-18T00:00:00.000Z" });
    const board = await repo.loadOrCreate();
    const next = { ...board, updatedAt: "" };

    await expect(repo.save(next)).rejects.toThrow("Refusing to write invalid quest board");
    expect(JSON.parse(await readFile(repo.boardPath, "utf8"))).toEqual(board);

    await repo.save({ ...board, updatedAt: "2026-05-18T00:02:00.000Z" });
    expect(JSON.parse(await readFile(repo.boardPath, "utf8")).updatedAt).toBe("2026-05-18T00:02:00.000Z");
    expect((await readdir(path.dirname(repo.boardPath))).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});
