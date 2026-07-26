import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MateriaSelectorItem } from './materiaEditPolicy.js';
import { MateriaSelectorSidebar, type MateriaSelectorSidebarProps } from './MateriaSelectorSidebar.js';

const items: MateriaSelectorItem[] = [
  {
    id: 'Build',
    label: 'Build',
    group: 'core',
    type: 'agent',
    description: 'Built-in builder',
    color: 'materia-color-green',
    source: 'default',
    isBuiltIn: true,
    isOverriddenBuiltIn: false,
    lockState: 'unlocked',
    saveScope: 'user',
    canSave: true,
    saveBlockedReason: null,
    canDelete: false,
    deleteTitle: 'Built-in materia cannot be deleted.',
    canToggleLock: false,
    lockTitle: 'Built-in materia cannot be locked. Save an override first.',
  },
  {
    id: 'Review',
    label: 'Review label',
    group: 'qa',
    type: 'agent',
    description: 'Project reviewer',
    color: 'materia-color-purple',
    source: 'project',
    isBuiltIn: true,
    isOverriddenBuiltIn: true,
    lockState: 'locked',
    saveScope: 'project',
    canSave: false,
    saveBlockedReason: 'Materia definition Review is locked. Unlock it before saving changes.',
    canDelete: true,
    deleteTitle: 'Delete Review from project scope',
    canToggleLock: true,
    lockTitle: 'Unlock Review',
  },
  {
    id: 'Shell',
    label: '',
    group: 'Utility',
    type: 'utility',
    description: 'Run a shell command',
    color: 'materia-color-cyan',
    source: 'user',
    isBuiltIn: false,
    isOverriddenBuiltIn: false,
    lockState: 'unlocked',
    saveScope: 'user',
    canSave: true,
    saveBlockedReason: null,
    canDelete: true,
    deleteTitle: 'Delete Shell from user scope',
    canToggleLock: true,
    lockTitle: 'Lock Shell',
  },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MateriaSelectorSidebar', () => {
  it('renders concise group, origin status, and locked badges with accessible row actions', () => {
    const onSelect = vi.fn();
    render(
      <MateriaSelectorSidebar
        items={items}
        selectedId="Review"
        onSelect={onSelect}
        onNew={vi.fn()}
        onDuplicate={vi.fn()}
        onToggleLock={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const selector = screen.getByRole('complementary', { name: 'Materia selector' });
    const rowSelects = Array.from(selector.querySelectorAll<HTMLButtonElement>('.materia-selector-row-select'));
    const rowFor = (id: string) => {
      const row = rowSelects.find((button) => button.dataset.materiaId === id);
      if (!row) throw new Error(`Missing selector row ${id}`);
      return row;
    };
    const buildRow = rowFor('Build');
    const reviewRow = rowFor('Review');
    const shellRow = rowFor('Shell');

    expect(within(selector).getByRole('button', { name: 'New' })).toBeTruthy();
    expect(within(buildRow).getByText('Built-in').getAttribute('title')).toBe('Built-in materia');
    expect(within(reviewRow).getByText('Customized').getAttribute('title')).toBe('Project override of built-in materia');
    expect(within(shellRow).getByText('Custom').getAttribute('title')).toBe('User materia');
    expect(within(reviewRow).getByText('Locked')).toBeTruthy();
    expect(within(reviewRow).queryByText('Project')).toBeNull();
    expect(within(reviewRow).queryByText('Override')).toBeNull();
    expect(within(selector).queryByText('Agent')).toBeNull();
    expect(within(selector).queryByText('agent')).toBeNull();
    expect(selector.querySelector('.materia-selector-badge-type')).toBeNull();
    expect(within(shellRow).getAllByText('Utility')).toHaveLength(1);
    expect(screen.queryByTestId('edit-materia-select')).toBeNull();
    expect(selector.querySelector('.materia-selector-row-id')).toBeNull();
    expect(selector.querySelectorAll('.materia-selector-row-orb .materia-orb-small')).toHaveLength(items.length);
    expect(reviewRow.querySelector('.materia-color-purple')?.getAttribute('title')).toBe('Review label materia color');
    expect(within(reviewRow).getByText('Review label')).toBeTruthy();
    expect(within(reviewRow).queryByText('Review')).toBeNull();
    expect(within(shellRow).getByText('Shell')).toBeTruthy();

    expect(reviewRow.getAttribute('title')).toBe('Review — Project override of built-in materia');
    expect(reviewRow.getAttribute('aria-current')).toBe('true');
    fireEvent.click(reviewRow);
    expect(onSelect).toHaveBeenCalledWith('Review');

    const builtInLock = within(selector).getByRole('button', { name: 'Built-in materia cannot be locked. Save an override first.' });
    expect(builtInLock.getAttribute('aria-disabled')).toBe('true');
  });

  it('opens an actions menu, respects disabled titles, and closes on Escape and outside click', () => {
    const onDuplicate = vi.fn();
    const onToggleLock = vi.fn();
    const onDelete = vi.fn();
    render(
      <MateriaSelectorSidebar
        items={items}
        selectedId="Build"
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onDuplicate={onDuplicate}
        onToggleLock={onToggleLock}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Build' }));
    let menu = screen.getByRole('menu', { name: 'Actions for Build' });
    expect(within(menu).getByRole('menuitem', { name: 'Duplicate' }).getAttribute('title')).toBe('Duplicate Build');
    expect(within(menu).getByRole('menuitem', { name: 'Lock' })).toHaveProperty('disabled', true);
    expect(within(menu).getByRole('menuitem', { name: 'Lock' }).getAttribute('title')).toContain('Built-in materia cannot be locked');
    expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toHaveProperty('disabled', true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Actions for Build' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Review' }));
    menu = screen.getByRole('menu', { name: 'Actions for Review' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Unlock' }));
    expect(onToggleLock).toHaveBeenCalledWith('Review', 'unlocked');
    expect(screen.queryByRole('menu', { name: 'Actions for Review' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Review' }));
    expect(screen.getByRole('menu', { name: 'Actions for Review' })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu', { name: 'Actions for Review' })).toBeNull();
  });
});

// A richer dataset where Name/Type/Group ascending each produce a distinct row
// order, so the shared palette controls can be exercised deterministically.
const catalogItems: MateriaSelectorItem[] = [
  {
    id: 'Build',
    label: 'Build',
    group: 'Alpha',
    type: 'agent',
    description: 'Builds the work',
    color: 'materia-color-green',
    source: 'default',
    isBuiltIn: true,
    isOverriddenBuiltIn: false,
    lockState: 'unlocked',
    saveScope: 'user',
    canSave: true,
    saveBlockedReason: null,
    canDelete: false,
    deleteTitle: 'Built-in materia cannot be deleted.',
    canToggleLock: false,
    lockTitle: 'Built-in materia cannot be locked. Save an override first.',
  },
  {
    id: 'Audit',
    label: 'Audit',
    group: 'Zeta',
    type: 'agent',
    description: 'Audits the work',
    color: 'materia-color-amber',
    source: 'default',
    isBuiltIn: true,
    isOverriddenBuiltIn: false,
    lockState: 'unlocked',
    saveScope: 'user',
    canSave: true,
    saveBlockedReason: null,
    canDelete: false,
    deleteTitle: 'Built-in materia cannot be deleted.',
    canToggleLock: false,
    lockTitle: 'Built-in materia cannot be locked. Save an override first.',
  },
  {
    id: 'detectVcs',
    label: 'Auto Detect',
    group: 'Utility',
    type: 'utility',
    description: 'Detects the vcs provider',
    color: 'materia-color-cyan',
    source: 'user',
    isBuiltIn: false,
    isOverriddenBuiltIn: false,
    lockState: 'unlocked',
    saveScope: 'user',
    canSave: true,
    saveBlockedReason: null,
    canDelete: true,
    deleteTitle: 'Delete detectVcs from user scope',
    canToggleLock: true,
    lockTitle: 'Lock detectVcs',
  },
  {
    id: 'ensureGit',
    label: 'Ensure Git',
    group: '',
    type: 'utility',
    description: 'Ensures git is configured',
    color: 'materia-color-purple',
    source: 'user',
    isBuiltIn: false,
    isOverriddenBuiltIn: false,
    lockState: 'locked',
    saveScope: 'user',
    canSave: false,
    saveBlockedReason: 'Materia definition ensureGit is locked. Unlock it before saving changes.',
    canDelete: true,
    deleteTitle: 'Delete ensureGit from user scope',
    canToggleLock: true,
    lockTitle: 'Unlock ensureGit',
  },
];

interface RenderSidebarOptions {
  items?: MateriaSelectorItem[];
  selectedId?: string;
  onSelect?: MateriaSelectorSidebarProps['onSelect'];
  onNew?: MateriaSelectorSidebarProps['onNew'];
  onDuplicate?: MateriaSelectorSidebarProps['onDuplicate'];
  onToggleLock?: MateriaSelectorSidebarProps['onToggleLock'];
  onDelete?: MateriaSelectorSidebarProps['onDelete'];
}

function renderSidebar(overrides: RenderSidebarOptions = {}) {
  const props: MateriaSelectorSidebarProps = {
    items: overrides.items ?? catalogItems,
    selectedId: overrides.selectedId,
    onSelect: overrides.onSelect ?? vi.fn(),
    onNew: overrides.onNew ?? vi.fn(),
    onDuplicate: overrides.onDuplicate ?? vi.fn(),
    onToggleLock: overrides.onToggleLock ?? vi.fn(),
    onDelete: overrides.onDelete ?? vi.fn(),
  };
  return { props, ...render(<MateriaSelectorSidebar {...props} />) };
}

function rowOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('.materia-selector-row-select'))
    .map((button) => button.dataset.materiaId ?? '');
}

describe('MateriaSelectorSidebar palette-style filtering and sorting', () => {
  it('renders the shared search, sort, and direction controls with a catalog test-id prefix', () => {
    const { container } = renderSidebar();
    const toolbar = container.querySelector('.palette-controls');
    expect(toolbar).toBeTruthy();
    expect(toolbar?.querySelector('[data-testid="catalog-filter-input"]')).toBeTruthy();
    expect(toolbar?.querySelector('[data-testid="catalog-sort-trigger"]')).toBeTruthy();
    expect(toolbar?.querySelector('[data-testid="catalog-sort-direction"]')).toBeTruthy();
  });

  it('defaults to Name ascending order', () => {
    const { container } = renderSidebar();
    expect(rowOrder(container)).toEqual(['Audit', 'detectVcs', 'Build', 'ensureGit']);
  });

  it('filters visible rows by searchable text, clears to nothing, and restores via clear', () => {
    const { container, getByTestId, queryByTestId } = renderSidebar();

    fireEvent.change(getByTestId('catalog-filter-input'), { target: { value: 'utility' } });
    expect(rowOrder(container)).toEqual(['detectVcs', 'ensureGit']);

    // A non-matching query yields no rows without disturbing the list container.
    fireEvent.change(getByTestId('catalog-filter-input'), { target: { value: 'zzznomatch' } });
    expect(rowOrder(container)).toEqual([]);
    expect(container.querySelector('.materia-selector-list')).toBeTruthy();

    // The clear button is only rendered while there is a query.
    expect(getByTestId('catalog-filter-clear')).toBeTruthy();
    fireEvent.click(getByTestId('catalog-filter-clear'));
    expect(queryByTestId('catalog-filter-clear')).toBeNull();
    expect(rowOrder(container)).toEqual(['Audit', 'detectVcs', 'Build', 'ensureGit']);
  });

  it('switches between every sort mode through the compact sort menu', () => {
    const { container, getByTestId } = renderSidebar();
    // Name asc is the default.
    expect(rowOrder(container)).toEqual(['Audit', 'detectVcs', 'Build', 'ensureGit']);

    fireEvent.click(getByTestId('catalog-sort-trigger'));
    fireEvent.click(getByTestId('catalog-sort-option-type'));
    expect(rowOrder(container)).toEqual(['Audit', 'Build', 'detectVcs', 'ensureGit']);

    fireEvent.click(getByTestId('catalog-sort-trigger'));
    fireEvent.click(getByTestId('catalog-sort-option-group'));
    // Named groups first (Alpha/Utility/Zeta) with the ungrouped row last.
    expect(rowOrder(container)).toEqual(['Build', 'detectVcs', 'Audit', 'ensureGit']);

    // Switching back to Name restores name ordering.
    fireEvent.click(getByTestId('catalog-sort-trigger'));
    fireEvent.click(getByTestId('catalog-sort-option-name'));
    expect(rowOrder(container)).toEqual(['Audit', 'detectVcs', 'Build', 'ensureGit']);
  });

  it('marks the active sort field in the compact sort menu', () => {
    const { getByTestId } = renderSidebar();
    fireEvent.click(getByTestId('catalog-sort-trigger'));
    expect(getByTestId('catalog-sort-option-name').getAttribute('aria-checked')).toBe('true');
    expect(getByTestId('catalog-sort-option-type').getAttribute('aria-checked')).toBe('false');

    fireEvent.click(getByTestId('catalog-sort-option-type'));
    fireEvent.click(getByTestId('catalog-sort-trigger'));
    expect(getByTestId('catalog-sort-option-type').getAttribute('aria-checked')).toBe('true');
    expect(getByTestId('catalog-sort-option-name').getAttribute('aria-checked')).toBe('false');
  });

  it('toggles sort direction and reverses the row order', () => {
    const { container, getByTestId } = renderSidebar();
    expect(getByTestId('catalog-sort-direction').getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(getByTestId('catalog-sort-direction'));
    expect(getByTestId('catalog-sort-direction').getAttribute('aria-pressed')).toBe('true');
    expect(rowOrder(container)).toEqual(['ensureGit', 'Build', 'detectVcs', 'Audit']);
  });

  it('keeps the active editor selection highlighted after rows are reordered', () => {
    const { container, getByTestId } = renderSidebar({ selectedId: 'Build' });
    // Type asc reorders rows so Build lands at index 1; it stays highlighted.
    fireEvent.click(getByTestId('catalog-sort-trigger'));
    fireEvent.click(getByTestId('catalog-sort-option-type'));
    expect(rowOrder(container)).toEqual(['Audit', 'Build', 'detectVcs', 'ensureGit']);

    const rows = Array.from(container.querySelectorAll('.materia-selector-row'));
    expect(rows[1].className).toContain('materia-selector-row-active');
    expect(rows[0].className).not.toContain('materia-selector-row-active');
    expect(rows[2].className).not.toContain('materia-selector-row-active');
  });

  it('routes select, duplicate, lock, and delete to the original materia id after rows are reordered', () => {
    const onSelect = vi.fn();
    const onDuplicate = vi.fn();
    const onToggleLock = vi.fn();
    const onDelete = vi.fn();
    const { container, getByTestId, getByRole } = renderSidebar({
      onSelect,
      onDuplicate,
      onToggleLock,
      onDelete,
    });

    // Reorder away from source order (Build, Audit, detectVcs, ensureGit).
    fireEvent.click(getByTestId('catalog-sort-trigger'));
    fireEvent.click(getByTestId('catalog-sort-option-type'));
    expect(rowOrder(container)).toEqual(['Audit', 'Build', 'detectVcs', 'ensureGit']);

    // Selecting a reordered row routes its original id.
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-materia-id="Build"]')!);
    expect(onSelect).toHaveBeenCalledWith('Build');

    // Duplicating a reordered row via its actions menu routes its original id.
    fireEvent.click(getByRole('button', { name: 'Actions for detectVcs' }));
    fireEvent.click(getByRole('menuitem', { name: 'Duplicate' }));
    expect(onDuplicate).toHaveBeenCalledWith('detectVcs');

    // Toggling lock via the row lock indicator routes its original id and next lock state.
    fireEvent.click(getByRole('button', { name: 'Lock detectVcs' }));
    expect(onToggleLock).toHaveBeenCalledWith('detectVcs', 'locked');

    // Deleting a reordered row via its actions menu routes its original id.
    fireEvent.click(getByRole('button', { name: 'Actions for ensureGit' }));
    fireEvent.click(getByRole('menuitem', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledWith('ensureGit');
  });
});

describe('MateriaSelectorSidebar stable filter states and sidebar styling', () => {
  it('renders the toolbar as a control region with accessible labels above the scrollable list', () => {
    const { container } = renderSidebar();
    const sidebar = screen.getByRole('complementary', { name: 'Materia selector' });
    const toolbar = container.querySelector('.palette-controls');
    expect(toolbar instanceof Element).toBe(true);
    expect(sidebar.contains(toolbar as Element)).toBe(true);

    // Every compact control exposes an accessible name.
    const search = within(toolbar as HTMLElement).getByTestId('catalog-filter-input');
    expect(search.getAttribute('aria-label')).toBe('Filter materia');
    const direction = within(toolbar as HTMLElement).getByTestId('catalog-sort-direction');
    expect(direction.getAttribute('aria-label')).toBe('Sort descending');
    const sortTrigger = within(toolbar as HTMLElement).getByTestId('catalog-sort-trigger');
    expect((sortTrigger.getAttribute('aria-label') ?? '').trim()).not.toBe('');

    // The scrollable materia list is a distinct sibling beneath the toolbar.
    const list = container.querySelector('[data-testid="catalog-list"]');
    expect(list instanceof Element).toBe(true);
    expect((list as Element).isSameNode(toolbar)).toBe(false);
  });

  it('shows the empty-catalog message when no definitions exist and never the no-results message', () => {
    const { getByTestId, queryByTestId } = renderSidebar({ items: [] });
    expect(getByTestId('catalog-empty').textContent).toBe('No reusable materia definitions are available.');
    expect(queryByTestId('catalog-no-results')).toBeNull();
    // The stable list container still hosts the empty state in place.
    expect(getByTestId('catalog-list')).toBeTruthy();
  });

  it('shows a distinct accessible no-results state when a non-empty catalog is filtered to nothing', () => {
    const { getByTestId, queryByTestId } = renderSidebar();
    // A non-empty catalog with no query renders rows, not an empty/no-results state.
    expect(queryByTestId('catalog-empty')).toBeNull();
    expect(queryByTestId('catalog-no-results')).toBeNull();

    fireEvent.change(getByTestId('catalog-filter-input'), { target: { value: 'zzznomatch' } });
    expect(getByTestId('catalog-no-results').textContent).toBe('No matching materia.');
    expect(queryByTestId('catalog-empty')).toBeNull();
  });

  it('keeps the same list container node across filter changes and restores rows on clear', () => {
    const { container, getByTestId } = renderSidebar();
    const listBefore = container.querySelector('[data-testid="catalog-list"]');
    expect(listBefore?.querySelectorAll('.materia-selector-row-select')).toHaveLength(catalogItems.length);
    expect(listBefore?.querySelector('[data-testid="catalog-no-results"]')).toBeNull();

    // Filtering to nothing swaps the children but preserves the container node.
    fireEvent.change(getByTestId('catalog-filter-input'), { target: { value: 'zzznomatch' } });
    const listFiltered = container.querySelector('[data-testid="catalog-list"]');
    expect(listFiltered?.isSameNode(listBefore)).toBe(true);
    expect(listFiltered?.querySelectorAll('.materia-selector-row-select')).toHaveLength(0);
    expect(listFiltered?.querySelector('[data-testid="catalog-no-results"]')).toBeTruthy();

    // Clearing the query restores the rows inside the same container node.
    fireEvent.click(getByTestId('catalog-filter-clear'));
    const listCleared = container.querySelector('[data-testid="catalog-list"]');
    expect(listCleared?.isSameNode(listBefore)).toBe(true);
    expect(listCleared?.querySelectorAll('.materia-selector-row-select')).toHaveLength(catalogItems.length);
    expect(listCleared?.querySelector('[data-testid="catalog-no-results"]')).toBeNull();
  });
});

// Catalog rows receive the provider/model label projected by
// buildMateriaSelectorItems as compact top-right chrome. These items mirror that
// projection (raw value for eligible agents, omitted for deterministic and
// model-less materia) so the sidebar rendering can be exercised in isolation.
const modelChromeItems: MateriaSelectorItem[] = [
  {
    id: 'Build',
    label: 'Build',
    group: 'Core',
    type: 'agent',
    description: 'Builds the work',
    color: 'materia-color-green',
    modelLabel: 'zai/glm-4.6',
    source: 'default',
    isBuiltIn: true,
    isOverriddenBuiltIn: false,
    lockState: 'unlocked',
    saveScope: 'user',
    canSave: true,
    saveBlockedReason: null,
    canDelete: false,
    deleteTitle: 'Built-in materia cannot be deleted.',
    canToggleLock: false,
    lockTitle: 'Built-in materia cannot be locked. Save an override first.',
  },
  {
    id: 'longModel',
    label: 'Long Model',
    group: 'Core',
    type: 'agent',
    description: 'Has a very long provider/model string',
    color: 'materia-color-amber',
    modelLabel: 'very-long-provider/extra-long-model-identifier-v2',
    source: 'user',
    isBuiltIn: false,
    isOverriddenBuiltIn: false,
    lockState: 'unlocked',
    saveScope: 'user',
    canSave: true,
    saveBlockedReason: null,
    canDelete: true,
    deleteTitle: 'Delete longModel from user scope',
    canToggleLock: true,
    lockTitle: 'Lock longModel',
  },
  {
    id: 'detectVcs',
    label: 'Detect VCS',
    group: 'Utility',
    type: 'utility',
    description: 'Deterministic utility materia',
    color: 'materia-color-cyan',
    // No modelLabel: deterministic materia are never labeled.
    source: 'user',
    isBuiltIn: false,
    isOverriddenBuiltIn: false,
    lockState: 'unlocked',
    saveScope: 'user',
    canSave: true,
    saveBlockedReason: null,
    canDelete: true,
    deleteTitle: 'Delete detectVcs from user scope',
    canToggleLock: true,
    lockTitle: 'Lock detectVcs',
  },
  {
    id: 'noModel',
    label: 'No Model',
    group: 'Core',
    type: 'agent',
    description: 'Agent without a selected model',
    color: 'materia-color-purple',
    // No modelLabel: agents without an explicit selection stay unlabeled.
    source: 'user',
    isBuiltIn: false,
    isOverriddenBuiltIn: false,
    lockState: 'unlocked',
    saveScope: 'user',
    canSave: true,
    saveBlockedReason: null,
    canDelete: true,
    deleteTitle: 'Delete noModel from user scope',
    canToggleLock: true,
    lockTitle: 'Lock noModel',
  },
];

describe('MateriaSelectorSidebar model chrome', () => {
  it('renders the raw provider/model value as top-right chrome with a full-value tooltip', () => {
    renderSidebar({ items: modelChromeItems });

    const buildChrome = screen.getByTestId('catalog-model-Build');
    expect(buildChrome.className).toContain('materia-selector-model-chrome');
    expect(buildChrome.textContent).toBe('zai/glm-4.6');
    expect(buildChrome.getAttribute('title')).toBe('zai/glm-4.6');
    expect(buildChrome.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the full configured value available via tooltip even for long labels', () => {
    // jsdom cannot lay out the ellipsis, so the chrome retains the full string
    // as its text and exposes the untruncated value through its title tooltip.
    renderSidebar({ items: modelChromeItems });
    const longChrome = screen.getByTestId('catalog-model-longModel');
    const value = 'very-long-provider/extra-long-model-identifier-v2';
    expect(longChrome.textContent).toBe(value);
    expect(longChrome.getAttribute('title')).toBe(value);
  });

  it('suppresses the chrome for deterministic utility materia', () => {
    renderSidebar({ items: modelChromeItems });
    expect(screen.queryByTestId('catalog-model-detectVcs')).toBeNull();
  });

  it('suppresses the chrome for agent materia without a selected model', () => {
    renderSidebar({ items: modelChromeItems });
    expect(screen.queryByTestId('catalog-model-noModel')).toBeNull();
  });

  it('renders exactly one chrome per eligible row and none for ineligible rows', () => {
    const { container } = renderSidebar({ items: modelChromeItems });
    const chromes = container.querySelectorAll('.materia-selector-model-chrome');
    expect(chromes).toHaveLength(2);
    expect(screen.getByTestId('catalog-model-Build')).toBeTruthy();
    expect(screen.getByTestId('catalog-model-longModel')).toBeTruthy();
  });

  it('keeps the chrome out of the lock and actions controls so they stay accessible', () => {
    const onToggleLock = vi.fn();
    renderSidebar({ items: modelChromeItems, onToggleLock });

    // The lock indicator and actions trigger remain interactive despite the
    // adjacent top-right chrome region (the chrome is pointer-events: none).
    fireEvent.click(screen.getByRole('button', { name: 'Lock longModel' }));
    expect(onToggleLock).toHaveBeenCalledWith('longModel', 'locked');

    fireEvent.click(screen.getByRole('button', { name: 'Actions for longModel' }));
    expect(screen.getByRole('menu', { name: 'Actions for longModel' })).toBeTruthy();

    // The built-in Build lock stays aria-disabled even with chrome present.
    expect(screen.getByRole('button', { name: 'Built-in materia cannot be locked. Save an override first.' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('does not interfere with selecting a row that shows a model label', () => {
    const onSelect = vi.fn();
    const { container } = renderSidebar({ items: modelChromeItems, onSelect });

    const buildRowButton = Array.from(container.querySelectorAll<HTMLButtonElement>('.materia-selector-row-select'))
      .find((button) => button.dataset.materiaId === 'Build');
    if (!buildRowButton) throw new Error('Missing Build selector row');
    fireEvent.click(buildRowButton);
    expect(onSelect).toHaveBeenCalledWith('Build');
  });
});
