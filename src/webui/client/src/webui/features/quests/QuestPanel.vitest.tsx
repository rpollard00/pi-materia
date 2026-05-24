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
