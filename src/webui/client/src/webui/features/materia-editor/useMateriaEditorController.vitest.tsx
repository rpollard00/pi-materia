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

function GenerationModelProbe() {
  const [status, setStatus] = useState('');
  const controller = useMateriaEditorController({
    materia: {},
    materiaSources: {},
    defaultMateriaIds: [],
    selectedTab: 'materia-editor',
    status,
    setStatus,
    reloadConfig: async () => {},
  });
  const generationModel = controller.roleGeneration.generationModel;

  return (
    <>
      <output aria-label="status">{controller.persistence.status}</output>
      <output aria-label="selected-generation-model">{generationModel.selectedModel}</output>
      <output aria-label="persisted-generation-model">{generationModel.persistedModel ?? ''}</output>
      <output aria-label="stale-generation-warning">{generationModel.stalePreferenceWarning}</output>
      <output aria-label="preference-status">{generationModel.preferenceStatus}</output>
      <output aria-label="save-error">{generationModel.saveError}</output>
      <output aria-label="generation-options">{generationModel.availableOptions.map((option) => option.value || '<active>').join(',')}</output>
      <button type="button" onClick={() => { void generationModel.changeModel('openai/gpt-alt'); }}>choose alt</button>
      <button type="button" onClick={() => { void generationModel.changeModel(''); }}>choose active</button>
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

function PolicyProbe({ onReload }: { onReload?: (options?: { preserveLoadoutEdits?: boolean; readyStatus?: string }) => void | Promise<void> } = {}) {
  const [materia] = useState<Record<string, MateriaBehaviorConfig>>({
    Build: { type: 'agent', prompt: 'built-in prompt', tools: 'coding' },
    Project: { type: 'agent', prompt: 'project prompt', tools: 'none' },
    Locked: { type: 'agent', prompt: 'locked prompt', tools: 'none', lockState: 'locked' },
  });
  const [materiaSources] = useState<Record<string, LoadoutSourceScope>>({ Build: 'default', Project: 'project', Locked: 'user' });
  const [status, setStatus] = useState('');
  const controller = useMateriaEditorController({
    materia,
    materiaSources,
    defaultMateriaIds: ['Build'],
    selectedTab: 'loadout',
    status,
    setStatus,
    reloadConfig: async (options) => {
      await onReload?.(options);
    },
  });

  return (
    <>
      <output aria-label="status">{controller.persistence.status}</output>
      <output aria-label="name">{controller.form.materiaForm.name}</output>
      <output aria-label="editing-id">{controller.form.materiaForm.editingSocketId}</output>
      <output aria-label="prompt">{controller.form.materiaForm.prompt}</output>
      <output aria-label="persist-scope">{controller.form.materiaForm.persistScope}</output>
      <output aria-label="selected-can-delete">{String(controller.selector.selectedPolicy?.canDelete)}</output>
      <output aria-label="selected-can-save">{String(controller.selector.selectedPolicy?.canSave)}</output>
      <button type="button" onClick={() => controller.form.editMateria('Build')}>edit Build</button>
      <button type="button" onClick={() => controller.form.editMateria('Project')}>edit Project</button>
      <button type="button" onClick={() => controller.form.editMateria('Locked')}>edit Locked</button>
      <button type="button" onClick={() => controller.selector.duplicateMateria('Project')}>duplicate Project</button>
      <button type="button" onClick={() => { void controller.selector.deleteMateria('Build'); }}>delete Build</button>
      <button type="button" onClick={() => { void controller.selector.deleteMateria('Project'); }}>delete Project</button>
      <button type="button" onClick={() => { void controller.selector.setMateriaLockState('Project', 'locked'); }}>lock Project</button>
      <button type="button" onClick={() => { void controller.selector.setMateriaLockState('Locked', 'unlocked'); }}>unlock Locked</button>
      <button type="button" onClick={() => { void controller.persistence.saveMateriaForm(); }}>save</button>
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useMateriaEditorController', () => {
  it('loads and reconciles an available role-generation model preference independently from the model catalog', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/profile/role-generation') return new Response(JSON.stringify({ ok: true, model: 'openai/gpt-alt' }));
      if (url === '/api/models') return new Response(JSON.stringify({ ok: true, activeModelValue: 'openai/gpt-active', models: [{ value: 'openai/gpt-alt', label: 'GPT Alt', supportedThinkingLevels: [] }] }));
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<GenerationModelProbe />);

    await waitFor(() => expect(screen.getByLabelText('preference-status').textContent).toBe('ready'));
    await waitFor(() => expect(screen.getByLabelText('generation-options').textContent).toBe('<active>,openai/gpt-alt'));
    expect(screen.getByLabelText('selected-generation-model').textContent).toBe('openai/gpt-alt');
    expect(screen.getByLabelText('persisted-generation-model').textContent).toBe('openai/gpt-alt');
    expect(screen.getByLabelText('stale-generation-warning').textContent).toBe('');
  });

  it('falls the generation picker back to Active Pi Model for stale preferences without clearing them', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/profile/role-generation') return new Response(JSON.stringify({ ok: true, model: 'openai/missing' }));
      if (url === '/api/models') return new Response(JSON.stringify({ ok: true, activeModelValue: 'openai/gpt-active', models: [{ value: 'openai/gpt-alt', label: 'GPT Alt', supportedThinkingLevels: [] }] }));
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<GenerationModelProbe />);

    await waitFor(() => expect(screen.getByLabelText('preference-status').textContent).toBe('ready'));
    await waitFor(() => expect(screen.getByLabelText('generation-options').textContent).toBe('<active>,openai/gpt-alt'));
    expect(screen.getByLabelText('selected-generation-model').textContent).toBe('');
    expect(screen.getByLabelText('persisted-generation-model').textContent).toBe('openai/missing');
    expect(screen.getByLabelText('stale-generation-warning').textContent).toContain('Saved generation model is unavailable');
  });

  it('persists generation-model changes immediately and keeps the last saved value on failure', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/profile/role-generation' && init?.method === 'PATCH') return new Response(JSON.stringify({ ok: false, error: { message: 'save failed' } }), { status: 500 });
      if (url === '/api/profile/role-generation') return new Response(JSON.stringify({ ok: true, model: null }));
      if (url === '/api/models') return new Response(JSON.stringify({ ok: true, activeModelValue: 'openai/gpt-active', models: [{ value: 'openai/gpt-alt', label: 'GPT Alt', supportedThinkingLevels: [] }] }));
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<GenerationModelProbe />);
    await waitFor(() => expect(screen.getByLabelText('preference-status').textContent).toBe('ready'));

    fireEvent.click(screen.getByText('choose alt'));

    await waitFor(() => expect(screen.getByLabelText('save-error').textContent).toBe('save failed'));
    expect(screen.getByLabelText('selected-generation-model').textContent).toBe('');
    expect(screen.getByLabelText('persisted-generation-model').textContent).toBe('');
    expect(fetchMock).toHaveBeenCalledWith('/api/profile/role-generation', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ model: 'openai/gpt-alt' }) }));
  });

  it('applies source-aware policies for built-ins, duplicate drafts, locking, locked saves, and deletes', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, target: 'user' })));
    vi.stubGlobal('fetch', fetchMock);

    render(<PolicyProbe />);

    fireEvent.click(screen.getByText('edit Build'));
    expect(screen.getByLabelText('persist-scope').textContent).toBe('user');
    expect(screen.getByLabelText('selected-can-delete').textContent).toBe('false');
    fireEvent.click(screen.getByText('delete Build'));
    expect(screen.getByLabelText('status').textContent).toBe('Built-in materia cannot be deleted.');

    fireEvent.click(screen.getByText('save'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(JSON.parse(String(calls.at(-1)?.[1].body))).toMatchObject({
      target: 'user',
      config: { materia: { Build: { prompt: 'built-in prompt' } } },
    });

    fireEvent.click(screen.getByText('edit Project'));
    expect(screen.getByLabelText('persist-scope').textContent).toBe('project');
    fireEvent.click(screen.getByText('duplicate Project'));
    expect(screen.getByLabelText('editing-id').textContent).toBe('');
    expect(screen.getByLabelText('name').textContent).toBe('Project Copy');
    expect(screen.getByLabelText('persist-scope').textContent).toBe('user');

    fireEvent.click(screen.getByText('lock Project'));
    await waitFor(() => expect(calls.some((call) => String(call[1].body) === JSON.stringify({ target: 'project', config: { materia: { Project: { lockState: 'locked' } } } }))).toBe(true));

    fireEvent.click(screen.getByText('edit Locked'));
    expect(screen.getByLabelText('selected-can-save').textContent).toBe('false');
    fireEvent.click(screen.getByText('save'));
    await waitFor(() => expect(screen.getByLabelText('status').textContent).toContain('Materia definition Locked is locked'));

    fireEvent.click(screen.getByText('edit Project'));
    fireEvent.click(screen.getByText('delete Project'));
    await waitFor(() => expect(calls.some((call) => String(call[1].body) === JSON.stringify({ target: 'project', config: { materia: { Project: null } } }))).toBe(true));
  });

  it('persists unlock metadata patches to the effective writable scope and reloads config', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, target: 'user' })));
    const reloadMock = vi.fn(async () => {});
    vi.stubGlobal('fetch', fetchMock);

    render(<PolicyProbe onReload={reloadMock} />);

    fireEvent.click(screen.getByText('unlock Locked'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/config', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ target: 'user', config: { materia: { Locked: { lockState: 'unlocked' } } } }),
    })));
    await waitFor(() => expect(reloadMock).toHaveBeenCalledWith(expect.objectContaining({
      preserveLoadoutEdits: true,
      readyStatus: 'Unlocked materia Locked. Loadout draft edits were left unchanged.',
    })));
  });

  it('surfaces backend delete validation errors in status text', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: { message: 'socket references unknown materia "Project"' } }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<PolicyProbe />);

    fireEvent.click(screen.getByText('edit Project'));
    fireEvent.click(screen.getByText('delete Project'));

    await waitFor(() => expect(screen.getByLabelText('status').textContent).toBe('socket references unknown materia "Project"'));
  });

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
