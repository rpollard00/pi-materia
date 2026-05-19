import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from './App.js';
import { normalizeMateriaConfigEdges, type PipelineConfig } from './loadoutModel.js';
import { fromWebUiLoadoutDto } from '../../loadoutDto.js';
import { resetToastStoreForTests } from './toast/index.js';
import type { QuestBoardResponse, QuestSummary } from './webui/types.js';
import { formatLoopDisplayLabel, getLoopExitBadges, getLoopMemberships, getLoopRegions, layoutSockets, routeLoadoutEdges } from './webui/utils/graphLayout.js';

const testConfig = {
  activeLoadout: 'Full-Auto',
  activeLoadoutId: 'Full-Auto',
  materia: {
    planner: { tools: 'none', prompt: 'Plan the work', generator: true },
    Build: { tools: 'coding', prompt: 'Build the work', model: 'openai/gpt-test' },
    'Auto-Eval': { tools: { type: 'custom', tools: ['read', 'grep', 'find', 'ls', 'bash'] }, prompt: 'Evaluate the work' },
    Maintain: { tools: 'coding', prompt: 'Maintain the work' },
    interactivePlan: { tools: 'readOnly', prompt: 'Plan interactively', multiTurn: true },
  },
  loadouts: {
    'Full-Auto': {
      id: 'Full-Auto',
      entry: 'Socket-1',
      sockets: {
        'Socket-1': { materia: 'planner', parse: 'json', assign: { workItems: '$.workItems' }, edges: [{ when: 'always', to: 'Socket-2' }], layout: { x: 0, y: 0 } },
        'Socket-2': { materia: 'Build', edges: [{ when: 'always', to: 'Socket-3' }], layout: { x: 1, y: 0 }, insertedBy: 'socket-shift' },
        'Socket-3': { materia: 'Auto-Eval', parse: 'json', edges: [{ when: 'satisfied', to: 'Socket-4' }, { when: 'not_satisfied', to: 'Socket-2' }], layout: { x: 2, y: 0 } },
        'Socket-4': { materia: 'Maintain', layout: { x: 3, y: 0 } },
      },
    },
    'Planning-Consult': {
      id: 'Planning-Consult',
      entry: 'Socket-1',
      sockets: {
        'Socket-1': { materia: 'interactivePlan', edges: [{ when: 'always', to: 'Socket-2' }] },
        'Socket-2': { materia: 'Build' },
      },
    },
  },
};

const edgeEditorConfig = {
  activeLoadout: 'Edges',
  activeLoadoutId: 'Edges',
  loadouts: {
    Edges: {
      id: 'Edges',
      entry: 'Socket-1',
      sockets: {
        'Socket-1': { materia: 'Start', parse: 'json', layout: { x: 0, y: 0 }, edges: [] as Array<{ to: string; when?: string }> },
        'Socket-2': { materia: 'Review', layout: { x: 1, y: 0 } },
        'Socket-3': { materia: 'Ship', layout: { x: 2, y: 0 } },
      },
    },
  },
};

const currentPipelineConfig = {
  materia: {
    planner: { tools: 'none', prompt: 'Plan the work' },
    finish: { type: 'utility', utility: 'finish', command: ['echo', 'done'] },
  },
  pipeline: {
    id: 'Current',
    entry: 'Socket-1',
    sockets: {
      'Socket-1': { materia: 'planner', edges: [{ when: 'always', to: 'Socket-2' }], layout: { x: 0, y: 0 } },
      'Socket-2': { materia: 'Build', parse: 'json', edges: [{ when: 'always', to: 'Socket-3' }, { when: 'not_satisfied', to: 'Socket-1' }], layout: { x: 1, y: 0 } },
      'Socket-3': { materia: 'finish', layout: { x: 2, y: 0 } },
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
  resetToastStoreForTests();
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

async function openTab(name: RegExp | string) {
  fireEvent.click(await screen.findByRole('button', { name }));
}

type FetchMock = ReturnType<typeof vi.fn>;

function configPostCalls(fetchMock: FetchMock) {
  return fetchMock.mock.calls.filter((call) => call[0] === '/api/config' && (call[1] as RequestInit | undefined)?.method === 'POST');
}

function configPostBody(fetchMock: FetchMock, index = 0) {
  const call = configPostCalls(fetchMock)[index];
  if (!call) throw new Error(`Missing config POST call ${index}`);
  return JSON.parse(String((call[1] as RequestInit).body));
}

function normalizedTestLoadout(loadout: unknown) {
  return fromWebUiLoadoutDto(normalizeMateriaConfigEdges(structuredClone({ materia: testConfig.materia, loadouts: { expected: loadout } }) as any).loadouts!.expected as any);
}

async function waitForConfigPostCount(fetchMock: FetchMock, count: number) {
  await waitFor(() => expect(configPostCalls(fetchMock)).toHaveLength(count));
}

function paletteIds() {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="palette-"]')).map((element) => element.dataset.testid?.replace('palette-', ''));
}

function normalizedBodyText() {
  return document.body.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function expectHeaderStatus(source: string, status: 'clean' | 'staged edits') {
  const bodyText = normalizedBodyText();
  expect(bodyText).toContain(`Source: ${source}`);
  expect(bodyText).toContain(`Status: ${status}`);
}

function loadoutCard(name: string) {
  return screen.getByRole('button', { name: new RegExp(name) }).closest('.loadout-card') as HTMLElement;
}

function openLoadoutActions(name: string) {
  fireEvent.click(within(loadoutCard(name)).getByLabelText('Loadout actions'));
}

async function clickMateriaSelectorRow(id: string) {
  await screen.findByRole('complementary', { name: 'Materia selector' });
  const rowButton = Array.from(document.querySelectorAll<HTMLButtonElement>('.materia-selector-row-select'))
    .find((button) => button.querySelector('.materia-selector-row-id')?.textContent === id);
  if (!rowButton) throw new Error(`Missing materia selector row ${id}`);
  fireEvent.click(rowButton);
}

async function materiaSelectorIds() {
  await screen.findByRole('complementary', { name: 'Materia selector' });
  return Array.from(document.querySelectorAll<HTMLElement>('.materia-selector-row-id')).map((element) => element.textContent ?? '');
}

async function findToastAlert() {
  const alerts = await screen.findAllByRole('alert');
  return alerts.find((alert) => alert.getAttribute('data-toast-variant')) ?? alerts[0];
}

const questTime = '2026-05-19T19:00:00.000Z';

function questSummary(overrides: Partial<QuestSummary> & Pick<QuestSummary, 'id' | 'title' | 'status'>): QuestSummary {
  const prompt = overrides.prompt ?? overrides.title;
  return {
    prompt,
    promptPreview: prompt,
    attempts: overrides.status === 'pending' ? 0 : 1,
    createdAt: questTime,
    updatedAt: questTime,
    ...overrides,
  };
}

function questBoardResponse(quests: QuestSummary[]): QuestBoardResponse {
  const runningQuest = quests.find((quest) => quest.status === 'running');
  return {
    ok: true,
    boardPath: '/tmp/project/.pi/pi-materia/quest-board.json',
    runner: { enabled: true, ...(runningQuest ? { activeQuestId: runningQuest.id } : {}) },
    activeQuest: runningQuest,
    runningQuest,
    pendingQuests: quests.filter((quest) => quest.status === 'pending'),
    completedQuests: quests.filter((quest) => quest.status === 'succeeded'),
    failedQuests: quests.filter((quest) => quest.status === 'failed' || quest.status === 'blocked'),
    quests,
    counts: {
      total: quests.length,
      pending: quests.filter((quest) => quest.status === 'pending').length,
      running: quests.filter((quest) => quest.status === 'running').length,
      succeeded: quests.filter((quest) => quest.status === 'succeeded').length,
      failed: quests.filter((quest) => quest.status === 'failed').length,
      blocked: quests.filter((quest) => quest.status === 'blocked').length,
      completed: quests.filter((quest) => quest.status === 'succeeded').length,
      terminal: quests.filter((quest) => quest.status === 'succeeded' || quest.status === 'failed' || quest.status === 'blocked').length,
    },
    status: { statuses: ['pending', 'running', 'succeeded', 'failed', 'blocked'], updatedAt: questTime, generatedAt: questTime, ...(runningQuest ? { activeQuestId: runningQuest.id } : {}) },
  };
}

function createQuestFetchMock(initialQuests: QuestSummary[]) {
  let quests = [...initialQuests];
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input === '/api/config') return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    if (input === '/api/quests' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const created = questSummary({ id: 'quest-added', title: body.prompt, prompt: body.prompt, promptPreview: body.prompt, status: 'pending', loadoutOverride: body.loadoutOverride });
      quests = [...quests, created];
      return new Response(JSON.stringify({ ok: true, quest: created, board: questBoardResponse(quests) }));
    }
    if (input === '/api/quests') return new Response(JSON.stringify(questBoardResponse(quests)));
    return new Response(JSON.stringify({ ok: true }));
  });
}

