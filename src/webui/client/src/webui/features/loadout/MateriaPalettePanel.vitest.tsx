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

    fireEvent.click(getByTestId('palette-sort-trigger'));
    fireEvent.click(getByTestId('palette-sort-option-type'));
    expect(rowOrder(container)).toEqual(['Audit', 'Build', 'detectVcs', 'ensureGit']);

    fireEvent.click(getByTestId('palette-sort-direction'));
    expect(rowOrder(container)).toEqual(['ensureGit', 'detectVcs', 'Build', 'Audit']);
  });

  it('sorts by group with ungrouped last while ascending and reversed while descending', () => {
    const { container, getByTestId } = renderPanel();

    fireEvent.click(getByTestId('palette-sort-trigger'));
    fireEvent.click(getByTestId('palette-sort-option-group'));
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

  it('keeps a stable scroll container around the palette regardless of filter results', () => {
    // The scrollable list container is always present, even before filtering,
    // so its height stays stable as the filtered result count changes.
    const { container, getByTestId, queryByTestId } = renderPanel();
    expect(getByTestId('palette-list')).toBeTruthy();

    // Filtering to a single result keeps the stable container in place.
    fireEvent.change(getByTestId('palette-filter-input'), { target: { value: 'git' } });
    const list = getByTestId('palette-list');
    expect(list.querySelector('[data-testid="palette-grid"]')).toBeTruthy();

    // Filtering to nothing still keeps the container; only its contents change.
    fireEvent.change(getByTestId('palette-filter-input'), { target: { value: 'zzznomatch' } });
    expect(queryByTestId('palette-grid')).toBeNull();
    expect(getByTestId('palette-list').querySelector('[data-testid="palette-no-results"]')).toBeTruthy();

    // Resetting the filter restores the grid inside the same container.
    fireEvent.click(getByTestId('palette-filter-clear'));
    expect(getByTestId('palette-list').querySelector('[data-testid="palette-grid"]')).toBeTruthy();
  });

  it('renders an empty state when there are no materia definitions', () => {
    const { getByTestId, queryByTestId } = renderPanel({ palette: [], materia: {} });
    expect(queryByTestId('palette-grid')).toBeNull();
    expect(getByTestId('palette-empty').textContent).toBe('No materia definitions available.');
  });

  it('renders the filter, sort, and direction controls in one toolbar container', () => {
    // All three controls share a single .palette-controls flex container so
    // the CSS can keep them aligned on one row at loadout page widths.
    const { container } = renderPanel();
    const toolbar = container.querySelector('.palette-controls');
    expect(toolbar).toBeTruthy();
    expect(toolbar?.querySelector('[data-testid="palette-filter-input"]')).toBeTruthy();
    expect(toolbar?.querySelector('[data-testid="palette-sort-trigger"]')).toBeTruthy();
    expect(toolbar?.querySelector('[data-testid="palette-sort-direction"]')).toBeTruthy();
  });

  it('exposes all sort fields from the compact sort menu and marks the active one', () => {
    // The native dropdown is gone; a compact icon trigger now opens a menu that
    // exposes every sort field and marks the selected one for sighted and AT users.
    const { container, getByTestId, queryByTestId } = renderPanel();

    // Menu is closed initially: no popover, trigger is collapsed.
    expect(queryByTestId('palette-sort-menu')).toBeNull();
    expect(getByTestId('palette-sort-trigger').getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(getByTestId('palette-sort-trigger'));
    const menu = getByTestId('palette-sort-menu');
    expect(menu.getAttribute('role')).toBe('menu');
    expect(getByTestId('palette-sort-trigger').getAttribute('aria-expanded')).toBe('true');

    // Every existing sort field is available as a menuitemradio.
    const options = Array.from(menu.querySelectorAll('[role="menuitemradio"]'));
    expect(options.map((option) => option.getAttribute('data-testid'))).toEqual([
      'palette-sort-option-name',
      'palette-sort-option-type',
      'palette-sort-option-group',
    ]);

    // Name is selected by default and is the only checked option.
    const checked = options.filter((option) => option.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0]?.getAttribute('data-testid')).toBe('palette-sort-option-name');
    expect(getByTestId('palette-sort-option-name').className).toContain('palette-sort-option-active');

    // Selecting another field updates sorting and the active indicator.
    fireEvent.click(getByTestId('palette-sort-option-type'));
    expect(rowOrder(container)).toEqual(['Audit', 'Build', 'detectVcs', 'ensureGit']);
    expect(queryByTestId('palette-sort-menu')).toBeNull();

    fireEvent.click(getByTestId('palette-sort-trigger'));
    expect(getByTestId('palette-sort-option-type').getAttribute('aria-checked')).toBe('true');
    expect(getByTestId('palette-sort-option-name').getAttribute('aria-checked')).toBe('false');
  });
});
