import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { QuestBoardResponse, QuestControlResponse, QuestSummary } from '../../types.js';
import { useQuestBoard } from './useQuestBoard.js';
import * as api from '../../api/index.js';

vi.mock('../../api/index.js', () => ({
  getQuests: vi.fn(),
  addQuest: vi.fn(),
  updateQuest: vi.fn(),
  reorderQuest: vi.fn(),
  requeueQuest: vi.fn(),
  deleteQuest: vi.fn(),
  runQuest: vi.fn(),
  runQuestOnce: vi.fn(),
  stopQuestRunner: vi.fn(),
}));

const mockedApi = vi.mocked(api);
const now = '2026-05-19T19:00:00.000Z';

function quest(id: string, status: QuestSummary['status'], title = id): QuestSummary {
  return { id, title, prompt: `${title} prompt`, promptPreview: `${title} prompt`, status, attempts: status === 'pending' ? 0 : 1, createdAt: now, updatedAt: now };
}

function board(quests: QuestSummary[], extras: Partial<QuestBoardResponse> = {}): QuestBoardResponse {
  const runningQuest = quests.find((candidate) => candidate.status === 'running');
  return {
    ok: true,
    boardPath: '/tmp/quest-board.json',
    runner: { enabled: false, ...(runningQuest ? { activeQuestId: runningQuest.id } : {}) },
    activeQuest: runningQuest,
    runningQuest,
    pendingQuests: quests.filter((candidate) => candidate.status === 'pending'),
    completedQuests: quests.filter((candidate) => candidate.status === 'succeeded'),
    failedQuests: quests.filter((candidate) => candidate.status === 'failed' || candidate.status === 'blocked'),
    quests,
    counts: {
      total: quests.length,
      pending: quests.filter((candidate) => candidate.status === 'pending').length,
      running: quests.filter((candidate) => candidate.status === 'running').length,
      succeeded: quests.filter((candidate) => candidate.status === 'succeeded').length,
      failed: quests.filter((candidate) => candidate.status === 'failed').length,
      blocked: quests.filter((candidate) => candidate.status === 'blocked').length,
      completed: quests.filter((candidate) => candidate.status === 'succeeded').length,
      terminal: quests.filter((candidate) => candidate.status === 'succeeded' || candidate.status === 'failed' || candidate.status === 'blocked').length,
    },
    status: { statuses: ['pending', 'running', 'succeeded', 'failed', 'blocked'], updatedAt: now, generatedAt: now, ...(runningQuest ? { activeQuestId: runningQuest.id } : {}) },
    ...extras,
  };
}

let latest: ReturnType<typeof useQuestBoard> | undefined;
function Harness() {
  latest = useQuestBoard();
  return (
    <div>
      <span data-testid="loading">{String(latest.loading)}</span>
      <span data-testid="controlSubmitting">{String(latest.controlSubmitting)}</span>
      <span data-testid="controlAction">{latest.controlAction ?? ''}</span>
      <span data-testid="error">{latest.error ?? ''}</span>
      <span data-testid="deleteSubmitting">{String(latest.deleteSubmitting)}</span>
      <span data-testid="deletingQuestId">{latest.deletingQuestId ?? ''}</span>
      <span data-testid="pending">{latest.board?.pendingQuests?.map((candidate) => candidate.id).join(',') ?? ''}</span>
      <span data-testid="running">{latest.board?.runningQuest?.id ?? ''}</span>
    </div>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  latest = undefined;
});

describe('useQuestBoard quest controls', () => {
  test('posts run payloads, normalizes returned board, exposes control state, and refreshes after success', async () => {
    const initial = board([quest('quest-pending', 'pending', 'Pending')]);
    const returned = {
      ok: true,
      runner: { enabled: true, activeQuestId: 'quest-pending' },
      quests: [{ id: 'quest-pending', title: 'Pending', status: 'running' }],
      pendingQuests: [],
      completedQuests: [],
      failedQuests: [],
      counts: { total: 1, pending: 0, running: 1, succeeded: 0, failed: 0, blocked: 0, completed: 0, terminal: 0 },
      status: { statuses: ['pending', 'running', 'succeeded', 'failed', 'blocked'] },
    } as unknown as QuestBoardResponse;
    const refreshed = board([quest('quest-pending', 'running', 'Pending')], { runner: { enabled: true, activeQuestId: 'quest-pending' } });
    mockedApi.getQuests.mockResolvedValueOnce(initial).mockResolvedValueOnce(refreshed);
    const pendingRun = deferred<{ response: Response; body: QuestControlResponse }>();
    mockedApi.runQuest.mockReturnValue(pendingRun.promise);

    render(<Harness />);
    await screen.findByText('quest-pending');

    let runPromise: Promise<QuestControlResponse | undefined>;
    act(() => { runPromise = latest!.runQuest({ questId: 'quest-pending' }); });
    await waitFor(() => expect(screen.getByTestId('controlSubmitting').textContent).toBe('true'));
    expect(screen.getByTestId('controlAction').textContent).toBe('run');
    expect(mockedApi.runQuest).toHaveBeenCalledWith({ questId: 'quest-pending' });

    await act(async () => {
      pendingRun.resolve({ response: new Response('{}'), body: { ok: true, action: 'run', message: 'Started.', board: returned } });
      await runPromise!;
    });

    await waitFor(() => expect(screen.getByTestId('controlSubmitting').textContent).toBe('false'));
    expect(screen.getByTestId('running').textContent).toBe('quest-pending');
    expect(screen.getByTestId('error').textContent).toBe('');
    expect(mockedApi.getQuests).toHaveBeenCalledTimes(2);
  });

  test('sets errors for HTTP failures and unusable control boards', async () => {
    mockedApi.getQuests.mockResolvedValue(board([quest('quest-pending', 'pending')]));
    mockedApi.runQuestOnce.mockResolvedValue({ response: new Response('{}', { status: 503 }), body: { ok: false, error: 'Quest runner control API is unavailable for this server.' } as unknown as QuestControlResponse });
    mockedApi.stopQuestRunner.mockResolvedValue({ response: new Response('{}'), body: { ok: true, action: 'stop', message: 'Stopped.', board: { ok: false, error: 'bad board' } as unknown as QuestBoardResponse } });

    render(<Harness />);
    await screen.findByText('quest-pending');

    await act(async () => { await latest!.runQuestOnce({ questId: 'quest-pending' }); });
    expect(screen.getByTestId('error').textContent).toBe('Quest runner control API is unavailable for this server.');

    await act(async () => { await latest!.stopQuestRunner(); });
    expect(screen.getByTestId('error').textContent).toBe('Quest stop response was not usable.');
  });
});

