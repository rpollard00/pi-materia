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
