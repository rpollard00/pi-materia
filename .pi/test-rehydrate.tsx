import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { MateriaBehaviorConfig } from '../src/webui/client/src/loadoutModel.js';
import type { LoadoutSourceScope } from '../src/webui/client/src/webui/types.js';
import { useMateriaEditorController } from '../src/webui/client/src/webui/features/materia-editor/useMateriaEditorController.js';

function SaveAndReselectProbe() {
  const [materia, setMateria] = useState<Record<string, MateriaBehaviorConfig>>({
    Test: { type: 'agent', prompt: 'old prompt', tools: 'coding' },
    Other: { type: 'agent', prompt: 'other prompt', tools: 'none' },
  });
  const [materiaSources, setMateriaSources] = useState<Record<string, LoadoutSourceScope>>({
    Test: 'user',
    Other: 'user',
  });
  const [status, setStatus] = useState('');

  const controller = useMateriaEditorController({
    materia,
    materiaSources,
    defaultMateriaIds: [],
    selectedTab: 'materia-editor',
    status,
    setStatus,
    reloadConfig: async (_options) => {
      // Simulate server returning the saved prompt
      setMateria({
        Test: { type: 'agent', prompt: 'new prompt', tools: 'coding' },
        Other: { type: 'agent', prompt: 'other prompt', tools: 'none' },
      });
      setMateriaSources({ Test: 'user', Other: 'user' });
      setStatus(_options?.readyStatus ?? 'reloaded');
    },
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

describe('save-then-reselect', () => {
  it('loads fresh prompt after saving, selecting other, then reselecting', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, target: 'user' })));
    vi.stubGlobal('fetch', fetchMock);

    render(<SaveAndReselectProbe />);

    // Edit Test
    fireEvent.click(screen.getByText('edit Test'));
    expect(screen.getByLabelText('prompt').textContent).toBe('old prompt');

    // Change the prompt
    // (In the probe, we can't directly change the form, so we save the old
    // prompt and let reloadConfig return the "new prompt" as if it was saved)
    fireEvent.click(screen.getByText('save'));

    await waitFor(() => expect(screen.getByLabelText('editing-id').textContent).toBe(''));

    // Now select Other
    fireEvent.click(screen.getByText('edit Other'));
    expect(screen.getByLabelText('prompt').textContent).toBe('other prompt');
    expect(screen.getByLabelText('editing-id').textContent).toBe('Other');

    // Now reselect Test
    fireEvent.click(screen.getByText('edit Test'));
    expect(screen.getByLabelText('editing-id').textContent).toBe('Test');
    // This should be 'new prompt' because reloadConfig refreshed the materia
    expect(screen.getByLabelText('prompt').textContent).toBe('new prompt');
  });
});
