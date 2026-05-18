import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createEmptyQuestBoard, validateQuestBoard, type QuestBoard } from "../domain/questBoard.js";
import { issuesToMessage, type DomainIssue } from "../domain/result.js";
import type { QuestBoardRepository } from "../application/ports.js";

export const QUEST_BOARD_FILE_NAME = "quest-board.json";

export interface QuestBoardClock {
  now(): string;
}

export class QuestBoardPersistenceError extends Error {
  readonly file: string;
  readonly issues?: DomainIssue[];

  constructor(message: string, options: { file: string; issues?: DomainIssue[]; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "QuestBoardPersistenceError";
    this.file = options.file;
    this.issues = options.issues;
  }
}

/**
 * Project-local JSON repository for the quest board.
 *
 * This first vertical slice assumes a single writer per project. Multiple Pi
 * sessions writing the same <cwd>/.pi/pi-materia/quest-board.json concurrently
 * may race; writes are temp-file-plus-rename for crash safety but do not take a
 * heavyweight inter-process lock.
 */
export class FileQuestBoardRepository implements QuestBoardRepository {
  readonly boardPath: string;
  private readonly clock: QuestBoardClock;

  constructor(cwd: string, clock: QuestBoardClock = systemClock) {
    this.boardPath = getProjectQuestBoardPath(cwd);
    this.clock = clock;
  }

  async loadOrCreate(): Promise<QuestBoard> {
    await mkdir(path.dirname(this.boardPath), { recursive: true });
    if (!existsSync(this.boardPath)) {
      const board = createEmptyQuestBoard({ now: this.clock.now() });
      await writeJsonAtomic(this.boardPath, board);
      return board;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.boardPath, "utf8"));
    } catch (error) {
      throw new QuestBoardPersistenceError(`Quest board ${this.boardPath} is malformed JSON: ${error instanceof Error ? error.message : String(error)}`, { file: this.boardPath, cause: error });
    }

    const validated = validateQuestBoard(parsed, "questBoard");
    if (!validated.ok) {
      throw new QuestBoardPersistenceError(`Quest board ${this.boardPath} is invalid: ${issuesToMessage(validated.issues)}`, { file: this.boardPath, issues: validated.issues });
    }
    return validated.value;
  }

  async save(board: QuestBoard): Promise<void> {
    const validated = validateQuestBoard(board, "questBoard");
    if (!validated.ok) {
      throw new QuestBoardPersistenceError(`Refusing to write invalid quest board ${this.boardPath}: ${issuesToMessage(validated.issues)}`, { file: this.boardPath, issues: validated.issues });
    }
    await writeJsonAtomic(this.boardPath, validated.value);
  }
}

export function getProjectQuestBoardPath(cwd: string): string {
  return path.join(cwd, ".pi", "pi-materia", QUEST_BOARD_FILE_NAME);
}

const systemClock: QuestBoardClock = {
  now: () => new Date().toISOString(),
};

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.pi-materia.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  await mkdir(dir, { recursive: true });
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}
