import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App, getLoopMemberships, getLoopRegions, routeLoadoutEdges } from './App.js';

const testConfig = {
  activeLoadout: 'Full-Auto',
  materia: {
    planner: { tools: 'none', prompt: 'Plan the work', generates: { output: 'tasks', listType: 'array', itemType: 'task', as: 'task', cursor: 'taskIndex', done: 'end' } },
    Build: { tools: 'coding', prompt: 'Build the work', model: 'openai/gpt-test' },
    'Auto-Eval': { tools: 'readOnly', prompt: 'Evaluate the work' },
    Maintain: { tools: 'coding', prompt: 'Maintain the work' },
    interactivePlan: { tools: 'readOnly', prompt: 'Plan interactively', multiTurn: true },
  },
  loadouts: {
    'Full-Auto': {
      entry: 'planner',
      nodes: {
        planner: { type: 'agent', materia: 'planner', parse: 'json', assign: { tasks: '$.tasks' }, edges: [{ when: 'always', to: 'Build' }], layout: { x: 0, y: 0 } },
        Build: { type: 'agent', materia: 'Build', edges: [{ when: 'always', to: 'Auto-Eval' }], layout: { x: 1, y: 0 }, insertedBy: 'node-shift' },
        'Auto-Eval': { type: 'agent', materia: 'Auto-Eval', edges: [{ when: 'satisfied', to: 'Maintain' }, { when: 'not_satisfied', to: 'Build' }], layout: { x: 2, y: 0 } },
        Maintain: { type: 'agent', materia: 'Maintain', layout: { x: 3, y: 0 } },
      },
    },
    'Planning-Consult': {
      entry: 'planner',
      nodes: {
        planner: { type: 'agent', materia: 'interactivePlan', edges: [{ when: 'always', to: 'Build' }] },
        Build: { type: 'agent', materia: 'Build' },
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
        Start: { type: 'agent', materia: 'Start', layout: { x: 0, y: 0 }, edges: [] as Array<{ to: string; when?: string }> },
        Review: { type: 'agent', materia: 'Review', layout: { x: 1, y: 0 } },
        Ship: { type: 'agent', materia: 'Ship', layout: { x: 2, y: 0 } },
      },
    },
  },
};

