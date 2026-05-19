import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import type { MateriaBehaviorConfig } from '../../../loadoutModel.js';
import type { LoadoutSourceScope } from '../../types.js';
import { useMateriaEditorController } from './useMateriaEditorController.js';

function DeleteFallbackProbe({ reloadReady }: { reloadReady?: Promise<void> }) {
  const [materia, setMateria] = useState<Record<string, MateriaBehaviorConfig>>({
    Custom: { type: 'agent', prompt: 'project prompt', tools: 'coding' },
  });
  const [materiaSources, setMateriaSources] = useState<Record<string, LoadoutSourceScope>>({ Custom: 'project' });
  const [status, setStatus] = useState('');
  const controller = useMateriaEditorController({
    materia,
    materiaSources,
    defaultMateriaIds: [],
    selectedTab: 'loadout',
    status,
    setStatus,
    reloadConfig: async () => {
      await reloadReady;
      setMateria({ Custom: { type: 'agent', prompt: 'user fallback prompt', tools: 'readOnly' } });
      setMateriaSources({ Custom: 'user' });
    },
  });

  return (
    <>
      <output aria-label="status">{controller.persistence.status}</output>
      <output aria-label="editing-id">{controller.form.materiaForm.editingSocketId}</output>
      <output aria-label="prompt">{controller.form.materiaForm.prompt}</output>
      <output aria-label="persist-scope">{controller.form.materiaForm.persistScope}</output>
      <button type="button" onClick={() => controller.form.editMateria('Custom')}>edit Custom</button>
      <button type="button" onClick={() => { void controller.selector.deleteMateria('Custom'); }}>delete Custom</button>
    </>
  );
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useMateriaEditorController', () => {
  it('reselects a lower-priority custom fallback after deleting the selected override', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, target: 'project' })));
    vi.stubGlobal('fetch', fetchMock);

    render(<DeleteFallbackProbe />);

    fireEvent.click(screen.getByText('edit Custom'));
    expect(screen.getByLabelText('editing-id').textContent).toBe('Custom');
    expect(screen.getByLabelText('prompt').textContent).toBe('project prompt');
    expect(screen.getByLabelText('persist-scope').textContent).toBe('project');

    fireEvent.click(screen.getByText('delete Custom'));

    await waitFor(() => expect(screen.getByLabelText('prompt').textContent).toBe('user fallback prompt'));
    expect(screen.getByLabelText('editing-id').textContent).toBe('Custom');
    expect(screen.getByLabelText('persist-scope').textContent).toBe('user');
    expect(fetchMock).toHaveBeenCalledWith('/api/config', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ target: 'project', config: { materia: { Custom: null } } }),
    }));
  });

  it('waits for an async config reload before selecting a fallback after delete', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, target: 'project' })));
    vi.stubGlobal('fetch', fetchMock);
    const reload = createDeferred();

    render(<DeleteFallbackProbe reloadReady={reload.promise} />);

    fireEvent.click(screen.getByText('edit Custom'));
    fireEvent.click(screen.getByText('delete Custom'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByLabelText('status').textContent).toBe('Deleting materia Custom from project scope…'));
    expect(screen.getByLabelText('prompt').textContent).toBe('project prompt');
    expect(screen.getByLabelText('persist-scope').textContent).toBe('project');

    await act(async () => {
      reload.resolve();
    });

    await waitFor(() => expect(screen.getByLabelText('prompt').textContent).toBe('user fallback prompt'));
    expect(screen.getByLabelText('editing-id').textContent).toBe('Custom');
    expect(screen.getByLabelText('persist-scope').textContent).toBe('user');
  });
});
