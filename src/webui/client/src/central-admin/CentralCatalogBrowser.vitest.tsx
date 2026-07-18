import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CentralCatalogBrowser } from './CentralCatalogBrowser.js';
import { CentralAdminRequestError, type CentralAdminApiPath, type CentralAdminRequester } from './api.js';
import type { CentralCatalogItemSummary } from './catalogTypes.js';

const summaries = [
  {
    id: 'full-auto',
    kind: 'loadout' as const,
    name: 'Full Auto',
    description: 'A central pipeline.',
    version: '4',
    updatedAt: '2026-07-17T10:00:00.000Z',
    contentHash: `sha256:${'a'.repeat(64)}`,
    provenance: { source: 'central', author: 'catalog-team', repositoryId: 'upstream-one' },
  },
  {
    id: 'buildja',
    kind: 'materia' as const,
    name: 'Buildja',
    description: 'Builds the assigned feature.',
    version: '9',
    updatedAt: '2026-07-17T11:00:00.000Z',
    contentHash: `sha256:${'b'.repeat(64)}`,
    provenance: { source: 'central' },
  },
];

function asRequester(implementation: (path: CentralAdminApiPath, init?: RequestInit) => Promise<unknown>): CentralAdminRequester {
  return implementation as CentralAdminRequester;
}

