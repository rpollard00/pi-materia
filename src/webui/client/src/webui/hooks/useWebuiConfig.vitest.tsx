import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MateriaConfig } from '../../loadoutModel.js';
import { useWebuiConfig } from './useWebuiConfig.js';

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

function ConfigProbe() {
  const config = useWebuiConfig();
  return (
    <>
      <output aria-label="status">{config.status}</output>
      <output aria-label="draft">{JSON.stringify(config.draftConfig)}</output>
      <button
        type="button"
        onClick={() => config.updateDraft((draft) => {
          const node = draft.loadouts?.Alpha?.nodes?.['Socket-1'];
          if (node) node.materia = 'LocalEdit';
        })}
      >
        edit loadout locally
      </button>
      <button
        type="button"
        onClick={() => void config.reloadConfig({ preserveLoadoutEdits: true, readyStatus: 'reloaded with preserved loadout edits' })}
      >
        reload preserving loadout edits
      </button>
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useWebuiConfig', () => {
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
