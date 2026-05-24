import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { QuestBoardResponse, QuestSummary, UpdateQuestResponse } from '../../types.js';
import { QuestPanel } from './QuestPanel.js';
import { useQuestBoard } from './useQuestBoard.js';

vi.mock('./useQuestBoard.js', () => ({
  useQuestBoard: vi.fn(),
}));

const mockedUseQuestBoard = vi.mocked(useQuestBoard);

function quest(id: string, status: QuestSummary['status'], title: string, extras: Partial<QuestSummary> = {}): QuestSummary {
  return {
    id,
    title,
    prompt: `${title} prompt`,
    promptPreview: `${title} prompt`,
    status,
    attempts: status === 'pending' ? 0 : 1,
    createdAt: '2026-05-19T00:00:00.000Z',
    updatedAt: '2026-05-19T00:00:00.000Z',
    ...extras,
  };
}

const pendingQuest = quest('quest-pending', 'pending', 'Pending quest', { loadoutOverride: 'Beta' });
const completedQuest = quest('quest-completed', 'succeeded', 'Completed quest');

const board: QuestBoardResponse = {
  ok: true,
  runner: { enabled: true },
  counts: { total: 2, pending: 1, running: 0, succeeded: 1, failed: 0, blocked: 0, completed: 1, terminal: 1 },
  pendingQuests: [pendingQuest],
  completedQuests: [completedQuest],
  failedQuests: [],
  quests: [pendingQuest, completedQuest],
  status: { statuses: ['pending', 'running', 'succeeded', 'failed', 'blocked'] },
};

const updatedQuestResponse: UpdateQuestResponse = {
  ok: true,
  quest: {
    ...pendingQuest,
    title: 'Updated pending',
    prompt: 'Updated pending prompt',
    promptPreview: 'Updated pending prompt',
  },
};

function renderPanel(overrides: Partial<ReturnType<typeof useQuestBoard>> = {}) {
  const update = vi.fn(async () => updatedQuestResponse);
  const add = vi.fn();
  mockedUseQuestBoard.mockReturnValue({
    board,
    loading: false,
    error: undefined,
    refresh: vi.fn(),
    add,
    submitting: false,
    update,
    updateSubmitting: false,
    reorder: vi.fn(),
    reorderSubmitting: false,
    requeue: vi.fn(),
    requeueSubmitting: false,
    runQuest: vi.fn(),
    runQuestOnce: vi.fn(),
    stopQuestRunner: vi.fn(),
    controlSubmitting: false,
    controlAction: undefined,
    ...overrides,
  });

  render(
    <QuestPanel
      persistedLoadouts={{
        Alpha: { id: 'user:alpha', entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Build' } } },
        Beta: { id: 'user:beta', entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Review' } } },
      }}
      questDefaultLoadoutId={null}
      setQuestDefaultLoadout={vi.fn()}
    />,
  );

  return { update, add };
}

afterEach(() => {
  cleanup();
  mockedUseQuestBoard.mockReset();
});

describe('QuestPanel runner controls', () => {
  test('shows banner controls above counts and disables actions from board state', () => {
    renderPanel({
      board: {
        ...board,
        runner: { enabled: false },
        counts: { total: 1, pending: 0, running: 0, succeeded: 1, failed: 0, blocked: 0, completed: 1, terminal: 1 },
        pendingQuests: [],
        quests: [completedQuest],
      },
    });

    expect(screen.getByRole('button', { name: 'Run quests continuously' })).not.toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Run one pending quest' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Stop quest auto-advance' })).toHaveProperty('disabled', true);
    const counts = screen.getByLabelText('Quest counts');
    expect(counts.textContent).toContain('0 active');
    expect(counts.textContent).toContain('0 pending');
    expect(counts.textContent).toContain('1 complete');
  });

  test('wires run, run once, and stop controls with in-flight labels and feedback', async () => {
    const runQuest = vi.fn(async () => ({ ok: true as const, action: 'run' as const, message: 'Runner started.', board }));
    const runQuestOnce = vi.fn(async () => ({ ok: true as const, action: 'runonce' as const, message: 'Started one quest.', board }));
    const stopQuestRunner = vi.fn(async () => ({ ok: true as const, action: 'stop' as const, message: 'Runner stopped.', board }));
    renderPanel({ runQuest, runQuestOnce, stopQuestRunner, board: { ...board, runner: { enabled: true } } });

    fireEvent.click(screen.getByRole('button', { name: 'Run quests continuously' }));
    await waitFor(() => expect(runQuest).toHaveBeenCalledWith({ questId: 'quest-pending' }));
    expect(screen.getByText('Runner started.')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Run one pending quest' }));
    await waitFor(() => expect(runQuestOnce).toHaveBeenCalledWith({ questId: 'quest-pending' }));

    fireEvent.click(screen.getByRole('button', { name: 'Stop quest auto-advance' }));
    await waitFor(() => expect(stopQuestRunner).toHaveBeenCalled());
  });

  test('renders active control action text and hook errors', () => {
    renderPanel({ controlSubmitting: true, controlAction: 'runonce', error: 'Quest runner control API is unavailable for this server.' });

    expect(screen.getByRole('button', { name: 'Run one pending quest' }).textContent).toContain('Starting…');
    expect(screen.getAllByText('Quest runner control API is unavailable for this server.')).toHaveLength(2);
  });
});

describe('QuestPanel editing flow', () => {
  test('switches from create to edit mode from the pending card menu, prefills values, saves, and returns to create mode', async () => {
    const { update } = renderPanel();

    expect(screen.getByRole('button', { name: /add quest/i })).not.toBeNull();

    fireEvent.click(screen.getByLabelText('Quest actions'));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Edit' }));

    expect(screen.getByRole('heading', { name: /edit pending quest/i })).not.toBeNull();
    const form = screen.getByRole('form', { name: /edit pending quest/i });
    expect((within(form).getByLabelText(/prompt/i) as HTMLTextAreaElement).value).toBe('Pending quest prompt');
    expect((within(form).getByLabelText(/loadout override/i) as HTMLSelectElement).value).toBe('Beta');

    fireEvent.change(within(form).getByLabelText(/prompt/i), { target: { value: '  Updated pending prompt  ' } });
    fireEvent.change(within(form).getByLabelText(/loadout override/i), { target: { value: 'Alpha' } });
    fireEvent.click(within(form).getByRole('button', { name: /save quest/i }));

    await waitFor(() => expect(update).toHaveBeenCalledWith('quest-pending', { prompt: 'Updated pending prompt', loadoutOverride: 'Alpha' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /add quest/i })).not.toBeNull());
  });

  test('cancels edit mode without saving', () => {
    const { update } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Edit selected quest' }));
    expect(screen.getByRole('heading', { name: /edit pending quest/i })).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(update).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /add quest/i })).not.toBeNull();
  });
});
