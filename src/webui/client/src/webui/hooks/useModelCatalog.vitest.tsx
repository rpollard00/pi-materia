import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MateriaTabId } from '../types.js';
import { useModelCatalog } from './useModelCatalog.js';

function CatalogProbe({ selectedTab }: { selectedTab: MateriaTabId }) {
  const { modelCatalog, modelCatalogError, modelCatalogStatus } = useModelCatalog(selectedTab);
  return (
    <output aria-label="catalog-state">
      {JSON.stringify({ status: modelCatalogStatus, error: modelCatalogError, values: modelCatalog.models.map((model) => model.value) })}
    </output>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useModelCatalog', () => {
  it('defers loading until the materia editor tab is selected', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<CatalogProbe selectedTab="loadout" />);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText('catalog-state').textContent).toContain('"status":"idle"');
  });

  it('loads and normalizes the model catalog once when the editor opens', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      models: [
        { value: 'openai/gpt-test', label: 'GPT Test', supportedThinkingLevels: ['low', '', 'high'] },
        { value: 'openai/gpt-test', label: 'Duplicate' },
        { label: 'missing value' },
      ],
    })));
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<CatalogProbe selectedTab="materia-editor" />);

    await waitFor(() => expect(screen.getByLabelText('catalog-state').textContent).toContain('"status":"ready"'));
    expect(screen.getByLabelText('catalog-state').textContent).toContain('openai/gpt-test');

    rerender(<CatalogProbe selectedTab="monitor" />);
    rerender(<CatalogProbe selectedTab="materia-editor" />);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/models');
  });

  it('surfaces request failures without throwing from the component tree', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));

    render(<CatalogProbe selectedTab="materia-editor" />);

    await waitFor(() => expect(screen.getByLabelText('catalog-state').textContent).toContain('"status":"error"'));
    expect(screen.getByLabelText('catalog-state').textContent).toContain('HTTP 503');
  });
});
