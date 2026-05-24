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
  effectiveLoadoutSource?: string;
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

export type MateriaQuestReorderPlacement = 'first' | 'before' | 'after';

export interface MateriaReorderQuestInput {
  questId: string;
  placement: MateriaQuestReorderPlacement;
  targetId?: string;
}

export interface MateriaRequeueQuestInput {
  questId: string;
}

export interface MateriaUpdateQuestInput {
  questId: string;
  prompt: string;
  loadoutOverride?: string;
}

export type MateriaQuestMutationFailureCode = 'invalid_loadout' | 'unavailable' | 'validation_failed' | 'active_cast_conflict' | 'active_quest_conflict';

export type MateriaQuestControlAction = 'run' | 'runonce' | 'stop';

export type MateriaQuestNoStartReason = 'runner_stopped' | 'active_cast' | 'running_quest' | 'waiting' | 'not_found' | 'safety_limit' | 'unavailable';

export interface MateriaQuestControlInput {
  questId?: string;
}

export type MateriaAddQuestResult =
  | { ok: true; boardPath: string; board: QuestBoard; quest: Quest }
  | { ok: false; code: MateriaQuestMutationFailureCode; message: string };

export type MateriaReorderQuestResult =
  | { ok: true; boardPath: string; board: QuestBoard; quest: Quest; target?: Quest }
  | { ok: false; code: MateriaQuestMutationFailureCode; message: string };

export type MateriaRequeueQuestResult =
  | { ok: true; boardPath: string; board: QuestBoard; quest: Quest }
  | { ok: false; code: MateriaQuestMutationFailureCode; message: string };

export type MateriaUpdateQuestResult =
  | { ok: true; boardPath: string; board: QuestBoard; quest: Quest }
  | { ok: false; code: MateriaQuestMutationFailureCode; message: string };

export type MateriaQuestControlResult =
  | { ok: true; boardPath: string; board: QuestBoard; action: MateriaQuestControlAction; started?: { quest: Quest; castId: string; currentSocketId?: string; artifactRoot?: string; runDir?: string }; reason?: MateriaQuestNoStartReason; message: string }
  | { ok: false; code: MateriaQuestMutationFailureCode; message: string };

export interface MateriaQuestRouteDeps {
  runQuest?: (input: MateriaQuestControlInput) => Promise<MateriaQuestControlResult>;
  runQuestOnce?: (input: MateriaQuestControlInput) => Promise<MateriaQuestControlResult>;
  stopQuestRunner?: () => Promise<MateriaQuestControlResult>;
  getQuestBoard?: () => Promise<MateriaQuestBoardSource>;
  addQuest?: (input: MateriaAddQuestInput) => Promise<MateriaAddQuestResult>;
  updateQuest?: (input: MateriaUpdateQuestInput) => Promise<MateriaUpdateQuestResult>;
  reorderQuest?: (input: MateriaReorderQuestInput) => Promise<MateriaReorderQuestResult>;
  requeueQuest?: (input: MateriaRequeueQuestInput) => Promise<MateriaRequeueQuestResult>;
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
  effectiveLoadoutSource?: string;
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

export interface MateriaUpdateQuestResponse {
  ok: true;
  quest: MateriaQuestSummary;
  board: MateriaQuestBoardResponse;
}

export interface MateriaQuestControlResponse {
  ok: true;
  action: MateriaQuestControlAction;
  board: MateriaQuestBoardResponse;
  message: string;
  reason?: MateriaQuestNoStartReason;
  started?: {
    quest: MateriaQuestSummary;
    castId: string;
    currentSocketId?: string;
    artifactRoot?: string;
    runDir?: string;
  };
}

export async function handleQuestRoute(req: IncomingMessage, res: ServerResponse, deps: MateriaQuestRouteDeps) {
  const pathname = req.url ? new URL(req.url, 'http://localhost').pathname : '';
  if (pathname === '/api/quests/runonce') {
    await handleRunQuestOnceRoute(req, res, deps);
    return;
  }
  if (pathname === '/api/quests/run') {
    await handleRunQuestRoute(req, res, deps);
    return;
  }
  if (pathname === '/api/quests/stop') {
    await handleStopQuestRunnerRoute(req, res, deps);
    return;
  }
  if (req.url?.startsWith('/api/quests/requeue')) {
    await handleRequeueQuestRoute(req, res, deps);
    return;
  }
  if (req.url?.startsWith('/api/quests/reorder')) {
    await handleReorderQuestRoute(req, res, deps);
    return;
  }
  if (req.method === 'GET') {
    await handleGetQuestsRoute(res, deps);
    return;
  }
  if (req.method === 'POST') {
    await handlePostQuestRoute(req, res, deps);
    return;
  }
  if (req.method === 'PATCH') {
    await handlePatchQuestRoute(req, res, deps);
    return;
  }
  sendJson(res, 405, { ok: false, error: 'Use GET to read quests, POST to add a quest, PATCH /api/quests/:questId to edit a pending quest, or POST /api/quests/reorder to reorder quests.' });
}

export async function handleRunQuestRoute(req: IncomingMessage, res: ServerResponse, deps: MateriaQuestRouteDeps) {
  await handleQuestControlRoute(req, res, deps.runQuest, 'run', 'Use POST to run quests.');
}

export async function handleRunQuestOnceRoute(req: IncomingMessage, res: ServerResponse, deps: MateriaQuestRouteDeps) {
  await handleQuestControlRoute(req, res, deps.runQuestOnce, 'runonce', 'Use POST to run one quest.');
}

export async function handleStopQuestRunnerRoute(req: IncomingMessage, res: ServerResponse, deps: MateriaQuestRouteDeps) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Use POST to stop the quest runner.' });
    return;
  }
  if (!deps.stopQuestRunner) {
    sendJson(res, 503, { ok: false, error: 'Quest runner control API is unavailable for this server.' });
    return;
  }
  try {
    const body = await readJsonBody(req);
    if (!isPlainObject(body)) throw new Error('Expected JSON object body.');
    if (Object.keys(body).length > 0) throw new Error('Stop does not accept a request body.');
    await sendQuestControlResult(res, deps.stopQuestRunner());
  } catch (error) {
    sendJson(res, 400, { ok: false, error: errorMessage(error) });
  }
}

