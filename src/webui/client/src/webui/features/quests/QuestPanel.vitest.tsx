import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DeleteQuestResponse, QuestBoardResponse, QuestSummary, UpdateQuestResponse } from '../../types.js';
import { Toaster, resetToastStoreForTests } from '../../../toast/index.js';
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
    deleteQuest: vi.fn(),
    deleteSubmitting: false,
    deletingQuestId: undefined,
    controlSubmitting: false,
    controlAction: undefined,
    ...overrides,
  });

  render(
    <>
      <QuestPanel
        persistedLoadouts={{
          Alpha: { id: 'user:alpha', entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Build' } } },
          Beta: { id: 'user:beta', entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Review' } } },
        }}
        questDefaultLoadoutId={null}
        setQuestDefaultLoadout={vi.fn()}
      />
      <Toaster />
    </>,
  );

  return { update, add };
}

afterEach(() => {
  cleanup();
  resetToastStoreForTests();
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
    expect(screen.getAllByText('Runner started.').length).toBeGreaterThanOrEqual(1);

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

function pendingActionsTrigger() {
  return within(screen.getByLabelText('Active & Pending')).getByLabelText('Quest actions');
}

function completedActionsTriggers() {
  return within(screen.getByLabelText('Completed')).queryAllByLabelText('Quest actions');
}

describe('QuestPanel editing flow', () => {
  test('switches from create to edit mode from the pending card menu, prefills values, saves, and returns to create mode', async () => {
    const { update } = renderPanel();

    expect(screen.getByRole('button', { name: /add quest/i })).not.toBeNull();

    fireEvent.click(pendingActionsTrigger());
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

describe('QuestPanel delete flow', () => {
  const deleteResponse: DeleteQuestResponse = {
    ok: true,
    quest: quest('quest-pending', 'pending', 'Pending quest'),
    board,
  };

  test('confirms before deleting and aborts when confirmation is declined', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const deleteQuest = vi.fn();
    renderPanel({ deleteQuest });

    fireEvent.click(pendingActionsTrigger());
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Delete' }));

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/irreversible/i));
    expect(deleteQuest).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  test('calls deleteQuest on confirmed delete and shows success toast', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const deleteQuest = vi.fn(async () => deleteResponse);
    renderPanel({ deleteQuest });

    fireEvent.click(pendingActionsTrigger());
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Delete' }));

    await waitFor(() => expect(deleteQuest).toHaveBeenCalledWith('quest-pending'));
    expect(screen.getByText('Quest deleted')).not.toBeNull();
    expect(screen.getByText('The quest has been removed from the board.')).not.toBeNull();
  });

  test('clears selectedQuestId and editingQuestId when the deleted quest matches', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const deleteQuest = vi.fn(async () => deleteResponse);
    renderPanel({ deleteQuest });

    // Enter edit mode to set editingQuestId via the pending card menu
    fireEvent.click(pendingActionsTrigger());
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Edit' }));
    expect(screen.getByRole('heading', { name: /edit pending quest/i })).not.toBeNull();

    // Cancel to go back, then select the pending quest card
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    fireEvent.click(screen.getByRole('button', { name: /Pending quest:/ }));

    // Edit again so both selected and editing point to the same quest
    fireEvent.click(screen.getByRole('button', { name: 'Edit selected quest' }));

    // Delete through the menu on the pending card in the sidebar
    fireEvent.click(pendingActionsTrigger());
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Delete' }));

    await waitFor(() => expect(deleteQuest).toHaveBeenCalledWith('quest-pending'));
    // After delete the create form should reappear (editing cleared)
    await waitFor(() => expect(screen.getByRole('button', { name: /add quest/i })).not.toBeNull());
  });

  test('preserves selection when deleted quest id does not match the current selection', async () => {
    const completedQuest2 = quest('quest-completed-2', 'succeeded', 'Another completed quest');
    const boardTwoCompleted: QuestBoardResponse = {
      ...board,
      counts: { total: 2, pending: 0, running: 0, succeeded: 2, failed: 0, blocked: 0, completed: 2, terminal: 2 },
      pendingQuests: [],
      completedQuests: [completedQuest, completedQuest2],
      quests: [completedQuest, completedQuest2],
    };
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const deleteQuest = vi.fn(async () => ({
      ok: true as const,
      quest: completedQuest2,
      board: {
        ...boardTwoCompleted,
        completedQuests: [completedQuest],
        quests: [completedQuest],
      },
    }));
    renderPanel({ deleteQuest, board: boardTwoCompleted });

    // Select the first completed quest
    fireEvent.click(screen.getByRole('button', { name: /Completed quest: quest-completed:/ }));

    // Delete the *second* completed quest (different id) — index 1 in the completed section
    const completedTriggers = completedActionsTriggers();
    fireEvent.click(completedTriggers[1]!);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Delete' }));

    await waitFor(() => expect(deleteQuest).toHaveBeenCalledWith('quest-completed-2'));
    // The first completed quest should remain selected
    expect(screen.getByRole('button', { name: /Completed quest: quest-completed:/ })).not.toBeNull();
  });

  test('does not show toast and preserves error on delete failure', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const deleteQuest = vi.fn(async () => ({ ok: false as const }));
    renderPanel({ deleteQuest });

    fireEvent.click(pendingActionsTrigger());
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Delete' }));

    await waitFor(() => expect(deleteQuest).toHaveBeenCalledWith('quest-pending'));
    expect(screen.queryByText('Quest deleted')).toBeNull();
  });

  test('shows menu with disabled Delete on running quest card', () => {
    const runningQuest = quest('quest-running', 'running', 'Running quest');
    const boardWithRunning: QuestBoardResponse = {
      ...board,
      runner: { enabled: true, activeQuestId: 'quest-running' },
      counts: { total: 1, pending: 0, running: 1, succeeded: 0, failed: 0, blocked: 0, completed: 0, terminal: 0 },
      pendingQuests: [],
      completedQuests: [],
      quests: [runningQuest],
    };
    renderPanel({ board: boardWithRunning, deleteQuest: vi.fn() });

    fireEvent.click(pendingActionsTrigger());

    const menu = screen.getByRole('menu');
    const deleteItem = within(menu).getByRole('menuitem', { name: 'Delete' });
    expect(deleteItem).toHaveProperty('disabled', true);
    expect(deleteItem.getAttribute('title')).toBe('Cannot delete a running quest.');
  });

  test('passes deleteSubmitting and deletingQuestId metadata into the sidebar', () => {
    renderPanel({ deleteSubmitting: true, deletingQuestId: 'quest-pending', deleteQuest: vi.fn() });

    fireEvent.click(pendingActionsTrigger());
    const menu = screen.getByRole('menu');
    const deleteItem = within(menu).getByRole('menuitem', { name: 'Deleting…' });
    expect(deleteItem).toHaveProperty('disabled', true);
  });
});
