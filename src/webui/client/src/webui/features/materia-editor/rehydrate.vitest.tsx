import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { MateriaBehaviorConfig } from '../../../loadoutModel.js';
import type { LoadoutSourceScope } from '../../types.js';
import { useMateriaEditorController } from './useMateriaEditorController.js';

function LayeredProbe() {
  // Simulate useWebuiConfig: draftConfig contains materia
  const [draftConfig, setDraftConfig] = useState<{ materia: Record<string, MateriaBehaviorConfig> }>({
    materia: {
      Test: { type: 'agent', prompt: 'old prompt', tools: 'coding' },
      Other: { type: 'agent', prompt: 'other prompt', tools: 'none' },
    },
  });

  // Simulate materiaSources from useWebuiConfig
  const [materiaSources, setMateriaSources] = useState<Record<string, LoadoutSourceScope>>({
    Test: 'user',
    Other: 'user',
  });

  const [status, setStatus] = useState('');

  // This is the reloadConfig that would come from useWebuiConfig
  async function reloadConfig(_options?: { preserveLoadoutEdits?: boolean; readyStatus?: string }) {
    // Simulate fetching fresh config from server
    setDraftConfig({
      materia: {
        Test: { type: 'agent', prompt: 'new prompt', tools: 'coding' },
        Other: { type: 'agent', prompt: 'other prompt', tools: 'none' },
      },
    });
    setMateriaSources({ Test: 'user', Other: 'user' });
    setStatus(_options?.readyStatus ?? 'reloaded');
  }

  // materia is derived from draftConfig (like in useLoadoutGraphViewModel)
  const materia = draftConfig.materia;

  const controller = useMateriaEditorController({
    materia,
    materiaSources,
    defaultMateriaIds: [],
    selectedTab: 'materia-editor',
    status,
    setStatus,
    reloadConfig,
  });

  return (
    <>
      <output aria-label="status">{controller.persistence.status}</output>
      <output aria-label="editing-id">{controller.form.materiaForm.editingSocketId}</output>
      <output aria-label="prompt">{controller.form.materiaForm.prompt}</output>
      <output aria-label="persist-scope">{controller.form.materiaForm.persistScope}</output>
      <button type="button" onClick={() => controller.form.editMateria('Test')}>edit Test</button>
      <button type="button" onClick={() => controller.form.editMateria('Other')}>edit Other</button>
      <button type="button" onClick={() => { void controller.persistence.saveMateriaForm(); }}>save</button>
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('rehydrate-after-save', () => {
  it('shows fresh prompt after saving via draftConfig layer, selecting other, then reselecting', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, target: 'user' })));
    vi.stubGlobal('fetch', fetchMock);

    render(<LayeredProbe />);

    // Edit Test
    fireEvent.click(screen.getByText('edit Test'));
    expect(screen.getByLabelText('prompt').textContent).toBe('old prompt');
    expect(screen.getByLabelText('editing-id').textContent).toBe('Test');

    // Save - reloadConfig will set draftConfig.materia to fresh data
    fireEvent.click(screen.getByText('save'));

    // Wait for form to clear after save
    await waitFor(() => expect(screen.getByLabelText('editing-id').textContent).toBe(''));

    // Select Other
    fireEvent.click(screen.getByText('edit Other'));
    expect(screen.getByLabelText('prompt').textContent).toBe('other prompt');
    expect(screen.getByLabelText('editing-id').textContent).toBe('Other');

    // Go back to Test - should show fresh 'new prompt'
    fireEvent.click(screen.getByText('edit Test'));
    expect(screen.getByLabelText('editing-id').textContent).toBe('Test');
    expect(screen.getByLabelText('prompt').textContent).toBe('new prompt');
  });

  it('shows fresh prompt after saving via draftConfig layer and immediate reselect of same materia', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, target: 'user' })));
    vi.stubGlobal('fetch', fetchMock);

    render(<LayeredProbe />);

    // Edit Test
    fireEvent.click(screen.getByText('edit Test'));
    expect(screen.getByLabelText('prompt').textContent).toBe('old prompt');

    // Save - reloadConfig will set draftConfig.materia to fresh data
    fireEvent.click(screen.getByText('save'));

    // Wait for form to clear after save
    await waitFor(() => expect(screen.getByLabelText('editing-id').textContent).toBe(''));

    // Immediately reselect Test
    fireEvent.click(screen.getByText('edit Test'));
    expect(screen.getByLabelText('editing-id').textContent).toBe('Test');
    expect(screen.getByLabelText('prompt').textContent).toBe('new prompt');
  });
});
