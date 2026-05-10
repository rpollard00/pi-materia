import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MateriaConfig } from '../../loadoutModel.js';
import { dirtyConfigKey, useWebuiConfig } from './useWebuiConfig.js';

const initialConfig = {
  activeLoadout: 'Alpha',
  materia: { Build: { tools: 'coding', prompt: 'old prompt' } },
  loadouts: {
    Alpha: {
      entry: 'Socket-1',
      nodes: { 'Socket-1': { type: 'agent', materia: 'Build' } },
    },
  },
} satisfies MateriaConfig;

const reloadedConfig = {
  activeLoadout: 'Alpha',
  materia: { Build: { tools: 'coding', prompt: 'new prompt' } },
  loadouts: {
    Alpha: {
      entry: 'Socket-1',
      nodes: { 'Socket-1': { type: 'agent', materia: 'Reloaded' } },
    },
  },
} satisfies MateriaConfig;

const reportedLayeredConfig = {
  activeLoadout: 'Full-Auto',
  materia: {
    Build: { tools: 'coding', prompt: 'Build the assigned work.' },
    'Auto-Eval': { tools: 'readOnly', prompt: 'Evaluate the work.' },
  },
  loadouts: {
    'Full-Auto': {
      entry: 'Socket-1',
      nodes: {
        'Socket-1': { type: 'agent', materia: 'Build', edges: [{ when: 'always', to: 'Socket-2' }] },
        'Socket-2': { type: 'agent', materia: 'Auto-Eval' },
      },
    },
    'Hojo-Consult': {
      entry: 'Socket-1',
      nodes: {
        'Socket-1': { type: 'agent', materia: 'Build', label: 'Hojo profile consult' },
      },
    },
  },
  profile: { roleGeneration: { model: 'profile-hojo-model' } },
} satisfies MateriaConfig;

