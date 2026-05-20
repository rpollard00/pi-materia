import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QuestLogSidebar } from './QuestLogSidebar.js';
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
