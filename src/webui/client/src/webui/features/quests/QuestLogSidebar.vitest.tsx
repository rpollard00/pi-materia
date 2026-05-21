import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QuestDetail } from './QuestDetail.js';
import { QuestLogSidebar } from './QuestLogSidebar.js';
import { normalizeQuestBoardResponse } from './useQuestBoard.js';
import type { QuestSummary } from '../../types.js';

function quest(id: string, status: QuestSummary['status'], title: string): QuestSummary {
  return {
    id,
    title,
    prompt: `${title} prompt`,
    promptPreview: `${title} prompt`,
    status,
    attempts: status === 'pending' ? 0 : 1,
    createdAt: '2026-05-19T00:00:00.000Z',
    updatedAt: '2026-05-19T00:00:00.000Z',
  };
}

function completedQuestWithDivergentCasts(): QuestSummary {
  return {
    ...quest('quest-completed-cast', 'succeeded', 'Completed cast quest'),
    currentCastId: 'cast-current-viewer',
    lastCastId: 'cast-legacy-last',
    lastResult: {
      status: 'succeeded',
      castId: 'cast-result-completion',
      finishedAt: '2026-05-19T01:00:00.000Z',
      message: 'Quest completed successfully.',
    },
  };
}

function dataTransfer(id: string) {
  const store = new Map<string, string>();
  store.set('text/plain', id);
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: vi.fn((type: string, value: string) => store.set(type, value)),
    getData: vi.fn((type: string) => store.get(type) ?? ''),
  };
}

afterEach(() => cleanup());