describe('Materia quests pane', () => {
  it('opens from the Quests tab and groups active, pending, completed, and hidden failed quests', async () => {
    const fetchMock = createQuestFetchMock([
      questSummary({ id: 'quest-active', title: 'Defeat the dragon', prompt: 'Defeat the dragon in the old keep', promptPreview: 'Defeat the dragon in the old keep', status: 'running' }),
      questSummary({ id: 'quest-pending-1', title: 'Gather moon herbs', status: 'pending' }),
      questSummary({ id: 'quest-pending-2', title: 'Forge silver key', status: 'pending' }),
      questSummary({ id: 'quest-complete', title: 'Light the beacon', status: 'succeeded' }),
      questSummary({ id: 'quest-failed', title: 'Sneak past sentries', status: 'failed' }),
    ]);
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await openTab('Quests');

    expect(await screen.findByRole('heading', { name: 'Quests' })).toBeTruthy();
    const questLog = screen.getByRole('complementary', { name: 'Quest Log' });
    const activeCard = within(questLog).getByRole('button', { name: 'Active quest: Defeat the dragon' });
    expect(activeCard.textContent).toContain('★');
    expect(within(activeCard).getByLabelText('Active quest')).toBeTruthy();
    expect(within(questLog).getByRole('heading', { name: 'Active & Pending' })).toBeTruthy();
    expect(within(questLog).getByRole('button', { name: 'Pending quest: Gather moon herbs' })).toBeTruthy();
    expect(within(questLog).getByRole('button', { name: 'Pending quest: Forge silver key' })).toBeTruthy();
    expect(within(questLog).getByRole('heading', { name: 'Completed' })).toBeTruthy();
    expect(within(questLog).getByRole('button', { name: 'Completed quest: Light the beacon' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Failed quest: Sneak past sentries' })).toBeNull();
    expect(within(questLog).getByRole('button', { name: /Failed \/ blocked hidden/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('submits the add quest form and refreshes the quest log', async () => {
    const fetchMock = createQuestFetchMock([]);
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await openTab('Quests');

    fireEvent.change(await screen.findByLabelText('Loadout override'), { target: { value: 'Full-Auto' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Rescue the villager' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add quest' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/quests', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ prompt: 'Rescue the villager', loadoutOverride: 'Full-Auto' }),
    })));
    expect(await screen.findByText('Added quest: Rescue the villager')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pending quest: Rescue the villager' })).toBeTruthy();
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('');
    await waitFor(() => expect(document.querySelector('[data-toast-variant="success"]')?.textContent).toContain('Quest added'));
  });
});

describe('Materia loadout grid editor', () => {
  it('renders active and available loadouts with staged save controls', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }))));

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Materia WebUI' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Full-Auto/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Planning-Consult/ })).toBeTruthy();
    expect(screen.getByTestId('socket-Socket-1')).toBeTruthy();
    const stageApplyPanel = screen.getByRole('heading', { name: 'Stage & apply' }).closest('section') as HTMLElement;
    expect(stageApplyPanel).toBeTruthy();
    expect(within(stageApplyPanel).queryByText(/Nothing is persisted until Save is pressed/i)).toBeNull();
    expect(screen.queryByTestId('trash-socket')).toBeNull();
    expect(screen.queryByText(/Drag socket here or onto the graph background to unsocket materia/i)).toBeNull();
  });

  it('shows a persisted active-loadout selector with configured loadout options', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }))));

    render(<App />);

    const activeSelect = await screen.findByLabelText('Active loadout') as HTMLSelectElement;
    expect(activeSelect.value).toBe('Full-Auto');
    expect(within(activeSelect).getByRole('option', { name: 'Full-Auto' })).toBeTruthy();
    expect(within(activeSelect).getByRole('option', { name: 'Planning-Consult' })).toBeTruthy();
  });

  it('posts active-loadout selector changes and refreshes from returned config without changing the viewed loadout', async () => {
    let activeLoadout = 'Full-Auto';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/api/loadout/active' && init?.method === 'POST') {
        activeLoadout = JSON.parse(String(init.body)).name;
        const updatedConfig = { ...structuredClone(testConfig), activeLoadout, activeLoadoutId: activeLoadout };
        return new Response(JSON.stringify({
          ok: true,
          activeLoadout,
          config: { config: updatedConfig, source: 'test', loadoutSources: { 'Full-Auto': 'default', 'Planning-Consult': 'user' } },
          message: `Active loadout changed to ${activeLoadout}.`,
        }));
      }
      return new Response(JSON.stringify({ ok: true, source: 'test', config: { ...testConfig, activeLoadout, activeLoadoutId: activeLoadout } }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const activeSelect = await screen.findByLabelText('Active loadout') as HTMLSelectElement;
    fireEvent.change(activeSelect, { target: { value: 'Planning-Consult' } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/loadout/active', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ name: 'Planning-Consult' }),
    })));
    await waitFor(() => expect((screen.getByLabelText('Active loadout') as HTMLSelectElement).value).toBe('Planning-Consult'));
    expect(screen.getByLabelText('Active loadout')).not.toHaveProperty('disabled', true);
    expect(within(screen.getByLabelText('Active loadout')).getByRole('option', { name: 'Full-Auto' })).toBeTruthy();
    expect(within(screen.getByLabelText('Active loadout')).getByRole('option', { name: 'Planning-Consult' })).toBeTruthy();
    expect(screen.getByText(/Active loadout is now Planning-Consult/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Full-Auto/ }).closest('.loadout-card')?.classList.contains('loadout-card-active')).toBe(true);

    fireEvent.change(screen.getByLabelText('Active loadout'), { target: { value: 'Full-Auto' } });
    await waitFor(() => expect(fetchMock.mock.calls.filter((call) => call[0] === '/api/loadout/active')).toHaveLength(2));
    await waitFor(() => expect((screen.getByLabelText('Active loadout') as HTMLSelectElement).value).toBe('Full-Auto'));
    expect(screen.getByLabelText('Active loadout')).not.toHaveProperty('disabled', true);
    expect(screen.getByText(/Active loadout is now Full-Auto/i)).toBeTruthy();
  });

  it('keeps known active-loadout options when a change response carries only partial stale config data', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/api/loadout/active' && init?.method === 'POST') {
        const activeLoadout = JSON.parse(String(init.body)).name;
        return new Response(JSON.stringify({
          ok: true,
          activeLoadout,
          config: { config: { activeLoadout }, source: 'monitor-stale-partial' },
          message: `Active loadout changed to ${activeLoadout}.`,
        }));
      }
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig, loadoutSources: { 'Full-Auto': 'default', 'Planning-Consult': 'user' } }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const activeSelect = await screen.findByLabelText('Active loadout') as HTMLSelectElement;
    expect(within(activeSelect).getAllByRole('option').map((option) => option.textContent)).toEqual(['Full-Auto', 'Planning-Consult']);
    fireEvent.change(activeSelect, { target: { value: 'Planning-Consult' } });

    await waitFor(() => expect((screen.getByLabelText('Active loadout') as HTMLSelectElement).value).toBe('Planning-Consult'));
    const changedSelect = screen.getByLabelText('Active loadout') as HTMLSelectElement;
    expect(changedSelect).not.toHaveProperty('disabled', true);
    expect(within(changedSelect).getAllByRole('option').map((option) => option.textContent)).toEqual(['Full-Auto', 'Planning-Consult']);
    expect(screen.getByRole('button', { name: /Full-Auto/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Planning-Consult/ })).toBeTruthy();
  });

  it('restores active-loadout selector state and surfaces backend conflicts on failure', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/api/loadout/active' && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: false, error: { code: 'active_cast_conflict', message: 'Cannot change active loadout during active cast cast-123.' } }), { status: 409 });
      }
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const activeSelect = await screen.findByLabelText('Active loadout') as HTMLSelectElement;
    fireEvent.change(activeSelect, { target: { value: 'Planning-Consult' } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/loadout/active', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ name: 'Planning-Consult' }),
    })));
    await waitFor(() => expect(screen.getAllByText(/Cannot change active loadout during active cast cast-123/i).length).toBeGreaterThan(0));
    expect((screen.getByLabelText('Active loadout') as HTMLSelectElement).value).toBe('Full-Auto');
  });

  it('keeps the reported layered config clean through selection, save, and refresh', async () => {
    const source = '/home/reese/.pi/agent/git/github.com/rpollard00/pi-materia/config/default.json < /home/reese/.config/pi/pi-materia/materia.json < /home/reese/projects/pi-materia/.pi/pi-materia.json';
    let responseConfig = {
      ...structuredClone(testConfig),
      loadouts: {
        'Full-Auto': structuredClone(testConfig.loadouts['Full-Auto']),
        'Hojo-Consult': structuredClone(testConfig.loadouts['Planning-Consult']),
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/api/config' && init?.method === 'POST') {
        responseConfig = JSON.parse(String(init.body)).config;
        return new Response(JSON.stringify({ ok: true, target: 'user' }));
      }
      return new Response(JSON.stringify({
        ok: true,
        source,
        config: responseConfig,
        loadoutSources: { 'Full-Auto': 'default', 'Hojo-Consult': 'user' },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByRole('button', { name: /Full-Auto/ });
    expectHeaderStatus(source, 'clean');

    fireEvent.click(screen.getByRole('button', { name: /Hojo-Consult/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Hojo-Consult/ }).closest('.loadout-card')?.classList.contains('loadout-card-active')).toBe(true));
    expectHeaderStatus(source, 'clean');

    fireEvent.click(screen.getByRole('button', { name: /Full-Auto/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Full-Auto/ }).closest('.loadout-card')?.classList.contains('loadout-card-active')).toBe(true));
    expectHeaderStatus(source, 'clean');

    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    await screen.findByRole('button', { name: /New Loadout/ });
    expectHeaderStatus(source, 'staged edits');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitForConfigPostCount(fetchMock, 1);
    await waitFor(() => expectHeaderStatus(source, 'clean'));

    cleanup();
    render(<App />);

    await screen.findByRole('button', { name: /New Loadout/ });
    expectHeaderStatus(source, 'clean');
  });

  it('visibly protects Built-In loadouts from deletion', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      source: 'test',
      config: testConfig,
      loadoutSources: { 'Full-Auto': 'default', 'Planning-Consult': 'user' },
    }))));

    render(<App />);

    await screen.findByRole('button', { name: /Full-Auto/ });
    expect(loadoutCard('Full-Auto').textContent).not.toContain('Built-In');
    expect(screen.queryByText(/shipped default/i)).toBeNull();

    openLoadoutActions('Full-Auto');
    const protectedDelete = screen.getByTitle('Built-In loadouts cannot be deleted.');
    expect(protectedDelete.hasAttribute('disabled')).toBe(true);
  });

  it('deletes a user loadout, falls back when it was active, and persists a deletion marker', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/api/config' && init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({
        ok: true,
        source: 'test',
        config: { ...testConfig, activeLoadout: 'Planning-Consult' },
        loadoutSources: { 'Full-Auto': 'default', 'Planning-Consult': 'user' },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByTestId('socket-Socket-1')).toBeTruthy();
    openLoadoutActions('Planning-Consult');
    fireEvent.click(screen.getByTitle('Delete Planning-Consult'));

    await waitFor(() => expect(screen.queryByRole('button', { name: /Planning-Consult/ })).toBeNull());
    expect(screen.getByRole('button', { name: /Full-Auto/ }).closest('.loadout-card')?.classList.contains('loadout-card-active')).toBe(true);
    expect(screen.getByText(/Deleted loadout Planning-Consult/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitForConfigPostCount(fetchMock, 1);
    const saved = configPostBody(fetchMock);
    expect(saved.config.activeLoadout).toBe('Full-Auto');
    expect(saved.config.loadouts['Planning-Consult']).toBeNull();
  });

  it('blocks invalid control-route saves before posting config', async () => {
    const invalidConfig = JSON.parse(JSON.stringify(testConfig));
    delete invalidConfig.loadouts['Full-Auto'].sockets['Socket-3'].parse;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/api/config' && init?.method === 'POST') throw new Error('invalid config was posted');
      return new Response(JSON.stringify({ ok: true, source: 'test', config: invalidConfig, loadoutSources: { 'Full-Auto': 'user', 'Planning-Consult': 'user' } }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const input = await screen.findByLabelText(/Edit name/i);
    fireEvent.change(input, { target: { value: 'Renamed Invalid Full Auto' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getAllByText(/Socket-3 \(Auto-Eval\).*satisfied\/not_satisfied routing requires JSON output parsing/i).length).toBeGreaterThan(0));
    const validationToast = screen.getByRole('alert');
    expect(validationToast.getAttribute('data-toast-variant')).toBe('validation');
    expect(validationToast.textContent).toContain('Cannot save loadout');
    expect(validationToast.textContent).toContain('satisfied/not_satisfied routing requires JSON output parsing');
    const stageApplyPanel = screen.getByRole('heading', { name: 'Stage & apply' }).closest('section') as HTMLElement;
    expect(within(stageApplyPanel).queryByText('Cannot save loadout')).toBeNull();
    expect(within(stageApplyPanel).queryByText(/satisfied\/not_satisfied routing requires JSON output parsing/i)).toBeNull();
    expect(configPostCalls(fetchMock)).toHaveLength(0);
  });

  it('keeps loadout name edits local until commit and rejects empty names', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }))));

    render(<App />);

    const input = await screen.findByLabelText(/Edit name/i);
    fireEvent.change(input, { target: { value: '' } });

    expect(input).toHaveProperty('value', '');
    expect(screen.getByRole('button', { name: /Full-Auto/ })).toBeTruthy();

    fireEvent.blur(input);

    expect(await screen.findByText(/name cannot be empty/i)).toBeTruthy();
    expect(input).toHaveProperty('value', '');
    expect(screen.getByRole('button', { name: /Full-Auto/ }).closest('.loadout-card')?.classList.contains('loadout-card-active')).toBe(true);
  });

  it('rejects duplicate loadout names without switching the active loadout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }))));

    render(<App />);

    const input = await screen.findByLabelText(/Edit name/i);
    fireEvent.change(input, { target: { value: 'Planning-Consult' } });
    fireEvent.blur(input);

    expect(await screen.findByText(/Planning-Consult already exists/i)).toBeTruthy();
    expect(input).toHaveProperty('value', 'Planning-Consult');
    expect(screen.getByRole('button', { name: /Full-Auto/ }).closest('.loadout-card')?.classList.contains('loadout-card-active')).toBe(true);
  });

  it('renames a persisted loadout on commit and saves a deletion marker for the old name', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/api/config' && init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig, loadoutSources: { 'Full-Auto': 'user', 'Planning-Consult': 'user' } }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const input = await screen.findByLabelText(/Edit name/i);
    fireEvent.change(input, { target: { value: 'Renamed Full Auto' } });
    fireEvent.blur(input);

    expect(await screen.findByRole('button', { name: /Renamed Full Auto/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Full-Auto/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Renamed Full Auto/ }).closest('.loadout-card')?.classList.contains('loadout-card-active')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitForConfigPostCount(fetchMock, 1);
    const saved = configPostBody(fetchMock);
    expect(saved.config.activeLoadout).toBe('Renamed Full Auto');
    expect(saved.config.loadouts['Full-Auto']).toBeNull();
    expect(saved.config.loadouts['Renamed Full Auto']).toMatchObject(normalizedTestLoadout(testConfig.loadouts['Full-Auto']));
    expect(saved.config.loadouts['Planning-Consult']).toMatchObject(normalizedTestLoadout(testConfig.loadouts['Planning-Consult']));
  });

  it('renames a new unsaved loadout without staging a deletion marker', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/api/config' && init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig, loadoutSources: { 'Full-Auto': 'user', 'Planning-Consult': 'user' } }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByTestId('socket-Socket-1');
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    const input = screen.getByLabelText(/Edit name/i);
    fireEvent.change(input, { target: { value: 'Unsaved Custom' } });
    fireEvent.blur(input);

    expect(await screen.findByRole('button', { name: /Unsaved Custom/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitForConfigPostCount(fetchMock, 1);
    const saved = configPostBody(fetchMock);
    expect(saved.config.activeLoadout).toBe('Full-Auto');
    expect(saved.config.loadouts['New Loadout']).toBeUndefined();
    expect(saved.config.loadouts['Unsaved Custom']).toBeTruthy();
  });

  it('renders socket supplemental details as hover titles', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }))));

    render(<App />);

    const build = await screen.findByTestId('socket-Socket-2');
    expect(build.getAttribute('title')).toContain('Socket: Socket-2');
    expect(build.getAttribute('title')).toContain('Materia: Build');
    expect(build.getAttribute('title')).toContain('Model: openai/gpt-test');
    expect(build.getAttribute('title')).toContain('Edges: Always → Socket-3 (Auto-Eval)');
  });

  it('renders longer loadout socket labels in full while keeping them single-line', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }))));

    render(<App />);

    const autoEvalSocket = await screen.findByTestId('socket-Socket-3');
    const autoEvalLabel = autoEvalSocket.querySelector('.materia-socket-label');
    expect(autoEvalLabel?.textContent).toBe('Auto-Eval');
    expect(autoEvalSocket.textContent).not.toContain('Auto-E...');

    fireEvent.click(screen.getByRole('button', { name: /Planning-Consult/ }));
    const interactivePlanSocket = await screen.findByTestId('socket-Socket-1');
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

    const socketBuild = screen.getByTestId('socket-Socket-2');
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

    const planner = await screen.findByTestId('socket-Socket-1');
    const build = await screen.findByTestId('socket-Socket-2');
    const evaluate = await screen.findByTestId('socket-Socket-3');
    const maintain = await screen.findByTestId('socket-Socket-4');
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
    const forwardPath = screen.getByTestId('edge-Socket-2-Socket-3-0').querySelector('path')?.getAttribute('d');
    const retryEdge = screen.getByTestId('edge-Socket-3-Socket-2-1');
    expect(retryEdge.getAttribute('class')).toContain('loadout-edge-route-backward');
    expect(retryEdge.querySelector('path')?.getAttribute('d')).not.toBe(forwardPath);
  });

  it('marks generator materia and generator edges distinctly without tagging loop members as iterators', async () => {
    const config = structuredClone(testConfig);
    (config.materia.planner as any) = { tools: 'none', prompt: 'Plan the work', generator: true };
    (config.loadouts['Full-Auto'].sockets['Socket-1'] as any).assign = { workItems: '$.workItems' };
    (config.loadouts['Full-Auto'] as { loops?: unknown }).loops = {
      taskIteration: {
        sockets: ['Socket-2', 'Socket-3', 'Socket-4'],
        consumes: { from: 'Socket-1', output: 'workItems' },
        exit: { from: 'Socket-4', when: 'satisfied', to: 'end' },
      },
    } as never;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config }))));

    render(<App />);

    const palettePlanner = await screen.findByTestId('palette-planner');
    expect(palettePlanner.classList.contains('palette-orb-generator')).toBe(true);
    expect(palettePlanner.textContent).toContain('Generator');
    expect(palettePlanner.getAttribute('title')).toContain('Generator: canonical workItems output');

    const planner = screen.getByTestId('socket-Socket-1');
    expect(planner.classList.contains('materia-socket-generator')).toBe(true);
    expect(planner.textContent).toContain('Generator');
    const plannerBadge = planner.querySelector('.graph-iterator-badge');
    expect(plannerBadge?.classList.contains('materia-generator-badge')).toBe(true);
    expect(plannerBadge?.textContent).toBe('Generator');

    const generatorEdge = screen.getByTestId('edge-Socket-1-Socket-2-0');
    expect(generatorEdge.classList.contains('loadout-edge-generator-input')).toBe(true);
    expect(generatorEdge.textContent).toContain('Generator output: workItems');
    expect(generatorEdge.querySelector('path')?.getAttribute('marker-end')).toBe('url(#materia-generator-edge-arrow)');

    const build = screen.getByTestId('socket-Socket-2');
    expect(build.classList.contains('materia-socket-iterator')).toBe(false);
    expect(build.textContent).not.toContain('Iterator');
    expect(build.textContent).not.toContain('Loop consumer');
    expect(build.getAttribute('title')).toContain('Loop consumes: Socket-1.workItems');
    expect(screen.getByTestId('loop-region-taskIteration').getAttribute('title')).toContain('Loop consumes: Socket-1.workItems');
  });

  it('derives generator-to-loop display from current graph edges when loop consumes metadata is stale', async () => {
    const config = structuredClone(testConfig);
    (config.materia.planner as any) = { tools: 'none', prompt: 'Plan the work', generator: true };
    (config.materia.Build as any) = { tools: 'coding', prompt: 'Build generated work', generator: true };
    config.loadouts['Full-Auto'].sockets['Socket-1'].edges = [{ when: 'always', to: 'Socket-2' }];
    config.loadouts['Full-Auto'].sockets['Socket-2'].edges = [{ when: 'always', to: 'Socket-3' }];
    (config.loadouts['Full-Auto'] as { loops?: unknown }).loops = {
      taskIteration: {
        sockets: ['Socket-3', 'Socket-4'],
        consumes: { from: 'Socket-1', output: 'workItems' },
        exit: { from: 'Socket-4', when: 'satisfied', to: 'end' },
      },
    } as never;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config }))));

    render(<App />);

    const insertedGeneratorEdge = await screen.findByTestId('edge-Socket-2-Socket-3-0');
    expect(insertedGeneratorEdge.classList.contains('loadout-edge-generator-input')).toBe(true);
    expect(insertedGeneratorEdge.textContent).toContain('Generator output: workItems');
    expect(insertedGeneratorEdge.querySelector('path')?.getAttribute('marker-end')).toBe('url(#materia-generator-edge-arrow)');
    const region = screen.getByTestId('loop-region-taskIteration');
    expect(region.getAttribute('title')).toContain('Loop consumes: Socket-2.workItems');
    expect(region.getAttribute('title')).not.toContain('Loop consumes: Socket-1.workItems');
  });

  it('renders generator-to-generator edges with generated-output semantics', async () => {
    const config = structuredClone(testConfig);
    (config.materia.planner as any) = { tools: 'none', prompt: 'Plan the work', generator: true };
    (config.materia.Build as any) = { tools: 'coding', prompt: 'Build generated work', generator: true };
    (config.loadouts['Full-Auto'].sockets['Socket-1'] as any).assign = { workItems: '$.workItems' };
    (config.loadouts['Full-Auto'].sockets['Socket-2'] as any).parse = 'json';
    (config.loadouts['Full-Auto'].sockets['Socket-2'] as any).assign = { workItems: '$.workItems' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config }))));

    render(<App />);

    const generatorEdge = await screen.findByTestId('edge-Socket-1-Socket-2-0');
    expect(generatorEdge.classList.contains('loadout-edge-generator-input')).toBe(true);
    expect(generatorEdge.textContent).toContain('Generator output: workItems');
    expect(generatorEdge.textContent).not.toContain('Always');
    expect(generatorEdge.querySelector('path')?.getAttribute('marker-end')).toBe('url(#materia-generator-edge-arrow)');
    expect(screen.getByTestId('socket-Socket-1').getAttribute('title')).toContain('Edges: Generator output: workItems → Socket-2 (Build)');

    const buildToEvalEdge = screen.getByTestId('edge-Socket-2-Socket-3-0');
    expect(buildToEvalEdge.textContent).toContain('Always');
    expect(buildToEvalEdge.classList.contains('loadout-edge-generator-input')).toBe(false);
  });

  it('highlights only loop-member sockets with coordinated per-loop accents', async () => {
    const config = structuredClone(testConfig);
    (config.loadouts['Full-Auto'] as { loops?: unknown }).loops = {
      taskIteration: {
        sockets: ['Socket-2', 'Socket-3', 'Socket-4'],
        consumes: { from: 'Socket-1', output: 'workItems' },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config }))));

    render(<App />);

    const build = await screen.findByTestId('socket-Socket-2');
    const autoEval = screen.getByTestId('socket-Socket-3');
    const planner = screen.getByTestId('socket-Socket-1');
    const cycleEdge = await screen.findByTestId('loop-cycle-edge-taskIteration');

    expect(build.classList.contains('materia-socket-loop-member')).toBe(true);
    expect(autoEval.classList.contains('materia-socket-loop-member')).toBe(true);
    expect(build.dataset.loopIds).toBe('taskIteration');
    expect(planner.classList.contains('materia-socket-loop-member')).toBe(false);
    expect(build.style.getPropertyValue('--loop-accent')).toBe(cycleEdge.style.getPropertyValue('--loop-accent'));
  });

  it('tracks overlapping loop memberships without collapsing loop identities', () => {
    const memberships = getLoopMemberships({
      sockets: {},
      loops: {
        first: { sockets: ['Socket-2', 'Socket-3'], iterator: { items: 'state.first' } },
        second: { sockets: ['Socket-3', 'Socket-4'], iterator: { items: 'state.second' } },
      },
    } as never);

    expect(memberships.get('Socket-2')?.loopIds).toEqual(['first']);
    expect(memberships.get('Socket-3')?.loopIds).toEqual(['first', 'second']);
    expect(memberships.get('Socket-4')?.loopIds).toEqual(['second']);
    expect(memberships.has('Socket-1')).toBe(false);
  });

  it('derives loop exit badges from loop exit metadata only', () => {
    const badges = getLoopExitBadges({
      sockets: {
        'Socket-2': { materia: 'Build' },
        'Socket-3': { materia: 'Auto-Eval' },
      },
      loops: {
        review: { sockets: ['Socket-2', 'Socket-3'], exit: { from: 'Socket-3', when: 'satisfied', to: 'end' } },
      },
    } as never);

    expect(badges.has('Socket-2')).toBe(false);
    expect(badges.get('Socket-3')?.loopIds).toEqual(['review']);
    expect(badges.get('Socket-3')?.title).toBe('Loop exit for Build → Auto-Eval: Satisfied → end');
  });

  it('derives stable visual edges for loop-exit route metadata without normal edges', () => {
    const graph = layoutSockets({
      sockets: {
        'Socket-1': { materia: 'planner', edges: [{ when: 'always', to: 'Socket-2' }] },
        'Socket-2': { materia: 'Build', parse: 'json' },
        'Socket-3': { materia: 'Maintain' },
        'Socket-4': { materia: 'Auto-Eval' },
      },
      loops: {
        work: {
          sockets: ['Socket-2', 'Socket-3'],
          exit: { from: 'Socket-3', when: 'satisfied', to: 'end' },
          exits: [
            { id: 'exit:Socket-3:always', from: 'Socket-3', condition: 'always', targetSocketId: 'Socket-4' },
            { id: 'exit:Socket-3:satisfied', from: 'Socket-3', condition: 'satisfied', targetSocketId: 'Socket-1' },
            { id: 'exit:Socket-3:not_satisfied', from: 'Socket-3', condition: 'not_satisfied', targetSocketId: 'Missing' },
          ],
        },
      },
    } as never);

    expect(graph.edges.filter((edge) => edge.kind !== 'loop-exit')).toHaveLength(1);
    expect(graph.edges.filter((edge) => edge.kind === 'loop-exit')).toEqual([
      expect.objectContaining({ id: 'loop-exit:work:exit:Socket-3:always', from: 'Socket-3', to: 'Socket-4', when: 'always', loopId: 'work', loopExitRouteId: 'exit:Socket-3:always' }),
      expect.objectContaining({ id: 'loop-exit:work:exit:Socket-3:satisfied', from: 'Socket-3', to: 'Socket-1', when: 'satisfied', loopId: 'work', loopExitRouteId: 'exit:Socket-3:satisfied' }),
    ]);
  });

  it('renders loop-exit route metadata without requiring current loop.exit metadata', () => {
    const graph = layoutSockets({
      sockets: {
        'Socket-1': { materia: 'Build' },
        'Socket-2': { materia: 'Maintain' },
        'Socket-3': { materia: 'Summarize' },
      },
      loops: {
        work: {
          sockets: ['Socket-1', 'Socket-2'],
          exits: [{ id: 'exit:Socket-2:always', from: 'Socket-2', condition: 'always', targetSocketId: 'Socket-3' }],
        },
      },
    } as never);

    expect(graph.edges.filter((edge) => edge.kind === 'loop-exit')).toEqual([
      expect.objectContaining({ id: 'loop-exit:work:exit:Socket-2:always', from: 'Socket-2', to: 'Socket-3', when: 'always', loopId: 'work', loopExitRouteId: 'exit:Socket-2:always' }),
    ]);
  });

  it('renders canonical loop-exit routes from member sources even when current loop.exit points elsewhere', () => {
    const graph = layoutSockets({
      sockets: {
        'Socket-1': { materia: 'Build' },
        'Socket-2': { materia: 'Eval' },
        'Socket-3': { materia: 'Maintain' },
        'Socket-4': { materia: 'Summarize' },
      },
      loops: {
        work: {
          sockets: ['Socket-1', 'Socket-2', 'Socket-3'],
          exit: { from: 'Socket-3', when: 'satisfied', to: 'end' },
          exits: [{ id: 'exit:Socket-2:not_satisfied', from: 'Socket-2', condition: 'not_satisfied', targetSocketId: 'Socket-4' }],
        },
      },
    } as never);

    expect(graph.edges.filter((edge) => edge.kind === 'loop-exit')).toEqual([
      expect.objectContaining({ id: 'loop-exit:work:exit:Socket-2:not_satisfied', from: 'Socket-2', to: 'Socket-4', when: 'not_satisfied', loopId: 'work', loopExitRouteId: 'exit:Socket-2:not_satisfied' }),
    ]);
  });

  it('toggles loop-exit route edge conditions without removing metadata from the edge hit target', async () => {
    const config = structuredClone(testConfig);
    (config.loadouts['Full-Auto'].sockets['Socket-4'] as { parse?: string }).parse = 'json';
    (config.loadouts['Full-Auto'] as { loops?: unknown }).loops = {
      taskIteration: {
        sockets: ['Socket-2', 'Socket-3', 'Socket-4'],
        exit: { from: 'Socket-4', when: 'satisfied', to: 'end' },
        exits: [
          { id: 'exit:Socket-4:always', from: 'Socket-4', condition: 'always', targetSocketId: 'Socket-1' },
        ],
      },
    } as never;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/api/config' && init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const loopExitEdge = await screen.findByTestId('loop-exit-edge-taskIteration-exit:Socket-4:always');
    expect(loopExitEdge.dataset.edgeKind).toBe('loop-exit');
    expect(loopExitEdge.classList.contains('loadout-edge-loop-exit')).toBe(true);
    expect(loopExitEdge.classList.contains('loadout-edge-default')).toBe(true);
    expect(loopExitEdge.textContent).toContain('Upon Loop Exit');
    expect(loopExitEdge.textContent).not.toContain('Satisfied');
    expect(loopExitEdge.querySelector('path')?.getAttribute('marker-end')).toBe('url(#materia-loop-exit-edge-arrow-default)');
    expect(screen.getByTestId('edge-Socket-1-Socket-2-0').classList.contains('loadout-edge-loop-exit')).toBe(false);

    fireEvent.click(loopExitEdge);
    await waitFor(() => expect(loopExitEdge.textContent).toContain('Upon Loop Exit: Satisfied'));
    expect(loopExitEdge.classList.contains('loadout-edge-loop-exit')).toBe(true);
    expect(loopExitEdge.classList.contains('loadout-edge-satisfied')).toBe(true);
    expect(loopExitEdge.querySelector('path')?.getAttribute('marker-end')).toBe('url(#materia-loop-exit-edge-arrow-satisfied)');
    expect(screen.getByTestId('loop-exit-edge-taskIteration-exit:Socket-4:always')).toBe(loopExitEdge);
    expect(screen.queryByTestId('loop-exit-edge-taskIteration-exit:Socket-4:satisfied')).toBeNull();
    expect(configPostCalls(fetchMock)).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitForConfigPostCount(fetchMock, 1);
    const saved = configPostBody(fetchMock).config.loadouts['Full-Auto'];
    expect(saved.loops.taskIteration.exits).toEqual([{ id: 'exit:Socket-4:always', from: 'Socket-4', condition: 'satisfied', targetSocketId: 'Socket-1' }]);
    expect(saved.sockets['Socket-4'].edges).toBeUndefined();

    fireEvent.keyDown(loopExitEdge, { key: 'Enter' });
    await waitFor(() => expect(loopExitEdge.textContent).toContain('Upon Loop Exit: Not Satisfied'));
    expect(loopExitEdge.classList.contains('loadout-edge-loop-exit')).toBe(true);
    expect(loopExitEdge.classList.contains('loadout-edge-unsatisfied')).toBe(true);
    expect(loopExitEdge.querySelector('path')?.getAttribute('marker-end')).toBe('url(#materia-loop-exit-edge-arrow-unsatisfied)');
    fireEvent.keyDown(loopExitEdge, { key: ' ' });
    await waitFor(() => expect(loopExitEdge.textContent).toContain('Upon Loop Exit'));
    expect(loopExitEdge.textContent).not.toContain('Satisfied');
    expect(loopExitEdge.classList.contains('loadout-edge-loop-exit')).toBe(true);
    expect(loopExitEdge.classList.contains('loadout-edge-default')).toBe(true);
    expect(loopExitEdge.querySelector('path')?.getAttribute('marker-end')).toBe('url(#materia-loop-exit-edge-arrow-default)');
    expect(screen.getByTestId('loop-exit-edge-taskIteration-exit:Socket-4:always')).toBe(loopExitEdge);
  });

  it('renders explicit loop regions and can create the build-eval-maintain task loop', async () => {
    const config = structuredClone(testConfig);
    (config.loadouts['Full-Auto'] as { loops?: unknown }).loops = {
      taskIteration: {
        sockets: ['Socket-2', 'Socket-3', 'Socket-4'],
        iterator: { items: 'state.tasks', as: 'task', cursor: 'taskIndex', done: 'end' },
        exit: { from: 'Socket-4', when: 'satisfied', to: 'end' },
      },
    } as never;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config }))));

    render(<App />);

    const region = await screen.findByTestId('loop-region-taskIteration');
    const buildSocket = screen.getByTestId('socket-Socket-2');
    const exitSocket = screen.getByTestId('socket-Socket-4');
    const summary = 'Loop consumes: Socket-1.workItems • Exit: Socket-4 (Maintain).Satisfied → end';
    expect(region.querySelector('.loadout-loop-badge')?.textContent).toBe('Loop');
    expect(region.querySelector('.loadout-loop-title')?.textContent).toBe('Build → Auto-Eval → Maintain');
    expect(region.querySelector('.loadout-loop-summary')?.textContent).toBe(summary);
    expect(parseFloat(region.style.height)).toBeGreaterThanOrEqual(92);
    expect(parseFloat(buildSocket.style.top) - (parseFloat(region.style.top) + parseFloat(region.style.height))).toBeGreaterThanOrEqual(16);
    expect(region.style.clipPath).toBe('');
    expect(region.getAttribute('style')).not.toContain('--loop-region-polygon');
    expect(await screen.findByTestId('loop-cycle-edge-taskIteration')).toBeTruthy();
    expect(parseFloat(region.style.top)).toBeGreaterThanOrEqual(28);
    expect(region.textContent).toContain('Build → Auto-Eval → Maintain');
    expect(region.textContent).toContain(summary);
    expect(region.getAttribute('title')).toBe(summary);
    expect(screen.getByTestId('loop-editor-panel').textContent).toContain('Loop exits');
    expect(screen.getByTestId('loop-editor-taskIteration').textContent).toContain('Members: Build, Auto-Eval, Maintain');
    expect(screen.getByTestId('loop-editor-taskIteration').textContent).not.toContain('Members: Socket-2');
    const sourceOptions = Array.from(screen.getByTestId('loop-exit-source-taskIteration').querySelectorAll('option')).map((option) => option.getAttribute('value'));
    expect(sourceOptions).toEqual(['Socket-2', 'Socket-3', 'Socket-4']);
    const sourceOptionLabels = Array.from(screen.getByTestId('loop-exit-source-taskIteration').querySelectorAll('option')).map((option) => option.textContent);
    expect(sourceOptionLabels).toEqual(['Build', 'Auto-Eval', 'Maintain']);
    expect(screen.getByTestId('loop-exit-condition-taskIteration')).toBeTruthy();
    expect(screen.getByTestId('loop-exit-target-taskIteration')).toBeTruthy();
    expect(buildSocket.querySelector('.loop-exit-rune')).toBeNull();
    expect(exitSocket.classList.contains('materia-socket-loop-exit')).toBe(true);
    expect(exitSocket.dataset.loopExitIds).toBe('taskIteration');
    expect(exitSocket.querySelector('.loop-exit-rune')?.textContent).toBe('Loop exit');
    expect(exitSocket.querySelector('.loop-exit-rune')?.getAttribute('title')).toBe('Loop exit for Build → Auto-Eval → Maintain: Satisfied → end');
    expect(exitSocket.getAttribute('title')).toContain('Loop exit for Build → Auto-Eval → Maintain: Satisfied → end');

    fireEvent.click(screen.getByTestId('loop-break-taskIteration'));
    await waitFor(() => expect(screen.queryByTestId('loop-region-taskIteration')).toBeNull());
    expect(screen.getByTestId('socket-Socket-4').querySelector('.loop-exit-rune')).toBeNull();
    expect(screen.getByTestId('socket-Socket-4').classList.contains('materia-socket-loop-exit')).toBe(false);
  });

  it('derives loop labels from member materia without changing socket-id storage', () => {
    const loadout = {
      sockets: {
        'Socket-1': { materia: 'Build' },
        'Socket-2': { materia: 'Auto-Eval' },
        'Socket-3': { empty: true },
      },
    } as never;

    expect(formatLoopDisplayLabel(loadout, 'taskLoop', ['Socket-1', 'Socket-2'])).toBe('Build → Auto-Eval');
    expect(formatLoopDisplayLabel(loadout, 'taskLoop', ['Socket-1', 'Socket-3'])).toBe('Build → Empty');
    expect(formatLoopDisplayLabel(loadout, 'taskLoop', ['Socket-9'])).toBe('Socket-9');
  });

  it('edits loop exit conditions with the canonical edge model', async () => {
    const config = structuredClone(testConfig);
    (config.loadouts['Full-Auto'] as { loops?: unknown }).loops = {
      taskIteration: {
        sockets: ['Socket-2', 'Socket-3', 'Socket-4'],
        iterator: { items: 'state.tasks', as: 'task', cursor: 'taskIndex', done: 'end' },
        exit: { from: 'Socket-4', when: 'satisfied', to: 'end' },
      },
    } as never;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.change(await screen.findByTestId('loop-exit-source-taskIteration'), { target: { value: 'Socket-3' } });
    await waitFor(() => expect(screen.getByTestId('loop-region-taskIteration').getAttribute('title')).toContain('Exit: Socket-3 (Auto-Eval).Satisfied → end'));
    fireEvent.change(screen.getByTestId('loop-exit-condition-taskIteration'), { target: { value: 'satisfied' } });
    await waitFor(() => expect(screen.getByTestId('loop-region-taskIteration').getAttribute('title')).toContain('Exit: Socket-3 (Auto-Eval).Satisfied → end'));
    fireEvent.change(screen.getByTestId('loop-exit-target-taskIteration'), { target: { value: 'Socket-4' } });
    await waitFor(() => expect(screen.getByTestId('loop-region-taskIteration').getAttribute('title')).toContain('Exit: Socket-3 (Auto-Eval).Satisfied → Socket-4 (Maintain)'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'];
    expect(saved.loops.taskIteration.exit).toEqual({ from: 'Socket-3', when: 'satisfied', to: 'Socket-4' });
  });

  it('breaks loop metadata without removing sockets or graph edges', async () => {
    const config = structuredClone(testConfig);
    (config.loadouts['Full-Auto'] as { loops?: unknown }).loops = {
      taskIteration: {
        sockets: ['Socket-2', 'Socket-3'],
        consumes: { from: 'Socket-1', output: 'workItems' },
        exit: { from: 'Socket-3', when: 'not_satisfied', to: 'Socket-4' },
      },
    } as never;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByTestId('loop-region-taskIteration')).toBeTruthy();
    expect(await screen.findByTestId('edge-Socket-3-Socket-2-1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('loop-break-taskIteration'));

    await waitFor(() => expect(screen.queryByTestId('loop-region-taskIteration')).toBeNull());
    expect(screen.queryByTestId('loop-editor-panel')).toBeNull();
    expect(screen.getByTestId('socket-Socket-2').classList.contains('materia-socket-loop-member')).toBe(false);
    expect(screen.getByTestId('socket-Socket-2')).toBeTruthy();
    expect(screen.getByTestId('socket-Socket-3')).toBeTruthy();
    expect(screen.getByTestId('edge-Socket-1-Socket-2-0')).toBeTruthy();
    expect(screen.getByTestId('edge-Socket-2-Socket-3-0')).toBeTruthy();
    expect(screen.getByTestId('edge-Socket-3-Socket-2-1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'];
    expect(saved.loops).toBeUndefined();
    expect(saved.sockets['Socket-1'].edges).toEqual([{ when: 'always', to: 'Socket-2' }]);
    expect(saved.sockets['Socket-2'].edges).toEqual([{ when: 'always', to: 'Socket-3' }]);
    expect(saved.sockets['Socket-3'].edges).toEqual([{ when: 'satisfied', to: 'Socket-4' }, { when: 'not_satisfied', to: 'Socket-2' }]);
  });

  it('shows invalid loop creation feedback as a validation toast outside Stage & apply', async () => {
    const config = structuredClone(testConfig);
    (config.loadouts['Full-Auto'].sockets as any)['Socket-5'] = { materia: 'Maintain', layout: { x: 4, y: 0 } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config, loadoutSources: { 'Full-Auto': 'user', 'Planning-Consult': 'user' } }))));

    render(<App />);

    const validationMessage = 'Cannot create loop; selected sockets need exactly one inbound Generator edge, found 0.';
    fireEvent.click(await screen.findByTestId('socket-Socket-5'), { shiftKey: true });
    fireEvent.click(screen.getByTestId('create-task-loop'));

    const notification = await screen.findByRole('alert');
    expect(notification.getAttribute('data-toast-variant')).toBe('validation');
    expect(notification.textContent).toContain(validationMessage);
    const stageApplyPanel = screen.getByRole('heading', { name: 'Stage & apply' }).closest('section') as HTMLElement;
    expect(within(stageApplyPanel).queryByText(validationMessage)).toBeNull();
    expect(within(stageApplyPanel).queryByText(/Nothing is persisted until Save is pressed/i)).toBeNull();

    fireEvent.click(screen.getByTestId('create-task-loop'));
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1));
    expect(screen.getByRole('alert').textContent).toContain(validationMessage);
  });

  it('creates and saves an explicit loop from shift-selected sockets on a fresh layout', async () => {
    const config = structuredClone(testConfig);
    delete (config.loadouts['Full-Auto'] as { loops?: unknown }).loops;
    (config.loadouts['Full-Auto'].sockets['Socket-4'] as any).edges = [{ when: 'always', to: 'Socket-2' }];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const createLoop = await screen.findByTestId('create-task-loop');
    expect(createLoop).toHaveProperty('disabled', true);
    fireEvent.click(await screen.findByTestId('socket-Socket-2'), { shiftKey: true });
    fireEvent.click(screen.getByTestId('socket-Socket-3'), { shiftKey: true });
    fireEvent.click(screen.getByTestId('socket-Socket-4'), { shiftKey: true });
    expect(createLoop).toHaveProperty('disabled', false);
    expect(screen.getByTestId('socket-Socket-2').classList.contains('materia-socket-loop-selected')).toBe(true);

    fireEvent.click(createLoop);
    expect(await screen.findByTestId('loop-region-loopSelection')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'];
    expect(saved.loops.loopSelection).toEqual({
      sockets: ['Socket-2', 'Socket-3', 'Socket-4'],
      consumes: { from: 'Socket-1', output: 'workItems' },
      exit: { from: 'Socket-4', when: 'satisfied', to: 'end' },
    });
    expect(screen.getByTestId('loop-region-loopSelection').querySelector('.loadout-loop-title')?.textContent).toBe('Build → Auto-Eval → Maintain');
  });

  it('creates, saves, and reloads a single-socket loop with one canonical self-edge', async () => {
    const config = structuredClone(testConfig);
    delete (config.loadouts['Full-Auto'] as { loops?: unknown }).loops;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const createLoop = await screen.findByTestId('create-task-loop');
    fireEvent.click(await screen.findByTestId('socket-Socket-2'), { shiftKey: true });
    expect(createLoop).toHaveProperty('disabled', false);
    fireEvent.click(createLoop);

    const region = await screen.findByTestId('loop-region-loopSelection');
    expect(region.querySelector('.loadout-loop-title')?.textContent).toBe('Build');
    expect(screen.getByTestId('socket-Socket-2').classList.contains('materia-socket-loop-member')).toBe(true);
    expect(await screen.findByTestId('edge-Socket-2-Socket-2-0')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'];
    expect(saved.loops.loopSelection).toEqual({
      sockets: ['Socket-2'],
      consumes: { from: 'Socket-1', output: 'workItems' },
      exit: { from: 'Socket-2', when: 'always', to: 'end' },
    });
    expect(saved.sockets['Socket-2'].edges).toEqual([{ when: 'always', to: 'Socket-2' }]);

    cleanup();
    fetchMock.mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: { ...config, loadouts: { ...config.loadouts, 'Full-Auto': saved } } }))));
    render(<App />);
    expect(await screen.findByTestId('loop-region-loopSelection')).toBeTruthy();
    expect(await screen.findByTestId('edge-Socket-2-Socket-2-0')).toBeTruthy();
  });

  it('does not duplicate an existing self-edge when creating a single-socket loop', async () => {
    const config = structuredClone(testConfig);
    delete (config.loadouts['Full-Auto'] as { loops?: unknown }).loops;
    (config.loadouts['Full-Auto'].sockets['Socket-2'] as any).parse = 'json';
    (config.loadouts['Full-Auto'].sockets['Socket-2'] as any).edges = [{ when: 'not_satisfied', to: 'Socket-2' }, { when: 'always', to: 'Socket-3' }];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    fireEvent.click(await screen.findByTestId('socket-Socket-2'), { shiftKey: true });
    fireEvent.click(await screen.findByTestId('create-task-loop'));
    expect(await screen.findByTestId('loop-region-loopSelection')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'];
    expect(saved.sockets['Socket-2'].edges.filter((edge: { to: string }) => edge.to === 'Socket-2')).toEqual([{ when: 'not_satisfied', to: 'Socket-2' }]);
  });

  it('deletes a normal socket, cleans graph references, and persists the result', async () => {
    const config = structuredClone(testConfig);
    (config.loadouts['Full-Auto'] as any).loops = {
      loopSelection: {
        sockets: ['Socket-2', 'Socket-3', 'Socket-4'],
        consumes: { from: 'Socket-1', output: 'workItems' },
        exit: { from: 'Socket-4', when: 'satisfied', to: 'end' },
      },
    };
    (config.loadouts['Full-Auto'].sockets['Socket-4'] as any).edges = [{ when: 'always', to: 'Socket-2' }];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByTestId('socket-Socket-2'));
    fireEvent.click(await screen.findByTestId('delete-socket-Socket-2'));

    await waitFor(() => expect(screen.queryByTestId('socket-Socket-2')).toBeNull());
    expect(screen.queryByTestId('edge-Socket-1-Socket-2-0')).toBeNull();
    expect(screen.queryByTestId('loop-region-loopSelection')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'];
    expect(saved.sockets['Socket-2']).toBeUndefined();
    expect(saved.sockets['Socket-1'].edges).toBeUndefined();
    expect(saved.sockets['Socket-3'].edges).toEqual([{ when: 'satisfied', to: 'Socket-4' }]);
    expect(saved.sockets['Socket-4'].edges).toBeUndefined();
    expect(saved.loops).toBeUndefined();
  });

  it('protects entry sockets from deletion in the socket actions UI', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: structuredClone(testConfig) }))));

    render(<App />);

    fireEvent.click(await screen.findByTestId('socket-Socket-1'));
    const deleteButton = await screen.findByTestId('delete-socket-Socket-1');
    expect(deleteButton).toHaveProperty('disabled', true);
  });

  it('creates connected sockets with normalized socketKind metadata before persisting', async () => {
    const config = structuredClone(testConfig);
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByTestId('socket-Socket-2'));
    fireEvent.click(screen.getByRole('button', { name: 'New Socket' }));

    expect(await screen.findByTestId('socket-Socket-5')).toBeTruthy();
    expect(screen.queryByTestId('socket-action-modal')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'];
    expect(saved.sockets['Socket-1'].socketKind).toBe('entry');
    expect(saved.sockets['Socket-2'].socketKind).toBe('normal');
    expect(saved.sockets['Socket-5'].socketKind).toBe('normal');
    expect(saved.sockets['Socket-2'].edges).toEqual([{ when: 'always', to: 'Socket-5' }]);
    expect(saved.sockets['Socket-5'].edges).toEqual([{ when: 'always', to: 'Socket-3' }]);
  });

  it('creates a loop from selected sockets on a fresh non-Build layout', async () => {
    const config = {
      activeLoadout: 'Fresh Loop',
      activeLoadoutId: 'Fresh Loop',
      materia: {
        planner: { tools: 'none', prompt: 'Plan', generator: true },
        worker: { tools: 'coding', prompt: 'Work' },
        checker: { tools: 'readOnly', prompt: 'Check' },
      },
      loadouts: {
        'Fresh Loop': {
          id: 'Fresh Loop',
          entry: 'Socket-1',
          sockets: {
            'Socket-1': { materia: 'planner', parse: 'json', assign: { workItems: '$.workItems' }, edges: [{ when: 'always', to: 'Socket-2' }], layout: { x: 0, y: 0 } },
            'Socket-2': { materia: 'worker', edges: [{ when: 'always', to: 'Socket-3' }], layout: { x: 1, y: 0 } },
            'Socket-3': { materia: 'checker', edges: [{ when: 'not_satisfied', to: 'Socket-2' }], layout: { x: 2, y: 0 } },
          },
        },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config }))));

    render(<App />);

    fireEvent.click(await screen.findByTestId('socket-Socket-2'), { shiftKey: true });
    fireEvent.click(screen.getByTestId('socket-Socket-3'), { shiftKey: true });
    fireEvent.click(screen.getByTestId('create-task-loop'));

    const region = await screen.findByTestId('loop-region-loopSelection');
    expect(region.getAttribute('title')).toContain('Loop consumes: Socket-1.workItems');
  });

  it('selects loop sockets by dragging a region box before creating a loop', async () => {
    const config = structuredClone(testConfig);
    delete (config.loadouts['Full-Auto'] as { loops?: unknown }).loops;
    (config.loadouts['Full-Auto'].sockets['Socket-4'] as any).edges = [{ when: 'always', to: 'Socket-2' }];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config }))));

    render(<App />);

    const grid = await screen.findByTestId('socket-grid');
    fireEvent.pointerDown(grid, { button: 0, pointerId: 1, clientX: 230, clientY: 0 });
    fireEvent.pointerMove(grid, { pointerId: 1, clientX: 760, clientY: 120 });
    expect(screen.getByTestId('loop-selection-rectangle')).toBeTruthy();
    fireEvent.pointerUp(grid, { pointerId: 1, clientX: 760, clientY: 120 });

    expect(screen.getByTestId('socket-Socket-2').classList.contains('materia-socket-loop-selected')).toBe(true);
    expect(screen.getByTestId('socket-Socket-3').classList.contains('materia-socket-loop-selected')).toBe(true);
    expect(screen.getByTestId('socket-Socket-4').classList.contains('materia-socket-loop-selected')).toBe(true);
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
      entry: 'Socket-1',
      sockets: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
        `Socket-${index + 1}`,
        { materia: 'Build', layout: { x: index, y: index % 2 }, edges: index < 7 ? [{ when: 'always', to: `Socket-${index + 2}` }] : undefined },
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
        sockets: ['Socket-1', 'Socket-2'],
        iterator: { items: 'state.questions', as: 'question' },
      },
    } as never;
    config.activeLoadout = 'Planning-Consult';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config }))));

    render(<App />);

    const region = await screen.findByTestId('loop-region-consultLoop');
    const planner = screen.getByTestId('socket-Socket-1');
    expect(parseFloat(region.style.left)).toBeGreaterThanOrEqual(28);
    expect(parseFloat(region.style.top)).toBeGreaterThanOrEqual(28);
    expect(parseFloat(planner.style.top) - parseFloat(region.style.top)).toBeGreaterThanOrEqual(48);
    expect(screen.getByTestId('socket-grid').style.height).not.toBe('256px');
  });

  it('sizes long loop labels and summaries wide enough to remain readable', () => {
    const loadout = {
      sockets: {
        'Socket-1': { materia: 'Consult', label: 'Consult' },
        'Socket-2': { materia: 'Build', label: 'Build' },
        'Socket-3': { materia: 'Maintain', label: 'Maintain' },
        'Socket-4': { materia: 'Finish', label: 'Finish' },
      },
      loops: {
        readableLoop: {
          sockets: ['Socket-1', 'Socket-2', 'Socket-3'],
          consumes: { from: 'Socket-1', output: 'detailed_task_backlog' },
          exit: { from: 'Socket-3', when: 'not_satisfied', to: 'Socket-4' },
        },
      },
    } as never;
    const positions = new Map<string, never>([
      ['Socket-1', { id: 'Socket-1', socket: {}, index: 0, x: 320, y: 100 } as never],
      ['Socket-2', { id: 'Socket-2', socket: {}, index: 1, x: 408, y: 100 } as never],
      ['Socket-3', { id: 'Socket-3', socket: {}, index: 2, x: 496, y: 100 } as never],
      ['Socket-4', { id: 'Socket-4', socket: {}, index: 3, x: 672, y: 100 } as never],
    ]);

    const [region] = getLoopRegions(loadout, positions);
    expect(region.label).toBe('Consult → Build → Maintain');
    expect(region.summary).toContain('Loop consumes: Socket-1.detailed_task_backlog');
    expect(region.summary).toContain('Exit: Socket-3 (Maintain).Not Satisfied → Socket-4 (Finish)');
    expect(region.width).toBeGreaterThan(360);
    expect(region.width).toBeLessThanOrEqual(780);
    expect(region.width).toBeGreaterThan(520);
    expect(region.x).toBeGreaterThanOrEqual(0);
  });

  it('builds fitted virtual cycle paths for three-of-four corner membership', () => {
    const loadout = {
      sockets: {
        'Socket-1': { materia: 'Build', label: 'A' },
        'Socket-2': { materia: 'Build', label: 'B' },
        'Socket-3': { materia: 'Build', label: 'C' },
        'Socket-4': { materia: 'Build', label: 'Excluded' },
      },
      loops: {
        cornerLoop: { sockets: ['Socket-1', 'Socket-2', 'Socket-3'], iterator: { items: 'state.items' } },
      },
    } as never;
    const positions = new Map<string, never>([
      ['Socket-1', { id: 'Socket-1', socket: {}, index: 0, x: 100, y: 100 } as never],
      ['Socket-2', { id: 'Socket-2', socket: {}, index: 1, x: 308, y: 100 } as never],
      ['Socket-3', { id: 'Socket-3', socket: {}, index: 2, x: 100, y: 268 } as never],
      ['Socket-4', { id: 'Socket-4', socket: {}, index: 3, x: 308, y: 268 } as never],
    ]);

    const [region] = getLoopRegions(loadout, positions);
    expect(region.cyclePath).toContain('Q 166 146');
    expect(region.cyclePath).toContain('Q 374 146');
    expect(region.cyclePath).toContain('Q 166 314');
    expect(region.cyclePath).not.toContain('374 314');
  });

  it('routes parallel edges between the same sockets on separate visual lanes', async () => {
    const parallelConfig = structuredClone(edgeEditorConfig);
    parallelConfig.loadouts.Edges.sockets['Socket-1'].edges = [
      { when: 'satisfied', to: 'Socket-2' },
      { when: 'not_satisfied', to: 'Socket-2' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: parallelConfig }))));

    render(<App />);

    const satisfied = await screen.findByTestId('edge-Socket-1-Socket-2-0');
    const unsatisfied = await screen.findByTestId('edge-Socket-1-Socket-2-1');
    expect(satisfied.querySelector('path')?.getAttribute('d')).not.toBe(unsatisfied.querySelector('path')?.getAttribute('d'));
    expect(satisfied.querySelector('text')?.getAttribute('y')).not.toBe(unsatisfied.querySelector('text')?.getAttribute('y'));
  });

  it('routes self edges outside the socket bounds with readable label clearance', () => {
    const socket = { id: 'Socket-1', socket: { materia: 'Maintain', label: 'Maintain' }, index: 0, x: 320, y: 80 } as never;
    const positions = new Map<string, never>([['Socket-1', socket]]);
    const [route] = routeLoadoutEdges([
      { id: 'Socket-1:edge:0:Socket-1:not_satisfied', from: 'Socket-1', to: 'Socket-1', kind: 'edge', edgeIndex: 0, when: 'not_satisfied' },
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
      ['Socket-1', { id: 'Socket-1', socket: { materia: 'Build', label: 'A' }, index: 0, x: 520, y: 0 } as never],
      ['Socket-2', { id: 'Socket-2', socket: { materia: 'Build', label: 'B' }, index: 1, x: 0, y: 20 } as never],
      ['Socket-3', { id: 'Socket-3', socket: { materia: 'Build', label: 'C' }, index: 2, x: 0, y: 120 } as never],
      ['Socket-4', { id: 'Socket-4', socket: { materia: 'Build', label: 'D' }, index: 3, x: 520, y: 140 } as never],
    ]);
    const edges = [
      { id: 'Socket-1:edge:0:Socket-2:satisfied', from: 'Socket-1', to: 'Socket-2', kind: 'edge', edgeIndex: 0, when: 'satisfied' },
      { id: 'Socket-1:edge:1:Socket-2:not_satisfied', from: 'Socket-1', to: 'Socket-2', kind: 'edge', edgeIndex: 1, when: 'not_satisfied' },
      { id: 'Socket-1:edge:2:Socket-1:first', from: 'Socket-1', to: 'Socket-1', kind: 'edge', edgeIndex: 2, when: 'first' },
      { id: 'Socket-1:edge:3:Socket-1:second', from: 'Socket-1', to: 'Socket-1', kind: 'edge', edgeIndex: 3, when: 'second' },
      { id: 'Socket-3:edge:0:Socket-4:satisfied', from: 'Socket-3', to: 'Socket-4', kind: 'edge', edgeIndex: 0, when: 'satisfied' },
      { id: 'Socket-2:edge:0:Socket-4:not_satisfied', from: 'Socket-2', to: 'Socket-4', kind: 'edge', edgeIndex: 0, when: 'not_satisfied' },
    ] as never;

    const routed = routeLoadoutEdges(edges, positions);
    const byId = new Map(routed.map((route) => [route.edge.id, route]));
    expect(byId.get('Socket-1:edge:0:Socket-2:satisfied')?.path).not.toBe(byId.get('Socket-1:edge:1:Socket-2:not_satisfied')?.path);
    expect(byId.get('Socket-1:edge:0:Socket-2:satisfied')?.labelY).not.toBe(byId.get('Socket-1:edge:1:Socket-2:not_satisfied')?.labelY);
    expect(byId.get('Socket-1:edge:2:Socket-1:first')?.path).not.toBe(byId.get('Socket-1:edge:3:Socket-1:second')?.path);
    expect(byId.get('Socket-1:edge:2:Socket-1:first')?.labelX).not.toBe(byId.get('Socket-1:edge:3:Socket-1:second')?.labelX);
    expect(byId.get('Socket-3:edge:0:Socket-4:satisfied')?.path).not.toBe(byId.get('Socket-2:edge:0:Socket-4:not_satisfied')?.path);
    expect(byId.get('Socket-3:edge:0:Socket-4:satisfied')?.labelY).not.toBe(byId.get('Socket-2:edge:0:Socket-4:not_satisfied')?.labelY);
  });

  it('renders edge routes as organic curves instead of right-angle-only polylines', () => {
    const positions = new Map<string, never>([
      ['Socket-1', { id: 'Socket-1', socket: { materia: 'Build', label: 'A' }, index: 0, x: 0, y: 0 } as never],
      ['Socket-2', { id: 'Socket-2', socket: { materia: 'Build', label: 'B' }, index: 1, x: 208, y: 0 } as never],
      ['Socket-3', { id: 'Socket-3', socket: { materia: 'Build', label: 'C' }, index: 2, x: 208, y: 176 } as never],
    ]);
    const sameRow = routeLoadoutEdges([{ id: 'Socket-1:edge:0:Socket-2:always', from: 'Socket-1', to: 'Socket-2', edgeIndex: 0, when: 'always' }] as never, positions)[0];
    const rowTransition = routeLoadoutEdges([{ id: 'Socket-2:edge:0:Socket-3:always', from: 'Socket-2', to: 'Socket-3', edgeIndex: 0, when: 'always' }] as never, positions)[0];
    const backward = routeLoadoutEdges([{ id: 'Socket-2:edge:0:Socket-1:satisfied', from: 'Socket-2', to: 'Socket-1', kind: 'edge', edgeIndex: 0, when: 'satisfied' }] as never, positions)[0];

    for (const route of [sameRow, rowTransition, backward]) {
      expect(route.path).toMatch(/^M /);
      expect(route.path, route.edge.id).toMatch(/[CQ]/);
      expect(route.path, route.edge.id).not.toMatch(/^(?:M|L) [-0-9.]+ [-0-9.]+(?: L [-0-9.]+ [-0-9.]+)+$/);
    }
  });

  it('renders loaded edge labels from canonical values without raw predicates', async () => {
    const config = structuredClone(edgeEditorConfig);
    config.loadouts.Edges.sockets['Socket-1'].edges = [
      { when: 'always', to: 'Socket-2' },
      { when: 'satisfied', to: 'Socket-3' },
      { when: 'not_satisfied', to: 'Socket-1' },
      { when: '$.passed == true', to: 'Socket-2' },
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
    singleEdgeConfig.loadouts['Full-Auto'].sockets['Socket-3'].edges = [{ when: 'always', to: 'Socket-4' }];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: singleEdgeConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const edge = await screen.findByTestId('edge-Socket-3-Socket-4-0');
    expect(edge.getAttribute('class')).toContain('loadout-edge-default');
    expect(edge.querySelector('text')?.textContent).toBe('Always');

    fireEvent.click(edge);
    expect(await screen.findByText(/Staged edge Socket-3 \(Auto-Eval\) → Socket-4 \(Maintain\) as Satisfied\./)).toBeTruthy();
    expect(screen.getByTestId('edge-Socket-3-Socket-4-0').getAttribute('class')).toContain('loadout-edge-satisfied');

    fireEvent.click(screen.getByTestId('edge-Socket-3-Socket-4-0'));
    expect(await screen.findByText(/Staged edge Socket-3 \(Auto-Eval\) → Socket-4 \(Maintain\) as Not Satisfied\./)).toBeTruthy();
    expect(screen.getByTestId('edge-Socket-3-Socket-4-0').getAttribute('class')).toContain('loadout-edge-unsatisfied');

    fireEvent.click(screen.getByTestId('edge-Socket-3-Socket-4-0'));
    expect(await screen.findByText(/Staged edge Socket-3 \(Auto-Eval\) → Socket-4 \(Maintain\) as Always\./)).toBeTruthy();
    expect(screen.getByTestId('edge-Socket-3-Socket-4-0').getAttribute('class')).toContain('loadout-edge-default');

    fireEvent.click(screen.getByTestId('edge-Socket-3-Socket-4-0'));
    expect(await screen.findByText(/Staged edge Socket-3 \(Auto-Eval\) → Socket-4 \(Maintain\) as Satisfied\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const savedEdge = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'].sockets['Socket-3'].edges[0];
    expect(savedEdge).toEqual({ when: 'satisfied', to: 'Socket-4' });
  });

  it('stages iterative retry edge toggles without rejecting looped satisfied routes', async () => {
    const iterativeConfig = structuredClone(testConfig);
    iterativeConfig.loadouts['Full-Auto'].sockets['Socket-3'].edges = [
      { when: 'satisfied', to: 'Socket-4' },
      { when: 'not_satisfied', to: 'Socket-2' },
    ];
    (iterativeConfig.loadouts['Full-Auto'].sockets['Socket-4'] as { edges?: Array<{ when: 'always'; to: string }> }).edges = [{ when: 'always', to: 'Socket-2' }];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: iterativeConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const retryEdge = await screen.findByTestId('edge-Socket-3-Socket-2-1');
    expect(retryEdge.getAttribute('class')).toContain('loadout-edge-unsatisfied');
    fireEvent.click(retryEdge);

    expect(await screen.findByText(/Staged edge Socket-3 \(Auto-Eval\) → Socket-2 \(Build\) as Always\./)).toBeTruthy();
    expect(screen.queryByText(/Cannot toggle edge Socket-3 \(Auto-Eval\) → Socket-2 \(Build\)/)).toBeNull();
    expect(screen.getByTestId('edge-Socket-3-Socket-2-1').getAttribute('class')).toContain('loadout-edge-default');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const savedSockets = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'].sockets;
    expect(savedSockets['Socket-3'].edges).toEqual([
      { when: 'satisfied', to: 'Socket-4' },
      { when: 'always', to: 'Socket-2' },
    ]);
    expect(savedSockets['Socket-4'].edges).toEqual([{ when: 'always', to: 'Socket-2' }]);
  });

  it('shows validation failures from unreachable edge toggles without mutating draft state', async () => {
    const config = structuredClone(testConfig);
    config.loadouts['Full-Auto'].sockets['Socket-3'].edges = [{ when: 'always', to: 'Socket-4' }, { when: 'satisfied', to: 'Socket-2' }] as never;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const edge = await screen.findByTestId('edge-Socket-3-Socket-2-1');
    fireEvent.click(edge);

    expect(await screen.findByText(/Cannot toggle edge Socket-3 → Socket-2: Socket "Socket-3" has an unreachable outgoing edge at Socket-3\.edges\[1\]/)).toBeTruthy();
    expect(screen.getByTestId('edge-Socket-3-Socket-2-1').getAttribute('class')).toContain('loadout-edge-satisfied');
    expect(screen.queryByText('staged edits')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('creates new loadouts with exactly one empty typed entry socket', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByTestId('socket-Socket-1');
    fireEvent.click(screen.getByRole('button', { name: 'New' }));

    const entry = await screen.findByTestId('socket-Socket-1');
    expect(entry).toBeTruthy();
    expect(entry.getAttribute('title')).toBe('Socket: Socket-1\nDisplay: Socket-1 (Empty)\nEmpty socket');
    expect(screen.getByText('Empty')).toBeTruthy();
    expect(screen.queryByText('Empty socket')).toBeNull();
    expect(screen.getByText('Entry')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const savedConfig = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config;
    const created = Object.entries(savedConfig.loadouts).find(([name]) => name.startsWith('New Loadout'))?.[1] as PipelineConfig | undefined;
    expect(created).toBeTruthy();
    expect(Object.keys(created?.sockets ?? {})).toEqual(['Socket-1']);
    expect(created?.entry).toBe('Socket-1');
    expect(created?.sockets?.['Socket-1']).toEqual({ empty: true, socketKind: 'entry' });
    expect(created?.sockets?.['Socket-1'].type).toBeUndefined();
  });

  it('creates connected sockets with the same Empty display model', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByTestId('socket-Socket-1');
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
    const created = Object.entries(savedConfig.loadouts).find(([name]) => name.startsWith('New Loadout'))?.[1] as PipelineConfig | undefined;
    expect(created).toBeTruthy();
    expect(created?.sockets?.['Socket-1']).toEqual({ empty: true, socketKind: 'entry', edges: [{ when: 'always', to: 'Socket-2' }] });
    expect(created?.sockets?.['Socket-2']).toEqual({ empty: true, socketKind: 'normal' });
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
    const created = Object.entries(savedConfig.loadouts).find(([name]) => name.startsWith('New Loadout'))?.[1] as PipelineConfig | undefined;
    expect(created).toBeTruthy();
    expect(savedConfig.materia).toEqual(initialMateria);
    expect(created?.sockets?.['Socket-1']).toEqual({ materia: 'Build', empty: false, socketKind: 'entry', edges: [{ when: 'always', to: 'Socket-2' }] });
    expect(created?.sockets?.['Socket-2']).toEqual({ empty: true, socketKind: 'normal' });
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
    fireEvent.click(screen.getByTestId('socket-Socket-2'));

    expect(screen.getByText('staged edits')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saveCall = fetchMock.mock.calls[1];
    expect(saveCall[0]).toBe('/api/config');
    expect(JSON.parse(String(saveCall[1]?.body)).target).toBe('user');
    const savedLoadout = JSON.parse(String(saveCall[1]?.body)).config.loadouts['Full-Auto'];
    const savedBuild = savedLoadout.sockets['Socket-2'];
    expect(savedBuild.materia).toBe('Maintain');
    expect(savedBuild.edges).toEqual([{ when: 'always', to: 'Socket-3' }]);
    expect(savedBuild.layout).toBeUndefined();
    expect(savedLoadout.layout.sockets['Socket-2']).toEqual({ x: 1, y: 0 });
    expect(savedBuild.insertedBy).toBe('socket-shift');
  });

  it('preserves socket graph structure when dragging materia between sockets', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByTestId('socket-Socket-4');
    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(screen.getByTestId('socket-Socket-4').querySelector('[draggable="true"]') as HTMLElement, { dataTransfer });
    fireEvent.drop(screen.getByTestId('socket-Socket-2'), { dataTransfer });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const savedLoadout = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'];
    const saved = savedLoadout.sockets;
    expect(saved['Socket-2'].materia).toBe('Maintain');
    expect(saved['Socket-2'].edges).toEqual([{ when: 'always', to: 'Socket-3' }]);
    expect(saved['Socket-2'].layout).toBeUndefined();
    expect(savedLoadout.layout.sockets['Socket-2']).toEqual({ x: 1, y: 0 });
    expect(saved['Socket-2'].insertedBy).toBe('socket-shift');
    expect(saved['Socket-4'].materia).toBe('Build');
    expect(saved['Socket-4'].layout).toBeUndefined();
    expect(savedLoadout.layout.sockets['Socket-4']).toEqual({ x: 3, y: 0 });
    expect(saved['Socket-1'].edges).toEqual([{ when: 'always', to: 'Socket-2' }]);
    expect(saved['Socket-3'].edges).toEqual([{ when: 'satisfied', to: 'Socket-4' }, { when: 'not_satisfied', to: 'Socket-2' }]);
  });

  it('clears dragged-out materia without deleting graph sockets or dangling references', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByTestId('socket-Socket-4');
    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(screen.getByTestId('socket-Socket-4').querySelector('[draggable="true"]') as HTMLElement, { dataTransfer });
    fireEvent.drop(screen.getByTestId('socket-grid-viewport'), { dataTransfer });
    expect(await screen.findByText(/Cleared materia from Socket-4/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const savedLoadout = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'];
    const saved = savedLoadout.sockets;
    expect(saved['Socket-4']).toMatchObject({ empty: true });
    expect(saved['Socket-4'].layout).toBeUndefined();
    expect(savedLoadout.layout.sockets['Socket-4']).toEqual({ x: 3, y: 0 });
    expect(Object.keys(saved)).toContain('Socket-4');
    expect(saved['Socket-3'].edges).toEqual([{ when: 'satisfied', to: 'Socket-4' }, { when: 'not_satisfied', to: 'Socket-2' }]);
  });

  it('opens a socket action modal and unsockets materia while preserving graph metadata', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByTestId('socket-Socket-2'));

    expect(await screen.findByTestId('socket-action-modal')).toBeTruthy();
    expect(screen.getByText(/drag this socket's orb onto the graph background/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear socket' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New Socket' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear socket' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const savedLoadout = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'];
    const savedBuild = savedLoadout.sockets['Socket-2'];
    expect(savedBuild).toMatchObject({ empty: true, edges: [{ when: 'always', to: 'Socket-3' }], insertedBy: 'socket-shift' });
    expect(savedBuild.layout).toBeUndefined();
    expect(savedLoadout.layout.sockets['Socket-2']).toEqual({ x: 1, y: 0 });
    expect(savedBuild.materia).toBeUndefined();
  });

  it('unsockets materia from a socket payload dropped onto the graph background', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByTestId('socket-Socket-2');
    const dataTransfer = createDataTransfer();
    dataTransfer.setData('application/json', JSON.stringify({ kind: 'socket', materiaId: 'Socket-2', fromLoadout: 'Full-Auto', fromSocket: 'Socket-2' }));
    fireEvent.drop(screen.getByTestId('socket-grid-viewport'), { dataTransfer });

    expect(await screen.findByText('Cleared materia from Socket-2; socket graph links and layout were preserved.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitForConfigPostCount(fetchMock, 1);
    const savedLoadout = configPostBody(fetchMock).config.loadouts['Full-Auto'];
    const savedBuild = savedLoadout.sockets['Socket-2'];
    expect(savedBuild).toMatchObject({ empty: true, edges: [{ when: 'always', to: 'Socket-3' }], insertedBy: 'socket-shift' });
    expect(savedBuild.layout).toBeUndefined();
    expect(savedLoadout.layout.sockets['Socket-2']).toEqual({ x: 1, y: 0 });
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
    fireEvent.click(await screen.findByTestId('socket-Socket-2'));
    fireEvent.click(await screen.findByRole('button', { name: 'New Socket' }));
    expect(await screen.findByTestId('socket-Socket-3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Planning-Consult'].sockets;
    expect(saved['Socket-2'].edges).toEqual([{ when: 'always', to: 'Socket-3' }]);
    expect(saved['Socket-3']).toEqual({ empty: true, socketKind: 'normal' });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.activeLoadout).toBe('Full-Auto');
  });

  it('replaces socket materia from the modal while preserving socket graph metadata', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByTestId('socket-Socket-2'));
    fireEvent.click(await screen.findByRole('button', { name: 'Replace' }));

    expect(await screen.findByTestId('materia-replacement-list')).toBeTruthy();
    fireEvent.click(screen.getByTestId('replacement-materia-Maintain'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const savedLoadout = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'];
    const saved = savedLoadout.sockets;
    expect(Object.keys(saved)).toContain('Socket-2');
    expect(saved['Socket-2'].materia).toBe('Maintain');
    expect(saved['Socket-2'].edges).toEqual([{ when: 'always', to: 'Socket-3' }]);
    expect(saved['Socket-2'].layout).toBeUndefined();
    expect(savedLoadout.layout.sockets['Socket-2']).toEqual({ x: 1, y: 0 });
    expect(saved['Socket-2'].insertedBy).toBe('socket-shift');
    expect(saved['Socket-3'].edges).toEqual([{ when: 'satisfied', to: 'Socket-4' }, { when: 'not_satisfied', to: 'Socket-2' }]);
  });

  it('cancels modal materia replacement without mutating draft state', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByTestId('socket-Socket-2'));
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

    fireEvent.click(await screen.findByTestId('socket-Socket-2'));
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
    const savedLoadout = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'];
    const saved = savedLoadout.sockets;
    expect(saved['Socket-2']).toMatchObject({ materia: 'Build', edges: [{ when: 'always', to: 'Socket-3' }], insertedBy: 'socket-shift', limits: { maxVisits: 7, maxEdgeTraversals: 3, maxOutputBytes: 2048 } });
    expect(saved['Socket-2'].layout).toBeUndefined();
    expect(savedLoadout.layout.sockets['Socket-2']).toEqual({ x: 4, y: 1.5 });
    expect(saved['Socket-1'].layout).toBeUndefined();
    expect(savedLoadout.layout.sockets['Socket-1']).toEqual({ x: 0, y: 0 });
    expect(saved['Socket-3'].edges).toEqual([{ when: 'satisfied', to: 'Socket-4' }, { when: 'not_satisfied', to: 'Socket-2' }]);
  });

  it('rejects invalid socket property input without mutating draft state', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByTestId('socket-Socket-2'));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(await screen.findByTestId('socket-max-visits'), { target: { value: '0' } });
    fireEvent.change(screen.getByTestId('socket-layout-x'), { target: { value: 'NaN' } });
    fireEvent.click(screen.getByTestId('save-socket-properties'));

    const validationToast = await findToastAlert();
    expect(validationToast.textContent).toContain('Max visits must be a positive whole number.');
    expect(validationToast.textContent).toContain('Layout X must be a finite number.');
    expect(screen.getByTestId('socket-property-editor')).toBeTruthy();
    expect(screen.queryByText('staged edits')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves socket graph structure and parse semantics when dragging a palette materia into a socket', async () => {
    const config = structuredClone(testConfig) as typeof testConfig & { materia: Record<string, any> };
    (config.materia as Record<string, any>).Maintain = { ...config.materia.Maintain, parse: 'json', assign: { satisfied: '$.satisfied' } };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(await screen.findByTestId('palette-Maintain'), { dataTransfer });
    fireEvent.drop(screen.getByTestId('socket-Socket-2'), { dataTransfer });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const savedLoadout = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts['Full-Auto'];
    const savedBuild = savedLoadout.sockets['Socket-2'];
    expect(savedBuild.materia).toBe('Maintain');
    expect(savedBuild.parse).toBe('json');
    expect(savedBuild.assign).toEqual({ satisfied: '$.satisfied' });
    expect(savedBuild.edges).toEqual([{ when: 'always', to: 'Socket-3' }]);
    expect(savedBuild.layout).toBeUndefined();
    expect(savedLoadout.layout.sockets['Socket-2']).toEqual({ x: 1, y: 0 });
    expect(savedBuild.insertedBy).toBe('socket-shift');
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
    fireEvent.drop(screen.getByTestId('socket-Socket-2'), { dataTransfer });

    await waitFor(() => expect(screen.getByTestId('socket-Socket-2').querySelector('.materia-orb')?.className).toContain('from-rose-200 via-red-300 to-red-700'));
    expect(screen.getByTestId('socket-Socket-2').querySelector('.materia-orb')?.className).toBe(paletteOrbClass?.replace('materia-orb-small', 'materia-orb'));
  });

  it('ignores invalid palette-to-socket drops without corrupting draft state', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByTestId('socket-Socket-2');
    const dataTransfer = createDataTransfer();
    dataTransfer.setData('application/json', '{not-json');
    fireEvent.drop(screen.getByTestId('socket-Socket-2'), { dataTransfer });

    expect(await screen.findByText('Ignored drop: unsupported drag payload.')).toBeTruthy();
    expect(screen.queryByText('staged edits')).toBeNull();

    dataTransfer.setData('application/json', JSON.stringify({ kind: 'palette', materiaId: 'Missing-Materia' }));
    fireEvent.drop(screen.getByTestId('socket-Socket-2'), { dataTransfer });
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

    fireEvent.click(await screen.findByTestId('socket-Socket-1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Edge' }));
    expect(await screen.findByTestId('edge-connector')).toBeTruthy();
    const targetOptionLabels = Array.from(screen.getByTestId('edge-target').querySelectorAll('option')).map((option) => option.textContent);
    expect(targetOptionLabels).toContain('Socket-2 (Review)');
    fireEvent.change(screen.getByTestId('edge-target'), { target: { value: 'Socket-2' } });
    fireEvent.change(screen.getByTestId('edge-condition'), { target: { value: 'not_satisfied' } });
    fireEvent.click(screen.getByTestId('create-edge'));

    expect(await screen.findByText(/Staged edge Socket-1 \(Start\) → Socket-2 \(Review\) as Not Satisfied\./)).toBeTruthy();
    expect(screen.queryByTestId('socket-action-modal')).toBeNull();
    expect(screen.getByTestId('edge-Socket-1-Socket-2-0').getAttribute('class')).toContain('loadout-edge-unsatisfied');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts.Edges.sockets;
    expect(saved['Socket-1'].edges).toEqual([{ to: 'Socket-2', when: 'not_satisfied' }]);
    expect(saved['Socket-2']).toBeTruthy();
  });

  it('creates loop-exit routes through loop metadata and confirms duplicate-condition replacement', async () => {
    const config = structuredClone(edgeEditorConfig);
    (config.loadouts.Edges as any).loops = {
      reviewLoop: {
        sockets: ['Socket-1', 'Socket-2'],
        exit: { from: 'Socket-1', when: 'always', to: 'end' },
      },
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<App />);

    fireEvent.click(await screen.findByTestId('socket-Socket-1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Edge' }));
    expect((await screen.findByTestId('edge-connector')).textContent).toContain('loop-exit route');
    fireEvent.change(screen.getByTestId('edge-target'), { target: { value: 'Socket-2' } });
    fireEvent.change(screen.getByTestId('edge-condition'), { target: { value: 'always' } });
    fireEvent.click(screen.getByTestId('create-edge'));

    expect(await screen.findByText(/Staged loop-exit route Socket-1 \(Start\) → Socket-2 \(Review\) as Always\./)).toBeTruthy();
    fireEvent.click(screen.getByTestId('socket-Socket-1'));
    expect(await screen.findByTestId('remove-loop-exit-route-reviewLoop-exit:Socket-1:always')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Connect Edge' }));
    fireEvent.change(screen.getByTestId('edge-target'), { target: { value: 'Socket-3' } });
    fireEvent.change(screen.getByTestId('edge-condition'), { target: { value: 'always' } });
    fireEvent.click(screen.getByTestId('create-edge'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Replace the existing Always loop-exit route'));
    expect((await screen.findByRole('alert')).textContent).toContain('Kept existing Always loop-exit route to Socket-2 (Review).');
    expect(screen.getByTestId('socket-action-modal')).toBeTruthy();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByTestId('create-edge'));
    expect(await screen.findByText(/Replaced loop-exit route Socket-1 \(Start\) → Socket-3 \(Ship\) as Always\./)).toBeTruthy();
    expect(screen.queryByTestId('socket-action-modal')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts.Edges;
    expect(saved.loops.reviewLoop.exits).toEqual([{ id: 'exit:Socket-1:always', from: 'Socket-1', condition: 'always', targetSocketId: 'Socket-3' }]);
    expect(saved.sockets['Socket-1'].edges).toBeUndefined();
  });

  it('prevents invalid conditional loop-exit routes with immediate feedback', async () => {
    const config = structuredClone(edgeEditorConfig);
    (config.loadouts.Edges.sockets['Socket-1'] as any).parse = 'text';
    (config.loadouts.Edges as any).loops = {
      reviewLoop: {
        sockets: ['Socket-1', 'Socket-2'],
        exit: { from: 'Socket-1', when: 'always', to: 'end' },
      },
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByTestId('socket-Socket-1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Edge' }));
    fireEvent.change(screen.getByTestId('edge-target'), { target: { value: 'Socket-2' } });
    fireEvent.change(screen.getByTestId('edge-condition'), { target: { value: 'satisfied' } });
    fireEvent.click(screen.getByTestId('create-edge'));

    expect((await findToastAlert()).textContent).toContain('require Socket-1 (Start) to parse JSON');
    expect(screen.queryByText('staged edits')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('prevents conditional loop-exit routes from sockets with omitted parse mode', async () => {
    const config = structuredClone(edgeEditorConfig);
    delete (config.loadouts.Edges.sockets['Socket-1'] as any).parse;
    (config.loadouts.Edges as any).loops = {
      reviewLoop: {
        sockets: ['Socket-1', 'Socket-2'],
        exit: { from: 'Socket-1', when: 'always', to: 'end' },
      },
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByTestId('socket-Socket-1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Edge' }));
    fireEvent.change(screen.getByTestId('edge-target'), { target: { value: 'Socket-2' } });
    fireEvent.change(screen.getByTestId('edge-condition'), { target: { value: 'not_satisfied' } });
    fireEvent.click(screen.getByTestId('create-edge'));

    expect((await findToastAlert()).textContent).toContain('require Socket-1 (Start) to parse JSON');
    expect(screen.queryByText('staged edits')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('creates a new socket from a loop exit by recording loop metadata instead of a normal edge', async () => {
    const config = structuredClone(edgeEditorConfig);
    (config.loadouts.Edges as any).loops = {
      reviewLoop: {
        sockets: ['Socket-1', 'Socket-2'],
        exit: { from: 'Socket-1', when: 'always', to: 'end' },
      },
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByTestId('socket-Socket-1'));
    fireEvent.click(await screen.findByRole('button', { name: 'New Socket' }));

    expect(await screen.findByText(/Created a socket and loop-exit route from Socket-1\./)).toBeTruthy();
    expect(screen.queryByTestId('socket-action-modal')).toBeNull();
    expect(await screen.findByTestId('socket-Socket-4')).toBeTruthy();
    expect(screen.getByTestId('loop-exit-edge-reviewLoop-exit:Socket-1:always').dataset.edgeKind).toBe('loop-exit');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts.Edges;
    expect(saved.loops.reviewLoop.exits).toEqual([{ id: 'exit:Socket-1:always', from: 'Socket-1', condition: 'always', targetSocketId: 'Socket-4' }]);
    expect(saved.sockets['Socket-1'].edges).toBeUndefined();
    expect(saved.sockets['Socket-4']).toMatchObject({ empty: true, socketKind: 'normal' });
  });

  it('does not create a new socket when a loop exit already has an always route', async () => {
    const config = structuredClone(edgeEditorConfig);
    (config.loadouts.Edges as any).loops = {
      reviewLoop: {
        sockets: ['Socket-1', 'Socket-2'],
        exit: { from: 'Socket-1', when: 'always', to: 'end' },
        exits: [{ id: 'exit:Socket-1:always', from: 'Socket-1', condition: 'always', targetSocketId: 'Socket-2' }],
      },
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByTestId('socket-Socket-1'));
    fireEvent.click(await screen.findByRole('button', { name: 'New Socket' }));

    expect(await screen.findByText(/already has an Always route/)).toBeTruthy();
    expect(screen.getByTestId('socket-action-modal')).toBeTruthy();
    expect(screen.queryByTestId('socket-Socket-4')).toBeNull();
    expect(screen.queryByText('staged edits')).toBeNull();
  });

  it('removes a conditional edge without deleting either socket', async () => {
    const config = structuredClone(edgeEditorConfig);
    config.loadouts.Edges.sockets['Socket-1'].edges = [{ to: 'Socket-2', when: 'satisfied' }];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByTestId('edge-Socket-1-Socket-2-0')).toBeTruthy();
    fireEvent.click(screen.getByTestId('socket-Socket-1'));
    fireEvent.click(await screen.findByTestId('remove-edge-Socket-1-0'));
    expect(await screen.findByText(/Removed edge Socket-1 → Socket-2; sockets were preserved\./)).toBeTruthy();
    expect(screen.queryByTestId('edge-Socket-1-Socket-2-0')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts.Edges.sockets;
    expect(saved['Socket-1'].edges).toBeUndefined();
    expect(saved['Socket-1']).toBeTruthy();
    expect(saved['Socket-2']).toBeTruthy();
  });

  it('surfaces invalid edge creation without mutating draft state', async () => {
    const config = structuredClone(edgeEditorConfig);
    config.loadouts.Edges.sockets['Socket-1'].edges = [{ when: 'always', to: 'Socket-2' }];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByTestId('socket-Socket-1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Edge' }));
    fireEvent.change(screen.getByTestId('edge-target'), { target: { value: 'Socket-3' } });
    fireEvent.change(screen.getByTestId('edge-condition'), { target: { value: 'satisfied' } });
    fireEvent.click(screen.getByTestId('create-edge'));

    expect((await findToastAlert()).textContent).toContain('Socket "Socket-1" has an unreachable outgoing edge at Socket-1.edges[1]');
    expect(screen.getByTestId('socket-action-modal')).toBeTruthy();
    expect(screen.queryByTestId('edge-Socket-1-Socket-3-1')).toBeNull();
    expect(screen.queryByText('staged edits')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('removes a current default flow without dropping conditional edges or sockets', async () => {
    const config = structuredClone(edgeEditorConfig);
    const startSocket = config.loadouts.Edges.sockets['Socket-1'] as typeof config.loadouts.Edges.sockets['Socket-1'];
    startSocket.edges = [{ to: 'Socket-3', when: 'satisfied' }, { to: 'Socket-2', when: 'always' }];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByTestId('edge-Socket-1-Socket-2-1')).toBeTruthy();
    expect(screen.getByTestId('edge-Socket-1-Socket-3-0')).toBeTruthy();
    fireEvent.click(screen.getByTestId('socket-Socket-1'));
    fireEvent.click(await screen.findByTestId('remove-edge-Socket-1-1'));

    expect(await screen.findByText(/Removed edge Socket-1 → Socket-2; sockets were preserved\./)).toBeTruthy();
    expect(screen.queryByTestId('edge-Socket-1-Socket-2-1')).toBeNull();
    expect(screen.getByTestId('edge-Socket-1-Socket-3-0')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts.Edges.sockets;
    expect(saved['Socket-1'].next).toBeUndefined();
    expect(saved['Socket-1'].edges).toEqual([{ to: 'Socket-3', when: 'satisfied' }]);
    expect(saved['Socket-2']).toBeTruthy();
    expect(saved['Socket-3']).toBeTruthy();
  });

  it('persists manually dragged socket layout using layout units near the graph origin', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: edgeEditorConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const startSocket = await screen.findByTestId('socket-Socket-1');
    startSocket.setPointerCapture = vi.fn();
    startSocket.releasePointerCapture = vi.fn();
    expect(startSocket.style.left).toBe('32px');
    expect(startSocket.style.top).toBe('28px');

    fireEvent.pointerDown(startSocket, { button: 0, pointerId: 7, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(startSocket, { pointerId: 7, clientX: 108, clientY: 107 });
    fireEvent.pointerUp(startSocket, { pointerId: 7, clientX: 108, clientY: 107 });

    expect(await screen.findByText(/Moved socket Socket-1; explicit layout will be saved with the loadout\./)).toBeTruthy();
    expect(screen.queryByTestId('socket-action-modal')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const savedLoadout = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).config.loadouts.Edges;
    const savedStart = savedLoadout.sockets['Socket-1'];
    expect(savedStart.layout).toBeUndefined();
    expect(savedLoadout.layout.sockets['Socket-1'].x).toBeCloseTo(8 / 208);
    expect(savedLoadout.layout.sockets['Socket-1'].y).toBeCloseTo(7 / 168);
    expect(savedStart.edges).toBeUndefined();
  });

  it('does not move unrelated automatic sockets during the first manual socket drag', async () => {
    const config = structuredClone(testConfig) as typeof testConfig & { activeLoadout: string; loadouts: Record<string, unknown> };
    config.activeLoadout = 'Drag-Stability';
    config.loadouts['Drag-Stability'] = {
      entry: 'Socket-1',
      sockets: {
        'Socket-1': { materia: 'Build', edges: [{ when: 'always', to: 'Socket-2' }] },
        'Socket-2': { materia: 'Build', edges: [{ when: 'always', to: 'Socket-3' }] },
        'Socket-3': { materia: 'Build' },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config }))));

    render(<App />);

    const a = await screen.findByTestId('socket-Socket-1');
    const b = await screen.findByTestId('socket-Socket-2');
    const c = await screen.findByTestId('socket-Socket-3');
    a.setPointerCapture = vi.fn();
    a.releasePointerCapture = vi.fn();
    const unrelatedBefore = {
      B: { left: b.style.left, top: b.style.top },
      C: { left: c.style.left, top: c.style.top },
    };

    fireEvent.pointerDown(a, { button: 0, pointerId: 11, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(a, { pointerId: 11, clientX: 160, clientY: 135 });
    fireEvent.pointerUp(a, { pointerId: 11, clientX: 160, clientY: 135 });

    expect(await screen.findByText(/Moved socket Socket-1; explicit layout will be saved with the loadout\./)).toBeTruthy();
    expect(screen.getByTestId('socket-Socket-2').style.left).toBe(unrelatedBefore.B.left);
    expect(screen.getByTestId('socket-Socket-2').style.top).toBe(unrelatedBefore.B.top);
    expect(screen.getByTestId('socket-Socket-3').style.left).toBe(unrelatedBefore.C.left);
    expect(screen.getByTestId('socket-Socket-3').style.top).toBe(unrelatedBefore.C.top);
  });

  it('falls back to automatic graph layout when sockets have no explicit layout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }))));

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Planning-Consult/ }));
    const planner = await screen.findByTestId('socket-Socket-1');
    const build = await screen.findByTestId('socket-Socket-2');

    expect(planner.style.left).toBe('32px');
    expect(planner.style.top).toBe('28px');
    expect(build.style.left).toBe('240px');
    expect(build.style.top).toBe('28px');
  });

  it('places automatic sockets in a bounded two-column serpentine layout', async () => {
    const snakeConfig = structuredClone(testConfig) as typeof testConfig & { activeLoadout: string; loadouts: Record<string, unknown> };
    snakeConfig.activeLoadout = 'Snake';
    snakeConfig.loadouts.Snake = {
      entry: 'Socket-1',
      sockets: {
        'Socket-1': { materia: 'Build', edges: [{ when: 'always', to: 'Socket-2' }] },
        'Socket-2': { materia: 'Build', edges: [{ when: 'always', to: 'Socket-3' }] },
        'Socket-3': { materia: 'Build', edges: [{ when: 'always', to: 'Socket-4' }] },
        'Socket-4': { materia: 'Build', edges: [{ when: 'always', to: 'Socket-5' }] },
        'Socket-5': { materia: 'Build', edges: [{ when: 'always', to: 'Socket-6' }] },
        'Socket-6': { materia: 'Build' },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: snakeConfig }))));

    render(<App />);

    const a = await screen.findByTestId('socket-Socket-1');
    const b = await screen.findByTestId('socket-Socket-2');
    const c = await screen.findByTestId('socket-Socket-3');
    const d = await screen.findByTestId('socket-Socket-4');
    const e = await screen.findByTestId('socket-Socket-5');
    const f = await screen.findByTestId('socket-Socket-6');

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
      entry: 'Socket-1',
      sockets: {
        'Socket-1': { materia: 'Build', edges: [{ when: 'always', to: 'Socket-2' }] },
        'Socket-2': { materia: 'Build', edges: [{ when: 'always', to: 'Socket-3' }] },
        'Socket-3': { materia: 'Build', layout: { x: 7, y: 3 }, edges: [{ when: 'always', to: 'Socket-4' }] },
        'Socket-4': { materia: 'Build' },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: mixedConfig }))));

    render(<App />);

    const a = await screen.findByTestId('socket-Socket-1');
    const b = await screen.findByTestId('socket-Socket-2');
    const c = await screen.findByTestId('socket-Socket-3');
    const d = await screen.findByTestId('socket-Socket-4');

    expect([a.style.left, a.style.top]).toEqual(['32px', '28px']);
    expect([b.style.left, b.style.top]).toEqual(['240px', '28px']);
    expect([c.style.left, c.style.top]).toEqual(['1488px', '532px']);
    expect([d.style.left, d.style.top]).toEqual(['240px', '204px']);
  });

  it('switches the active loadout as a clean client-side selection without showing a viewed-loadout toast', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig })));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Planning-Consult/ }));

    await waitFor(() => expect(screen.queryByTestId('socket-Socket-3')).toBeNull());
    expect(screen.getByTestId('socket-Socket-2')).toBeTruthy();
    expectHeaderStatus('test', 'clean');
    expect(configPostCalls(fetchMock)).toHaveLength(0);

    const toastElements = Array.from(document.querySelectorAll<HTMLElement>('[data-toast-variant]'));
    expect(toastElements.some((toastElement) => toastElement.textContent?.includes('Loadout update'))).toBe(false);
    expect(toastElements.some((toastElement) => toastElement.textContent?.includes('Viewing loadout: Planning-Consult'))).toBe(false);
  });




  it('creates prompt materia, emits a saved event, and reloads without clobbering loadout draft edits', async () => {
    let serverConfig = structuredClone(testConfig) as typeof testConfig & { materia?: Record<string, unknown> };
    const savedEvents: CustomEvent[] = [];
    window.addEventListener('materia:saved', (event) => savedEvents.push(event as CustomEvent), { once: true });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/models') {
        return new Response(JSON.stringify({
          ok: true,
          activeModel: { value: 'openai/gpt-active', label: 'Active Test Model', supportedThinkingLevels: ['off', 'low', 'high'] },
          activeModelValue: 'openai/gpt-active',
          activeThinking: 'low',
          models: [{ value: 'openai/gpt-review', label: 'GPT Review (openai/gpt-review)', supportedThinkingLevels: ['off', 'high'] }],
        }));
      }
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
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    await screen.findByRole('button', { name: /New Loadout/ });
    await openTab('Materia Editor');
    const modelSelect = await screen.findByTestId('materia-model') as HTMLSelectElement;
    const thinkingSelect = screen.getByTestId('materia-thinking') as HTMLSelectElement;
    const outputFormatSelect = screen.getByTestId('materia-output-format') as HTMLSelectElement;
    expect(outputFormatSelect.value).toBe('json');
    expect(modelSelect.value).toBe('');
    expect(modelSelect.options[0]?.textContent).toBe('Active Pi Model');
    expect(thinkingSelect.value).toBe('');
    expect(thinkingSelect.options[0]?.textContent).toBe('Active Pi Thinking');
    await waitFor(() => expect(Array.from(modelSelect.options).map((option) => option.value)).toContain('openai/gpt-review'));
    await waitFor(() => expect(Array.from(thinkingSelect.options).map((option) => option.value)).toEqual(['', 'off', 'low', 'high']));
    fireEvent.change(await screen.findByTestId('materia-name'), { target: { value: 'Critique' } });
    fireEvent.change(screen.getByTestId('materia-prompt'), { target: { value: 'Review the output carefully.' } });
    fireEvent.change(modelSelect, { target: { value: 'openai/gpt-review' } });
    await waitFor(() => expect(Array.from(thinkingSelect.options).map((option) => option.value)).toEqual(['', 'off', 'high']));
    fireEvent.change(thinkingSelect, { target: { value: 'high' } });
    const colorPicker = screen.getByTestId('materia-color');
    expect(screen.queryByRole('radiogroup', { name: /materia color/i })).toBeNull();
    expect(screen.queryByRole('radio', { name: /purple/i })).toBeNull();

    const colorTrigger = within(colorPicker).getByRole('button', { name: 'Select materia color' });
    expect(colorTrigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(colorTrigger);

    const colorChoices = within(colorPicker).getByRole('listbox', { name: 'Materia color choices' });
    const colorOptions = within(colorChoices).getAllByRole('option');
    expect(colorOptions).toHaveLength(8);
    expect(colorOptions.every((option) => option.textContent === '')).toBe(true);
    expect(within(colorChoices).getByRole('option', { name: 'Green materia color' }).getAttribute('aria-selected')).toBe('true');
    expect(within(colorChoices).getByRole('option', { name: 'Purple materia color' }).getAttribute('aria-selected')).toBe('false');

    const css = readFileSync(`${process.cwd()}/src/webui/client/src/styles.css`, 'utf8');
    expect(css).toMatch(/\.materia-settings-section\s*{[^}]*overflow: visible;/s);
    expect(css).toMatch(/\.materia-color-picker\s*{[^}]*position: relative;[^}]*z-index: 20;/s);
    expect(css).toMatch(/\.materia-color-options\s*{[^}]*z-index: 1000;[^}]*display: grid;[^}]*grid-template-columns: repeat\(2, 3\.25rem\);[^}]*grid-template-rows: repeat\(4, 3\.25rem\);/s);

    fireEvent.click(within(colorChoices).getByRole('option', { name: 'Purple materia color' }));
    expect(colorTrigger.getAttribute('aria-expanded')).toBe('false');
    expect(within(colorPicker).queryByRole('listbox', { name: 'Materia color choices' })).toBeNull();

    fireEvent.click(colorTrigger);
    expect(within(screen.getByRole('listbox', { name: 'Materia color choices' })).getByRole('option', { name: 'Purple materia color' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(colorTrigger.getAttribute('aria-expanded')).toBe('false');
    expect(within(colorPicker).queryByRole('listbox', { name: 'Materia color choices' })).toBeNull();

    fireEvent.click(colorTrigger);
    expect(within(screen.getByRole('listbox', { name: 'Materia color choices' })).getByRole('option', { name: 'Purple materia color' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.pointerDown(document.body);
    expect(colorTrigger.getAttribute('aria-expanded')).toBe('false');
    expect(within(colorPicker).queryByRole('listbox', { name: 'Materia color choices' })).toBeNull();

    fireEvent.change(outputFormatSelect, { target: { value: 'text' } });
    fireEvent.change(outputFormatSelect, { target: { value: 'json' } });
    fireEvent.click(screen.getByTestId('materia-multiturn'));
    fireEvent.click(screen.getByTestId('save-materia-form'));

    await waitForConfigPostCount(fetchMock, 1);
    const body = configPostBody(fetchMock);
    expect(body.target).toBe('user');
    expect(body.config).not.toHaveProperty('loadouts');
    expect(body.config.materia.Critique).toMatchObject({ tools: 'none', prompt: 'Review the output carefully.', model: 'openai/gpt-review', thinking: 'high', color: 'materia-color-purple', parse: 'json', multiTurn: true });
    await waitFor(() => expect(fetchMock.mock.calls.filter((call) => call[0] === '/api/config' && (call[1] as RequestInit | undefined)?.method !== 'POST').length).toBeGreaterThanOrEqual(2));
    expect(savedEvents[0].detail).toMatchObject({ id: 'Critique', name: 'Critique', behavior: 'prompt', requestedScope: 'user', scope: 'user' });
    await waitFor(() => expect(screen.getByTestId('materia-save-status').textContent).toContain('Saved reusable prompt materia Critique'));
    expect(await materiaSelectorIds()).toContain('Critique');
    expect(screen.queryByTestId('edit-materia-select')).toBeNull();
    await openTab('Loadout');
    expect(await screen.findByTestId('palette-Critique')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('preserves an existing unavailable model and current thinking value when saved unchanged', async () => {
    const config = structuredClone(testConfig) as typeof testConfig & { materia: Record<string, any> };
    (config.materia as Record<string, any>).Build = { ...config.materia.Build, model: 'current/missing-model', thinking: 'ultra' };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/models') {
        return new Response(JSON.stringify({
          ok: true,
          activeModel: { value: 'openai/gpt-active', label: 'Active Test Model', supportedThinkingLevels: ['off', 'low'] },
          activeModelValue: 'openai/gpt-active',
          activeThinking: 'low',
          models: [
            { value: 'openai/gpt-review', label: 'GPT Review', supportedThinkingLevels: ['off', 'high'] },
            { value: 'anthropic/haiku', label: 'Haiku', supportedThinkingLevels: ['off'] },
          ],
        }));
      }
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await openTab('Materia Editor');
    await clickMateriaSelectorRow('Build');
    const modelSelect = screen.getByTestId('materia-model') as HTMLSelectElement;
    await waitFor(() => expect(Array.from(modelSelect.options).map((option) => option.value)).toContain('current/missing-model'));
    expect(Array.from(modelSelect.options).map((option) => option.value)).toEqual(['', 'openai/gpt-review', 'anthropic/haiku', 'current/missing-model']);
    expect(Array.from(modelSelect.options).find((option) => option.value === 'current/missing-model')?.textContent).toContain('(unavailable)');
    const thinkingSelect = screen.getByTestId('materia-thinking') as HTMLSelectElement;
    expect(Array.from(thinkingSelect.options).map((option) => option.value)).toEqual(['', 'ultra']);
    expect(Array.from(thinkingSelect.options).find((option) => option.value === 'ultra')?.textContent).toContain('unsupported saved value');

    fireEvent.click(screen.getByTestId('save-materia-form'));

    await waitForConfigPostCount(fetchMock, 1);
    const body = configPostBody(fetchMock);
    expect(body.config.materia.Build).toMatchObject({ model: 'current/missing-model', thinking: 'ultra' });
  });

  it('updates thinking choices from model metadata and resets unsupported saved thinking after model changes', async () => {
    const config = structuredClone(testConfig) as typeof testConfig & { materia: Record<string, any> };
    (config.materia as Record<string, any>).Build = { ...config.materia.Build, thinking: 'xhigh' };
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/models') {
        return new Response(JSON.stringify({
          ok: true,
          activeModel: { value: 'openai/gpt-active', label: 'Active Test Model', supportedThinkingLevels: ['low', 'medium'] },
          activeModelValue: 'openai/gpt-active',
          activeThinking: 'medium',
          models: [
            { value: 'openai/gpt-test', label: 'GPT Test', supportedThinkingLevels: ['off', 'high'] },
            { value: 'anthropic/haiku', label: 'Haiku', supportedThinkingLevels: ['off'] },
          ],
        }));
      }
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await openTab('Materia Editor');
    const modelSelect = await screen.findByTestId('materia-model') as HTMLSelectElement;
    const thinkingSelect = screen.getByTestId('materia-thinking') as HTMLSelectElement;
    await waitFor(() => expect(Array.from(thinkingSelect.options).map((option) => option.value)).toEqual(['', 'low', 'medium']));
    await clickMateriaSelectorRow('Build');
    await waitFor(() => expect(Array.from(thinkingSelect.options).map((option) => option.value)).toEqual(['', 'off', 'high', 'xhigh']));
    expect(thinkingSelect.value).toBe('xhigh');

    fireEvent.change(modelSelect, { target: { value: 'anthropic/haiku' } });

    expect(thinkingSelect.value).toBe('');
    expect(Array.from(thinkingSelect.options).map((option) => option.value)).toEqual(['', 'off']);
    expect(Array.from(thinkingSelect.options).map((option) => option.value)).not.toContain('xhigh');
  });

  it('views, creates, and removes semantic Generator config without current fields', async () => {
    const generatorConfig = structuredClone(testConfig) as typeof testConfig & { materia: Record<string, any> };
    (generatorConfig.materia.planner as any).generator = true;
    (generatorConfig.materia.interactivePlan as any).generator = true;
    (generatorConfig.materia.interactivePlan as any).generates = { output: 'tasks', listType: 'array', itemType: 'task', as: 'task', cursor: 'taskIndex', done: 'end' };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: generatorConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await openTab('Materia Editor');
    await clickMateriaSelectorRow('planner');
    expect(screen.getByTestId('materia-generator')).toHaveProperty('checked', true);
    expect(screen.queryByTestId('materia-generated-output')).toBeNull();
    expect(screen.queryByText(/Generated List/)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Generator behavior help' })).toBeNull();
    expect(screen.getByLabelText('Generator').closest('label')?.getAttribute('title')).toContain('canonical workItems');

    fireEvent.click(screen.getByTestId('save-materia-form'));
    await waitForConfigPostCount(fetchMock, 1);
    let body = configPostBody(fetchMock, 0);
    expect(body.config.materia.planner.generator).toBe(true);
    expect(body.config.materia.planner.generates).toBeNull();

    await clickMateriaSelectorRow('interactivePlan');
    expect(screen.getByTestId('materia-generator')).toHaveProperty('checked', true);
    fireEvent.click(screen.getByTestId('save-materia-form'));
    await waitForConfigPostCount(fetchMock, 2);
    body = configPostBody(fetchMock, 1);
    expect(body.config.materia.interactivePlan.generator).toBe(true);
    expect(body.config.materia.interactivePlan.generates).toBeNull();

    await clickMateriaSelectorRow('Build');
    expect(screen.getByTestId('materia-generator')).toHaveProperty('checked', false);
    fireEvent.click(screen.getByTestId('materia-generator'));
    expect(screen.getByTestId('materia-generator')).toHaveProperty('checked', true);
    expect(screen.queryByRole('region', { name: 'Generator behavior help' })).toBeNull();
    fireEvent.click(screen.getByTestId('save-materia-form'));
    await waitForConfigPostCount(fetchMock, 3);
    body = configPostBody(fetchMock, 2);
    expect(body.config.materia.Build.generator).toBe(true);
    expect(body.config.materia.Build.generates).toBeNull();

    await clickMateriaSelectorRow('planner');
    fireEvent.click(screen.getByTestId('materia-generator'));
    fireEvent.click(screen.getByTestId('save-materia-form'));
    await waitForConfigPostCount(fetchMock, 4);
    body = configPostBody(fetchMock, 3);
    expect(body.config.materia.planner.generator).toBeNull();
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

  it('sends canonical workItems generator config when generating role prompts for configured materia', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/generate/materia-role') {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          brief: 'Planner prompt',
          generates: { output: 'workItems', listType: 'array', itemType: 'workItem', as: 'workItem', cursor: 'workItemIndex', done: 'end' },
        });
        return new Response(JSON.stringify({ ok: true, prompt: 'Generated planner prompt' }));
      }
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await openTab('Materia Editor');
    await clickMateriaSelectorRow('planner');
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

  it('defaults the prompt-generation model picker to Active Pi Model and lists available models', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/models') return new Response(JSON.stringify({ ok: true, activeModelValue: 'openai/gpt-active', models: [{ value: 'openai/gpt-alt', label: 'GPT Alt', supportedThinkingLevels: [] }] }));
      if (url === '/api/profile/role-generation') return new Response(JSON.stringify({ ok: true, model: null }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await openTab('Materia Editor');
    const select = await screen.findByTestId('generation-model-select') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(''));
    expect(within(select).getByRole('option', { name: 'Active Pi Model (openai/gpt-active)' })).toBeTruthy();
    expect(within(select).getByRole('option', { name: 'GPT Alt' })).toHaveProperty('value', 'openai/gpt-alt');
  });

  it('persists selected prompt-generation models through the profile preference API', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/profile/role-generation' && init?.method === 'PATCH') return new Response(JSON.stringify({ ok: true, model: 'openai/gpt-alt' }));
      if (url === '/api/models') return new Response(JSON.stringify({ ok: true, activeModelValue: 'openai/gpt-active', models: [{ value: 'openai/gpt-alt', label: 'GPT Alt', supportedThinkingLevels: [] }] }));
      if (url === '/api/profile/role-generation') return new Response(JSON.stringify({ ok: true, model: null }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await openTab('Materia Editor');
    const select = await screen.findByTestId('generation-model-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'openai/gpt-alt' } });

    await waitFor(() => expect(select.value).toBe('openai/gpt-alt'));
    expect(fetchMock).toHaveBeenCalledWith('/api/profile/role-generation', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ model: 'openai/gpt-alt' }),
    }));
  });

  it('shows stale prompt-generation model warnings without clearing the saved preference', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === '/api/models') return new Response(JSON.stringify({ ok: true, activeModelValue: 'openai/gpt-active', models: [{ value: 'openai/gpt-alt', label: 'GPT Alt', supportedThinkingLevels: [] }] }));
      if (url === '/api/profile/role-generation') return new Response(JSON.stringify({ ok: true, model: 'openai/missing' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await openTab('Materia Editor');
    const select = await screen.findByTestId('generation-model-select') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(''));
    expect((await screen.findByTestId('generation-model-stale-warning')).textContent).toContain('Saved generation model is unavailable');
    expect(fetchMock.mock.calls.some((call) => call[0] === '/api/profile/role-generation' && (call[1] as RequestInit | undefined)?.method === 'PATCH')).toBe(false);
  });

  it('surfaces prompt-generation model save failures without hiding the brief', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/profile/role-generation' && init?.method === 'PATCH') return new Response(JSON.stringify({ ok: false, error: { message: 'profile disk unavailable' } }), { status: 500 });
      if (url === '/api/models') return new Response(JSON.stringify({ ok: true, activeModelValue: 'openai/gpt-active', models: [{ value: 'openai/gpt-alt', label: 'GPT Alt', supportedThinkingLevels: [] }] }));
      if (url === '/api/profile/role-generation') return new Response(JSON.stringify({ ok: true, model: null }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await openTab('Materia Editor');
    const brief = await screen.findByTestId('role-generation-brief');
    fireEvent.change(brief, { target: { value: 'A careful reviewer materia' } });
    fireEvent.change(screen.getByTestId('generation-model-select'), { target: { value: 'openai/gpt-alt' } });

    expect((await screen.findByTestId('generation-model-save-error')).textContent).toContain('profile disk unavailable');
    expect(screen.getByTestId('role-generation-brief')).toHaveProperty('value', 'A careful reviewer materia');
  });

  it('displays role generation fallback warnings and effective model metadata with generated output', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/generate/materia-role') {
        expect(JSON.parse(String(init?.body)).brief).toBe('A careful reviewer materia');
        return new Response(JSON.stringify({
          ok: true,
          prompt: 'Generated fallback prompt',
          warnings: ['Saved generation model is unavailable; using Active Pi Model.'],
          modelResolution: { requestedModel: 'openai/missing', effectiveModel: 'openai/gpt-active', fallback: true, warnings: ['Saved generation model is unavailable; using Active Pi Model.'] },
        }));
      }
      if (url === '/api/models') return new Response(JSON.stringify({ ok: true, activeModelValue: 'openai/gpt-active', models: [{ value: 'openai/gpt-alt', label: 'GPT Alt', supportedThinkingLevels: [] }] }));
      if (url === '/api/profile/role-generation') return new Response(JSON.stringify({ ok: true, model: 'openai/missing' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await openTab('Materia Editor');
    fireEvent.change(await screen.findByTestId('role-generation-brief'), { target: { value: 'A careful reviewer materia' } });
    fireEvent.click(screen.getByTestId('generate-role-prompt'));

    expect((await screen.findByTestId('role-generation-preview')).textContent).toContain('Generated fallback prompt');
    expect(screen.getByTestId('role-generation-warning').textContent).toContain('Saved generation model is unavailable');
    expect(screen.getByTestId('role-generation-effective-model').textContent).toContain('openai/gpt-active');
  });

  it('creates prompt materia in current pipeline configs without materializing loadouts', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: currentPipelineConfig }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await openTab('Materia Editor');
    fireEvent.change(await screen.findByTestId('materia-name'), { target: { value: 'Critique' } });
    fireEvent.change(screen.getByTestId('materia-prompt'), { target: { value: 'Review the output carefully.' } });
    fireEvent.click(screen.getByTestId('save-materia-form'));

    await waitForConfigPostCount(fetchMock, 1);
    const body = configPostBody(fetchMock);
    expect(body.config).not.toHaveProperty('loadouts');
    expect(body.config).not.toHaveProperty('pipeline');
    expect(body.config.materia.Critique).toMatchObject({ tools: 'none', prompt: 'Review the output carefully.' });
  });

  it('renders prompt toggles inside settings and keeps generator available for tool materia', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: testConfig }))));

    render(<App />);

    await openTab('Materia Editor');
    const settings = await screen.findByRole('region', { name: 'Materia settings' });
    expect(screen.queryByText('Toggles')).toBeNull();
    expect(settings.contains(screen.getByTestId('materia-multiturn'))).toBe(true);
    expect(settings.contains(screen.getByTestId('materia-generator'))).toBe(true);
    expect(within(settings).getByLabelText('Multiturn')).toBe(screen.getByTestId('materia-multiturn'));
    expect(within(settings).getByLabelText('Generator')).toBe(screen.getByTestId('materia-generator'));

    fireEvent.change(screen.getByTestId('materia-behavior'), { target: { value: 'tool' } });
    expect(screen.queryByTestId('materia-multiturn')).toBeNull();
    expect(screen.queryByTestId('materia-generator')).not.toBeNull();
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

    await waitForConfigPostCount(fetchMock, 1);
    const body = configPostBody(fetchMock);
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
          entry: 'Socket-1',
          sockets: {
            'Socket-1': { materia: 'SocketOnly' },
            'Socket-2': { materia: 'Build' },
          },
        },
        Alternate: {
          entry: 'Socket-1',
          sockets: {
            'Socket-1': { materia: 'RunTests' },
          },
        },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: selectorConfig }))));

    render(<App />);

    await openTab('Materia Editor');
    const initialOptions = await materiaSelectorIds();
    expect(screen.queryByTestId('edit-materia-select')).toBeNull();
    expect(initialOptions).toEqual(['Build', 'DetachedMateria', 'PromptDef', 'RunTests']);
    expect(initialOptions).not.toContain('SocketOnly');
    expect(initialOptions).not.toContain('OtherSocket');

    await openTab('Loadout');
    expect(await screen.findByTestId('palette-RunTests')).toBeTruthy();
    expect(screen.getByTestId('palette-DetachedMateria')).toBeTruthy();
    expect(screen.queryByTestId('palette-SocketOnly')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /Alternate/ }));
    await openTab('Materia Editor');
    const afterLoadoutSwitch = await materiaSelectorIds();
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
    await clickMateriaSelectorRow('RunTests');
    expect(screen.getByTestId('materia-name')).toHaveProperty('value', 'RunTests');
    expect(screen.getByTestId('materia-behavior')).toHaveProperty('value', 'tool');
    expect(screen.getByTestId('materia-utility')).toHaveProperty('value', 'shell');
    expect(screen.getByTestId('materia-command')).toHaveProperty('value', 'npm test');
    expect(screen.getByTestId('materia-params')).toHaveProperty('value', JSON.stringify({ ci: true }, null, 2));
    expect(screen.getByTestId('materia-timeout')).toHaveProperty('value', '90000');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['/api/config', '/api/models', '/api/profile/role-generation']);
  });

  it('edits custom tool allowlists distinctly from presets', async () => {
    const config = structuredClone(testConfig) as typeof testConfig & { materia: Record<string, any> };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await openTab('Materia Editor');
    await clickMateriaSelectorRow('Auto-Eval');
    expect(screen.getByTestId('materia-tools')).toHaveProperty('value', 'custom');
    expect(screen.getByTestId('materia-custom-tools-panel').classList.contains('materia-custom-tools')).toBe(true);
    expect(screen.getByTestId('materia-tool-card-grid').classList.contains('materia-tool-card-grid')).toBe(true);
    expect(screen.getByTestId('materia-custom-tools-panel').textContent).toContain('Command execution is powerful');
    expect(screen.getByTestId('materia-custom-tools')).toHaveProperty('value', 'read, grep, find, ls, bash');
    expect(screen.getByTestId('materia-tool-bash').closest('.materia-tool-card')?.classList.contains('materia-tool-card-warning')).toBe(true);
    fireEvent.click(screen.getByTestId('materia-tool-bash'));
    fireEvent.click(screen.getByTestId('save-materia-form'));

    await waitForConfigPostCount(fetchMock, 1);
    const body = configPostBody(fetchMock);
    expect(body.config.materia['Auto-Eval'].tools).toEqual({ type: 'custom', tools: ['read', 'grep', 'find', 'ls'] });
  });

  it('saves portable custom tool names even when live registry metadata is unavailable', async () => {
    const config = structuredClone(testConfig) as typeof testConfig & { materia: Record<string, any> };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await openTab('Materia Editor');
    await clickMateriaSelectorRow('Build');
    fireEvent.change(screen.getByTestId('materia-tools'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByTestId('materia-custom-tools'), { target: { value: 'read, bsh' } });
    expect(screen.getByTestId('materia-tool-registry-status').textContent).toContain('Live Pi tool registry unavailable');
    expect(screen.getByRole('button', { name: /bsh/i }).classList.contains('materia-configured-tool-chip')).toBe(true);
    fireEvent.click(screen.getByTestId('save-materia-form'));

    await waitForConfigPostCount(fetchMock, 1);
    const body = configPostBody(fetchMock);
    expect(body.config.materia.Build.tools).toEqual({ type: 'custom', tools: ['read', 'bsh'] });
  });

  it('uses live tool registry metadata to show extension tools and warn about unavailable names', async () => {
    const config = structuredClone(testConfig) as typeof testConfig & { materia: Record<string, any> };
    (config.materia as Record<string, any>).Build = { ...config.materia.Build, tools: { type: 'custom', tools: ['read', 'extensionTool', 'staleTool'] } };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', class {
      private listeners = new Map<string, (event: MessageEvent) => void>();
      constructor(_url: string) {
        queueMicrotask(() => this.listeners.get('monitor')?.(new MessageEvent('monitor', { data: JSON.stringify({ ok: true, toolRegistry: { ok: true, available: true, tools: ['read', 'extensionTool'] } }) })));
      }
      addEventListener(type: string, listener: EventListener) { this.listeners.set(type, listener as (event: MessageEvent) => void); }
      close() { this.listeners.clear(); }
    });

    render(<App />);

    await openTab('Materia Editor');
    await clickMateriaSelectorRow('Build');
    await waitFor(() => expect(screen.getByTestId('materia-tool-extensionTool')).toBeTruthy());
    expect(screen.getByTestId('materia-tool-extensionTool')).toHaveProperty('checked', true);
    expect(screen.getByTestId('materia-tool-extensionTool').closest('.materia-tool-card')?.textContent).toContain('Live Pi tool registered for this session.');
    expect(screen.getByTestId('materia-tool-registry-status').textContent).toContain('2 live Pi tools');
    expect(screen.getByTestId('materia-custom-tools-warning').textContent).toContain('staleTool');
    expect(screen.getByRole('button', { name: /staleTool/i }).classList.contains('materia-configured-tool-chip-warning')).toBe(true);
    fireEvent.click(screen.getByTestId('save-materia-form'));

    await waitForConfigPostCount(fetchMock, 1);
    expect(configPostBody(fetchMock).config.materia.Build.tools).toEqual({ type: 'custom', tools: ['read', 'extensionTool', 'staleTool'] });
  });

  it('edits existing prompt materia materia settings where supported', async () => {
    const config = structuredClone(testConfig) as typeof testConfig & { materia: Record<string, any> };
    (config.materia as Record<string, any>).Build = { ...config.materia.Build, parse: 'json' };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, target: 'user' }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await openTab('Materia Editor');
    await clickMateriaSelectorRow('Build');
    expect(screen.getByTestId('materia-output-format')).toHaveProperty('value', 'json');
    fireEvent.change(screen.getByTestId('materia-prompt'), { target: { value: 'Build with extra care.' } });
    fireEvent.change(screen.getByTestId('materia-tools'), { target: { value: 'readOnly' } });
    fireEvent.click(screen.getByTestId('save-materia-form'));

    await waitForConfigPostCount(fetchMock, 1);
    const body = configPostBody(fetchMock);
    expect(body.target).toBe('user');
    expect(body.config).not.toHaveProperty('loadouts');
    expect(body.config.materia.Build).toMatchObject({ tools: 'readOnly', prompt: 'Build with extra care.', model: 'openai/gpt-test', parse: 'json' });
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
    await screen.findByTestId('socket-Socket-2');
    listeners.get('monitor')?.(new MessageEvent('monitor', { data: JSON.stringify({
      ok: true,
      now: 61_000,
      uiStartedAt: 1_000,
      activeCast: { castId: 'cast-1', active: true, phase: 'Build', currentSocketId: 'Socket-2', currentMateria: 'Build', socketState: 'awaiting_agent_response', awaitingResponse: true, runDir: '/tmp/run', artifactRoot: '/tmp', startedAt: 1_000, updatedAt: 61_000 },
      emittedOutputs: [{ id: 'entry-1', type: 'pi-materia', text: 'Build · materia_prompt', timestamp: 61_000, socket: 'Build' }],
      artifactSummary: { runDir: '/tmp/run', summary: 'Completed sockets: planner', outputs: [{ socket: 'Build', kind: 'socket_output', artifact: 'sockets/Build/1.md', content: 'built' }] },
    }) }));

    await waitFor(() => expect(screen.getByTestId('socket-Socket-2').className).toContain('materia-socket-active'));
    await openTab('Monitoring');
    expect(await screen.findByText('awaiting_agent_response')).toBeTruthy();
    expect(screen.getByText('Completed sockets: planner')).toBeTruthy();
  });

  it('applies external active-loadout monitor events without overwriting staged loadout edits', async () => {
    const listeners = new Map<string, (event: MessageEvent) => void>();
    class MockEventSource {
      url: string;
      constructor(url: string) { this.url = url; }
      addEventListener(type: string, listener: (event: MessageEvent) => void) { listeners.set(type, listener); }
      close() {}
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/monitor') return new Response(JSON.stringify({ ok: true }));
      return new Response(JSON.stringify({ ok: true, source: 'test', config: structuredClone(testConfig), loadoutSources: { 'Full-Auto': 'user', 'Planning-Consult': 'user' } }));
    });
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const activeSelect = await screen.findByLabelText('Active loadout') as HTMLSelectElement;
    expect(activeSelect.value).toBe('Full-Auto');
    fireEvent.click(await screen.findByTestId('socket-Socket-2'));
    fireEvent.click(screen.getByRole('button', { name: 'New Socket' }));
    expect(await screen.findByTestId('socket-Socket-5')).toBeTruthy();
    listeners.get('monitor')?.(new MessageEvent('monitor', { data: JSON.stringify({ ok: true, activeLoadoutId: 'Planning-Consult', activeLoadout: 'Planning-Consult', now: 61_000 }) }));

    await waitFor(() => expect((screen.getByLabelText('Active loadout') as HTMLSelectElement).value).toBe('Planning-Consult'));
    expect(screen.getByTestId('socket-Socket-5')).toBeTruthy();
    expect(screen.getByText('staged edits')).toBeTruthy();
    expect(fetchMock.mock.calls.filter((call) => call[0] === '/api/loadout/active')).toHaveLength(0);
  });

  it('raises one deduped toast when an observed active cast completes', async () => {
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
    await screen.findByTestId('socket-Socket-2');
    await openTab('Monitoring');

    listeners.get('monitor')?.(new MessageEvent('monitor', { data: JSON.stringify({
      ok: true,
      now: 61_000,
      uiStartedAt: 1_000,
      activeCast: { castId: 'stale-cast', active: false, phase: 'complete', currentSocketId: 'Socket-2', currentMateria: 'Build', socketState: 'complete', awaitingResponse: false, runDir: '/tmp/run', artifactRoot: '/tmp', startedAt: 1_000, updatedAt: 61_000 },
    }) }));
    expect(await screen.findByText('complete')).toBeTruthy();
    expect(screen.queryByText('Cast completed')).toBeNull();

    listeners.get('monitor')?.(new MessageEvent('monitor', { data: JSON.stringify({
      ok: true,
      now: 62_000,
      uiStartedAt: 1_000,
      activeCast: { castId: 'cast-1', active: true, phase: 'Build', currentSocketId: 'Socket-2', currentMateria: 'Build', socketState: 'awaiting_agent_response', awaitingResponse: true, runDir: '/tmp/run', artifactRoot: '/tmp', startedAt: 1_000, updatedAt: 62_000 },
    }) }));
    await screen.findByText('awaiting_agent_response');

    const completedSnapshot = {
      ok: true,
      now: 63_000,
      uiStartedAt: 1_000,
      activeCast: { castId: 'cast-1', active: false, phase: 'complete', currentSocketId: 'Socket-2', currentMateria: 'Build', socketState: 'complete', awaitingResponse: false, runDir: '/tmp/run', artifactRoot: '/tmp', startedAt: 1_000, updatedAt: 63_000 },
    };
    listeners.get('monitor')?.(new MessageEvent('monitor', { data: JSON.stringify(completedSnapshot) }));
    listeners.get('monitor')?.(new MessageEvent('monitor', { data: JSON.stringify(completedSnapshot) }));

    expect(await screen.findByText('Cast completed')).toBeTruthy();
    expect(screen.getByText('Cast cast-1 finished after Build.')).toBeTruthy();
    expect(screen.getAllByText('Cast completed')).toHaveLength(1);
    expect(screen.getByRole('status').getAttribute('data-toast-variant')).toBe('success');
  });
});
