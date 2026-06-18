import { createRequire } from 'node:module';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MateriaBehaviorConfig, PipelineSocket } from '../../../loadoutModel.js';
import { MateriaPalettePanel } from './MateriaPalettePanel.js';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string) => { window: Window & typeof globalThis } };
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window as never;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;

type Materia = Record<string, MateriaBehaviorConfig>;

const materia: Materia = {
  Build: { prompt: 'build', group: 'Core', description: 'Builds the work items' },
  Audit: { prompt: 'audit', group: 'Core', description: 'Audits the work' },
  detectVcs: { type: 'utility', utility: 'vcs.detect', label: 'Detect VCS', group: 'Utility', description: 'Detects the vcs provider', parse: 'json', assign: { vcs: '$' } },
  ensureGit: { type: 'utility', utility: 'vcs.ensureGit', label: 'Ensure Git', description: 'Ensures git is configured' },
};

function buildPalette(definitions: Materia): Array<[string, PipelineSocket]> {
  return Object.keys(definitions).map((id) => [id, { materia: id }] as [string, PipelineSocket]);
}

function renderPanel(overrides: Partial<Parameters<typeof MateriaPalettePanel>[0]> = {}) {
  const palette = buildPalette(materia);
  const props: Parameters<typeof MateriaPalettePanel>[0] = {
    palette,
    materia,
    selectedMateriaId: undefined,
    onDragMateria: () => undefined,
    onSelectMateria: () => undefined,
    ...overrides,
  };
  return { props, ...render(<MateriaPalettePanel {...props} />) };
}

function rowOrder(container: HTMLElement): string[] {
  const grid = container.querySelector('[data-testid="palette-grid"]');
  if (!grid) return [];
  return Array.from(grid.querySelectorAll<HTMLButtonElement>('[data-testid^="palette-"]'))
    .map((button) => button.dataset.testid?.replace('palette-', '') ?? '');
}

afterEach(() => {
  cleanup();
});

describe('MateriaPalettePanel filtering and sorting', () => {
  it('defaults to name ascending order', () => {
    const { container } = renderPanel();
    expect(rowOrder(container)).toEqual(['Audit', 'Build', 'detectVcs', 'ensureGit']);
  });

  it('sorts agents before utilities by type ascending and flips on descending', () => {
    const { container, getByTestId } = renderPanel();

    fireEvent.change(getByTestId('palette-sort-select'), { target: { value: 'type' } });
    expect(rowOrder(container)).toEqual(['Audit', 'Build', 'detectVcs', 'ensureGit']);

    fireEvent.click(getByTestId('palette-sort-direction'));
    expect(rowOrder(container)).toEqual(['ensureGit', 'detectVcs', 'Build', 'Audit']);
  });

  it('sorts by group with ungrouped last while ascending and reversed while descending', () => {
    const { container, getByTestId } = renderPanel();

    fireEvent.change(getByTestId('palette-sort-select'), { target: { value: 'group' } });
    expect(rowOrder(container)).toEqual(['Audit', 'Build', 'detectVcs', 'ensureGit']);

    fireEvent.click(getByTestId('palette-sort-direction'));
    expect(rowOrder(container)).toEqual(['ensureGit', 'detectVcs', 'Build', 'Audit']);
  });

  it('filters by group, type, and free text and restores via clear', () => {
    const { container, getByTestId, queryByTestId } = renderPanel();

    fireEvent.change(getByTestId('palette-filter-input'), { target: { value: 'core' } });
    expect(rowOrder(container)).toEqual(['Audit', 'Build']);
    expect(queryByTestId('palette-no-results')).toBeNull();

    fireEvent.change(getByTestId('palette-filter-input'), { target: { value: 'utility' } });
    expect(rowOrder(container)).toEqual(['detectVcs', 'ensureGit']);

    fireEvent.change(getByTestId('palette-filter-input'), { target: { value: 'git' } });
    expect(rowOrder(container)).toEqual(['ensureGit']);

    fireEvent.click(getByTestId('palette-filter-clear'));
    expect(rowOrder(container)).toEqual(['Audit', 'Build', 'detectVcs', 'ensureGit']);
  });

  it('shows a no-results state when nothing matches', () => {
    const { container, getByTestId, queryByTestId } = renderPanel();
    fireEvent.change(getByTestId('palette-filter-input'), { target: { value: 'zzznomatch' } });
    expect(queryByTestId('palette-grid')).toBeNull();
    expect(getByTestId('palette-no-results')).toBeTruthy();
    expect(container.querySelector('[data-testid="palette-no-results"]')?.textContent).toBe('No matching materia.');
  });

  it('preserves selection and drag handlers after filtering', () => {
    const onSelectMateria = vi.fn();
    const { getByTestId } = renderPanel({ onSelectMateria, selectedMateriaId: 'Build' });

    fireEvent.change(getByTestId('palette-filter-input'), { target: { value: 'core' } });
    const buildOrb = getByTestId('palette-Build');
    expect(buildOrb.className).toContain('palette-orb-selected');

    // Clicking a different (unselected) orb after filtering still routes through onSelectMateria.
    fireEvent.click(getByTestId('palette-Audit'));
    expect(onSelectMateria).toHaveBeenCalledWith('Audit');
  });

  it('renders an empty state when there are no materia definitions', () => {
    const { getByTestId, queryByTestId } = renderPanel({ palette: [], materia: {} });
    expect(queryByTestId('palette-grid')).toBeNull();
    expect(getByTestId('palette-empty').textContent).toBe('No materia definitions available.');
  });
});