describe('QuestDetail requeue action', () => {
  test('shows requeue action for failed and blocked quests only', () => {
    const { rerender } = render(<QuestDetail quest={quest('quest-failed', 'failed', 'Failed quest')} onRefresh={vi.fn()} onRequeue={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Requeue Failed quest' })).not.toBeNull();

    rerender(<QuestDetail quest={quest('quest-blocked', 'blocked', 'Blocked quest')} onRefresh={vi.fn()} onRequeue={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Requeue Blocked quest' })).not.toBeNull();

    for (const status of ['pending', 'running', 'succeeded'] as const) {
      rerender(<QuestDetail quest={quest(`quest-${status}`, status, `${status} quest`)} onRefresh={vi.fn()} onRequeue={vi.fn()} />);
      expect(screen.queryByRole('button', { name: new RegExp(`Requeue ${status} quest`, 'i') })).toBeNull();
    }
  });

  test('calls requeue with the selected quest id', () => {
    const requeue = vi.fn();
    render(<QuestDetail quest={quest('quest-failed', 'failed', 'Failed quest')} onRefresh={vi.fn()} onRequeue={requeue} />);

    fireEvent.click(screen.getByRole('button', { name: 'Requeue Failed quest' }));

    expect(requeue).toHaveBeenCalledWith('quest-failed');
  });

  test('disables requeue action while a requeue is submitting', () => {
    render(<QuestDetail quest={quest('quest-blocked', 'blocked', 'Blocked quest')} requeueSubmitting onRefresh={vi.fn()} onRequeue={vi.fn()} />);

    const button = screen.getByRole('button', { name: 'Requeue Blocked quest' });
    expect(button).toHaveProperty('disabled', true);
    expect(button.textContent).toBe('Requeueing…');
  });
});

describe('Quest completed cast display coverage', () => {
  test('quest detail Last result shows the cast the quest completed in from lastResult', () => {
    render(<QuestDetail quest={completedQuestWithDivergentCasts()} onRefresh={vi.fn()} />);

    const resultPanel = screen.getByRole('heading', { name: 'Last result' }).closest('.quest-result-panel');
    expect(resultPanel).not.toBeNull();
    expect(within(resultPanel as HTMLElement).getByText('Quest completed successfully.')).not.toBeNull();
    expect(within(resultPanel as HTMLElement).getByText('Completed in cast cast-result-completion')).not.toBeNull();
    expect(within(resultPanel as HTMLElement).queryByText(/cast-legacy-last/)).toBeNull();
    expect(within(resultPanel as HTMLElement).queryByText(/cast-current-viewer/)).toBeNull();
  });

  test('completed quest cards visibly include the completion cast id', () => {
    render(
      <QuestLogSidebar
        pendingQuests={[]}
        completedQuests={[completedQuestWithDivergentCasts()]}
        failedQuests={[]}
        onSelectQuest={vi.fn()}
      />,
    );

    const completedSection = screen.getByRole('heading', { name: 'Completed' }).closest('.quest-log-section');
    expect(completedSection).not.toBeNull();
    expect(within(completedSection as HTMLElement).getByText('Completed cast quest')).not.toBeNull();
    expect(within(completedSection as HTMLElement).getByText('Completed in cast cast-result-completion')).not.toBeNull();
    expect(within(completedSection as HTMLElement).queryByText(/cast-legacy-last/)).toBeNull();
    expect(within(completedSection as HTMLElement).queryByText(/cast-current-viewer/)).toBeNull();
  });

  test('quest board normalization preserves completed quest lastResult cast id', () => {
    const normalized = normalizeQuestBoardResponse({
      ok: true,
      quests: [],
      pendingQuests: [],
      failedQuests: [],
      completedQuests: [
        {
          id: 'quest-completed-cast',
          title: 'Completed cast quest',
          prompt: 'Complete the cast attribution quest',
          promptPreview: 'Complete the cast attribution quest',
          status: 'succeeded',
          attempts: 1,
          createdAt: '2026-05-19T00:00:00.000Z',
          updatedAt: '2026-05-19T01:00:00.000Z',
          currentCastId: 'cast-current-viewer',
          lastCastId: 'cast-legacy-last',
          lastResult: {
            status: 'succeeded',
            castId: 'cast-result-completion',
            finishedAt: '2026-05-19T01:00:00.000Z',
            message: 'Quest completed successfully.',
          },
        },
      ],
    });

    expect(normalized?.completedQuests?.[0]?.currentCastId).toBe('cast-current-viewer');
    expect(normalized?.completedQuests?.[0]?.lastCastId).toBe('cast-legacy-last');
    expect(normalized?.completedQuests?.[0]?.lastResult?.castId).toBe('cast-result-completion');
  });
});

describe('QuestLogSidebar quest reordering', () => {
  test('renders active quest pinned above pending quests and only pending quests get drag handles', () => {
    render(
      <QuestLogSidebar
        activeQuest={quest('quest-active', 'running', 'Active quest')}
        pendingQuests={[quest('quest-pending-1', 'pending', 'First pending'), quest('quest-pending-2', 'pending', 'Second pending')]}
        completedQuests={[quest('quest-done', 'succeeded', 'Completed quest')]}
        failedQuests={[]}
        onSelectQuest={vi.fn()}
        onReorderQuest={vi.fn()}
      />,
    );

    const activePending = screen.getByLabelText('Active & Pending');
    const buttons = within(activePending).getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Active quest: Active quest',
      'Drag First pending to reorder pending quests',
      'Pending quest: First pending',
      'Drag Second pending to reorder pending quests',
      'Pending quest: Second pending',
    ]);
    expect(screen.queryByLabelText('Drag Active quest to reorder pending quests')).toBeNull();
  });

  test('maps drops before the first pending quest to first placement', () => {
    const reorder = vi.fn();
    render(
      <QuestLogSidebar
        pendingQuests={[quest('quest-a', 'pending', 'Alpha'), quest('quest-b', 'pending', 'Beta')]}
        completedQuests={[]}
        failedQuests={[]}
        onSelectQuest={vi.fn()}
        onReorderQuest={reorder}
      />,
    );

    const transfer = dataTransfer('quest-b');
    fireEvent.dragStart(screen.getByLabelText('Drag Beta to reorder pending quests'), { dataTransfer: transfer });
    fireEvent.drop(screen.getByText('Drop here for first pending'), {
      dataTransfer: transfer,
      clientY: 25,
    });

    expect(reorder).toHaveBeenCalledWith({ questId: 'quest-b', placement: 'first' });
  });

  test('maps drops after another pending quest to after placement without selecting cards', () => {
    const reorder = vi.fn();
    const select = vi.fn();
    render(
      <QuestLogSidebar
        pendingQuests={[quest('quest-a', 'pending', 'Alpha'), quest('quest-b', 'pending', 'Beta'), quest('quest-c', 'pending', 'Gamma')]}
        completedQuests={[]}
        failedQuests={[]}
        onSelectQuest={select}
        onReorderQuest={reorder}
      />,
    );

    const targetRow = screen.getByLabelText('Pending quest: Beta').closest('.quest-pending-row')!;
    vi.spyOn(targetRow, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 100, bottom: 100, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON: () => ({}) });
    const transfer = dataTransfer('quest-a');
    fireEvent.dragStart(screen.getByLabelText('Drag Alpha to reorder pending quests'), { dataTransfer: transfer });
    fireEvent.drop(targetRow, { dataTransfer: transfer, clientY: 75 });

    expect(reorder).toHaveBeenCalledWith({ questId: 'quest-a', placement: 'after', targetId: 'quest-b' });
    expect(select).not.toHaveBeenCalled();
  });

  test('disables drag reordering while a reorder is submitting', () => {
    render(
      <QuestLogSidebar
        pendingQuests={[quest('quest-a', 'pending', 'Alpha'), quest('quest-b', 'pending', 'Beta')]}
        completedQuests={[]}
        failedQuests={[]}
        reorderSubmitting
        onSelectQuest={vi.fn()}
        onReorderQuest={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Drag Alpha to reorder pending quests').getAttribute('draggable')).toBe('false');
    expect(screen.getByRole('status').textContent).toBe('Reordering pending quests…');
  });
});
