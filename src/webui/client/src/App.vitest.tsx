import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App.js';

const testConfig = {
  activeLoadout: 'Full-Auto',
  roles: {
    planner: { tools: 'none', systemPrompt: 'Plan the work' },
    Build: { tools: 'coding', systemPrompt: 'Build the work', model: 'openai/gpt-test' },
  },
  loadouts: {
    'Full-Auto': {
      entry: 'planner',
      nodes: {
        planner: { type: 'agent', role: 'planner', next: 'Build', layout: { x: 0, y: 0 } },
        Build: { type: 'agent', role: 'Build', next: 'Auto-Eval', layout: { x: 1, y: 0 }, insertedBy: 'node-shift' },
        'Auto-Eval': { type: 'agent', role: 'Auto-Eval', edges: [{ when: 'satisfied', to: 'Maintain' }, { when: 'not_satisfied', to: 'Build' }], layout: { x: 2, y: 0 } },
        Maintain: { type: 'agent', role: 'Maintain', layout: { x: 3, y: 0 } },
      },
    },
    'Planning-Consult': {
      entry: 'planner',
      nodes: {
        planner: { type: 'agent', role: 'interactivePlan', next: 'Build' },
        Build: { type: 'agent', role: 'Build' },
      },
    },
  },
};

function createDataTransfer() {
  const store = new Map<string, string>();
  return {
    effectAllowed: 'move',
    setData: (key: string, value: string) => store.set(key, value),
    getData: (key: string) => store.get(key) ?? '',
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Materia loadout grid editor', () => {
  it('renders active and available loadouts with staged save controls', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }))));

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Materia WebUI' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Full-Auto/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Planning-Consult/ })).toBeTruthy();
    expect(screen.getByTestId('socket-planner')).toBeTruthy();
    expect(screen.getByText(/Changes are staged until you save/i)).toBeTruthy();
  });

  it('supports click-to-swap staging before explicit persistence', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user', written: 'profile' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByTestId('palette-Maintain');
    fireEvent.click(screen.getByTestId('palette-Maintain'));
    fireEvent.click(screen.getByTestId('socket-Build'));

    expect(screen.getByText('staged edits')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saveCall = fetchMock.mock.calls[1];
    expect(saveCall[0]).toBe('/api/config');
    expect(JSON.parse(String(saveCall[1]?.body)).target).toBe('user');
    const savedBuild = JSON.parse(String(saveCall[1]?.body)).config.loadouts['Full-Auto'].nodes.Build;
    expect(savedBuild.role).toBe('Maintain');
    expect(savedBuild.next).toBe('Auto-Eval');
    expect(savedBuild.layout).toEqual({ x: 1, y: 0 });
    expect(savedBuild.insertedBy).toBe('node-shift');
  });

  it('preserves socket graph structure when dragging materia between sockets', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByTestId('socket-Maintain');
    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(screen.getByTestId('socket-Maintain').querySelector('[draggable="true"]') as HTMLElement, { dataTransfer });
    fireEvent.drop(screen.getByTestId('socket-Build'), { dataTransfer });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'].nodes;
    expect(saved.Build.role).toBe('Maintain');
    expect(saved.Build.next).toBe('Auto-Eval');
    expect(saved.Build.layout).toEqual({ x: 1, y: 0 });
    expect(saved.Build.insertedBy).toBe('node-shift');
    expect(saved.Maintain.role).toBe('Build');
    expect(saved.Maintain.layout).toEqual({ x: 3, y: 0 });
    expect(saved.planner.next).toBe('Build');
    expect(saved['Auto-Eval'].edges).toEqual([{ when: 'satisfied', to: 'Maintain' }, { when: 'not_satisfied', to: 'Build' }]);
  });

  it('clears dragged-out materia without deleting graph sockets or dangling references', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByTestId('socket-Auto-Eval');
    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(screen.getByTestId('socket-Auto-Eval').querySelector('[draggable="true"]') as HTMLElement, { dataTransfer });
    fireEvent.drop(screen.getByTestId('trash-socket'), { dataTransfer });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'].nodes;
    expect(saved['Auto-Eval']).toMatchObject({ empty: true, layout: { x: 2, y: 0 }, edges: [{ when: 'satisfied', to: 'Maintain' }, { when: 'not_satisfied', to: 'Build' }] });
    expect(Object.keys(saved)).toContain('Auto-Eval');
    expect(saved.Build.next).toBe('Auto-Eval');
  });

  it('preserves socket graph structure when dragging a palette materia into a socket', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(await screen.findByTestId('palette-Maintain'), { dataTransfer });
    fireEvent.drop(screen.getByTestId('socket-Build'), { dataTransfer });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const savedBuild = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'].nodes.Build;
    expect(savedBuild.role).toBe('Maintain');
    expect(savedBuild.next).toBe('Auto-Eval');
    expect(savedBuild.layout).toEqual({ x: 1, y: 0 });
  });

  it('switches the active loadout as a staged client-side edit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }))));

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Planning-Consult/ }));

    expect(screen.getByTestId('socket-Build')).toBeTruthy();
    expect(screen.queryByTestId('socket-Auto-Eval')).toBeNull();
    expect(screen.getByText('staged edits')).toBeTruthy();
  });

  it('renders the visual pipeline graph with current edges', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }))));

    render(<App />);

    expect(await screen.findByTestId('pipeline-graph')).toBeTruthy();
    expect(screen.getByTestId('graph-node-planner')).toBeTruthy();
    expect(screen.getByTestId('graph-node-Auto-Eval')).toBeTruthy();
    expect(screen.getAllByText('satisfied').length).toBeGreaterThan(0);
    expect(screen.getAllByText('not_satisfied').length).toBeGreaterThan(0);
  });

  it('adds a graph node and persists it through staged save', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.change(await screen.findByTestId('new-node-id'), { target: { value: 'Verifier' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add node' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'].nodes;
    expect(saved.Verifier).toMatchObject({ type: 'agent', role: 'Verifier', limits: { maxVisits: 3 } });
    expect(saved.Build.insertedBy).toBe('node-shift');
  });

  it('inserts a node between existing nodes while preserving surrounding layout and inserted metadata', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.change(await screen.findByTestId('insert-from'), { target: { value: 'Build' } });
    fireEvent.change(screen.getByTestId('insert-to'), { target: { value: 'Auto-Eval' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'].nodes;
    expect(saved.Build.next).toBe('Build-insert');
    expect(saved.Build.layout).toEqual({ x: 1, y: 0 });
    expect(saved.Build.insertedBy).toBe('node-shift');
    expect(saved['Build-insert']).toMatchObject({ next: 'Auto-Eval', inserted: { between: ['Build', 'Auto-Eval'], via: 'webui-graph-editor' } });
    expect(saved['Auto-Eval'].edges).toEqual([{ when: 'satisfied', to: 'Maintain' }, { when: 'not_satisfied', to: 'Build' }]);
  });

  it('creates prompt materia with model, output format, and multiturn defaults to user persistence', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.change(await screen.findByTestId('materia-name'), { target: { value: 'Critique' } });
    fireEvent.change(screen.getByTestId('materia-prompt'), { target: { value: 'Review the output carefully.' } });
    fireEvent.change(screen.getByTestId('materia-model'), { target: { value: 'openai/gpt-review' } });
    fireEvent.change(screen.getByTestId('materia-output-format'), { target: { value: 'json' } });
    fireEvent.click(screen.getByTestId('materia-multiturn'));
    fireEvent.click(screen.getByTestId('save-materia-form'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body.target).toBe('user');
    expect(body.config.loadouts['Full-Auto'].nodes.Critique).toMatchObject({ type: 'agent', role: 'Critique', prompt: 'Review the output carefully.', parse: 'json' });
    expect(body.config.roles.Critique).toMatchObject({ tools: 'none', systemPrompt: 'Review the output carefully.', model: 'openai/gpt-review', multiTurn: true });
  });

  it('creates tool invocation materia and only uses project persistence when explicitly selected', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'project' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.change(await screen.findByTestId('materia-name'), { target: { value: 'RunTests' } });
    fireEvent.change(screen.getByTestId('materia-behavior'), { target: { value: 'tool' } });
    fireEvent.change(screen.getByTestId('materia-persist-scope'), { target: { value: 'project' } });
    fireEvent.change(screen.getByTestId('materia-utility'), { target: { value: 'shell' } });
    fireEvent.change(screen.getByTestId('materia-command'), { target: { value: 'npm test' } });
    fireEvent.change(screen.getByTestId('materia-params'), { target: { value: '{"ci":true}' } });
    fireEvent.change(screen.getByTestId('materia-timeout'), { target: { value: '90000' } });
    fireEvent.click(screen.getByTestId('save-materia-form'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body.target).toBe('project');
    expect(body.config.loadouts['Full-Auto'].nodes.RunTests).toMatchObject({ type: 'utility', utility: 'shell', command: ['npm', 'test'], params: { ci: true }, timeoutMs: 90000 });
  });

  it('edits existing prompt materia role settings where supported', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.change(await screen.findByTestId('edit-materia-select'), { target: { value: 'Build' } });
    fireEvent.change(screen.getByTestId('materia-prompt'), { target: { value: 'Build with extra care.' } });
    fireEvent.change(screen.getByTestId('materia-tools'), { target: { value: 'readOnly' } });
    fireEvent.click(screen.getByTestId('save-materia-form'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body.target).toBe('user');
    expect(body.config.loadouts['Full-Auto'].nodes.Build).toMatchObject({ type: 'agent', role: 'Build', prompt: 'Build with extra care.', next: 'Auto-Eval', layout: { x: 1, y: 0 }, insertedBy: 'node-shift' });
    expect(body.config.roles.Build).toMatchObject({ tools: 'readOnly', systemPrompt: 'Build with extra care.', model: 'openai/gpt-test' });
  });

  it('stages branch, layout, and retry limit edits without deleting graph semantics', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByTestId('graph-node-Build');
    fireEvent.change(screen.getByLabelText('Build satisfied branch'), { target: { value: 'Maintain' } });
    fireEvent.change(screen.getByLabelText('Build not satisfied branch'), { target: { value: 'planner' } });
    fireEvent.change(screen.getByLabelText('Build layout x'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Build satisfied max traversals'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Build max visits'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Build max edge traversals'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'].nodes;
    expect(saved.Build.next).toBe('Auto-Eval');
    expect(saved.Build.edges).toEqual([{ when: 'satisfied', to: 'Maintain', maxTraversals: 2 }, { when: 'not_satisfied', to: 'planner' }]);
    expect(saved.Build.layout).toEqual({ x: 7, y: 0 });
    expect(saved.Build.limits).toMatchObject({ maxVisits: 5, maxEdgeTraversals: 9 });
    expect(saved.Build.insertedBy).toBe('node-shift');
  });
});