async function handleQuestControlRoute(req: IncomingMessage, res: ServerResponse, callback: ((input: MateriaQuestControlInput) => Promise<MateriaQuestControlResult>) | undefined, action: 'run' | 'runonce', methodError: string) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: methodError });
    return;
  }
  if (!callback) {
    sendJson(res, 503, { ok: false, error: 'Quest runner control API is unavailable for this server.' });
    return;
  }
  try {
    const body = await readJsonBody(req);
    if (!isPlainObject(body)) throw new Error('Expected JSON object body.');
    const keys = Object.keys(body);
    if (keys.some((key) => key !== 'questId')) throw new Error('Only questId is accepted.');
    const questId = typeof body.questId === 'string' ? body.questId.trim() : undefined;
    if (body.questId !== undefined && !questId) throw new Error('questId must be a non-empty string.');
    await sendQuestControlResult(res, callback({ ...(questId ? { questId } : {}) }));
  } catch (error) {
    sendJson(res, 400, { ok: false, error: errorMessage(error) });
  }
}

async function sendQuestControlResult(res: ServerResponse, pendingResult: Promise<MateriaQuestControlResult>) {
  const result = await pendingResult;
  if (!result.ok) {
    sendJson(res, result.code === 'unavailable' ? 503 : 400, { ok: false, code: result.code, error: result.message });
    return;
  }
  sendJson(res, 200, mapQuestControlResponse(result));
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

export async function handlePatchQuestRoute(req: IncomingMessage, res: ServerResponse, deps: MateriaQuestRouteDeps) {
  if (!deps.updateQuest) {
    sendJson(res, 503, { ok: false, error: 'Quest update API is unavailable for this server.' });
    return;
  }
  try {
    const questId = questIdFromPatchUrl(req.url);
    if (!questId) throw new Error('Quest id is required.');
    const body = await readJsonBody(req);
    if (!isPlainObject(body)) throw new Error('Expected JSON object body.');
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) throw new Error('Quest prompt is required.');
    const rawLoadoutOverride = typeof body.loadoutOverride === 'string' ? body.loadoutOverride.trim() : undefined;
    const result = await deps.updateQuest({ questId, prompt, ...(rawLoadoutOverride ? { loadoutOverride: rawLoadoutOverride } : {}) });
    if (!result.ok) {
      sendJson(res, result.code === 'unavailable' ? 503 : 400, { ok: false, code: result.code, error: result.message });
      return;
    }
    const board = mapQuestBoardResponse(result);
    sendJson(res, 200, { ok: true, quest: mapQuest(result.quest), board } satisfies MateriaUpdateQuestResponse);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: errorMessage(error) });
  }
}

