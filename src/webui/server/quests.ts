import { errorMessage, isPlainObject, readJsonBody, sendJson } from './http.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type QuestStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'blocked';

export interface QuestRunnerState {
  enabled: boolean;
  activeQuestId?: string;
  lastStartedAt?: string;
  lastStoppedAt?: string;
}

export interface QuestRunResult {
  status: Exclude<QuestStatus, 'pending' | 'running'>;
  castId: string;
  finishedAt: string;
  message?: string;
  error?: string;
  artifactDirectory?: string;
  runDirectory?: string;
  requestedLoadoutOverride?: string;
  effectiveLoadoutId?: string;
  effectiveLoadoutName?: string;
}

export interface QuestRunError {
  message: string;
  occurredAt: string;
  castId?: string;
  code?: string;
}

export interface Quest {
  id: string;
  title: string;
  prompt: string;
  status: QuestStatus;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  loadoutOverride?: string;
  currentCastId?: string;
  lastCastId?: string;
  lastResult?: QuestRunResult;
  lastError?: QuestRunError;
}

export interface QuestBoard {
  updatedAt: string;
  runner: QuestRunnerState;
  quests: Quest[];
}

export interface MateriaQuestBoardSource {
  boardPath: string;
  board: QuestBoard;
}

export interface MateriaAddQuestInput {
  prompt: string;
  loadoutOverride?: string;
}

export type MateriaAddQuestFailureCode = 'invalid_loadout' | 'unavailable' | 'validation_failed';

export type MateriaAddQuestResult =
  | { ok: true; boardPath: string; board: QuestBoard; quest: Quest }
  | { ok: false; code: MateriaAddQuestFailureCode; message: string };

export interface MateriaQuestRouteDeps {
  getQuestBoard?: () => Promise<MateriaQuestBoardSource>;
  addQuest?: (input: MateriaAddQuestInput) => Promise<MateriaAddQuestResult>;
}

export interface MateriaQuestSummary {
  id: string;
  title: string;
  prompt: string;
  promptPreview: string;
  status: QuestStatus;
  attempts: number;
  loadoutOverride?: string;
  createdAt: string;
  updatedAt: string;
  currentCastId?: string;
  lastCastId?: string;
  lastResult?: MateriaQuestRunResultSummary;
  lastError?: MateriaQuestRunErrorSummary;
}

export interface MateriaQuestRunResultSummary {
  status: QuestRunResult['status'];
  castId: string;
  finishedAt: string;
  message?: string;
  error?: string;
  artifactDirectory?: string;
  runDirectory?: string;
  requestedLoadoutOverride?: string;
  effectiveLoadoutId?: string;
  effectiveLoadoutName?: string;
}

export interface MateriaQuestRunErrorSummary {
  message: string;
  occurredAt: string;
  castId?: string;
  code?: string;
}

export interface MateriaQuestCounts {
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  blocked: number;
  completed: number;
  terminal: number;
}

export interface MateriaQuestBoardResponse {
  ok: true;
  boardPath: string;
  runner: QuestRunnerState;
  counts: MateriaQuestCounts;
  activeQuest?: MateriaQuestSummary;
  runningQuest?: MateriaQuestSummary;
  pendingQuests: MateriaQuestSummary[];
  completedQuests: MateriaQuestSummary[];
  failedQuests: MateriaQuestSummary[];
  quests: MateriaQuestSummary[];
  status: {
    statuses: QuestStatus[];
    activeQuestId?: string;
    updatedAt: string;
    generatedAt: string;
  };
}

export interface MateriaAddQuestResponse {
  ok: true;
  quest: MateriaQuestSummary;
  board: MateriaQuestBoardResponse;
}

export async function handleQuestRoute(req: IncomingMessage, res: ServerResponse, deps: MateriaQuestRouteDeps) {
  if (req.method === 'GET') {
    await handleGetQuestsRoute(res, deps);
    return;
  }
  if (req.method === 'POST') {
    await handlePostQuestRoute(req, res, deps);
    return;
  }
  sendJson(res, 405, { ok: false, error: 'Use GET to read quests or POST to add a quest.' });
}

export async function handleGetQuestsRoute(res: ServerResponse, deps: MateriaQuestRouteDeps) {
  if (!deps.getQuestBoard) {
    sendJson(res, 503, { ok: false, error: 'Quest API is unavailable for this server.' });
    return;
  }
  try {
    const source = await deps.getQuestBoard();
    sendJson(res, 200, mapQuestBoardResponse(source));
  } catch (error) {
    sendJson(res, 500, { ok: false, error: errorMessage(error) });
  }
}

