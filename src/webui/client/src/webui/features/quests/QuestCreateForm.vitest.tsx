import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipelineConfig } from '../../../loadoutModel.js';
import { QuestCreateForm } from './QuestCreateForm.js';

const persistedLoadouts = {
  Alpha: { id: 'user:alpha', entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Build' } } },
  Beta: { id: 'user:beta', entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Review' } } },
} satisfies Record<string, PipelineConfig>;

afterEach(() => cleanup());

describe('QuestCreateForm layout', () => {
  it('keeps loadout controls in the left controls wrapper and prompt as the right layout item', () => {
    render(
      <QuestCreateForm
        persistedLoadouts={persistedLoadouts}
        questDefaultLoadoutId="user:alpha"
        setQuestDefaultLoadout={vi.fn(async (loadoutId: string | null) => loadoutId)}
        onAddQuest={vi.fn(async () => ({ ok: true, quest: { id: 'quest-1', title: 'Quest 1' } }))}
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
});