export async function handleRequeueQuestRoute(req: IncomingMessage, res: ServerResponse, deps: MateriaQuestRouteDeps) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Use POST to requeue quests.' });
    return;
  }
  if (!deps.requeueQuest) {
    sendJson(res, 503, { ok: false, error: 'Quest requeue API is unavailable for this server.' });
    return;
  }
  try {
    const body = await readJsonBody(req);
    if (!isPlainObject(body)) throw new Error('Expected JSON object body.');
    const questId = typeof body.questId === 'string' ? body.questId.trim() : '';
    if (!questId) throw new Error('Quest id is required.');
    const result = await deps.requeueQuest({ questId });
    if (!result.ok) {
      sendJson(res, result.code === 'unavailable' ? 503 : 400, { ok: false, code: result.code, error: result.message });
      return;
    }
    sendJson(res, 200, mapQuestBoardResponse(result));
  } catch (error) {
    sendJson(res, 400, { ok: false, error: errorMessage(error) });
  }
}

export async function handleReorderQuestRoute(req: IncomingMessage, res: ServerResponse, deps: MateriaQuestRouteDeps) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Use POST to reorder quests.' });
    return;
  }
  if (!deps.reorderQuest) {
    sendJson(res, 503, { ok: false, error: 'Quest reorder API is unavailable for this server.' });
    return;
  }
  try {
    const body = await readJsonBody(req);
    if (!isPlainObject(body)) throw new Error('Expected JSON object body.');
    const questId = typeof body.questId === 'string' ? body.questId.trim() : '';
    if (!questId) throw new Error('Quest id is required.');
    const placement = typeof body.placement === 'string' ? body.placement.trim() : '';
    if (!isQuestReorderPlacement(placement)) throw new Error('Quest placement must be first, before, or after.');
    const rawTargetId = typeof body.targetId === 'string' ? body.targetId.trim() : undefined;
    const result = await deps.reorderQuest({ questId, placement, ...(rawTargetId ? { targetId: rawTargetId } : {}) });
    if (!result.ok) {
      sendJson(res, result.code === 'unavailable' ? 503 : 400, { ok: false, code: result.code, error: result.message });
      return;
    }
    sendJson(res, 200, mapQuestBoardResponse(result));
  } catch (error) {
    sendJson(res, 400, { ok: false, error: errorMessage(error) });
  }
}

function isQuestReorderPlacement(value: string): value is MateriaQuestReorderPlacement {
  return value === 'first' || value === 'before' || value === 'after';
}

function questIdFromPatchUrl(url: string | undefined): string {
  if (!url) return '';
  const pathname = new URL(url, 'http://localhost').pathname;
  const match = /^\/api\/quests\/([^/]+)$/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]).trim() : '';
}

export function mapQuestControlResponse(result: Extract<MateriaQuestControlResult, { ok: true }>): MateriaQuestControlResponse {
  return {
    ok: true,
    action: result.action,
    board: mapQuestBoardResponse(result),
    message: result.message,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.started ? {
      started: {
        quest: mapQuest(result.started.quest),
        castId: result.started.castId,
        ...(result.started.currentSocketId ? { currentSocketId: result.started.currentSocketId } : {}),
        ...(result.started.artifactRoot ? { artifactRoot: result.started.artifactRoot } : {}),
        ...(result.started.runDir ? { runDir: result.started.runDir } : {}),
      },
    } : {}),
  };
}

export function mapQuestBoardResponse(source: MateriaQuestBoardSource): MateriaQuestBoardResponse {
  const { board } = source;
  const runningQuest = board.quests.find((quest) => quest.status === 'running');
  const activeQuest = board.runner.activeQuestId ? board.quests.find((quest) => quest.id === board.runner.activeQuestId) ?? runningQuest : runningQuest;
  const pendingQuests = board.quests.filter((quest) => quest.status === 'pending').map(mapQuest);
  const completedQuests = sortCompletedQuestsByCompletionTime(board.quests).map(mapQuest);
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

function sortCompletedQuestsByCompletionTime(quests: Quest[]): Quest[] {
  return quests
    .map((quest, index) => ({ quest, index, completedAt: completionTimeMs(quest) }))
    .filter(({ quest }) => quest.status === 'succeeded')
    .sort((left, right) => right.completedAt - left.completedAt || left.index - right.index)
    .map(({ quest }) => quest);
}

function completionTimeMs(quest: Quest): number {
  return validTimeMs(quest.lastResult?.finishedAt) ?? validTimeMs(quest.updatedAt) ?? Number.NEGATIVE_INFINITY;
}

function validTimeMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
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
    ...(result.effectiveLoadoutSource ? { effectiveLoadoutSource: result.effectiveLoadoutSource } : {}),
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
