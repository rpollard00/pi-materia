import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CentralCatalogBrowser } from './CentralCatalogBrowser.js';
import { CentralAdminRequestError, type CentralAdminApiPath, type CentralAdminRequester } from './api.js';

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
});
