import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MateriaSelectorItem } from './materiaEditPolicy.js';
import { MateriaSelectorSidebar } from './MateriaSelectorSidebar.js';

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
    expect(within(selector).getByRole('button', { name: 'New' })).toBeTruthy();
    expect(within(selector).getByText('Built-in')).toBeTruthy();
    expect(within(selector).getByText('Customized').getAttribute('title')).toBe('Project override of built-in materia');
    expect(within(selector).getByText('Custom').getAttribute('title')).toBe('User materia');
    expect(within(selector).getByText('Locked')).toBeTruthy();
    expect(within(selector).queryByText('Project')).toBeNull();
    expect(within(selector).queryByText('Override')).toBeNull();
    expect(within(selector).queryByText('agent')).toBeNull();
    expect(within(selector).getAllByText('Utility')).toHaveLength(1);
    expect(screen.queryByTestId('edit-materia-select')).toBeNull();
    expect(selector.querySelector('.materia-selector-row-id')).toBeNull();
    expect(selector.querySelectorAll('.materia-selector-row-orb .materia-orb-small')).toHaveLength(items.length);
    expect(selector.querySelector('.materia-color-purple')?.getAttribute('title')).toBe('Review label materia color');
    expect(within(selector).getByText('Review label')).toBeTruthy();
    expect(within(selector).queryByText('Review')).toBeNull();
    expect(within(selector).getByText('Shell')).toBeTruthy();

    const reviewRow = within(selector).getByTitle('Review — Project override of built-in materia');
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