export async function handlePostQuestRoute(req: IncomingMessage, res: ServerResponse, deps: MateriaQuestRouteDeps) {
  if (!deps.addQuest) {
    sendJson(res, 503, { ok: false, error: 'Quest add API is unavailable for this server.' });
    return;
  }
  try {
    const body = await readJsonBody(req);
    if (!isPlainObject(body)) throw new Error('Expected JSON object body.');
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) throw new Error('Quest prompt is required.');
    const rawLoadoutOverride = typeof body.loadoutOverride === 'string' ? body.loadoutOverride.trim() : undefined;
    const result = await deps.addQuest({ prompt, ...(rawLoadoutOverride ? { loadoutOverride: rawLoadoutOverride } : {}) });
    if (!result.ok) {
      sendJson(res, result.code === 'unavailable' ? 503 : 400, { ok: false, code: result.code, error: result.message });
      return;
    }
    const board = mapQuestBoardResponse(result);
    sendJson(res, 200, { ok: true, quest: mapQuest(result.quest), board } satisfies MateriaAddQuestResponse);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: errorMessage(error) });
  }
}

export function mapQuestBoardResponse(source: MateriaQuestBoardSource): MateriaQuestBoardResponse {
  const { board } = source;
  const runningQuest = board.quests.find((quest) => quest.status === 'running');
  const activeQuest = board.runner.activeQuestId ? board.quests.find((quest) => quest.id === board.runner.activeQuestId) ?? runningQuest : runningQuest;
  const pendingQuests = board.quests.filter((quest) => quest.status === 'pending').map(mapQuest);
  const completedQuests = board.quests.filter((quest) => quest.status === 'succeeded').map(mapQuest);
  const failedQuests = board.quests.filter((quest) => quest.status === 'failed' || quest.status === 'blocked').map(mapQuest);
  return {
    ok: true,
    boardPath: source.boardPath,
    runner: { ...board.runner },
    counts: countQuests(board.quests),
    ...(activeQuest ? { activeQuest: mapQuest(activeQuest) } : {}),
    ...(runningQuest ? { runningQuest: mapQuest(runningQuest) } : {}),
    pendingQuests,
    completedQuests,
    failedQuests,
    quests: board.quests.map(mapQuest),
    status: {
      statuses: ['pending', 'running', 'succeeded', 'failed', 'blocked'],
      ...(activeQuest ? { activeQuestId: activeQuest.id } : {}),
      updatedAt: board.updatedAt,
      generatedAt: new Date().toISOString(),
    },
  };
}

export function mapQuest(quest: Quest): MateriaQuestSummary {
  return {
    id: quest.id,
    title: quest.title,
    prompt: quest.prompt,
    promptPreview: preview(quest.prompt),
    status: quest.status,
    attempts: quest.attempts,
    ...(quest.loadoutOverride ? { loadoutOverride: quest.loadoutOverride } : {}),
    createdAt: quest.createdAt,
    updatedAt: quest.updatedAt,
    ...(quest.currentCastId ? { currentCastId: quest.currentCastId } : {}),
    ...(quest.lastCastId ? { lastCastId: quest.lastCastId } : {}),
    ...(quest.lastResult ? { lastResult: mapRunResult(quest.lastResult) } : {}),
    ...(quest.lastError ? { lastError: mapRunError(quest.lastError) } : {}),
  };
}

function countQuests(quests: Quest[]): MateriaQuestCounts {
  const counts: MateriaQuestCounts = { total: quests.length, pending: 0, running: 0, succeeded: 0, failed: 0, blocked: 0, completed: 0, terminal: 0 };
  for (const quest of quests) counts[quest.status] += 1;
  counts.completed = counts.succeeded;
  counts.terminal = counts.succeeded + counts.failed + counts.blocked;
  return counts;
}

function mapRunResult(result: QuestRunResult): MateriaQuestRunResultSummary {
  return {
    status: result.status,
    castId: result.castId,
    finishedAt: result.finishedAt,
    ...(result.message ? { message: result.message } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.artifactDirectory ? { artifactDirectory: result.artifactDirectory } : {}),
    ...(result.runDirectory ? { runDirectory: result.runDirectory } : {}),
    ...(result.requestedLoadoutOverride ? { requestedLoadoutOverride: result.requestedLoadoutOverride } : {}),
    ...(result.effectiveLoadoutId ? { effectiveLoadoutId: result.effectiveLoadoutId } : {}),
    ...(result.effectiveLoadoutName ? { effectiveLoadoutName: result.effectiveLoadoutName } : {}),
  };
}

function mapRunError(error: QuestRunError): MateriaQuestRunErrorSummary {
  return {
    message: error.message,
    occurredAt: error.occurredAt,
    ...(error.castId ? { castId: error.castId } : {}),
    ...(error.code ? { code: error.code } : {}),
  };
}

function preview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}