const legacyPipelineConfig = {
  materia: {
    planner: { tools: 'none', prompt: 'Plan the work' },
  },
  pipeline: {
    entry: 'planner',
    nodes: {
      planner: { type: 'agent', materia: 'planner', edges: [{ when: 'always', to: 'Build' }], layout: { x: 0, y: 0 } },
      Build: { type: 'agent', materia: 'Build', edges: [{ when: 'always', to: 'Done' }, { when: 'not_satisfied', to: 'planner' }], layout: { x: 1, y: 0 } },
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

function paletteIds() {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="palette-"]')).map((element) => element.dataset.testid?.replace('palette-', ''));
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

  it('renders socket supplemental details as hover titles', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }))));

    render(<App />);

    const build = await screen.findByTestId('socket-Build');
    expect(build.getAttribute('title')).toContain('Socket: Build');
    expect(build.getAttribute('title')).toContain('Materia: Build');
    expect(build.getAttribute('title')).toContain('Model: openai/gpt-test');
    expect(build.getAttribute('title')).toContain('Edges: Always → Auto-Eval');
  });

  it('renders longer loadout socket labels in full while keeping them single-line', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }))));

    render(<App />);

    const autoEvalSocket = await screen.findByTestId('socket-Auto-Eval');
    const autoEvalLabel = autoEvalSocket.querySelector('.materia-socket-label');
    expect(autoEvalLabel?.textContent).toBe('Auto-Eval');
    expect(autoEvalSocket.textContent).not.toContain('Auto-E...');

    fireEvent.click(screen.getByRole('button', { name: /Planning-Consult/ }));
    const interactivePlanSocket = await screen.findByTestId('socket-planner');
    const interactivePlanLabel = interactivePlanSocket.querySelector('.materia-socket-label');
    expect(interactivePlanLabel?.textContent).toBe('interactivePlan');
    expect(interactivePlanSocket.textContent).not.toContain('interac...');

    const css = readFileSync(`${process.cwd()}/src/webui/client/src/styles.css`, 'utf8');
    expect(css).toContain('--materia-socket-width: 8.25rem;');
    expect(css).toMatch(/\.materia-socket-label\s*{[^}]*max-width: var\(--materia-socket-width\);[^}]*white-space: nowrap;/s);
    expect(css).toMatch(/\.graph-materia-socket\s*{[^}]*width: var\(--materia-socket-width\);/s);
  });

  it('marks iterator materia in both the palette and graph without changing non-iterators', async () => {
    const config = structuredClone(testConfig) as typeof testConfig & { materia: typeof testConfig.materia & { Build: typeof testConfig.materia.Build & { foreach?: { items: string; as?: string; done?: string } } } };
    config.materia.Build.foreach = { items: 'state.tasks', as: 'task', done: 'end' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config }))));

    render(<App />);

    const paletteBuild = await screen.findByTestId('palette-Build');
    expect(paletteBuild.classList.contains('palette-orb-iterator')).toBe(true);
    expect(paletteBuild.querySelector('.materia-orb-iterator')).toBeTruthy();
    expect(paletteBuild.textContent).toContain('Iterator');
    expect(paletteBuild.getAttribute('title')).toContain('Iterator: state.tasks as task until end');

    const socketBuild = screen.getByTestId('socket-Build');
    expect(socketBuild.classList.contains('materia-socket-iterator')).toBe(true);
    expect(socketBuild.querySelector('.materia-orb-iterator')).toBeTruthy();
    expect(socketBuild.textContent).toContain('Iterator');
    expect(socketBuild.getAttribute('title')).toContain('Iterator: state.tasks as task until end');

    const paletteMaintain = screen.getByTestId('palette-Maintain');
    expect(paletteMaintain.classList.contains('palette-orb-iterator')).toBe(false);
    expect(paletteMaintain.querySelector('.materia-orb-iterator')).toBeNull();
    expect(paletteMaintain.textContent).not.toContain('Iterator');
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
    expect(build.style.left).toBe('240px');
    expect(screen.getAllByText('Always').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Satisfied')).toBeTruthy();
    expect(screen.getByText('Not Satisfied')).toBeTruthy();
    expect(container.querySelector('.loadout-edge-satisfied')).toBeTruthy();
    expect(container.querySelector('.loadout-edge-unsatisfied')).toBeTruthy();
    expect(container.querySelectorAll('.loadout-edge path[marker-end]').length).toBe(4);
    const forwardPath = screen.getByTestId('edge-Build-Auto-Eval-0').querySelector('path')?.getAttribute('d');
    const retryEdge = screen.getByTestId('edge-Auto-Eval-Build-1');
    expect(retryEdge.getAttribute('class')).toContain('loadout-edge-route-backward');
    expect(retryEdge.querySelector('path')?.getAttribute('d')).not.toBe(forwardPath);
  });

  it('marks generator materia and generator edges distinctly without tagging loop members as iterators', async () => {
    const config = structuredClone(testConfig);
    (config.loadouts['Full-Auto'] as { loops?: unknown }).loops = {
      taskIteration: {
        label: 'Build → Eval → Maintain until all tasks complete',
        nodes: ['Build', 'Auto-Eval', 'Maintain'],
        consumes: { from: 'planner', output: 'tasks' },
        exit: { from: 'Maintain', when: 'satisfied', to: 'end' },
      },
    } as never;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config }))));

    render(<App />);

    const palettePlanner = await screen.findByTestId('palette-planner');
    expect(palettePlanner.classList.contains('palette-orb-generator')).toBe(true);
    expect(palettePlanner.textContent).toContain('List: tasks');
    expect(palettePlanner.getAttribute('title')).toContain('Generated list output: tasks (task list)');

    const planner = screen.getByTestId('socket-planner');
    expect(planner.classList.contains('materia-socket-generator')).toBe(true);
    expect(planner.textContent).toContain('List: tasks');
    const plannerBadge = planner.querySelector('.graph-iterator-badge');
    expect(plannerBadge?.classList.contains('materia-generator-badge')).toBe(true);
    expect(plannerBadge?.textContent).toBe('List: tasks');

    const generatorEdge = screen.getByTestId('edge-planner-Build-0');
    expect(generatorEdge.classList.contains('loadout-edge-generator-input')).toBe(true);
    expect(generatorEdge.textContent).toContain('Generates output: tasks');
    expect(generatorEdge.querySelector('path')?.getAttribute('marker-end')).toBe('url(#materia-generator-edge-arrow)');

    const build = screen.getByTestId('socket-Build');
    expect(build.classList.contains('materia-socket-iterator')).toBe(false);
    expect(build.textContent).not.toContain('Iterator');
    expect(build.textContent).not.toContain('Loop consumer');
    expect(build.getAttribute('title')).toContain('Loop consumes: planner.tasks');
    expect(screen.getByTestId('loop-region-taskIteration').getAttribute('title')).toContain('Loop consumes: planner.tasks');
  });

  it('highlights only loop-member sockets with coordinated per-loop accents', async () => {
    const config = structuredClone(testConfig);
    (config.loadouts['Full-Auto'] as { loops?: unknown }).loops = {
      taskIteration: {
        label: 'Build → Eval → Maintain until all tasks complete',
        nodes: ['Build', 'Auto-Eval', 'Maintain'],
        consumes: { from: 'planner', output: 'tasks' },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config }))));

    render(<App />);

    const build = await screen.findByTestId('socket-Build');
    const autoEval = screen.getByTestId('socket-Auto-Eval');
    const planner = screen.getByTestId('socket-planner');
    const cycleEdge = await screen.findByTestId('loop-cycle-edge-taskIteration');

    expect(build.classList.contains('materia-socket-loop-member')).toBe(true);
    expect(autoEval.classList.contains('materia-socket-loop-member')).toBe(true);
    expect(build.dataset.loopIds).toBe('taskIteration');
    expect(planner.classList.contains('materia-socket-loop-member')).toBe(false);
    expect(build.style.getPropertyValue('--loop-accent')).toBe(cycleEdge.style.getPropertyValue('--loop-accent'));
  });

  it('tracks overlapping loop memberships without collapsing loop identities', () => {
    const memberships = getLoopMemberships({
      nodes: {},
      loops: {
        first: { nodes: ['Build', 'Auto-Eval'], iterator: { items: 'state.first' } },
        second: { nodes: ['Auto-Eval', 'Maintain'], iterator: { items: 'state.second' } },
      },
    } as never);

    expect(memberships.get('Build')?.loopIds).toEqual(['first']);
    expect(memberships.get('Auto-Eval')?.loopIds).toEqual(['first', 'second']);
    expect(memberships.get('Maintain')?.loopIds).toEqual(['second']);
    expect(memberships.has('planner')).toBe(false);
  });

  it('renders explicit loop regions and can create the build-eval-maintain task loop', async () => {
    const config = structuredClone(testConfig);
    (config.loadouts['Full-Auto'] as { loops?: unknown }).loops = {
      taskIteration: {
        label: 'Build → Eval → Maintain until all tasks complete',
        nodes: ['Build', 'Auto-Eval', 'Maintain'],
        iterator: { items: 'state.tasks', as: 'task', cursor: 'taskIndex', done: 'end' },
        exit: { from: 'Maintain', when: 'satisfied', to: 'end' },
      },
    } as never;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config }))));

    render(<App />);

    const region = await screen.findByTestId('loop-region-taskIteration');
    const buildSocket = screen.getByTestId('socket-Build');
    const summary = 'Loop consumes: state.tasks as task until end • Exit: Maintain (Maintain).Satisfied → end';
    expect(region.querySelector('.loadout-loop-badge')?.textContent).toBe('Loop');
    expect(region.querySelector('.loadout-loop-title')?.textContent).toBe('Build → Eval → Maintain until all tasks complete');
    expect(region.querySelector('.loadout-loop-summary')?.textContent).toBe(summary);
    expect(parseFloat(region.style.height)).toBeGreaterThanOrEqual(92);
    expect(parseFloat(buildSocket.style.top) - (parseFloat(region.style.top) + parseFloat(region.style.height))).toBeGreaterThanOrEqual(16);
    expect(region.style.clipPath).toBe('');
    expect(region.getAttribute('style')).not.toContain('--loop-region-polygon');
    expect(await screen.findByTestId('loop-cycle-edge-taskIteration')).toBeTruthy();
    expect(parseFloat(region.style.top)).toBeGreaterThanOrEqual(28);
    expect(region.textContent).toContain('Build → Eval → Maintain until all tasks complete');
    expect(region.textContent).toContain(summary);
    expect(region.getAttribute('title')).toBe(summary);
    expect(screen.getByTestId('loop-editor-panel').textContent).toContain('Loop exits');
    const sourceOptions = Array.from(screen.getByTestId('loop-exit-source-taskIteration').querySelectorAll('option')).map((option) => option.getAttribute('value'));
    expect(sourceOptions).toEqual(['Build', 'Auto-Eval', 'Maintain']);
    const sourceOptionLabels = Array.from(screen.getByTestId('loop-exit-source-taskIteration').querySelectorAll('option')).map((option) => option.textContent);
    expect(sourceOptionLabels).toEqual(['Build (Build)', 'Auto-Eval (Auto-Eval)', 'Maintain (Maintain)']);
    expect(screen.getByTestId('loop-exit-condition-taskIteration')).toBeTruthy();
    expect(screen.getByTestId('loop-exit-target-taskIteration')).toBeTruthy();
  });

  it('edits loop exit conditions with the canonical edge model', async () => {
    const config = structuredClone(testConfig);
    (config.loadouts['Full-Auto'] as { loops?: unknown }).loops = {
      taskIteration: {
        label: 'Build → Eval → Maintain until all tasks complete',
        nodes: ['Build', 'Auto-Eval', 'Maintain'],
        iterator: { items: 'state.tasks', as: 'task', cursor: 'taskIndex', done: 'end' },
        exit: { from: 'Maintain', when: 'satisfied', to: 'end' },
      },
    } as never;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.change(await screen.findByTestId('loop-exit-source-taskIteration'), { target: { value: 'Auto-Eval' } });
    await waitFor(() => expect(screen.getByTestId('loop-region-taskIteration').getAttribute('title')).toContain('Exit: Auto-Eval (Auto-Eval).Satisfied → end'));
    fireEvent.change(screen.getByTestId('loop-exit-condition-taskIteration'), { target: { value: 'not_satisfied' } });
    await waitFor(() => expect(screen.getByTestId('loop-region-taskIteration').getAttribute('title')).toContain('Exit: Auto-Eval (Auto-Eval).Not Satisfied → end'));
    fireEvent.change(screen.getByTestId('loop-exit-target-taskIteration'), { target: { value: 'Maintain' } });
    await waitFor(() => expect(screen.getByTestId('loop-region-taskIteration').getAttribute('title')).toContain('Exit: Auto-Eval (Auto-Eval).Not Satisfied → Maintain (Maintain)'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'];
    expect(saved.loops.taskIteration.exit).toEqual({ from: 'Auto-Eval', when: 'not_satisfied', to: 'Maintain' });
  });

  it('creates and saves an explicit loop from shift-selected sockets on a fresh layout', async () => {
    const config = structuredClone(testConfig);
    delete (config.loadouts['Full-Auto'] as { loops?: unknown }).loops;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const createLoop = await screen.findByTestId('create-task-loop');
    expect(createLoop).toHaveProperty('disabled', true);
    fireEvent.click(await screen.findByTestId('socket-Build'), { shiftKey: true });
    fireEvent.click(screen.getByTestId('socket-Auto-Eval'), { shiftKey: true });
    fireEvent.click(screen.getByTestId('socket-Maintain'), { shiftKey: true });
    expect(createLoop).toHaveProperty('disabled', false);
    expect(screen.getByTestId('socket-Build').classList.contains('materia-socket-loop-selected')).toBe(true);

    fireEvent.click(createLoop);
    expect(await screen.findByTestId('loop-region-loopSelection')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'];
    expect(saved.loops.loopSelection).toEqual({
      label: 'Loop: Build → Auto-Eval → Maintain',
      nodes: ['Build', 'Auto-Eval', 'Maintain'],
      consumes: { from: 'planner', output: 'tasks' },
      exit: { from: 'Maintain', when: 'satisfied', to: 'end' },
    });
  });

  it('creates a loop from selected sockets on a fresh non-Build layout', async () => {
    const config = {
      activeLoadout: 'Fresh Loop',
      materia: {
        planner: { tools: 'none', prompt: 'Plan', generates: { output: 'items', listType: 'array', itemType: 'task' } },
        worker: { tools: 'coding', prompt: 'Work' },
        checker: { tools: 'readOnly', prompt: 'Check' },
      },
      loadouts: {
        'Fresh Loop': {
          entry: 'PlanSocket',
          nodes: {
            PlanSocket: { type: 'agent', materia: 'planner', assign: { items: '$.items' }, edges: [{ when: 'always', to: 'DoWork' }], layout: { x: 0, y: 0 } },
            DoWork: { type: 'agent', materia: 'worker', edges: [{ when: 'always', to: 'CheckWork' }], layout: { x: 1, y: 0 } },
            CheckWork: { type: 'agent', materia: 'checker', edges: [{ when: 'not_satisfied', to: 'DoWork' }], layout: { x: 2, y: 0 } },
          },
        },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config }))));

    render(<App />);

    fireEvent.click(await screen.findByTestId('socket-DoWork'), { shiftKey: true });
    fireEvent.click(screen.getByTestId('socket-CheckWork'), { shiftKey: true });
    fireEvent.click(screen.getByTestId('create-task-loop'));

    const region = await screen.findByTestId('loop-region-loopSelection');
    expect(region.getAttribute('title')).toContain('Loop consumes: PlanSocket.items');
  });

  it('selects loop sockets by dragging a region box before creating a loop', async () => {
    const config = structuredClone(testConfig);
    delete (config.loadouts['Full-Auto'] as { loops?: unknown }).loops;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config }))));

    render(<App />);

    const grid = await screen.findByTestId('socket-grid');
    fireEvent.pointerDown(grid, { button: 0, pointerId: 1, clientX: 230, clientY: 0 });
    fireEvent.pointerMove(grid, { pointerId: 1, clientX: 760, clientY: 120 });
    expect(screen.getByTestId('loop-selection-rectangle')).toBeTruthy();
    fireEvent.pointerUp(grid, { pointerId: 1, clientX: 760, clientY: 120 });

    expect(screen.getByTestId('socket-Build').classList.contains('materia-socket-loop-selected')).toBe(true);
    expect(screen.getByTestId('socket-Auto-Eval').classList.contains('materia-socket-loop-selected')).toBe(true);
    expect(screen.getByTestId('socket-Maintain').classList.contains('materia-socket-loop-selected')).toBe(true);
    fireEvent.click(screen.getByTestId('create-task-loop'));
    expect(await screen.findByTestId('loop-region-loopSelection')).toBeTruthy();
  });

  it('keeps socket shells only modestly larger than their materia orb while preserving overflow containment', () => {
    const css = readFileSync(`${process.cwd()}/src/webui/client/src/styles.css`, 'utf8');
    const cssRem = (name: string) => {
      const match = css.match(new RegExp(`${name}:\\s*([0-9.]+)rem;`));
      if (!match) throw new Error(`Missing CSS custom property ${name}`);
      return Number(match[1]);
    };

    const socketWidth = cssRem('--materia-socket-width');
    const socketStageSize = cssRem('--materia-socket-stage-size');
    const socketMinHeight = cssRem('--materia-socket-min-height');
    const orbSize = cssRem('--materia-orb-size');
    expect(socketWidth).toBeGreaterThanOrEqual(8.25);
    expect(socketWidth / orbSize).toBeLessThanOrEqual(2);
    expect(socketStageSize / orbSize).toBeLessThanOrEqual(1.55);
    expect(socketMinHeight / orbSize).toBeLessThanOrEqual(2.1);
    expect(css).toMatch(/\.materia-socket-orb-stage\s*{[^}]*height: var\(--materia-socket-stage-size\);[^}]*width: var\(--materia-socket-stage-size\);/s);
    expect(css).toMatch(/\.materia-socket-label\s*{[^}]*max-width: var\(--materia-socket-width\);/s);
    expect(css).toContain('--materia-orb-small-size: 2rem;');
    expect(css).toMatch(/\.loadout-graph-viewport\s*{[^}]*max-width: 100%;[^}]*overflow: auto;/s);
    expect(css).toMatch(/\.loadout-graph-canvas\s*{[^}]*min-width: 100%;[^}]*min-height: 100%;/s);
    expect(css).toMatch(/\.materia-orb-iterator\s*{[^}]*outline: 1px solid/s);
    expect(css).toMatch(/\.materia-orb-iterator::after\s*{[^}]*radial-gradient/s);
    expect(css).toMatch(/\.materia-iterator-badge\s*{[^}]*text-transform: uppercase;/s);
    expect(css).toMatch(/\.materia-socket-generator \.materia-socket-orb-stage\s*{[^}]*overflow: visible;/s);
    expect(css).toMatch(/\.materia-generator-badge\s*{[^}]*min-width: max-content;[^}]*white-space: nowrap;/s);
    expect(css).toContain('.palette-orb-iterator');
    expect(css).toContain('.materia-socket-iterator');
    expect(css).toContain('.palette-orb-generator');
    expect(css).toContain('.materia-socket-generator');
    expect(css).toContain('.loadout-edge-generator-input');
  });

  it('contains oversized graph dimensions inside a scrollable viewport', async () => {
    const wideConfig = structuredClone(testConfig) as typeof testConfig & { activeLoadout: string; loadouts: Record<string, unknown> };
    wideConfig.activeLoadout = 'Wide';
    wideConfig.loadouts.Wide = {
      entry: 'socket-0',
      nodes: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
        `socket-${index}`,
        { type: 'agent', materia: 'Build', layout: { x: index, y: index % 2 }, edges: index < 7 ? [{ when: 'always', to: `socket-${index + 1}` }] : undefined },
      ])),
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: wideConfig }))));

    render(<App />);

    const viewport = await screen.findByTestId('socket-grid-viewport');
    const grid = screen.getByTestId('socket-grid');
    expect(viewport.classList.contains('loadout-graph-viewport')).toBe(true);
    expect(grid.style.width).toBe('1678px');
    expect(grid.style.minWidth).toBe('');
    expect(grid.style.height).toBe('386px');
  });

  it('pads loop labels inside the canvas and leaves serpentine loop headers clear of sockets', async () => {
    const config = structuredClone(testConfig);
    (config.loadouts['Planning-Consult'] as { loops?: unknown }).loops = {
      consultLoop: {
        label: 'Consultation loop header should not collide',
        nodes: ['planner', 'Build'],
        iterator: { items: 'state.questions', as: 'question' },
      },
    } as never;
    config.activeLoadout = 'Planning-Consult';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config }))));

    render(<App />);

    const region = await screen.findByTestId('loop-region-consultLoop');
    const planner = screen.getByTestId('socket-planner');
    expect(parseFloat(region.style.left)).toBeGreaterThanOrEqual(28);
    expect(parseFloat(region.style.top)).toBeGreaterThanOrEqual(28);
    expect(parseFloat(planner.style.top) - parseFloat(region.style.top)).toBeGreaterThanOrEqual(48);
    expect(screen.getByTestId('socket-grid').style.height).not.toBe('256px');
  });

  it('sizes long loop labels and summaries wide enough to remain readable', () => {
    const loadout = {
      nodes: {
        Consult: { type: 'agent', materia: 'Consult' },
        Build: { type: 'agent', materia: 'Build' },
        Maintain: { type: 'agent', materia: 'Maintain' },
        Finish: { type: 'utility', utility: 'finish' },
      },
      loops: {
        readableLoop: {
          label: 'Loop: Consult → Build → Maintain',
          nodes: ['Consult', 'Build', 'Maintain'],
          consumes: { from: 'Consult', output: 'detailed_task_backlog' },
          exit: { from: 'Maintain', when: 'not_satisfied', to: 'Finish' },
        },
      },
    } as never;
    const positions = new Map<string, never>([
      ['Consult', { id: 'Consult', node: {}, index: 0, x: 320, y: 100 } as never],
      ['Build', { id: 'Build', node: {}, index: 1, x: 408, y: 100 } as never],
      ['Maintain', { id: 'Maintain', node: {}, index: 2, x: 496, y: 100 } as never],
      ['Finish', { id: 'Finish', node: {}, index: 3, x: 672, y: 100 } as never],
    ]);

    const [region] = getLoopRegions(loadout, positions);
    expect(region.label).toBe('Loop: Consult → Build → Maintain');
    expect(region.summary).toContain('Loop consumes: Consult.detailed_task_backlog');
    expect(region.summary).toContain('Exit: Maintain (Maintain).Not Satisfied → Finish (finish)');
    expect(region.width).toBeGreaterThan(360);
    expect(region.width).toBeLessThanOrEqual(780);
    expect(region.width).toBeGreaterThan(520);
    expect(region.x).toBeGreaterThanOrEqual(0);
  });

  it('builds fitted virtual cycle paths for three-of-four corner membership', () => {
    const loadout = {
      nodes: {
        a: { type: 'agent', materia: 'Build' },
        b: { type: 'agent', materia: 'Build' },
        c: { type: 'agent', materia: 'Build' },
        excluded: { type: 'agent', materia: 'Build' },
      },
      loops: {
        cornerLoop: { label: 'Three corners', nodes: ['a', 'b', 'c'], iterator: { items: 'state.items' } },
      },
    } as never;
    const positions = new Map<string, never>([
      ['a', { id: 'a', node: {}, index: 0, x: 100, y: 100 } as never],
      ['b', { id: 'b', node: {}, index: 1, x: 308, y: 100 } as never],
      ['c', { id: 'c', node: {}, index: 2, x: 100, y: 268 } as never],
      ['excluded', { id: 'excluded', node: {}, index: 3, x: 308, y: 268 } as never],
    ]);

    const [region] = getLoopRegions(loadout, positions);
    expect(region.cyclePath).toContain('Q 166 146');
    expect(region.cyclePath).toContain('Q 374 146');
    expect(region.cyclePath).toContain('Q 166 314');
    expect(region.cyclePath).not.toContain('374 314');
  });

  it('routes parallel edges between the same sockets on separate visual lanes', async () => {
    const parallelConfig = structuredClone(edgeEditorConfig);
    parallelConfig.loadouts.Edges.nodes.Start.edges = [
      { when: 'satisfied', to: 'Review' },
      { when: 'not_satisfied', to: 'Review' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: parallelConfig }))));

    render(<App />);

    const satisfied = await screen.findByTestId('edge-Start-Review-0');
    const unsatisfied = await screen.findByTestId('edge-Start-Review-1');
    expect(satisfied.querySelector('path')?.getAttribute('d')).not.toBe(unsatisfied.querySelector('path')?.getAttribute('d'));
    expect(satisfied.querySelector('text')?.getAttribute('y')).not.toBe(unsatisfied.querySelector('text')?.getAttribute('y'));
  });

  it('routes self edges outside the socket bounds with readable label clearance', () => {
    const socket = { id: 'Maintain', node: { type: 'agent', materia: 'Maintain' }, index: 0, x: 320, y: 80 } as never;
    const positions = new Map<string, never>([['Maintain', socket]]);
    const [route] = routeLoadoutEdges([
      { id: 'Maintain:edge:0:Maintain:not_satisfied', from: 'Maintain', to: 'Maintain', kind: 'edge', edgeIndex: 0, when: 'not_satisfied' },
    ] as never, positions);
    const socketRight = 320 + 92;
    const socketBottom = 80 + 92;
    const pathNumbers = route.path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    const xValues = pathNumbers.filter((_, index) => index % 2 === 0);
    const yValues = pathNumbers.filter((_, index) => index % 2 === 1);

    expect(route.routeClass).toBe('loop');
    expect(route.path).toMatch(/^M /);
    expect(route.path).toMatch(/ C /);
    expect(Math.max(...xValues)).toBeGreaterThan(socketRight + 100);
    expect(Math.max(...yValues)).toBeGreaterThan(socketBottom + 80);
    expect(route.labelX).toBeGreaterThan(socketRight + 56);
    expect(route.labelY).toBeGreaterThan(socketBottom + 24);
  });

  it('routes parallel backward, loop, nearby, and crossing edges on separate lanes', () => {
    const positions = new Map<string, never>([
      ['A', { id: 'A', node: { type: 'agent', materia: 'A' }, index: 0, x: 520, y: 0 } as never],
      ['B', { id: 'B', node: { type: 'agent', materia: 'B' }, index: 1, x: 0, y: 20 } as never],
      ['C', { id: 'C', node: { type: 'agent', materia: 'C' }, index: 2, x: 0, y: 120 } as never],
      ['D', { id: 'D', node: { type: 'agent', materia: 'D' }, index: 3, x: 520, y: 140 } as never],
    ]);
    const edges = [
      { id: 'A:edge:0:B:satisfied', from: 'A', to: 'B', kind: 'edge', edgeIndex: 0, when: 'satisfied' },
      { id: 'A:edge:1:B:not_satisfied', from: 'A', to: 'B', kind: 'edge', edgeIndex: 1, when: 'not_satisfied' },
      { id: 'A:edge:2:A:first', from: 'A', to: 'A', kind: 'edge', edgeIndex: 2, when: 'first' },
      { id: 'A:edge:3:A:second', from: 'A', to: 'A', kind: 'edge', edgeIndex: 3, when: 'second' },
      { id: 'C:edge:0:D:satisfied', from: 'C', to: 'D', kind: 'edge', edgeIndex: 0, when: 'satisfied' },
      { id: 'B:edge:0:D:not_satisfied', from: 'B', to: 'D', kind: 'edge', edgeIndex: 0, when: 'not_satisfied' },
    ] as never;

    const routed = routeLoadoutEdges(edges, positions);
    const byId = new Map(routed.map((route) => [route.edge.id, route]));
    expect(byId.get('A:edge:0:B:satisfied')?.path).not.toBe(byId.get('A:edge:1:B:not_satisfied')?.path);
    expect(byId.get('A:edge:0:B:satisfied')?.labelY).not.toBe(byId.get('A:edge:1:B:not_satisfied')?.labelY);
    expect(byId.get('A:edge:2:A:first')?.path).not.toBe(byId.get('A:edge:3:A:second')?.path);
    expect(byId.get('A:edge:2:A:first')?.labelX).not.toBe(byId.get('A:edge:3:A:second')?.labelX);
    expect(byId.get('C:edge:0:D:satisfied')?.path).not.toBe(byId.get('B:edge:0:D:not_satisfied')?.path);
    expect(byId.get('C:edge:0:D:satisfied')?.labelY).not.toBe(byId.get('B:edge:0:D:not_satisfied')?.labelY);
  });

  it('renders edge routes as organic curves instead of right-angle-only polylines', () => {
    const positions = new Map<string, never>([
      ['A', { id: 'A', node: { type: 'agent', materia: 'A' }, index: 0, x: 0, y: 0 } as never],
      ['B', { id: 'B', node: { type: 'agent', materia: 'B' }, index: 1, x: 208, y: 0 } as never],
      ['C', { id: 'C', node: { type: 'agent', materia: 'C' }, index: 2, x: 208, y: 176 } as never],
    ]);
    const sameRow = routeLoadoutEdges([{ id: 'A:edge:0:B:always', from: 'A', to: 'B', edgeIndex: 0, when: 'always' }] as never, positions)[0];
    const rowTransition = routeLoadoutEdges([{ id: 'B:edge:0:C:always', from: 'B', to: 'C', edgeIndex: 0, when: 'always' }] as never, positions)[0];
    const backward = routeLoadoutEdges([{ id: 'B:edge:0:A:satisfied', from: 'B', to: 'A', kind: 'edge', edgeIndex: 0, when: 'satisfied' }] as never, positions)[0];

    for (const route of [sameRow, rowTransition, backward]) {
      expect(route.path).toMatch(/^M /);
      expect(route.path, route.edge.id).toMatch(/[CQ]/);
      expect(route.path, route.edge.id).not.toMatch(/^(?:M|L) [-0-9.]+ [-0-9.]+(?: L [-0-9.]+ [-0-9.]+)+$/);
    }
  });

  it('renders loaded edge labels from canonical values without raw predicates', async () => {
    const config = structuredClone(edgeEditorConfig);
    config.loadouts.Edges.nodes.Start.edges = [
      { when: 'always', to: 'Review' },
      { when: 'satisfied', to: 'Ship' },
      { when: 'not_satisfied', to: 'Start' },
      { when: '$.passed == true', to: 'Review' },
    ] as never;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config }))));

    render(<App />);

    expect(await screen.findByText('Always')).toBeTruthy();
    expect(screen.getByText('Satisfied')).toBeTruthy();
    expect(screen.getByText('Not Satisfied')).toBeTruthy();
    expect(screen.getByText('Invalid')).toBeTruthy();
    expect(screen.queryByText('$.passed == true')).toBeNull();
  });

  it('toggles a clickable edge condition through the canonical cycle and saves canonical values', async () => {
    const singleEdgeConfig = structuredClone(testConfig);
    singleEdgeConfig.loadouts['Full-Auto'].nodes['Auto-Eval'].edges = [{ when: 'always', to: 'Maintain' }];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: singleEdgeConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const edge = await screen.findByTestId('edge-Auto-Eval-Maintain-0');
    expect(edge.getAttribute('class')).toContain('loadout-edge-default');
    expect(edge.querySelector('text')?.textContent).toBe('Always');

    fireEvent.click(edge);
    expect(await screen.findByText(/Staged edge Auto-Eval \(Auto-Eval\) → Maintain \(Maintain\) as Satisfied\./)).toBeTruthy();
    expect(screen.getByTestId('edge-Auto-Eval-Maintain-0').getAttribute('class')).toContain('loadout-edge-satisfied');

    fireEvent.click(screen.getByTestId('edge-Auto-Eval-Maintain-0'));
    expect(await screen.findByText(/Staged edge Auto-Eval \(Auto-Eval\) → Maintain \(Maintain\) as Not Satisfied\./)).toBeTruthy();
    expect(screen.getByTestId('edge-Auto-Eval-Maintain-0').getAttribute('class')).toContain('loadout-edge-unsatisfied');

    fireEvent.click(screen.getByTestId('edge-Auto-Eval-Maintain-0'));
    expect(await screen.findByText(/Staged edge Auto-Eval \(Auto-Eval\) → Maintain \(Maintain\) as Always\./)).toBeTruthy();
    expect(screen.getByTestId('edge-Auto-Eval-Maintain-0').getAttribute('class')).toContain('loadout-edge-default');

    fireEvent.click(screen.getByTestId('edge-Auto-Eval-Maintain-0'));
    expect(await screen.findByText(/Staged edge Auto-Eval \(Auto-Eval\) → Maintain \(Maintain\) as Satisfied\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const savedEdge = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'].nodes['Auto-Eval'].edges[0];
    expect(savedEdge).toEqual({ when: 'satisfied', to: 'Maintain' });
  });

  it('stages iterative retry edge toggles without rejecting looped satisfied routes', async () => {
    const iterativeConfig = structuredClone(testConfig);
    iterativeConfig.loadouts['Full-Auto'].nodes['Auto-Eval'].edges = [
      { when: 'satisfied', to: 'Maintain' },
      { when: 'not_satisfied', to: 'Build' },
    ];
    (iterativeConfig.loadouts['Full-Auto'].nodes.Maintain as { edges?: Array<{ when: 'always'; to: string }> }).edges = [{ when: 'always', to: 'Build' }];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: iterativeConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const retryEdge = await screen.findByTestId('edge-Auto-Eval-Build-1');
    expect(retryEdge.getAttribute('class')).toContain('loadout-edge-unsatisfied');
    fireEvent.click(retryEdge);

    expect(await screen.findByText(/Staged edge Auto-Eval \(Auto-Eval\) → Build \(Build\) as Always\./)).toBeTruthy();
    expect(screen.queryByText(/Cannot toggle edge Auto-Eval \(Auto-Eval\) → Build \(Build\)/)).toBeNull();
    expect(screen.getByTestId('edge-Auto-Eval-Build-1').getAttribute('class')).toContain('loadout-edge-default');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const savedNodes = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'].nodes;
    expect(savedNodes['Auto-Eval'].edges).toEqual([
      { when: 'satisfied', to: 'Maintain' },
      { when: 'always', to: 'Build' },
    ]);
    expect(savedNodes.Maintain.edges).toEqual([{ when: 'always', to: 'Build' }]);
  });

  it('shows validation failures from unreachable edge toggles without mutating draft state', async () => {
    const config = structuredClone(testConfig);
    config.loadouts['Full-Auto'].nodes['Auto-Eval'].edges = [{ when: 'always', to: 'Maintain' }, { when: 'satisfied', to: 'Build' }] as never;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const edge = await screen.findByTestId('edge-Auto-Eval-Build-1');
    fireEvent.click(edge);

    expect(await screen.findByText(/Cannot toggle edge Auto-Eval → Build: Socket "Auto-Eval" has an unreachable outgoing edge at Auto-Eval\.edges\[1\]/)).toBeTruthy();
    expect(screen.getByTestId('edge-Auto-Eval-Build-1').getAttribute('class')).toContain('loadout-edge-satisfied');
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

    const entry = await screen.findByTestId('socket-Socket-1');
    expect(entry).toBeTruthy();
    expect(entry.getAttribute('title')).toBe('Socket: Socket-1\nDisplay: Socket-1 (Empty)\nEmpty socket');
    expect(screen.getByText('Empty')).toBeTruthy();
    expect(screen.queryByText('Empty socket')).toBeNull();
    expect(screen.queryByText('entry')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const savedConfig = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config;
    const created = savedConfig.loadouts[savedConfig.activeLoadout];
    expect(Object.keys(created.nodes)).toEqual(['Socket-1']);
    expect(created.entry).toBe('Socket-1');
    expect(created.nodes['Socket-1']).toEqual({ empty: true });
    expect(created.nodes['Socket-1'].type).toBeUndefined();
  });

  it('creates connected sockets with the same Empty display model', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByTestId('socket-planner');
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    const entry = await screen.findByTestId('socket-Socket-1');
    fireEvent.click(entry);
    fireEvent.click(await screen.findByRole('button', { name: 'New Socket' }));

    expect(await screen.findByTestId('socket-Socket-2')).toBeTruthy();
    expect(screen.getAllByText('Empty')).toHaveLength(2);
    expect(screen.queryByText('Empty socket')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const savedConfig = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config;
    const created = savedConfig.loadouts[savedConfig.activeLoadout];
    expect(created.nodes['Socket-1']).toEqual({ empty: true, edges: [{ when: 'always', to: 'Socket-2' }] });
    expect(created.nodes['Socket-2']).toEqual({ empty: true });
  });

  it('keeps palette definitions and save payload materia stable during new loadout grid edits', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByTestId('palette-Build');
    const initialPaletteIds = paletteIds();
    const initialMateria = structuredClone(testConfig.materia);

    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(screen.getByTestId('palette-Build'), { dataTransfer });
    fireEvent.drop(await screen.findByTestId('socket-Socket-1'), { dataTransfer });

    expect(paletteIds()).toEqual(initialPaletteIds);

    fireEvent.click(screen.getByTestId('socket-Socket-1'));
    fireEvent.click(await screen.findByRole('button', { name: 'New Socket' }));

    expect(await screen.findByTestId('socket-Socket-2')).toBeTruthy();
    expect(paletteIds()).toEqual(initialPaletteIds);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const savedConfig = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config;
    const created = savedConfig.loadouts[savedConfig.activeLoadout];
    expect(savedConfig.materia).toEqual(initialMateria);
    expect(created.nodes['Socket-1']).toEqual({ type: 'agent', materia: 'Build', empty: false, edges: [{ when: 'always', to: 'Socket-2' }] });
    expect(created.nodes['Socket-2']).toEqual({ empty: true });
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
    expect(savedBuild.materia).toBe('Maintain');
    expect(savedBuild.edges).toEqual([{ when: 'always', to: 'Auto-Eval' }]);
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
    expect(saved.Build.materia).toBe('Maintain');
    expect(saved.Build.edges).toEqual([{ when: 'always', to: 'Auto-Eval' }]);
    expect(saved.Build.layout).toEqual({ x: 1, y: 0 });
    expect(saved.Build.insertedBy).toBe('node-shift');
    expect(saved.Maintain.materia).toBe('Build');
    expect(saved.Maintain.layout).toEqual({ x: 3, y: 0 });
    expect(saved.planner.edges).toEqual([{ when: 'always', to: 'Build' }]);
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
    fireEvent.drop(screen.getByTestId('socket-grid-viewport'), { dataTransfer });
    expect(await screen.findByText(/Cleared materia from Auto-Eval/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'].nodes;
    expect(saved['Auto-Eval']).toMatchObject({ empty: true, layout: { x: 2, y: 0 }, edges: [{ when: 'satisfied', to: 'Maintain' }, { when: 'not_satisfied', to: 'Build' }] });
    expect(Object.keys(saved)).toContain('Auto-Eval');
    expect(saved.Build.edges).toEqual([{ when: 'always', to: 'Auto-Eval' }]);
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
    expect(screen.getByText(/drag this socket's orb onto the graph background/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear socket' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New Socket' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear socket' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const savedBuild = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'].nodes.Build;
    expect(savedBuild).toMatchObject({ empty: true, edges: [{ when: 'always', to: 'Auto-Eval' }], layout: { x: 1, y: 0 }, insertedBy: 'node-shift' });
    expect(savedBuild.materia).toBeUndefined();
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
    expect(await screen.findByTestId('socket-Socket-1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Planning-Consult'].nodes;
    expect(saved.Build.edges).toEqual([{ when: 'always', to: 'Socket-1' }]);
    expect(saved['Socket-1']).toEqual({ empty: true });
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
    expect(saved.Build.materia).toBe('Maintain');
    expect(saved.Build.edges).toEqual([{ when: 'always', to: 'Auto-Eval' }]);
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
    expect(saved.Build).toMatchObject({ materia: 'Build', edges: [{ when: 'always', to: 'Auto-Eval' }], insertedBy: 'node-shift', limits: { maxVisits: 7, maxEdgeTraversals: 3, maxOutputBytes: 2048 }, layout: { x: 4, y: 1.5 } });
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
    expect(savedBuild.materia).toBe('Maintain');
    expect(savedBuild.edges).toEqual([{ when: 'always', to: 'Auto-Eval' }]);
    expect(savedBuild.layout).toEqual({ x: 1, y: 0 });
    expect(savedBuild.insertedBy).toBe('node-shift');
  });

  it('renders socketed materia with the same configured color as its palette materia after drop', async () => {
    const colorConfig = structuredClone(testConfig) as typeof testConfig & { materia: typeof testConfig.materia & { Maintain: typeof testConfig.materia.Maintain & { color?: string } } };
    colorConfig.materia.Maintain.color = 'from-rose-200 via-red-300 to-red-700';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: colorConfig })));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const paletteOrbClass = (await screen.findByTestId('palette-Maintain')).querySelector('.materia-orb-small')?.className;
    expect(paletteOrbClass).toContain('from-rose-200 via-red-300 to-red-700');
    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(screen.getByTestId('palette-Maintain'), { dataTransfer });
    fireEvent.drop(screen.getByTestId('socket-Build'), { dataTransfer });

    await waitFor(() => expect(screen.getByTestId('socket-Build').querySelector('.materia-orb')?.className).toContain('from-rose-200 via-red-300 to-red-700'));
    expect(screen.getByTestId('socket-Build').querySelector('.materia-orb')?.className).toBe(paletteOrbClass?.replace('materia-orb-small', 'materia-orb'));
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

    dataTransfer.setData('application/json', JSON.stringify({ kind: 'palette', materiaId: 'Build' }));
    fireEvent.drop(screen.getByTestId('socket-grid-viewport'), { dataTransfer });
    expect(await screen.findByText('Ignored drop: drag palette materia onto a socket to place it.')).toBeTruthy();
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
    const targetOptionLabels = Array.from(screen.getByTestId('edge-target').querySelectorAll('option')).map((option) => option.textContent);
    expect(targetOptionLabels).toContain('Review (Review)');
    fireEvent.change(screen.getByTestId('edge-target'), { target: { value: 'Review' } });
    fireEvent.change(screen.getByTestId('edge-condition'), { target: { value: 'not_satisfied' } });
    fireEvent.click(screen.getByTestId('create-edge'));

    expect(await screen.findByText(/Staged edge Start \(Start\) → Review \(Review\) as Not Satisfied\./)).toBeTruthy();
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
    config.loadouts.Edges.nodes.Start.edges = [{ when: 'always', to: 'Review' }];
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

    expect((await screen.findByRole('alert')).textContent).toContain('Socket "Start" has an unreachable outgoing edge at Start.edges[1]');
    expect(screen.queryByTestId('edge-Start-Ship-1')).toBeNull();
    expect(screen.queryByText('staged edits')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('removes a legacy default flow without dropping conditional edges or sockets', async () => {
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

    expect(await screen.findByTestId('edge-Start-Review-1')).toBeTruthy();
    expect(screen.getByTestId('edge-Start-Ship-0')).toBeTruthy();
    fireEvent.click(screen.getByTestId('socket-Start'));
    fireEvent.click(await screen.findByTestId('remove-edge-Start-1'));

    expect(await screen.findByText(/Removed edge Start → Review; sockets were preserved\./)).toBeTruthy();
    expect(screen.queryByTestId('edge-Start-Review-1')).toBeNull();
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
    expect(savedStart.layout.x).toBeCloseTo(8 / 208);
    expect(savedStart.layout.y).toBeCloseTo(7 / 168);
    expect(savedStart.edges).toBeUndefined();
  });

  it('does not move unrelated automatic sockets during the first manual socket drag', async () => {
    const config = structuredClone(testConfig) as typeof testConfig & { activeLoadout: string; loadouts: Record<string, unknown> };
    config.activeLoadout = 'Drag-Stability';
    config.loadouts['Drag-Stability'] = {
      entry: 'A',
      nodes: {
        A: { type: 'agent', materia: 'Build', edges: [{ when: 'always', to: 'B' }] },
        B: { type: 'agent', materia: 'Build', edges: [{ when: 'always', to: 'C' }] },
        C: { type: 'agent', materia: 'Build' },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config }))));

    render(<App />);

    const a = await screen.findByTestId('socket-A');
    const b = await screen.findByTestId('socket-B');
    const c = await screen.findByTestId('socket-C');
    a.setPointerCapture = vi.fn();
    a.releasePointerCapture = vi.fn();
    const unrelatedBefore = {
      B: { left: b.style.left, top: b.style.top },
      C: { left: c.style.left, top: c.style.top },
    };

    fireEvent.pointerDown(a, { button: 0, pointerId: 11, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(a, { pointerId: 11, clientX: 160, clientY: 135 });
    fireEvent.pointerUp(a, { pointerId: 11, clientX: 160, clientY: 135 });

    expect(await screen.findByText(/Moved socket A; explicit layout will be saved with the loadout\./)).toBeTruthy();
    expect(screen.getByTestId('socket-B').style.left).toBe(unrelatedBefore.B.left);
    expect(screen.getByTestId('socket-B').style.top).toBe(unrelatedBefore.B.top);
    expect(screen.getByTestId('socket-C').style.left).toBe(unrelatedBefore.C.left);
    expect(screen.getByTestId('socket-C').style.top).toBe(unrelatedBefore.C.top);
  });

  it('falls back to automatic graph layout when sockets have no explicit layout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }))));

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Planning-Consult/ }));
    const planner = await screen.findByTestId('socket-planner');
    const build = await screen.findByTestId('socket-Build');

    expect(planner.style.left).toBe('32px');
    expect(planner.style.top).toBe('28px');
    expect(build.style.left).toBe('240px');
    expect(build.style.top).toBe('28px');
  });

  it('places automatic sockets in a bounded two-column serpentine layout', async () => {
    const snakeConfig = structuredClone(testConfig) as typeof testConfig & { activeLoadout: string; loadouts: Record<string, unknown> };
    snakeConfig.activeLoadout = 'Snake';
    snakeConfig.loadouts.Snake = {
      entry: 'A',
      nodes: {
        A: { type: 'agent', materia: 'Build', edges: [{ when: 'always', to: 'B' }] },
        B: { type: 'agent', materia: 'Build', edges: [{ when: 'always', to: 'C' }] },
        C: { type: 'agent', materia: 'Build', edges: [{ when: 'always', to: 'D' }] },
        D: { type: 'agent', materia: 'Build', edges: [{ when: 'always', to: 'E' }] },
        E: { type: 'agent', materia: 'Build', edges: [{ when: 'always', to: 'F' }] },
        F: { type: 'agent', materia: 'Build' },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: snakeConfig }))));

    render(<App />);

    const a = await screen.findByTestId('socket-A');
    const b = await screen.findByTestId('socket-B');
    const c = await screen.findByTestId('socket-C');
    const d = await screen.findByTestId('socket-D');
    const e = await screen.findByTestId('socket-E');
    const f = await screen.findByTestId('socket-F');

    expect([a.style.left, a.style.top]).toEqual(['32px', '28px']);
    expect([b.style.left, b.style.top]).toEqual(['240px', '28px']);
    expect([c.style.left, c.style.top]).toEqual(['240px', '268px']);
    expect([d.style.left, d.style.top]).toEqual(['32px', '268px']);
    expect([e.style.left, e.style.top]).toEqual(['32px', '508px']);
    expect([f.style.left, f.style.top]).toEqual(['240px', '508px']);
    expect(parseFloat(c.style.top) - parseFloat(a.style.top)).toBeGreaterThanOrEqual(240);
    expect(parseFloat(e.style.top) - parseFloat(c.style.top)).toBeGreaterThanOrEqual(240);
    expect(screen.getByTestId('socket-grid').style.width).toBe('448px');
  });

  it('preserves explicit socket coordinates while ordering remaining automatic sockets by graph flow', async () => {
    const mixedConfig = structuredClone(testConfig) as typeof testConfig & { activeLoadout: string; loadouts: Record<string, unknown> };
    mixedConfig.activeLoadout = 'Mixed';
    mixedConfig.loadouts.Mixed = {
      entry: 'A',
      nodes: {
        A: { type: 'agent', materia: 'Build', edges: [{ when: 'always', to: 'B' }] },
        B: { type: 'agent', materia: 'Build', edges: [{ when: 'always', to: 'C' }] },
        C: { type: 'agent', materia: 'Build', layout: { x: 7, y: 3 }, edges: [{ when: 'always', to: 'D' }] },
        D: { type: 'agent', materia: 'Build' },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: mixedConfig }))));

    render(<App />);

    const a = await screen.findByTestId('socket-A');
    const b = await screen.findByTestId('socket-B');
    const c = await screen.findByTestId('socket-C');
    const d = await screen.findByTestId('socket-D');

    expect([a.style.left, a.style.top]).toEqual(['32px', '28px']);
    expect([b.style.left, b.style.top]).toEqual(['240px', '28px']);
    expect([c.style.left, c.style.top]).toEqual(['1488px', '532px']);
    expect([d.style.left, d.style.top]).toEqual(['240px', '204px']);
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
    let serverConfig = structuredClone(testConfig) as typeof testConfig & { materia?: Record<string, unknown> };
    const savedEvents: CustomEvent[] = [];
    window.addEventListener('materia:saved', (event) => savedEvents.push(event as CustomEvent), { once: true });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        serverConfig = {
          ...serverConfig,
          materia: { ...(serverConfig.materia ?? {}), ...(body.config.materia ?? {}) },
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
    fireEvent.change(screen.getByTestId('materia-color'), { target: { value: 'from-violet-200 via-indigo-300 to-slate-700' } });
    fireEvent.change(screen.getByTestId('materia-output-format'), { target: { value: 'json' } });
    fireEvent.click(screen.getByTestId('materia-multiturn'));
    fireEvent.click(screen.getByTestId('save-materia-form'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body.target).toBe('user');
    expect(body.config).not.toHaveProperty('loadouts');
    expect(body.config.materia.Critique).toMatchObject({ tools: 'none', prompt: 'Review the output carefully.', model: 'openai/gpt-review', color: 'from-violet-200 via-indigo-300 to-slate-700', multiTurn: true });
    expect(fetchMock.mock.calls[2][0]).toBe('/api/config');
    expect(savedEvents[0].detail).toMatchObject({ id: 'Critique', name: 'Critique', behavior: 'prompt', requestedScope: 'user', scope: 'user' });
    await waitFor(() => expect(screen.getByTestId('materia-save-status').textContent).toContain('Saved reusable prompt materia Critique'));
    expect(Array.from((screen.getByTestId('edit-materia-select') as HTMLSelectElement).options).map((option) => option.value)).toContain('Critique');
    await openTab('Loadout');
    expect(await screen.findByTestId('palette-Critique')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('views, edits, creates, and removes generic generated list output config', async () => {
    const generatorConfig = structuredClone(testConfig) as typeof testConfig & { materia: Record<string, any> };
    (generatorConfig.materia.planner as any).generates = { output: 'ideas', items: 'state.ideas', listType: 'array', itemType: 'idea', as: 'idea', cursor: 'ideaIndex', done: 'archive' };
    (generatorConfig.materia.interactivePlan as any).generates = { output: 'tasks', listType: 'array', itemType: 'task', as: 'task', cursor: 'taskIndex', done: 'end' };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: generatorConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await openTab('Materia Editor');
    fireEvent.change(await screen.findByTestId('edit-materia-select'), { target: { value: 'planner' } });
    expect(screen.getByTestId('materia-generates-list')).toHaveProperty('checked', true);
    expect(screen.getByTestId('materia-generated-output')).toHaveProperty('value', 'ideas');
    expect(screen.getByTestId('materia-generated-items')).toHaveProperty('value', 'state.ideas');
    expect(screen.getByTestId('materia-generated-item-type')).toHaveProperty('value', 'idea');
    expect(screen.getByTestId('materia-generated-as')).toHaveProperty('value', 'idea');
    expect(screen.getByTestId('materia-generated-cursor')).toHaveProperty('value', 'ideaIndex');
    expect(screen.getByTestId('materia-generated-done')).toHaveProperty('value', 'archive');

    fireEvent.change(screen.getByTestId('materia-generated-output'), { target: { value: 'stories' } });
    fireEvent.change(screen.getByTestId('materia-generated-item-type'), { target: { value: 'story' } });
    fireEvent.click(screen.getByTestId('save-materia-form'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    let body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body.config.materia.planner.generates).toEqual({ output: 'stories', items: 'state.ideas', listType: 'array', itemType: 'story', as: 'idea', cursor: 'ideaIndex', done: 'archive' });

    fireEvent.change(await screen.findByTestId('edit-materia-select'), { target: { value: 'interactivePlan' } });
    expect(screen.getByTestId('materia-generates-list')).toHaveProperty('checked', true);
    expect(screen.getByTestId('materia-generated-output')).toHaveProperty('value', 'tasks');
    expect(screen.getByTestId('materia-generated-item-type')).toHaveProperty('value', 'task');
    expect(screen.getByTestId('materia-generated-as')).toHaveProperty('value', 'task');
    expect(screen.getByTestId('materia-generated-cursor')).toHaveProperty('value', 'taskIndex');
    expect(screen.getByTestId('materia-generated-done')).toHaveProperty('value', 'end');
    fireEvent.click(screen.getByTestId('save-materia-form'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    body = JSON.parse(String(fetchMock.mock.calls[3][1]?.body));
    expect(body.config.materia.interactivePlan.generates).toEqual({ output: 'tasks', listType: 'array', itemType: 'task', as: 'task', cursor: 'taskIndex', done: 'end' });

    fireEvent.change(await screen.findByTestId('edit-materia-select'), { target: { value: 'Build' } });
    expect(screen.getByTestId('materia-generates-list')).toHaveProperty('checked', false);
    fireEvent.click(screen.getByTestId('materia-generates-list'));
    expect(screen.getByTestId('materia-generated-output')).toHaveProperty('value', 'tasks');
    expect(screen.getByTestId('materia-generated-item-type')).toHaveProperty('value', 'task');
    expect(screen.getByTestId('materia-generated-as')).toHaveProperty('value', 'task');
    expect(screen.getByTestId('materia-generated-cursor')).toHaveProperty('value', 'taskIndex');
    expect(screen.getByTestId('materia-generated-done')).toHaveProperty('value', 'end');
    fireEvent.click(screen.getByTestId('save-materia-form'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));
    body = JSON.parse(String(fetchMock.mock.calls[5][1]?.body));
    expect(body.config.materia.Build.generates).toEqual({ output: 'tasks', listType: 'array', itemType: 'task', as: 'task', cursor: 'taskIndex', done: 'end' });

    fireEvent.change(await screen.findByTestId('edit-materia-select'), { target: { value: 'planner' } });
    fireEvent.click(screen.getByTestId('materia-generates-list'));
    expect(screen.queryByTestId('materia-generated-output')).toBeNull();
    fireEvent.click(screen.getByTestId('save-materia-form'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(9));
    body = JSON.parse(String(fetchMock.mock.calls[7][1]?.body));
    expect(body.config.materia.planner.generates).toBeNull();
  });

  it('generates, previews, regenerates, discards, and explicitly applies role prompts without overwriting existing text', async () => {
    const generatedPrompts = ['Generated role prompt v1', 'Generated role prompt v2', 'Generated role prompt v1'];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/generate/materia-role') {
        const body = JSON.parse(String(init?.body));
        expect(body.brief).toBe('A careful reviewer materia');
        expect(body.generates).toBeNull();
        return new Response(JSON.stringify({ ok: true, prompt: generatedPrompts.shift() }));
      }
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await openTab('Materia Editor');
    const generationBrief = await screen.findByTestId('role-generation-brief');
    const promptField = screen.getByTestId('materia-prompt');
    expect(generationBrief.compareDocumentPosition(promptField) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.change(promptField, { target: { value: 'Keep this existing prompt.' } });
    fireEvent.change(generationBrief, { target: { value: 'A careful reviewer materia' } });
    fireEvent.click(screen.getByTestId('generate-role-prompt'));

    expect((await screen.findByTestId('role-generation-preview')).textContent).toContain('Generated role prompt v1');
    expect(screen.getByTestId('materia-prompt')).toHaveProperty('value', 'Keep this existing prompt.');
    expect(screen.getByTestId('generate-role-prompt').textContent).toContain('Regenerate');

    fireEvent.click(screen.getByTestId('generate-role-prompt'));
    await waitFor(() => expect(screen.getByTestId('role-generation-preview').textContent).toContain('Generated role prompt v2'));
    expect(screen.getByTestId('materia-prompt')).toHaveProperty('value', 'Keep this existing prompt.');

    fireEvent.click(screen.getByTestId('discard-generated-role-prompt'));
    expect(screen.queryByTestId('role-generation-preview')).toBeNull();
    expect(screen.getByTestId('materia-prompt')).toHaveProperty('value', 'Keep this existing prompt.');

    fireEvent.click(screen.getByTestId('generate-role-prompt'));
    await waitFor(() => expect(screen.getByTestId('role-generation-preview').textContent).toContain('Generated role prompt v1'));
    fireEvent.click(screen.getByTestId('apply-generated-role-prompt'));
    expect(screen.getByTestId('materia-prompt')).toHaveProperty('value', 'Generated role prompt v1');
    expect(screen.queryByTestId('role-generation-preview')).toBeNull();
  });

  it('sends generated list output config when generating role prompts for configured materia', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/generate/materia-role') {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          brief: 'Planner prompt',
          generates: { output: 'tasks', listType: 'array', itemType: 'task', as: 'task', cursor: 'taskIndex', done: 'end' },
        });
        return new Response(JSON.stringify({ ok: true, prompt: 'Generated planner prompt' }));
      }
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await openTab('Materia Editor');
    fireEvent.change(await screen.findByTestId('edit-materia-select'), { target: { value: 'planner' } });
    fireEvent.change(screen.getByTestId('role-generation-brief'), { target: { value: 'Planner prompt' } });
    fireEvent.click(screen.getByTestId('generate-role-prompt'));

    expect((await screen.findByTestId('role-generation-preview')).textContent).toContain('Generated planner prompt');
  });

  it('shows role prompt generation errors without changing the prompt field', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/generate/materia-role') return new Response(JSON.stringify({ ok: false, error: 'generation unavailable' }), { status: 503 });
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await openTab('Materia Editor');
    fireEvent.change(await screen.findByTestId('materia-prompt'), { target: { value: 'Manual prompt' } });
    fireEvent.change(screen.getByTestId('role-generation-brief'), { target: { value: 'A careful reviewer materia' } });
    fireEvent.click(screen.getByTestId('generate-role-prompt'));

    expect((await screen.findByTestId('role-generation-error')).textContent).toContain('generation unavailable');
    expect(screen.queryByTestId('role-generation-preview')).toBeNull();
    expect(screen.getByTestId('materia-prompt')).toHaveProperty('value', 'Manual prompt');
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
    expect(body.config.materia.Critique).toMatchObject({ tools: 'none', prompt: 'Review the output carefully.' });
  });

  it('renders prompt-only toggle controls inside settings and hides them for tool materia', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }))));

    render(<App />);

    await openTab('Materia Editor');
    const settings = await screen.findByRole('region', { name: 'Materia settings' });
    expect(screen.queryByText('Toggles')).toBeNull();
    expect(settings.contains(screen.getByTestId('materia-multiturn'))).toBe(true);
    expect(settings.contains(screen.getByTestId('materia-generates-list'))).toBe(true);
    expect(within(settings).getByLabelText('Multiturn')).toBe(screen.getByTestId('materia-multiturn'));
    expect(within(settings).getByLabelText('Enable generated list')).toBe(screen.getByTestId('materia-generates-list'));

    fireEvent.change(screen.getByTestId('materia-behavior'), { target: { value: 'tool' } });
    expect(screen.queryByTestId('materia-multiturn')).toBeNull();
    expect(screen.queryByTestId('materia-generates-list')).toBeNull();
  });

  it('creates reusable tool invocation materia as first-class utility definitions', async () => {
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
    expect(body.config.materia.RunTests).toMatchObject({
      type: 'utility',
      label: 'RunTests',
      group: 'Utility',
      utility: 'shell',
      command: ['npm', 'test'],
      params: { ci: true },
      timeoutMs: 90000,
    });
  });

  it('populates the edit selector from reusable definitions instead of active loadout sockets', async () => {
    const selectorConfig = {
      activeLoadout: 'Full-Auto',
      materia: {
        Build: { tools: 'coding', prompt: 'Build the work' },
        DetachedMateria: { tools: 'none', prompt: 'Reusable materia not placed in a socket' },
        RunTests: { type: 'utility', utility: 'shell', command: ['npm', 'test'] },
        PromptDef: { tools: 'none', prompt: 'Prompt definition' },
      },
      loadouts: {
        'Full-Auto': {
          entry: 'SocketOnly',
          nodes: {
            SocketOnly: { type: 'agent', materia: 'SocketOnly' },
            Build: { type: 'agent', materia: 'Build' },
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
    expect(initialOptions).toEqual(['', 'Build', 'DetachedMateria', 'PromptDef', 'RunTests']);
    expect(initialOptions).not.toContain('SocketOnly');
    expect(initialOptions).not.toContain('OtherSocket');

    await openTab('Loadout');
    expect(await screen.findByTestId('palette-RunTests')).toBeTruthy();
    expect(screen.getByTestId('palette-DetachedMateria')).toBeTruthy();
    expect(screen.queryByTestId('palette-SocketOnly')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /Alternate/ }));
    await openTab('Materia Editor');
    const afterLoadoutSwitch = Array.from((await screen.findByTestId('edit-materia-select') as HTMLSelectElement).options).map((option) => option.value);
    expect(afterLoadoutSwitch).toEqual(initialOptions);
  });

  it('loads existing tool definition data without selecting or mutating loadout sockets', async () => {
    const selectorConfig = {
      activeLoadout: 'Full-Auto',
      materia: {
        Build: { tools: 'coding', prompt: 'Build the work' },
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
    expect(screen.getByTestId('materia-params')).toHaveProperty('value', JSON.stringify({ ci: true }, null, 2));
    expect(screen.getByTestId('materia-timeout')).toHaveProperty('value', '90000');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('edits existing prompt materia materia settings where supported', async () => {
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
    expect(body.config.materia.Build).toMatchObject({ tools: 'readOnly', prompt: 'Build with extra care.', model: 'openai/gpt-test' });
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
      activeCast: { castId: 'cast-1', active: true, phase: 'Build', currentNode: 'Build', currentMateria: 'Build', nodeState: 'awaiting_agent_response', awaitingResponse: true, runDir: '/tmp/run', artifactRoot: '/tmp', startedAt: 1_000, updatedAt: 61_000 },
      emittedOutputs: [{ id: 'entry-1', type: 'pi-materia', text: 'Build · materia_prompt', timestamp: 61_000, node: 'Build' }],
      artifactSummary: { runDir: '/tmp/run', summary: 'Completed nodes: planner', outputs: [{ node: 'Build', kind: 'node_output', artifact: 'nodes/Build/1.md', content: 'built' }] },
    }) }));

    await waitFor(() => expect(screen.getByTestId('socket-Build').className).toContain('materia-socket-active'));
    await openTab('Monitoring');
    expect(await screen.findByText('awaiting_agent_response')).toBeTruthy();
    expect(screen.getByText('Completed nodes: planner')).toBeTruthy();
  });
});
