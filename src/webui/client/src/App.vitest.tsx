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

const edgeEditorConfig = {
  activeLoadout: 'Edges',
  loadouts: {
    Edges: {
      entry: 'Start',
      nodes: {
        Start: { type: 'agent', role: 'Start', layout: { x: 0, y: 0 }, edges: [] as Array<{ to: string; when?: string }> },
        Review: { type: 'agent', role: 'Review', layout: { x: 1, y: 0 } },
        Ship: { type: 'agent', role: 'Ship', layout: { x: 2, y: 0 } },
      },
    },
  },
};

const legacyPipelineConfig = {
  roles: {
    planner: { tools: 'none', systemPrompt: 'Plan the work' },
  },
  pipeline: {
    entry: 'planner',
    nodes: {
      planner: { type: 'agent', role: 'planner', next: 'Build', layout: { x: 0, y: 0 } },
      Build: { type: 'agent', role: 'Build', next: 'Done', edges: [{ when: 'not_satisfied', to: 'planner' }], layout: { x: 1, y: 0 } },
      Done: { type: 'utility', utility: 'finish', command: ['echo', 'done'], layout: { x: 2, y: 0 } },
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
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

async function openTab(name: RegExp | string) {
  fireEvent.click(await screen.findByRole('button', { name }));
}

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

  it('renders the active loadout as a directional left-to-right graph', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }))));

    const { container } = render(<App />);

    const planner = await screen.findByTestId('socket-planner');
    const build = await screen.findByTestId('socket-Build');
    const evaluate = await screen.findByTestId('socket-Auto-Eval');
    const maintain = await screen.findByTestId('socket-Maintain');
    expect(parseFloat(planner.style.left)).toBeLessThan(parseFloat(build.style.left));
    expect(parseFloat(build.style.left)).toBeLessThan(parseFloat(evaluate.style.left));
    expect(parseFloat(evaluate.style.left)).toBeLessThan(parseFloat(maintain.style.left));
    expect(planner.style.left).toBe('32px');
    expect(build.style.left).toBe('292px');
    expect(screen.getAllByText('flow').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('satisfied')).toBeTruthy();
    expect(screen.getByText('not satisfied')).toBeTruthy();
    expect(container.querySelector('.loadout-edge-satisfied')).toBeTruthy();
    expect(container.querySelector('.loadout-edge-unsatisfied')).toBeTruthy();
    expect(container.querySelectorAll('.loadout-edge path[marker-end]').length).toBe(4);
  });

  it('toggles a clickable edge condition through validated staged state', async () => {
    const singleEdgeConfig = structuredClone(testConfig);
    singleEdgeConfig.loadouts['Full-Auto'].nodes['Auto-Eval'].edges = [{ when: 'satisfied', to: 'Maintain' }];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: singleEdgeConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const edge = await screen.findByTestId('edge-Auto-Eval-Maintain-0');
    expect(edge.getAttribute('class')).toContain('loadout-edge-satisfied');
    fireEvent.click(edge);

    expect(await screen.findByText(/Staged edge Auto-Eval → Maintain as not satisfied\./)).toBeTruthy();
    expect(screen.getByTestId('edge-Auto-Eval-Maintain-0').getAttribute('class')).toContain('loadout-edge-unsatisfied');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const savedEdge = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'].nodes['Auto-Eval'].edges[0];
    expect(savedEdge).toEqual({ when: 'not_satisfied', to: 'Maintain' });
  });

  it('shows validation failures from edge condition toggles without mutating draft state', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const edge = await screen.findByTestId('edge-Auto-Eval-Maintain-0');
    fireEvent.click(edge);

    expect(await screen.findByText(/Cannot toggle edge Auto-Eval → Maintain: Socket "Auto-Eval" has more than one outgoing unsatisfied edge/)).toBeTruthy();
    expect(screen.getByTestId('edge-Auto-Eval-Maintain-0').getAttribute('class')).toContain('loadout-edge-satisfied');
    expect(screen.queryByText('staged edits')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('creates new loadouts with exactly one empty untyped entry socket', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByTestId('socket-planner');
    fireEvent.click(screen.getByRole('button', { name: 'New' }));

    expect(await screen.findByTestId('socket-Entry')).toBeTruthy();
    expect(screen.getByText('Empty socket')).toBeTruthy();
    expect(screen.getByText('entry')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const savedConfig = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config;
    const created = savedConfig.loadouts[savedConfig.activeLoadout];
    expect(Object.keys(created.nodes)).toEqual(['Entry']);
    expect(created.entry).toBe('Entry');
    expect(created.nodes.Entry).toEqual({ empty: true });
    expect(created.nodes.Entry.type).toBeUndefined();
  });

  it('opens a valid tab from the URL query parameter', async () => {
    window.history.replaceState({}, '', '/?tab=monitor');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }))));

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Live cast telemetry' })).toBeTruthy();
    expect(screen.queryByText('Visual materia grid')).toBeNull();
  });

  it('falls back to Loadout for invalid tab values', async () => {
    window.history.replaceState({}, '', '/?tab=unknown');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }))));

    render(<App />);

    expect(await screen.findByText('Visual materia grid')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Live cast telemetry' })).toBeNull();
  });

  it('removes the standalone Pipeline Graph tab and falls back to Loadout for old graph URLs', async () => {
    window.history.replaceState({}, '', '/?tab=pipeline-graph');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }))));

    render(<App />);

    expect(await screen.findByText('Visual materia grid')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pipeline Graph' })).toBeNull();
    expect(screen.queryByTestId('pipeline-graph')).toBeNull();
  });

  it('switches tabs while preserving unrelated query params and responding to history navigation', async () => {
    window.history.replaceState({}, '', '/?cast=abc');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }))));

    render(<App />);

    await openTab('Materia Editor');
    expect(await screen.findByRole('heading', { name: 'Create / edit materia' })).toBeTruthy();
    expect(window.location.search).toContain('cast=abc');
    expect(window.location.search).toContain('tab=materia-editor');

    window.history.back();
    await waitFor(() => expect(screen.getByText('Visual materia grid')).toBeTruthy());
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

  it('opens a socket action modal and unsockets materia while preserving graph metadata', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByTestId('socket-Build'));

    expect(await screen.findByTestId('socket-action-modal')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unsocket' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New Socket' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Unsocket' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const savedBuild = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'].nodes.Build;
    expect(savedBuild).toMatchObject({ empty: true, next: 'Auto-Eval', layout: { x: 1, y: 0 }, insertedBy: 'node-shift' });
    expect(savedBuild.role).toBeUndefined();
  });

  it('creates a connected empty socket through validated socket modal mutation', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Planning-Consult/ }));
    fireEvent.click(await screen.findByTestId('socket-Build'));
    fireEvent.click(await screen.findByRole('button', { name: 'New Socket' }));
    expect(await screen.findByTestId('socket-Build-Socket')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Planning-Consult'].nodes;
    expect(saved.Build.next).toBe('Build-Socket');
    expect(saved['Build-Socket']).toEqual({ empty: true });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.activeLoadout).toBe('Planning-Consult');
  });

  it('replaces socket materia from the modal while preserving socket graph metadata', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByTestId('socket-Build'));
    fireEvent.click(await screen.findByRole('button', { name: 'Replace' }));

    expect(await screen.findByTestId('materia-replacement-list')).toBeTruthy();
    fireEvent.click(screen.getByTestId('replacement-materia-Maintain'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'].nodes;
    expect(Object.keys(saved)).toContain('Build');
    expect(saved.Build.role).toBe('Maintain');
    expect(saved.Build.next).toBe('Auto-Eval');
    expect(saved.Build.layout).toEqual({ x: 1, y: 0 });
    expect(saved.Build.insertedBy).toBe('node-shift');
    expect(saved['Auto-Eval'].edges).toEqual([{ when: 'satisfied', to: 'Maintain' }, { when: 'not_satisfied', to: 'Build' }]);
  });

  it('cancels modal materia replacement without mutating draft state', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByTestId('socket-Build'));
    fireEvent.click(await screen.findByRole('button', { name: 'Replace' }));
    expect(await screen.findByTestId('materia-replacement-list')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByTestId('socket-action-modal')).toBeNull();
    expect(screen.queryByText('staged edits')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('edits socket properties while preserving materia and graph metadata', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByTestId('socket-Build'));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(await screen.findByTestId('socket-property-editor')).toBeTruthy();
    expect(screen.getByTestId('socket-layout-x')).toHaveProperty('value', '1');
    fireEvent.change(screen.getByTestId('socket-max-visits'), { target: { value: '7' } });
    fireEvent.change(screen.getByTestId('socket-max-edge-traversals'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('socket-max-output-bytes'), { target: { value: '2048' } });
    fireEvent.change(screen.getByTestId('socket-layout-x'), { target: { value: '4' } });
    fireEvent.change(screen.getByTestId('socket-layout-y'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByTestId('save-socket-properties'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'].nodes;
    expect(saved.Build).toMatchObject({ role: 'Build', next: 'Auto-Eval', insertedBy: 'node-shift', limits: { maxVisits: 7, maxEdgeTraversals: 3, maxOutputBytes: 2048 }, layout: { x: 4, y: 1.5 } });
    expect(saved.planner.layout).toEqual({ x: 0, y: 0 });
    expect(saved['Auto-Eval'].edges).toEqual([{ when: 'satisfied', to: 'Maintain' }, { when: 'not_satisfied', to: 'Build' }]);
  });

  it('rejects invalid socket property input without mutating draft state', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByTestId('socket-Build'));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(await screen.findByTestId('socket-max-visits'), { target: { value: '0' } });
    fireEvent.change(screen.getByTestId('socket-layout-x'), { target: { value: 'NaN' } });
    fireEvent.click(screen.getByTestId('save-socket-properties'));

    expect((await screen.findByRole('alert')).textContent).toContain('Max visits must be a positive whole number.');
    expect(screen.getByRole('alert').textContent).toContain('Layout X must be a finite number.');
    expect(screen.getByTestId('socket-property-editor')).toBeTruthy();
    expect(screen.queryByText('staged edits')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    expect(savedBuild.insertedBy).toBe('node-shift');
    expect(savedBuild.edges).toBeUndefined();
  });

  it('ignores invalid palette-to-socket drops without corrupting draft state', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByTestId('socket-Build');
    const dataTransfer = createDataTransfer();
    dataTransfer.setData('application/json', '{not-json');
    fireEvent.drop(screen.getByTestId('socket-Build'), { dataTransfer });

    expect(await screen.findByText('Ignored drop: unsupported drag payload.')).toBeTruthy();
    expect(screen.queryByText('staged edits')).toBeNull();

    dataTransfer.setData('application/json', JSON.stringify({ kind: 'palette', materiaId: 'Missing-Materia' }));
    fireEvent.drop(screen.getByTestId('socket-Build'), { dataTransfer });
    expect(await screen.findByText('Ignored drop: materia Missing-Materia is not available.')).toBeTruthy();
    expect(screen.queryByText('staged edits')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('creates a validated edge between existing sockets from the socket modal', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: edgeEditorConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByTestId('socket-Start'));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Edge' }));
    expect(await screen.findByTestId('edge-connector')).toBeTruthy();
    fireEvent.change(screen.getByTestId('edge-target'), { target: { value: 'Review' } });
    fireEvent.change(screen.getByTestId('edge-condition'), { target: { value: 'not_satisfied' } });
    fireEvent.click(screen.getByTestId('create-edge'));

    expect(await screen.findByText(/Staged edge Start → Review as not satisfied\./)).toBeTruthy();
    expect(screen.getByTestId('edge-Start-Review-0').getAttribute('class')).toContain('loadout-edge-unsatisfied');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts.Edges.nodes;
    expect(saved.Start.edges).toEqual([{ to: 'Review', when: 'not_satisfied' }]);
    expect(saved.Review).toBeTruthy();
  });

  it('removes a conditional edge without deleting either socket', async () => {
    const config = structuredClone(edgeEditorConfig);
    config.loadouts.Edges.nodes.Start.edges = [{ to: 'Review', when: 'satisfied' }];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByTestId('edge-Start-Review-0')).toBeTruthy();
    fireEvent.click(screen.getByTestId('socket-Start'));
    fireEvent.click(await screen.findByTestId('remove-edge-Start-0'));
    expect(await screen.findByText(/Removed edge Start → Review; sockets were preserved\./)).toBeTruthy();
    expect(screen.queryByTestId('edge-Start-Review-0')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts.Edges.nodes;
    expect(saved.Start.edges).toBeUndefined();
    expect(saved.Start).toBeTruthy();
    expect(saved.Review).toBeTruthy();
  });

  it('surfaces invalid edge creation without mutating draft state', async () => {
    const config = structuredClone(edgeEditorConfig);
    config.loadouts.Edges.nodes.Start.edges = [{ to: 'Review', when: 'satisfied' }];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByTestId('socket-Start'));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Edge' }));
    fireEvent.change(screen.getByTestId('edge-target'), { target: { value: 'Ship' } });
    fireEvent.change(screen.getByTestId('edge-condition'), { target: { value: 'satisfied' } });
    fireEvent.click(screen.getByTestId('create-edge'));

    expect((await screen.findByRole('alert')).textContent).toContain('Socket "Start" has more than one outgoing satisfied edge');
    expect(screen.queryByTestId('edge-Start-Ship-1')).toBeNull();
    expect(screen.queryByText('staged edits')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('removes a default flow without dropping conditional edges or sockets', async () => {
    const config = structuredClone(edgeEditorConfig);
    const startNode = config.loadouts.Edges.nodes.Start as typeof config.loadouts.Edges.nodes.Start & { next?: string };
    startNode.next = 'Review';
    startNode.edges = [{ to: 'Ship', when: 'satisfied' }];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByTestId('edge-Start-Review-next')).toBeTruthy();
    expect(screen.getByTestId('edge-Start-Ship-0')).toBeTruthy();
    fireEvent.click(screen.getByTestId('socket-Start'));
    fireEvent.click(await screen.findByTestId('remove-next-edge-Start'));

    expect(await screen.findByText(/Removed default flow Start → Review; conditional edges and sockets were preserved\./)).toBeTruthy();
    expect(screen.queryByTestId('edge-Start-Review-next')).toBeNull();
    expect(screen.getByTestId('edge-Start-Ship-0')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts.Edges.nodes;
    expect(saved.Start.next).toBeUndefined();
    expect(saved.Start.edges).toEqual([{ to: 'Ship', when: 'satisfied' }]);
    expect(saved.Review).toBeTruthy();
    expect(saved.Ship).toBeTruthy();
  });

  it('persists manually dragged socket layout using layout units near the graph origin', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: edgeEditorConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const startSocket = await screen.findByTestId('socket-Start');
    startSocket.setPointerCapture = vi.fn();
    startSocket.releasePointerCapture = vi.fn();
    expect(startSocket.style.left).toBe('32px');
    expect(startSocket.style.top).toBe('28px');

    fireEvent.pointerDown(startSocket, { button: 0, pointerId: 7, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(startSocket, { pointerId: 7, clientX: 108, clientY: 107 });
    fireEvent.pointerUp(startSocket, { pointerId: 7, clientX: 108, clientY: 107 });

    expect(await screen.findByText(/Moved socket Start; explicit layout will be saved with the loadout\./)).toBeTruthy();
    expect(screen.queryByTestId('socket-action-modal')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const savedStart = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts.Edges.nodes.Start;
    expect(savedStart.layout.x).toBeCloseTo(8 / 260);
    expect(savedStart.layout.y).toBeCloseTo(7 / 210);
    expect(savedStart.edges).toEqual([]);
  });

  it('falls back to automatic graph layout when sockets have no explicit layout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }))));

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Planning-Consult/ }));
    const planner = await screen.findByTestId('socket-planner');
    const build = await screen.findByTestId('socket-Build');

    expect(planner.style.left).toBe('32px');
    expect(planner.style.top).toBe('28px');
    expect(build.style.left).toBe('292px');
    expect(build.style.top).toBe('28px');
  });

  it('switches the active loadout as a staged client-side edit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }))));

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Planning-Consult/ }));

    expect(screen.getByTestId('socket-Build')).toBeTruthy();
    expect(screen.queryByTestId('socket-Auto-Eval')).toBeNull();
    expect(screen.getByText('staged edits')).toBeTruthy();
  });




  it('creates prompt materia, emits a saved event, and reloads without clobbering loadout draft edits', async () => {
    let serverConfig = structuredClone(testConfig) as typeof testConfig & { materiaDefinitions?: Record<string, unknown> };
    const savedEvents: CustomEvent[] = [];
    window.addEventListener('materia:saved', (event) => savedEvents.push(event as CustomEvent), { once: true });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        serverConfig = {
          ...serverConfig,
          roles: { ...serverConfig.roles, ...(body.config.roles ?? {}) },
          materiaDefinitions: { ...(serverConfig.materiaDefinitions ?? {}), ...(body.config.materiaDefinitions ?? {}) },
        };
        return new Response(JSON.stringify({ ok: true, target: 'user' }));
      }
      return new Response(JSON.stringify({ ok: true, source: 'test', config: serverConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Planning-Consult/ }));
    await openTab('Materia Editor');
    fireEvent.change(await screen.findByTestId('materia-name'), { target: { value: 'Critique' } });
    fireEvent.change(screen.getByTestId('materia-prompt'), { target: { value: 'Review the output carefully.' } });
    fireEvent.change(screen.getByTestId('materia-model'), { target: { value: 'openai/gpt-review' } });
    fireEvent.change(screen.getByTestId('materia-output-format'), { target: { value: 'json' } });
    fireEvent.click(screen.getByTestId('materia-multiturn'));
    fireEvent.click(screen.getByTestId('save-materia-form'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body.target).toBe('user');
    expect(body.config).not.toHaveProperty('loadouts');
    expect(body.config.materiaDefinitions.Critique).toMatchObject({ type: 'agent', role: 'Critique', prompt: 'Review the output carefully.', parse: 'json' });
    expect(body.config.roles.Critique).toMatchObject({ tools: 'none', systemPrompt: 'Review the output carefully.', model: 'openai/gpt-review', multiTurn: true });
    expect(fetchMock.mock.calls[2][0]).toBe('/api/config');
    expect(savedEvents[0].detail).toMatchObject({ id: 'Critique', name: 'Critique', behavior: 'prompt', requestedScope: 'user', scope: 'user' });
    await waitFor(() => expect(screen.getByTestId('materia-save-status').textContent).toContain('Saved reusable prompt materia Critique'));
    expect(Array.from((screen.getByTestId('edit-materia-select') as HTMLSelectElement).options).map((option) => option.value)).toContain('Critique');
    await openTab('Loadout');
    expect(await screen.findByTestId('palette-Critique')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('creates prompt materia in legacy pipeline configs without materializing loadouts', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: legacyPipelineConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await openTab('Materia Editor');
    fireEvent.change(await screen.findByTestId('materia-name'), { target: { value: 'Critique' } });
    fireEvent.change(screen.getByTestId('materia-prompt'), { target: { value: 'Review the output carefully.' } });
    fireEvent.click(screen.getByTestId('save-materia-form'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body.config).not.toHaveProperty('loadouts');
    expect(body.config).not.toHaveProperty('pipeline');
    expect(body.config.materiaDefinitions.Critique).toMatchObject({ type: 'agent', role: 'Critique', prompt: 'Review the output carefully.', parse: 'text' });
    expect(body.config.roles.Critique).toMatchObject({ tools: 'none', systemPrompt: 'Review the output carefully.' });
  });

  it('creates tool invocation materia and only uses project persistence when explicitly selected', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'project' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await openTab('Materia Editor');
    fireEvent.change(await screen.findByTestId('materia-name'), { target: { value: 'RunTests' } });
    fireEvent.change(screen.getByTestId('materia-behavior'), { target: { value: 'tool' } });
    fireEvent.change(screen.getByTestId('materia-persist-scope'), { target: { value: 'project' } });
    fireEvent.change(screen.getByTestId('materia-utility'), { target: { value: 'shell' } });
    fireEvent.change(screen.getByTestId('materia-command'), { target: { value: 'npm test' } });
    fireEvent.change(screen.getByTestId('materia-params'), { target: { value: '{"ci":true}' } });
    fireEvent.change(screen.getByTestId('materia-timeout'), { target: { value: '90000' } });
    fireEvent.click(screen.getByTestId('save-materia-form'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body.target).toBe('project');
    expect(body.config).not.toHaveProperty('loadouts');
    expect(body.config).not.toHaveProperty('roles');
    expect(body.config.materiaDefinitions.RunTests).toMatchObject({ type: 'utility', utility: 'shell', command: ['npm', 'test'], params: { ci: true }, timeoutMs: 90000 });
  });

  it('populates the edit selector from reusable definitions instead of active loadout sockets', async () => {
    const selectorConfig = {
      activeLoadout: 'Full-Auto',
      roles: {
        Build: { tools: 'coding', systemPrompt: 'Build the work' },
        RoleOnly: { tools: 'none', systemPrompt: 'Reusable role not placed in a socket' },
      },
      materiaDefinitions: {
        RunTests: { type: 'utility', utility: 'shell', command: ['npm', 'test'] },
        PromptDef: { type: 'agent', role: 'RoleOnly', prompt: 'Prompt definition' },
      },
      loadouts: {
        'Full-Auto': {
          entry: 'SocketOnly',
          nodes: {
            SocketOnly: { type: 'agent', role: 'SocketOnly' },
            Build: { type: 'agent', role: 'Build' },
          },
        },
        Alternate: {
          entry: 'OtherSocket',
          nodes: {
            OtherSocket: { type: 'utility', utility: 'other' },
          },
        },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: selectorConfig }))));

    render(<App />);

    await openTab('Materia Editor');
    const select = await screen.findByTestId('edit-materia-select') as HTMLSelectElement;
    const initialOptions = Array.from(select.options).map((option) => option.value);
    expect(initialOptions).toEqual(['', 'Build', 'PromptDef', 'RoleOnly', 'RunTests']);
    expect(initialOptions).not.toContain('SocketOnly');
    expect(initialOptions).not.toContain('OtherSocket');

    await openTab('Loadout');
    expect(await screen.findByTestId('palette-RunTests')).toBeTruthy();
    expect(screen.getByTestId('palette-RoleOnly')).toBeTruthy();
    expect(screen.getByTestId('palette-SocketOnly')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: /Alternate/ }));
    await openTab('Materia Editor');
    const afterLoadoutSwitch = Array.from((await screen.findByTestId('edit-materia-select') as HTMLSelectElement).options).map((option) => option.value);
    expect(afterLoadoutSwitch).toEqual(initialOptions);
  });

  it('loads existing tool definition data without selecting or mutating loadout sockets', async () => {
    const selectorConfig = {
      activeLoadout: 'Full-Auto',
      roles: {
        Build: { tools: 'coding', systemPrompt: 'Build the work' },
      },
      materiaDefinitions: {
        RunTests: { type: 'utility', utility: 'shell', command: ['npm', 'test'], params: { ci: true }, timeoutMs: 90000, parse: 'json' },
      },
      loadouts: testConfig.loadouts,
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: selectorConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await openTab('Materia Editor');
    fireEvent.change(await screen.findByTestId('edit-materia-select'), { target: { value: 'RunTests' } });
    expect(screen.getByTestId('materia-name')).toHaveProperty('value', 'RunTests');
    expect(screen.getByTestId('materia-behavior')).toHaveProperty('value', 'tool');
    expect(screen.getByTestId('materia-utility')).toHaveProperty('value', 'shell');
    expect(screen.getByTestId('materia-command')).toHaveProperty('value', 'npm test');
    expect(screen.getByTestId('materia-timeout')).toHaveProperty('value', '90000');
    fireEvent.change(screen.getByTestId('materia-timeout'), { target: { value: '91000' } });
    fireEvent.click(screen.getByTestId('save-materia-form'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body.config).not.toHaveProperty('loadouts');
    expect(body.config.materiaDefinitions.RunTests).toMatchObject({ timeoutMs: 91000 });
  });

  it('edits existing prompt materia role settings where supported', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await openTab('Materia Editor');
    fireEvent.change(await screen.findByTestId('edit-materia-select'), { target: { value: 'Build' } });
    fireEvent.change(screen.getByTestId('materia-prompt'), { target: { value: 'Build with extra care.' } });
    fireEvent.change(screen.getByTestId('materia-tools'), { target: { value: 'readOnly' } });
    fireEvent.click(screen.getByTestId('save-materia-form'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body.target).toBe('user');
    expect(body.config).not.toHaveProperty('loadouts');
    expect(body.config.materiaDefinitions.Build).toMatchObject({ type: 'agent', role: 'Build', prompt: 'Build with extra care.', parse: 'text' });
    expect(body.config.roles.Build).toMatchObject({ tools: 'readOnly', systemPrompt: 'Build with extra care.', model: 'openai/gpt-test' });
  });


  it('renders live monitor updates and highlights the active loadout socket', async () => {
    const listeners = new Map<string, (event: MessageEvent) => void>();
    class MockEventSource {
      url: string;
      constructor(url: string) { this.url = url; }
      addEventListener(type: string, listener: (event: MessageEvent) => void) { listeners.set(type, listener); }
      close() {}
    }
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }))));

    render(<App />);
    await screen.findByTestId('socket-Build');
    listeners.get('monitor')?.(new MessageEvent('monitor', { data: JSON.stringify({
      ok: true,
      now: 61_000,
      uiStartedAt: 1_000,
      activeCast: { castId: 'cast-1', active: true, phase: 'Build', currentNode: 'Build', currentRole: 'Build', nodeState: 'awaiting_agent_response', awaitingResponse: true, runDir: '/tmp/run', artifactRoot: '/tmp', startedAt: 1_000, updatedAt: 61_000 },
      emittedOutputs: [{ id: 'entry-1', type: 'pi-materia', text: 'Build · role_prompt', timestamp: 61_000, node: 'Build' }],
      artifactSummary: { runDir: '/tmp/run', summary: 'Completed nodes: planner', outputs: [{ node: 'Build', kind: 'node_output', artifact: 'nodes/Build/1.md', content: 'built' }] },
    }) }));

    await waitFor(() => expect(screen.getByTestId('socket-Build').className).toContain('materia-socket-active'));
    await openTab('Monitoring');
    expect(await screen.findByText('awaiting_agent_response')).toBeTruthy();
    expect(screen.getByText('Completed nodes: planner')).toBeTruthy();
  });
});