function ConfigProbe() {
  const config = useWebuiConfig();
  return (
    <>
      <output aria-label="status">{config.status}</output>
      <output aria-label="dirty">{String(config.isDirty)}</output>
      <output aria-label="active-loadout">{config.activeLoadoutName}</output>
      <output aria-label="draft">{JSON.stringify(config.draftConfig)}</output>
      <button type="button" onClick={() => config.switchLoadout('Full-Auto')}>view Full-Auto</button>
      <button type="button" onClick={() => config.switchLoadout('Hojo-Consult')}>view Hojo-Consult</button>
      <button
        type="button"
        onClick={() => config.updateDraft((draft) => {
          const node = draft.loadouts?.Alpha?.nodes?.['Socket-1'] ?? draft.loadouts?.['Full-Auto']?.nodes?.['Socket-1'];
          if (node) node.materia = 'LocalEdit';
        })}
      >
        edit loadout locally
      </button>
      <button
        type="button"
        onClick={() => config.updateDraft((draft) => {
          draft.profile = { ...(draft.profile as Record<string, unknown> | undefined ?? {}), note: 'real profile edit' };
        })}
      >
        edit profile locally
      </button>
      <button
        type="button"
        onClick={() => config.updateLoadoutLayout(config.activeLoadoutName ?? '', (loadout) => ({
          ...loadout,
          layout: { ...(loadout.layout ?? {}), sockets: { ...(loadout.layout?.sockets ?? {}), 'Socket-1': { x: 7, y: 9 } } },
        }))}
      >
        edit layout locally
      </button>
      <button type="button" onClick={() => void config.saveDraft()}>save draft</button>
      <button
        type="button"
        onClick={() => void config.reloadConfig({ preserveLoadoutEdits: true, readyStatus: 'reloaded with preserved loadout edits' })}
      >
        reload preserving loadout edits
      </button>
      <button
        type="button"
        onClick={() => void config.reloadConfig({ readyStatus: 'reloaded cleanly' })}
      >
        reload cleanly
      </button>
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('dirty config comparison', () => {
  it('canonicalizes object key order and equivalent default representations', () => {
    const baseline = {
      activeLoadout: 'Full-Auto',
      materia: {
        Build: { outputFormat: 'json', prompt: 'Build the assigned work.', tools: 'coding' },
      },
      loadouts: {
        'Full-Auto': {
          nodes: {
            'Socket-1': { next: 'Socket-2', materia: 'Build', type: 'agent' },
            'Socket-2': { materia: 'Build', type: 'agent' },
          },
          entry: 'Socket-1',
        },
      },
    } satisfies MateriaConfig;
    const draft = {
      loadouts: {
        'Full-Auto': {
          entry: 'Socket-1',
          nodes: {
            'Socket-2': { type: 'agent', materia: 'Build' },
            'Socket-1': { type: 'agent', materia: 'Build', edges: [{ when: 'always', to: 'Socket-2' }] },
          },
        },
      },
      materia: {
        Build: { tools: 'coding', prompt: 'Build the assigned work.', parse: 'json' },
      },
      activeLoadout: 'Hojo-Consult',
    } satisfies MateriaConfig;

    expect(dirtyConfigKey(baseline)).toBe(dirtyConfigKey(draft));
  });

  it('does not mark migrated legacy node layout dirty after normalization', () => {
    const legacy = {
      loadouts: {
        Layout: {
          entry: 'Socket-1',
          nodes: {
            'Socket-1': { type: 'agent', materia: 'Build', layout: { x: 1, y: 2 } },
            'Socket-2': { type: 'agent', materia: 'Build', layout: { x: 3, y: 4 } },
          },
        },
      },
      materia: { Build: { tools: 'coding', prompt: 'Build.' } },
    } satisfies MateriaConfig;
    const migrated = {
      loadouts: {
        Layout: {
          entry: 'Socket-1',
          layout: { sockets: { 'Socket-1': { x: 1, y: 2 }, 'Socket-2': { x: 3, y: 4 } } },
          nodes: {
            'Socket-1': { type: 'agent', materia: 'Build' },
            'Socket-2': { type: 'agent', materia: 'Build' },
          },
        },
      },
      materia: { Build: { tools: 'coding', prompt: 'Build.' } },
    } satisfies MateriaConfig;

    expect(dirtyConfigKey(legacy)).toBe(dirtyConfigKey(migrated));
  });

  it('detects real persisted config additions, deletions, renames, and socket/materia/profile/loadout edits', () => {
    const baseline = reportedLayeredConfig;
    const editedSocket = cloneConfigForTest(baseline);
    editedSocket.loadouts!['Full-Auto']!.nodes!['Socket-1']!.materia = 'Auto-Eval';
    expect(dirtyConfigKey(editedSocket)).not.toBe(dirtyConfigKey(baseline));

    const editedMateria = cloneConfigForTest(baseline);
    editedMateria.materia!.Build!.prompt = 'Changed prompt';
    expect(dirtyConfigKey(editedMateria)).not.toBe(dirtyConfigKey(baseline));

    const editedProfile = cloneConfigForTest(baseline);
    editedProfile.profile = { ...(editedProfile.profile as Record<string, unknown>), note: 'real edit' };
    expect(dirtyConfigKey(editedProfile)).not.toBe(dirtyConfigKey(baseline));

    const addedLoadout = cloneConfigForTest(baseline);
    addedLoadout.loadouts!.Added = { entry: 'Socket-1', nodes: { 'Socket-1': { type: 'agent', materia: 'Build' } } };
    expect(dirtyConfigKey(addedLoadout)).not.toBe(dirtyConfigKey(baseline));

    const deletedLoadout = cloneConfigForTest(baseline);
    delete deletedLoadout.loadouts!['Hojo-Consult'];
    expect(dirtyConfigKey(deletedLoadout)).not.toBe(dirtyConfigKey(baseline));

    const renamedLoadout = cloneConfigForTest(baseline);
    renamedLoadout.loadouts!['Hojo-Renamed'] = renamedLoadout.loadouts!['Hojo-Consult'];
    delete renamedLoadout.loadouts!['Hojo-Consult'];
    expect(dirtyConfigKey(renamedLoadout)).not.toBe(dirtyConfigKey(baseline));
  });
});

function cloneConfigForTest(config: MateriaConfig): MateriaConfig {
  return JSON.parse(JSON.stringify(config)) as MateriaConfig;
}

describe('useWebuiConfig', () => {
  it('reports clean on initial load when the active loadout falls back without mutating the draft', async () => {
    const config = { ...reportedLayeredConfig, activeLoadout: 'Missing-Loadout' } satisfies MateriaConfig;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'default < user < project', config }))));

    render(<ConfigProbe />);

    await waitFor(() => expect(screen.getByLabelText('active-loadout').textContent).toBe('Full-Auto'));
    expect(screen.getByLabelText('dirty').textContent).toBe('false');
  });

  it('keeps Full-Auto and Hojo-Consult loadout selection clean while real persisted edits are dirty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      source: 'default < user < project',
      config: reportedLayeredConfig,
      loadoutSources: { 'Full-Auto': 'default', 'Hojo-Consult': 'user' },
    }))));

    render(<ConfigProbe />);

    await waitFor(() => expect(screen.getByLabelText('dirty').textContent).toBe('false'));
    fireEvent.click(screen.getByRole('button', { name: 'view Hojo-Consult' }));
    await waitFor(() => expect(screen.getByLabelText('active-loadout').textContent).toBe('Hojo-Consult'));
    expect(screen.getByLabelText('dirty').textContent).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'view Full-Auto' }));
    await waitFor(() => expect(screen.getByLabelText('active-loadout').textContent).toBe('Full-Auto'));
    expect(screen.getByLabelText('dirty').textContent).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'edit loadout locally' }));
    await waitFor(() => expect(screen.getByLabelText('dirty').textContent).toBe('true'));
  });

  it('keeps a saved loadout clean after a reload and still flags profile edits as dirty', async () => {
    let responseConfig: MateriaConfig = reportedLayeredConfig;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        responseConfig = JSON.parse(String(init.body)).config as MateriaConfig;
        return new Response(JSON.stringify({ ok: true, target: 'user' }));
      }
      return new Response(JSON.stringify({ ok: true, source: 'default < user < project', config: responseConfig, loadoutSources: { 'Full-Auto': 'default', 'Hojo-Consult': 'user' } }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ConfigProbe />);

    await waitFor(() => expect(screen.getByLabelText('dirty').textContent).toBe('false'));
    fireEvent.click(screen.getByRole('button', { name: 'edit loadout locally' }));
    await waitFor(() => expect(screen.getByLabelText('dirty').textContent).toBe('true'));

    fireEvent.click(screen.getByRole('button', { name: 'save draft' }));
    await waitFor(() => expect(screen.getByLabelText('status').textContent).toBe('Saved staged loadout edits to user scope.'));
    expect(screen.getByLabelText('dirty').textContent).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'reload cleanly' }));
    await waitFor(() => expect(screen.getByLabelText('status').textContent).toBe('reloaded cleanly'));
    expect(screen.getByLabelText('dirty').textContent).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'edit profile locally' }));
    await waitFor(() => expect(screen.getByLabelText('dirty').textContent).toBe('true'));
  });

  it('keeps layout-only edits out of semantic normalization while still marking the draft dirty', async () => {
    const generatorConfig = {
      activeLoadout: 'Alpha',
      materia: { Build: { type: 'agent', generator: true, prompt: 'Build.' } },
      loadouts: {
        Alpha: {
          entry: 'Socket-1',
          nodes: { 'Socket-1': { type: 'agent', materia: 'Build' } },
        },
      },
    } satisfies MateriaConfig;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: generatorConfig, loadoutSources: { Alpha: 'user' } }))));

    render(<ConfigProbe />);

    await waitFor(() => expect(screen.getByLabelText('dirty').textContent).toBe('false'));
    fireEvent.click(screen.getByRole('button', { name: 'edit layout locally' }));
    await waitFor(() => expect(screen.getByLabelText('dirty').textContent).toBe('true'));
    const draft = JSON.parse(screen.getByLabelText('draft').textContent ?? '{}') as MateriaConfig;
    expect(draft.loadouts?.Alpha?.layout?.sockets?.['Socket-1']).toEqual({ x: 7, y: 9 });
    expect(draft.loadouts?.Alpha?.nodes?.['Socket-1']?.parse).toBeUndefined();
    expect(draft.loadouts?.Alpha?.nodes?.['Socket-1']?.assign).toBeUndefined();
  });

  it('can reload reusable materia definitions while preserving staged loadout edits', async () => {
    let responseConfig: MateriaConfig = initialConfig;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, source: 'test', config: responseConfig, loadoutSources: { Alpha: 'user' } })));
    vi.stubGlobal('fetch', fetchMock);

    render(<ConfigProbe />);

    await waitFor(() => expect(screen.getByLabelText('status').textContent).toBe('Draft ready. Changes are staged until you save.'));
    fireEvent.click(screen.getByRole('button', { name: 'edit loadout locally' }));
    await waitFor(() => expect(screen.getByLabelText('draft').textContent).toContain('LocalEdit'));

    responseConfig = reloadedConfig;
    fireEvent.click(screen.getByRole('button', { name: 'reload preserving loadout edits' }));

    await waitFor(() => expect(screen.getByLabelText('status').textContent).toBe('reloaded with preserved loadout edits'));
    const draft = JSON.parse(screen.getByLabelText('draft').textContent ?? '{}') as MateriaConfig;
    expect(draft.materia?.Build?.prompt).toBe('new prompt');
    expect(draft.loadouts?.Alpha?.nodes?.['Socket-1']?.materia).toBe('LocalEdit');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to demo data when the initial config request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));

    render(<ConfigProbe />);

    await waitFor(() => expect(screen.getByLabelText('status').textContent).toContain('Using demo loadout data: offline'));
    expect(screen.getByLabelText('draft').textContent).toContain('Demo Loadout');
  });
});