describe('useQuestBoard delete mutation', () => {
  test('deletes a quest, normalizes returned board, toggles state, and updates board from response', async () => {
    const initial = board([quest('quest-1', 'pending', 'First'), quest('quest-2', 'succeeded', 'Second')]);
    const afterDelete = board([quest('quest-2', 'succeeded', 'Second')]);
    mockedApi.getQuests.mockResolvedValue(initial);
    const pendingDelete = deferred<{ response: Response; body: { ok: boolean; quest: QuestSummary; board: QuestBoardResponse } }>();
    mockedApi.deleteQuest.mockReturnValue(pendingDelete.promise);

    render(<Harness />);
    await screen.findByText('quest-1');
    expect(screen.getByTestId('pending').textContent).toBe('quest-1');

    let deletePromise: Promise<QuestBoardResponse | undefined>;
    act(() => { deletePromise = latest!.deleteQuest('quest-1'); });
    await waitFor(() => expect(screen.getByTestId('deleteSubmitting').textContent).toBe('true'));
    expect(screen.getByTestId('deletingQuestId').textContent).toBe('quest-1');
    expect(mockedApi.deleteQuest).toHaveBeenCalledWith('quest-1');

    await act(async () => {
      pendingDelete.resolve({ response: new Response('{}'), body: { ok: true, quest: quest('quest-1', 'pending'), board: afterDelete } });
      await deletePromise!;
    });

    await waitFor(() => expect(screen.getByTestId('deleteSubmitting').textContent).toBe('false'));
    expect(screen.getByTestId('deletingQuestId').textContent).toBe('');
    expect(screen.getByTestId('pending').textContent).toBe('');
    expect(screen.getByTestId('error').textContent).toBe('');
  });

  test('encodes quest ids in the delete request', async () => {
    mockedApi.getQuests.mockResolvedValue(board([quest('quest%2Fspecial', 'pending', 'Special')]));
    const pendingDelete = deferred<{ response: Response; body: { ok: boolean; quest: QuestSummary; board: QuestBoardResponse } }>();
    mockedApi.deleteQuest.mockReturnValue(pendingDelete.promise);

    render(<Harness />);
    await screen.findByText('quest%2Fspecial');

    act(() => { latest!.deleteQuest('quest%2Fspecial'); });
    expect(mockedApi.deleteQuest).toHaveBeenCalledWith('quest%2Fspecial');
  });

  test('sets error on HTTP failure', async () => {
    mockedApi.getQuests.mockResolvedValue(board([quest('quest-fail', 'pending')]));
    mockedApi.deleteQuest.mockResolvedValue({ response: new Response('{}', { status: 503 }), body: { ok: false, error: 'Quest runner control API is unavailable for this server.' } as unknown as QuestBoardResponse });

    render(<Harness />);
    await screen.findByText('quest-fail');

    await act(async () => { await latest!.deleteQuest('quest-fail'); });
    expect(screen.getByTestId('error').textContent).toBe('Quest runner control API is unavailable for this server.');
  });

  test('sets error on unusable response board', async () => {
    mockedApi.getQuests.mockResolvedValue(board([quest('quest-badboard', 'pending')]));
    mockedApi.deleteQuest.mockResolvedValue({ response: new Response('{}'), body: { ok: true, quest: quest('quest-badboard', 'pending'), board: { ok: false, error: 'bad board' } as unknown as QuestBoardResponse } });

    render(<Harness />);
    await screen.findByText('quest-badboard');

    await act(async () => { await latest!.deleteQuest('quest-badboard'); });
    expect(screen.getByTestId('error').textContent).toBe('Quest delete response was not usable.');
  });

  test('clears state after delete completes', async () => {
    mockedApi.getQuests.mockResolvedValue(board([quest('quest-clear', 'pending')]));
    const pendingDelete = deferred<{ response: Response; body: { ok: boolean; quest: QuestSummary; board: QuestBoardResponse } }>();
    mockedApi.deleteQuest.mockReturnValue(pendingDelete.promise);

    render(<Harness />);
    await screen.findByText('quest-clear');

    act(() => { latest!.deleteQuest('quest-clear'); });
    await waitFor(() => expect(screen.getByTestId('deleteSubmitting').textContent).toBe('true'));

    await act(async () => {
      pendingDelete.resolve({ response: new Response('{}'), body: { ok: true, quest: quest('quest-clear', 'pending'), board: board([]) } });
    });

    await waitFor(() => expect(screen.getByTestId('deleteSubmitting').textContent).toBe('false'));
    expect(screen.getByTestId('deletingQuestId').textContent).toBe('');
    expect(screen.getByTestId('error').textContent).toBe('');
  });
});
