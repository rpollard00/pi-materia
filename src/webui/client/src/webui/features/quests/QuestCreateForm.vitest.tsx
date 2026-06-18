import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipelineConfig } from '../../../loadoutModel.js';
import type { AddQuestResponse, UpdateQuestResponse } from '../../types.js';
import { QuestCreateForm, QuestEditForm } from './QuestCreateForm.js';
import { resetQuestDraftStoreForTests } from './questDraftStore.js';

const persistedLoadouts = {
  Alpha: { id: 'user:alpha', entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Build' } } },
  Beta: { id: 'user:beta', entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Review' } } },
} satisfies Record<string, PipelineConfig>;

const addQuestResponse = {
  ok: true,
  quest: {
    id: 'quest-1',
    title: 'Quest 1',
    prompt: 'Quest prompt',
    promptPreview: 'Quest prompt',
    status: 'pending',
    attempts: 0,
    createdAt: '2026-05-23T00:00:00.000Z',
    updatedAt: '2026-05-23T00:00:00.000Z',
  },
} satisfies AddQuestResponse;

const updateQuestResponse = {
  ok: true,
  quest: {
    ...addQuestResponse.quest,
    title: 'Updated quest',
    prompt: 'Updated prompt',
    promptPreview: 'Updated prompt',
  },
} satisfies UpdateQuestResponse;

afterEach(() => {
  cleanup();
  resetQuestDraftStoreForTests();
});

describe('QuestCreateForm layout', () => {
  it('keeps loadout controls in the left controls wrapper and prompt as the right layout item', () => {
    render(
      <QuestCreateForm
        persistedLoadouts={persistedLoadouts}
        questDefaultLoadoutId="user:alpha"
        setQuestDefaultLoadout={vi.fn(async (loadoutId: string | null) => loadoutId)}
        onAddQuest={vi.fn(async () => addQuestResponse)}
        submitting={false}
      />,
    );

    const questDefaultLoadout = screen.getByLabelText(/quest default loadout/i);
    const loadoutOverride = screen.getByLabelText(/loadout override/i);
    const prompt = screen.getByLabelText(/prompt/i);

    const controls = questDefaultLoadout.closest('.quest-create-controls');
    expect(controls).not.toBeNull();
    expect(controls?.contains(questDefaultLoadout)).toBe(true);
    expect(controls?.contains(loadoutOverride)).toBe(true);

    const promptField = prompt.closest('.quest-prompt-field');
    expect(promptField).not.toBeNull();
    expect(promptField?.contains(prompt)).toBe(true);
    expect(controls?.contains(prompt)).toBe(false);

    const fields = controls?.parentElement;
    expect(fields?.classList.contains('quest-create-fields')).toBe(true);
    expect(promptField?.parentElement).toBe(fields);
    expect(Array.from(fields?.children ?? [])).toEqual([controls, promptField]);
  });

  it('keeps create submit behavior with the shared quest form', async () => {
    const onAddQuest = vi.fn(async () => addQuestResponse);
    render(
      <QuestCreateForm
        persistedLoadouts={persistedLoadouts}
        questDefaultLoadoutId="user:alpha"
        setQuestDefaultLoadout={vi.fn(async (loadoutId: string | null) => loadoutId)}
        onAddQuest={onAddQuest}
        submitting={false}
      />,
    );

    fireEvent.change(screen.getByLabelText(/loadout override/i), { target: { value: 'Beta' } });
    fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: '  Rescue the villager  ' } });
    fireEvent.click(screen.getByRole('button', { name: /add quest/i }));

    await waitFor(() => expect(onAddQuest).toHaveBeenCalledWith({ prompt: 'Rescue the villager', loadoutOverride: 'Beta' }));
    expect((await screen.findByRole('status')).textContent).toBe('Added quest: Quest 1');
  });
});

describe('QuestEditForm', () => {
  it('prefills editable fields and submits trimmed changes', async () => {
    const onUpdateQuest = vi.fn(async () => updateQuestResponse);
    const onCancel = vi.fn();
    render(
      <QuestEditForm
        persistedLoadouts={persistedLoadouts}
        initialValues={{ prompt: 'Old prompt', loadoutOverride: 'Alpha' }}
        onUpdateQuest={onUpdateQuest}
        onCancel={onCancel}
        submitting={false}
        questTitle="Old quest"
      />,
    );

    expect((screen.getByLabelText(/prompt/i) as HTMLTextAreaElement).value).toBe('Old prompt');
    expect((screen.getByLabelText(/loadout override/i) as HTMLSelectElement).value).toBe('Alpha');

    fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: '  Updated prompt  ' } });
    fireEvent.change(screen.getByLabelText(/loadout override/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save quest/i }));

    await waitFor(() => expect(onUpdateQuest).toHaveBeenCalledWith({ prompt: 'Updated prompt' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('returns to create mode on cancel without saving', () => {
    const onUpdateQuest = vi.fn(async () => updateQuestResponse);
    const onCancel = vi.fn();
    render(
      <QuestEditForm
        persistedLoadouts={persistedLoadouts}
        initialValues={{ prompt: 'Old prompt', loadoutOverride: '' }}
        onUpdateQuest={onUpdateQuest}
        onCancel={onCancel}
        submitting={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onCancel).toHaveBeenCalled();
    expect(onUpdateQuest).not.toHaveBeenCalled();
  });
});

describe('QuestCreateForm draft retention across unmount/remount', () => {
  function renderCreateForm(onAddQuest = vi.fn(async () => addQuestResponse)) {
    render(
      <QuestCreateForm
        persistedLoadouts={persistedLoadouts}
        questDefaultLoadoutId="user:alpha"
        setQuestDefaultLoadout={vi.fn(async (loadoutId: string | null) => loadoutId)}
        onAddQuest={onAddQuest}
        submitting={false}
      />,
    );
    return { onAddQuest };
  }

  it('preserves the prompt and loadout override when the panel unmounts and remounts (tab switch)', () => {
    renderCreateForm();
    const multiLinePrompt = 'Rescue the villager.\nCheck the eastern path first.\nThen regroup at the inn.';
    fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: multiLinePrompt } });
    fireEvent.change(screen.getByLabelText(/loadout override/i), { target: { value: 'Beta' } });

    // Simulate navigating to another Materia tab: AppShell unmounts the quest workspace.
    cleanup();
    expect(screen.queryByLabelText(/prompt/i)).toBeNull();

    // Simulate navigating back: the quest workspace remounts.
    renderCreateForm();

    expect((screen.getByLabelText(/prompt/i) as HTMLTextAreaElement).value).toBe(multiLinePrompt);
    expect((screen.getByLabelText(/loadout override/i) as HTMLSelectElement).value).toBe('Beta');
  });

  it('clears the preserved draft after a successful submission', async () => {
    const { onAddQuest } = renderCreateForm();
    fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: 'Storm the keep' } });
    fireEvent.click(screen.getByRole('button', { name: /add quest/i }));

    await waitFor(() => expect(onAddQuest).toHaveBeenCalledWith({ prompt: 'Storm the keep' }));

    expect((screen.getByLabelText(/prompt/i) as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByLabelText(/loadout override/i) as HTMLSelectElement).value).toBe('');
  });
});