function successfulRequester() {
  return asRequester(async (path) => {
    if (path === '/api/catalog') return { ok: true, items: summaries };
    if (path === '/api/catalog/loadout/full-auto') {
      return { ok: true, item: { ...summaries[0], content: { definition: { sockets: [{ id: 'Socket-1', materia: 'buildja' }] } } } };
    }
    if (path === '/api/catalog/materia/buildja') {
      return { ok: true, item: { ...summaries[1], content: { definition: { type: 'agent', model: { value: 'openai/gpt-5' } } } } };
    }
    if (path === '/api/catalog?kind=materia') return { ok: true, items: [summaries[1]] };
    if (path === '/api/catalog?kind=materia&search=build') return { ok: true, items: [summaries[1]] };
    throw new Error(`unexpected central path ${path}`);
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CentralCatalogBrowser', () => {
  it('renders loading, kind-distinct summaries, full metadata, provenance, hash, and definition JSON', async () => {
    const request = successfulRequester();
    render(<CentralCatalogBrowser request={request} />);

    expect(screen.getByTestId('central-catalog-loading')).toBeTruthy();
    const definition = await screen.findByTestId('central-catalog-definition');

    expect(screen.getByTestId('central-catalog-read-only').textContent).toContain('Read-only');
    expect(screen.getAllByText('Loadout').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Materia').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Full Auto/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Buildja/ })).toBeTruthy();
    expect(screen.getByText('Version 4')).toBeTruthy();
    expect(screen.getByTestId('central-catalog-content-hash').textContent).toBe(`sha256:${'a'.repeat(64)}`);
    expect(within(screen.getByTestId('central-catalog-provenance')).getByText('catalog-team')).toBeTruthy();
    expect(definition.textContent).toContain('"sockets"');
    expect(definition.textContent).toContain('"Socket-1"');

    expect(screen.queryByRole('button', { name: /create/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });

  it('selects materia independently from loadouts and fetches its full definition', async () => {
    render(<CentralCatalogBrowser request={successfulRequester()} />);
    await screen.findByTestId('central-catalog-definition');

    fireEvent.click(screen.getByRole('button', { name: /Buildja/ }));

    const definition = await screen.findByLabelText('Materia definition JSON');
    await waitFor(() => expect(definition.textContent).toContain('openai/gpt-5'));
    expect(screen.getByText('Version 9')).toBeTruthy();
    expect((screen.getByTestId('central-catalog-item-materia-buildja') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
  });

  it('sends kind and search filters to the central list API', async () => {
    const request = vi.fn(successfulRequester());
    render(<CentralCatalogBrowser request={request as unknown as CentralAdminRequester} />);
    await screen.findByTestId('central-catalog-definition');

    fireEvent.change(screen.getByLabelText('Catalog kind'), { target: { value: 'materia' } });
    await waitFor(() => expect(request.mock.calls.some((call) => call[0] === '/api/catalog?kind=materia')).toBe(true));

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search name or id' }), { target: { value: 'build' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(request.mock.calls.some((call) => call[0] === '/api/catalog?kind=materia&search=build')).toBe(true));
  });

  it('renders distinct empty states for an empty catalog and filtered results', async () => {
    const request = asRequester(async (path) => {
      if (path === '/api/catalog' || path === '/api/catalog?search=missing') return { ok: true, items: [] };
      throw new Error(`unexpected central path ${path}`);
    });
    render(<CentralCatalogBrowser request={request} />);

    expect((await screen.findByTestId('central-catalog-empty')).textContent).toContain('central catalog is empty');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search name or id' }), { target: { value: 'missing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(screen.getByTestId('central-catalog-empty').textContent).toContain('No matching definitions'));
  });

  it('keeps and clearly marks last-known list and definition snapshots after refresh failures', async () => {
    let failing = false;
    const successful = successfulRequester();
    const request = asRequester(async (path, init) => {
      if (failing) throw new CentralAdminRequestError('unreachable', 'connection refused');
      return successful(path, init);
    });
    render(<CentralCatalogBrowser request={request} />);
    await screen.findByTestId('central-catalog-definition');

    failing = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh catalog' }));

    expect(await screen.findByTestId('central-catalog-stale-list')).toBeTruthy();
    expect(await screen.findByTestId('central-catalog-stale-definition')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Full Auto/ })).toBeTruthy();
    expect(screen.getByTestId('central-catalog-definition').textContent).toContain('Socket-1');
  });

  it('shows catalog.read permission failures instead of an empty catalog', async () => {
    const request = asRequester(async () => {
      throw new CentralAdminRequestError('forbidden', 'forbidden', 403);
    });
    render(<CentralCatalogBrowser request={request} />);

    const alert = await screen.findByTestId('central-catalog-permission-error');
    expect(alert.textContent).toContain('catalog.read');
    expect(screen.queryByTestId('central-catalog-empty')).toBeNull();
  });

  it('validates and publishes a structured create draft, then refreshes summaries', async () => {
    let catalogItems: CentralCatalogItemSummary[] = [...summaries];
    let postedBody: Record<string, unknown> | undefined;
    let listReads = 0;
    const created = {
      id: 'reviewja',
      kind: 'materia' as const,
      name: 'Reviewja',
      description: 'Reviews a change.',
      version: '1',
      updatedAt: '2026-07-18T00:00:00.000Z',
      contentHash: `sha256:${'c'.repeat(64)}`,
      provenance: { source: 'admin-ui', author: 'operator', repositoryId: 'catalog-repo' },
    };
    const base = successfulRequester();
    const request = vi.fn(asRequester(async (path, init) => {
      if (path === '/api/catalog' && init?.method === 'POST') {
        postedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        catalogItems = [...catalogItems, created];
        return { ok: true, result: { action: 'created', summary: created } };
      }
      if (path === '/api/catalog') {
        listReads += 1;
        return { ok: true, items: catalogItems };
      }
      if (path === '/api/catalog/materia/reviewja') {
        return { ok: true, item: { ...created, content: { definition: { type: 'agent', prompt: 'Review this.' } } } };
      }
      return base(path, init);
    }));

    render(<CentralCatalogBrowser request={request as unknown as CentralAdminRequester} canWrite />);
    await screen.findByTestId('central-catalog-definition');
    fireEvent.click(screen.getByRole('button', { name: 'Create definition' }));

    const dialog = screen.getByRole('dialog', { name: 'Create catalog definition' });
    fireEvent.change(within(dialog).getByLabelText('Central id'), { target: { value: 'reviewja' } });
    fireEvent.change(within(dialog).getByLabelText('Display name'), { target: { value: 'Reviewja' } });
    fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: 'Reviews a change.' } });
    fireEvent.change(within(dialog).getByLabelText('Provenance source'), { target: { value: 'admin-ui' } });
    fireEvent.change(within(dialog).getByLabelText('Provenance author'), { target: { value: 'operator' } });
    fireEvent.change(within(dialog).getByLabelText('Provenance repository id'), { target: { value: 'catalog-repo' } });
    fireEvent.change(within(dialog).getByLabelText('Definition JSON'), { target: { value: '{bad json' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create definition' }));

    expect((await within(dialog).findByTestId('central-catalog-validation-error')).textContent).toContain('invalid');
    expect(request.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText('Definition JSON'), { target: { value: '{"type":"agent","prompt":"Review this."}' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create definition' }));

    expect((await screen.findByTestId('central-catalog-publish-success')).textContent).toContain('was created');
    expect(postedBody).toEqual({
      id: 'reviewja',
      kind: 'materia',
      name: 'Reviewja',
      description: 'Reviews a change.',
      content: { definition: { type: 'agent', prompt: 'Review this.' } },
      provenance: { source: 'admin-ui', author: 'operator', repositoryId: 'catalog-repo' },
    });
    await waitFor(() => expect(listReads).toBeGreaterThan(1));
  });

  it('sends expectedVersion on edit and preserves the draft when the server reports a 409', async () => {
    let patchPath = '';
    let patchBody: Record<string, unknown> | undefined;
    const base = successfulRequester();
    const request = asRequester(async (path, init) => {
      if (init?.method === 'PATCH') {
        patchPath = path;
        patchBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        throw new CentralAdminRequestError('unreachable', 'HTTP 409', 409, {
          error: 'version mismatch',
          code: 'version_mismatch',
          currentVersion: '5',
        });
      }
      return base(path, init);
    });

    render(<CentralCatalogBrowser request={request} canWrite />);
    await screen.findByTestId('central-catalog-definition');
    fireEvent.click(screen.getByRole('button', { name: 'Edit definition' }));

    const dialog = screen.getByRole('dialog', { name: 'Edit loadout definition' });
    const nameInput = within(dialog).getByLabelText('Display name') as HTMLInputElement;
    const definitionInput = within(dialog).getByLabelText('Definition JSON') as HTMLTextAreaElement;
    fireEvent.change(nameInput, { target: { value: 'My unresolved edit' } });
    fireEvent.change(definitionInput, { target: { value: '{"sockets":[{"id":"changed"}]}' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish update' }));

    const conflict = await within(dialog).findByTestId('central-catalog-conflict');
    expect(conflict.textContent).toContain('409 publishing conflict');
    expect(conflict.textContent).toContain('version 5');
    expect(nameInput.value).toBe('My unresolved edit');
    expect(definitionInput.value).toContain('changed');
    expect(patchPath).toBe('/api/catalog/loadout/full-auto?expectedVersion=4');
    expect(patchBody).toMatchObject({ name: 'My unresolved edit', content: { definition: { sockets: [{ id: 'changed' }] } } });
  });

  it('requires destructive confirmation, sends delete expectedVersion, and refreshes summaries', async () => {
    let deletePath = '';
    let listReads = 0;
    let catalogItems = [...summaries];
    const base = successfulRequester();
    const request = asRequester(async (path, init) => {
      if (init?.method === 'DELETE') {
        deletePath = path;
        catalogItems = catalogItems.filter((entry) => entry.id !== 'full-auto');
        return { ok: true, result: { action: 'deleted', summary: summaries[0] } };
      }
      if (path === '/api/catalog') {
        listReads += 1;
        return { ok: true, items: catalogItems };
      }
      return base(path, init);
    });

    render(<CentralCatalogBrowser request={request} canWrite />);
    await screen.findByTestId('central-catalog-definition');
    fireEvent.click(screen.getByRole('button', { name: 'Delete definition' }));

    const dialog = screen.getByRole('dialog', { name: 'Delete loadout full-auto' });
    expect(deletePath).toBe('');
    expect(dialog.textContent).toContain('cannot be undone');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm delete full-auto' }));

    expect((await screen.findByTestId('central-catalog-publish-success')).textContent).toContain('was deleted');
    expect(deletePath).toBe('/api/catalog/loadout/full-auto?expectedVersion=4');
    await waitFor(() => expect(listReads).toBeGreaterThan(1));
  });
});
