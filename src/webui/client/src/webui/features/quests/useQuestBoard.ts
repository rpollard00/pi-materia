import { useCallback, useEffect, useRef, useState } from 'react';
import { addQuest as postQuest, getQuests, reorderQuest as postReorderQuest, requeueQuest as postRequeueQuest, runQuest as postRunQuest, runQuestOnce as postRunQuestOnce, stopQuestRunner as postStopQuestRunner, updateQuest as patchQuest } from '../../api/index.js';
import type { AddQuestRequest, AddQuestResponse, QuestBoardResponse, QuestControlAction, QuestControlRequest, QuestControlResponse, QuestCounts, QuestRunnerState, QuestStatus, QuestSummary, ReorderQuestRequest, RequeueQuestRequest, UpdateQuestRequest, UpdateQuestResponse } from '../../types.js';

export const QUEST_BOARD_POLL_INTERVAL_MS = 5000;

const QUEST_STATUSES: QuestStatus[] = ['pending', 'running', 'succeeded', 'failed', 'blocked'];

const EMPTY_COUNTS: QuestCounts = {
  total: 0,
  pending: 0,
  running: 0,
  succeeded: 0,
  failed: 0,
  blocked: 0,
  completed: 0,
  terminal: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isQuestStatus(value: unknown): value is QuestStatus {
  return typeof value === 'string' && QUEST_STATUSES.includes(value as QuestStatus);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function requiredString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function normalizeQuestSummary(value: unknown): QuestSummary | undefined {
  if (!isRecord(value) || typeof value.id !== 'string') return undefined;
  const status = isQuestStatus(value.status) ? value.status : 'pending';
  const prompt = requiredString(value.prompt, '');
  const promptPreview = requiredString(value.promptPreview, prompt.replace(/\s+/g, ' ').trim().slice(0, 180));
  const attempts = typeof value.attempts === 'number' && Number.isFinite(value.attempts) ? value.attempts : 0;
  const quest: QuestSummary = {
    id: value.id,
    title: requiredString(value.title, value.id),
    prompt,
    promptPreview,
    status,
    attempts,
    createdAt: requiredString(value.createdAt, ''),
    updatedAt: requiredString(value.updatedAt, ''),
  };
  const loadoutOverride = optionalString(value.loadoutOverride);
  if (loadoutOverride) quest.loadoutOverride = loadoutOverride;
  const currentCastId = optionalString(value.currentCastId);
  if (currentCastId) quest.currentCastId = currentCastId;
  const lastCastId = optionalString(value.lastCastId);
  if (lastCastId) quest.lastCastId = lastCastId;
  if (isRecord(value.lastResult)) {
    const resultStatus = isQuestStatus(value.lastResult.status) && value.lastResult.status !== 'pending' && value.lastResult.status !== 'running'
      ? value.lastResult.status
      : undefined;
    const castId = optionalString(value.lastResult.castId);
    const finishedAt = optionalString(value.lastResult.finishedAt);
    if (resultStatus && castId && finishedAt) {
      quest.lastResult = {
        status: resultStatus,
        castId,
        finishedAt,
        ...(optionalString(value.lastResult.message) ? { message: optionalString(value.lastResult.message) } : {}),
        ...(optionalString(value.lastResult.error) ? { error: optionalString(value.lastResult.error) } : {}),
        ...(optionalString(value.lastResult.artifactDirectory) ? { artifactDirectory: optionalString(value.lastResult.artifactDirectory) } : {}),
        ...(optionalString(value.lastResult.runDirectory) ? { runDirectory: optionalString(value.lastResult.runDirectory) } : {}),
        ...(optionalString(value.lastResult.requestedLoadoutOverride) ? { requestedLoadoutOverride: optionalString(value.lastResult.requestedLoadoutOverride) } : {}),
        ...(optionalString(value.lastResult.effectiveLoadoutId) ? { effectiveLoadoutId: optionalString(value.lastResult.effectiveLoadoutId) } : {}),
        ...(optionalString(value.lastResult.effectiveLoadoutName) ? { effectiveLoadoutName: optionalString(value.lastResult.effectiveLoadoutName) } : {}),
        ...(optionalString(value.lastResult.effectiveLoadoutSource) ? { effectiveLoadoutSource: optionalString(value.lastResult.effectiveLoadoutSource) } : {}),
      };
    }
  }
  if (isRecord(value.lastError) && typeof value.lastError.message === 'string' && typeof value.lastError.occurredAt === 'string') {
    quest.lastError = {
      message: value.lastError.message,
      occurredAt: value.lastError.occurredAt,
      ...(optionalString(value.lastError.castId) ? { castId: optionalString(value.lastError.castId) } : {}),
      ...(optionalString(value.lastError.code) ? { code: optionalString(value.lastError.code) } : {}),
    };
  }
  return quest;
}

function normalizeQuestList(value: unknown): QuestSummary[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeQuestSummary).filter((quest): quest is QuestSummary => Boolean(quest));
}

function normalizeCounts(value: unknown, quests: QuestSummary[]): QuestCounts {
  if (isRecord(value)) {
    return {
      total: numberOr(value.total, quests.length),
      pending: numberOr(value.pending, quests.filter((quest) => quest.status === 'pending').length),
      running: numberOr(value.running, quests.filter((quest) => quest.status === 'running').length),
      succeeded: numberOr(value.succeeded, quests.filter((quest) => quest.status === 'succeeded').length),
      failed: numberOr(value.failed, quests.filter((quest) => quest.status === 'failed').length),
      blocked: numberOr(value.blocked, quests.filter((quest) => quest.status === 'blocked').length),
      completed: numberOr(value.completed, quests.filter((quest) => quest.status === 'succeeded').length),
      terminal: numberOr(value.terminal, quests.filter((quest) => quest.status === 'succeeded' || quest.status === 'failed' || quest.status === 'blocked').length),
    };
  }
  return { ...EMPTY_COUNTS, total: quests.length };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeRunner(value: unknown): QuestRunnerState {
  if (!isRecord(value)) return { enabled: false };
  return {
    enabled: value.enabled === true,
    ...(optionalString(value.activeQuestId) ? { activeQuestId: optionalString(value.activeQuestId) } : {}),
    ...(optionalString(value.lastStartedAt) ? { lastStartedAt: optionalString(value.lastStartedAt) } : {}),
    ...(optionalString(value.lastStoppedAt) ? { lastStoppedAt: optionalString(value.lastStoppedAt) } : {}),
  };
}

export function normalizeQuestBoardResponse(value: unknown): QuestBoardResponse | undefined {
  if (!isRecord(value) || value.ok === false) return undefined;
  const quests = normalizeQuestList(value.quests);
  const activeQuest = normalizeQuestSummary(value.activeQuest);
  const runningQuest = normalizeQuestSummary(value.runningQuest);
  const pendingQuests = normalizeQuestList(value.pendingQuests);
  const completedQuests = normalizeQuestList(value.completedQuests);
  const failedQuests = normalizeQuestList(value.failedQuests);
  const status = isRecord(value.status) ? value.status : {};
  return {
    ok: true,
    boardPath: optionalString(value.boardPath),
    runner: normalizeRunner(value.runner),
    counts: normalizeCounts(value.counts, quests),
    ...(activeQuest ? { activeQuest } : {}),
    ...(runningQuest ? { runningQuest } : {}),
    pendingQuests,
    completedQuests,
    failedQuests,
    quests,
    status: {
      statuses: Array.isArray(status.statuses) ? status.statuses.filter(isQuestStatus) : QUEST_STATUSES,
      ...(optionalString(status.activeQuestId) ? { activeQuestId: optionalString(status.activeQuestId) } : {}),
      updatedAt: optionalString(status.updatedAt),
      generatedAt: optionalString(status.generatedAt),
    },
  };
}

function responseError(body: { error?: unknown; code?: string } | undefined, fallback: string): string {
  if (typeof body?.error === 'string') return body.error;
  if (isRecord(body?.error) && typeof body.error.message === 'string') return body.error.message;
  return body?.code ? `${fallback} (${body.code})` : fallback;
}

export function useQuestBoard() {
  const [board, setBoard] = useState<QuestBoardResponse>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [reorderSubmitting, setReorderSubmitting] = useState(false);
  const [requeueSubmitting, setRequeueSubmitting] = useState(false);
  const [updateSubmitting, setUpdateSubmitting] = useState(false);
  const [controlSubmitting, setControlSubmitting] = useState(false);
  const [controlAction, setControlAction] = useState<QuestControlAction>();
  const [error, setError] = useState<string>();
  const mountedRef = useRef(false);
  const refreshSeqRef = useRef(0);
  const mutationSeqRef = useRef(0);
  const reorderSeqRef = useRef(0);
  const requeueSeqRef = useRef(0);
  const updateSeqRef = useRef(0);
  const controlSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    try {
      const body = await getQuests();
      const normalized = normalizeQuestBoardResponse(body);
      if (!mountedRef.current || seq !== refreshSeqRef.current) return undefined;
      if (!normalized) throw new Error(responseError(body, 'Quest board response was not usable.'));
      setBoard(normalized);
      setError(undefined);
      return normalized;
    } catch (caught) {
      if (mountedRef.current && seq === refreshSeqRef.current) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
      return undefined;
    } finally {
      if (mountedRef.current && seq === refreshSeqRef.current) setLoading(false);
    }
  }, []);

  const add = useCallback(async (payload: AddQuestRequest): Promise<AddQuestResponse | undefined> => {
    setSubmitting(true);
    try {
      const result = await postQuest(payload);
      if (!mountedRef.current) return undefined;
      if (!result.response.ok || result.body.ok !== true) throw new Error(responseError(result.body, `Quest add failed with HTTP ${result.response.status}`));
      const normalizedBoard = normalizeQuestBoardResponse(result.body.board);
      if (normalizedBoard) {
        ++refreshSeqRef.current;
        setBoard(normalizedBoard);
        setLoading(false);
      }
      await refresh();
      setError(undefined);
      return result.body;
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : String(caught));
      return undefined;
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }, [refresh]);

  const update = useCallback(async (questId: string, payload: UpdateQuestRequest): Promise<UpdateQuestResponse | undefined> => {
    const mutationSeq = ++mutationSeqRef.current;
    const updateSeq = ++updateSeqRef.current;
    setUpdateSubmitting(true);
    try {
      const result = await patchQuest(questId, payload);
      if (!mountedRef.current || mutationSeq !== mutationSeqRef.current) return undefined;
      if (!result.response.ok || result.body.ok !== true) throw new Error(responseError(result.body, `Quest update failed with HTTP ${result.response.status}`));
      const normalizedBoard = normalizeQuestBoardResponse(result.body.board);
      if (normalizedBoard) {
        ++refreshSeqRef.current;
        setBoard(normalizedBoard);
        setLoading(false);
      }
      setError(undefined);
      return result.body;
    } catch (caught) {
      if (mountedRef.current && mutationSeq === mutationSeqRef.current) setError(caught instanceof Error ? caught.message : String(caught));
      return undefined;
    } finally {
      if (mountedRef.current && updateSeq === updateSeqRef.current) setUpdateSubmitting(false);
    }
  }, []);

  const reorder = useCallback(async (payload: ReorderQuestRequest): Promise<QuestBoardResponse | undefined> => {
    const mutationSeq = ++mutationSeqRef.current;
    const reorderSeq = ++reorderSeqRef.current;
    setReorderSubmitting(true);
    try {
      const result = await postReorderQuest(payload);
      if (!mountedRef.current || mutationSeq !== mutationSeqRef.current) return undefined;
      if (!result.response.ok || result.body.ok === false) throw new Error(responseError(result.body, `Quest reorder failed with HTTP ${result.response.status}`));
      const normalizedBoard = normalizeQuestBoardResponse(result.body);
      if (!normalizedBoard) throw new Error(responseError(result.body, 'Quest reorder response was not usable.'));
      ++refreshSeqRef.current;
      setBoard(normalizedBoard);
      setLoading(false);
      setError(undefined);
      return normalizedBoard;
    } catch (caught) {
      if (mountedRef.current && mutationSeq === mutationSeqRef.current) setError(caught instanceof Error ? caught.message : String(caught));
      return undefined;
    } finally {
      if (mountedRef.current && reorderSeq === reorderSeqRef.current) setReorderSubmitting(false);
    }
  }, []);

  const requeue = useCallback(async (payload: RequeueQuestRequest): Promise<QuestBoardResponse | undefined> => {
    const mutationSeq = ++mutationSeqRef.current;
    const requeueSeq = ++requeueSeqRef.current;
    setRequeueSubmitting(true);
    try {
      const result = await postRequeueQuest(payload);
      if (!mountedRef.current || mutationSeq !== mutationSeqRef.current) return undefined;
      if (!result.response.ok || result.body.ok === false) throw new Error(responseError(result.body, `Quest requeue failed with HTTP ${result.response.status}`));
      const normalizedBoard = normalizeQuestBoardResponse(result.body);
      if (!normalizedBoard) throw new Error(responseError(result.body, 'Quest requeue response was not usable.'));
      ++refreshSeqRef.current;
      setBoard(normalizedBoard);
      setLoading(false);
      setError(undefined);
      return normalizedBoard;
    } catch (caught) {
      if (mountedRef.current && mutationSeq === mutationSeqRef.current) setError(caught instanceof Error ? caught.message : String(caught));
      return undefined;
    } finally {
      if (mountedRef.current && requeueSeq === requeueSeqRef.current) setRequeueSubmitting(false);
    }
  }, []);

  const applyControlResult = useCallback(async (action: QuestControlAction, request: () => Promise<{ response: Response; body: QuestControlResponse }>): Promise<QuestControlResponse | undefined> => {
    const controlSeq = ++controlSeqRef.current;
    setControlAction(action);
    setControlSubmitting(true);
    try {
      const result = await request();
      if (!mountedRef.current || controlSeq !== controlSeqRef.current) return undefined;
      if (!result.response.ok || result.body.ok !== true) throw new Error(responseError(result.body, `Quest ${action} failed with HTTP ${result.response.status}`));
      const normalizedBoard = normalizeQuestBoardResponse(result.body.board);
      if (!normalizedBoard) throw new Error(responseError(result.body, `Quest ${action} response was not usable.`));
      ++refreshSeqRef.current;
      setBoard(normalizedBoard);
      setLoading(false);
      setError(undefined);
      await refresh();
      return result.body;
    } catch (caught) {
      if (mountedRef.current && controlSeq === controlSeqRef.current) setError(caught instanceof Error ? caught.message : String(caught));
      return undefined;
    } finally {
      if (mountedRef.current && controlSeq === controlSeqRef.current) {
        setControlSubmitting(false);
        setControlAction(undefined);
      }
    }
  }, [refresh]);

  const runQuest = useCallback((payload: QuestControlRequest = {}) => applyControlResult('run', () => postRunQuest(payload)), [applyControlResult]);

  const runQuestOnce = useCallback((payload: QuestControlRequest = {}) => applyControlResult('runonce', () => postRunQuestOnce(payload)), [applyControlResult]);

  const stopQuestRunner = useCallback(() => applyControlResult('stop', () => postStopQuestRunner()), [applyControlResult]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, QUEST_BOARD_POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      refreshSeqRef.current += 1;
      controlSeqRef.current += 1;
      window.clearInterval(interval);
    };
  }, [refresh]);

  return { board, loading, error, refresh, add, submitting, update, updateSubmitting, reorder, reorderSubmitting, requeue, requeueSubmitting, runQuest, runQuestOnce, stopQuestRunner, controlSubmitting, controlAction };
}
