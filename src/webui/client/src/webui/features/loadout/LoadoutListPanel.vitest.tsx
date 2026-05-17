import { readFileSync } from 'node:fs';
import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipelineConfig } from '../../../loadoutModel.js';
import { buildLoadoutSelectorViewModels, LoadoutListPanel } from './LoadoutListPanel.js';

const loadouts = {
  Alpha: { id: 'Alpha', entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Build' } } },
  Beta: { id: 'Beta', entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Test' } } },
  Gamma: { id: 'Gamma', entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Review' } } },
} satisfies Record<string, PipelineConfig>;

function renderPanel(overrides: Partial<ComponentProps<typeof LoadoutListPanel>> = {}) {
  const props: ComponentProps<typeof LoadoutListPanel> = {
    loadouts,
    editingLoadoutName: 'Alpha',
    runtimeActiveLoadoutId: 'Alpha',
    defaultLoadoutId: 'Beta',
    persistedLoadouts: loadouts,
    loadoutSources: { Alpha: 'user', Beta: 'user', Gamma: 'user' },
    canDeleteLoadout: () => true,
    onCreateLoadout: vi.fn(),
    onSwitchEditingLoadout: vi.fn(),
    onDeleteLoadout: vi.fn(),
    onDuplicateLoadout: vi.fn(),
    onSetDefaultLoadout: vi.fn(async (name: string) => name),
    onSetRuntimeActiveLoadout: vi.fn(async (name: string) => name),
    getLoadoutLockEligibility: vi.fn(() => ({ eligible: true, reason: null })),
    onToggleLoadoutLock: vi.fn(() => true),
    ...overrides,
  };
  render(<LoadoutListPanel {...props} />);
  return props;
}

function cardFor(name: string) {
  return screen.getByRole('button', { name: new RegExp(name) }).closest('.loadout-card') as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LoadoutListPanel', () => {
  it('renders a labelled star only for the validated default loadout without empty slots', () => {
    renderPanel({ defaultLoadoutId: 'Beta' });

    expect(within(cardFor('Beta')).getByLabelText('Default loadout').querySelector('svg')).toBeTruthy();
    expect(within(cardFor('Alpha')).queryByLabelText('Default loadout')).toBeNull();
    expect(within(cardFor('Gamma')).queryByLabelText('Default loadout')).toBeNull();
    expect(cardFor('Alpha').querySelector('.loadout-default-indicator')).toBeNull();
    expect(cardFor('Gamma').querySelector('.loadout-default-indicator')).toBeNull();
  });

  it('uses the available loadout set to validate the canonical default id', () => {
    renderPanel({
      defaultLoadoutId: 'Gamma',
      persistedLoadouts: { Alpha: loadouts.Alpha, Beta: loadouts.Beta },
    });

    expect(within(cardFor('Gamma')).getByLabelText('Default loadout').querySelector('svg')).toBeTruthy();
    expect(within(cardFor('Alpha')).queryByLabelText('Default loadout')).toBeNull();
    expect(within(cardFor('Beta')).queryByLabelText('Default loadout')).toBeNull();
  });

  it('keeps default status separate from Built-In provenance and lock state', () => {
    renderPanel({
      defaultLoadoutId: 'Beta',
      loadouts: {
        ...loadouts,
        Beta: { ...loadouts.Beta, source: 'user', lockState: 'locked' },
        Gamma: { ...loadouts.Gamma, source: 'default', lockState: 'unlocked' },
      },
      loadoutSources: { Alpha: 'user', Beta: 'user', Gamma: 'default' },
    });

    const betaCard = cardFor('Beta');
    expect(within(betaCard).getByText('Beta')).toBeTruthy();
    expect(within(betaCard).getByLabelText('Default loadout')).toBeTruthy();
    expect(within(betaCard).getByLabelText('Unlock edits')).toBeTruthy();
    expect(betaCard.textContent).not.toContain('user loadout');

    const gammaCard = cardFor('Gamma');
    expect(within(gammaCard).getByText('Gamma')).toBeTruthy();
    expect(within(gammaCard).queryByLabelText('Default loadout')).toBeNull();
    expect(within(gammaCard).getByLabelText('Built-In read-only')).toBeTruthy();
    expect(gammaCard.textContent).not.toContain('Built-In');
  });

  it('shows the default star for a Built-In read-only default loadout', () => {
    renderPanel({
      defaultLoadoutId: 'Gamma',
      loadouts: { ...loadouts, Gamma: { ...loadouts.Gamma, source: 'default', lockState: 'locked' } },
      loadoutSources: { Alpha: 'user', Beta: 'user', Gamma: 'default' },
    });

    const gammaCard = cardFor('Gamma');
    expect(within(gammaCard).getByText('Gamma')).toBeTruthy();
    expect(within(gammaCard).getByLabelText('Default loadout')).toBeTruthy();
    expect(within(gammaCard).getByLabelText('Built-In read-only')).toBeTruthy();
    expect(gammaCard.textContent).not.toContain('Built-In');
    expect(screen.queryByText(/Shipped default/i)).toBeNull();
  });

  it('does not render a stale star when the default preference points at a missing loadout', () => {
    renderPanel({ defaultLoadoutId: 'Missing' });

    expect(screen.queryByLabelText('Default loadout')).toBeNull();
  });

  it('matches the default star by stable loadout id instead of display name', () => {
    renderPanel({
      defaultLoadoutId: 'user:hojo',
      loadouts: {
        Hojo: { id: 'user:hojo', entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Review' } } },
      },
      persistedLoadouts: {
        Hojo: { id: 'user:hojo', entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Review' } } },
      },
      loadoutSources: { Hojo: 'user' },
    });

    expect(within(cardFor('Hojo')).getByLabelText('Default loadout').querySelector('svg')).toBeTruthy();
  });

  it('does not fall back to the display name for default star matching', () => {
    renderPanel({
      defaultLoadoutId: 'Hojo',
      loadouts: {
        Hojo: { id: 'user:hojo', entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Review' } } },
      },
      persistedLoadouts: {
        Hojo: { id: 'user:hojo', entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Review' } } },
      },
      loadoutSources: { Hojo: 'user' },
    });

    expect(within(cardFor('Hojo')).queryByLabelText('Default loadout')).toBeNull();
  });

  it('matches the active green dot by stable loadout id instead of display name', () => {
    renderPanel({
      runtimeActiveLoadoutId: 'user:hojo',
      defaultLoadoutId: null,
      loadouts: {
        Hojo: { id: 'user:hojo', entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Review' } } },
      },
      persistedLoadouts: {
        Hojo: { id: 'user:hojo', entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Review' } } },
      },
      loadoutSources: { Hojo: 'user' },
    });

    expect(within(cardFor('Hojo')).getByLabelText('Runtime active loadout')).toBeTruthy();
  });

  it('does not fall back to current activeLoadout display names for the active green dot', () => {
    renderPanel({
      runtimeActiveLoadoutId: undefined,
      defaultLoadoutId: null,
      loadouts: {
        Hojo: { id: 'user:hojo', entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Review' } } },
      },
      persistedLoadouts: {
        Hojo: { id: 'user:hojo', entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Review' } } },
      },
      loadoutSources: { Hojo: 'user' },
      activeLoadout: 'Hojo',
    } as Partial<ComponentProps<typeof LoadoutListPanel>> & { activeLoadout: string });

    expect(within(cardFor('Hojo')).queryByLabelText('Runtime active loadout')).toBeNull();
  });

  it('derives selector default and active state from normalized loadout records', () => {
    const rows = buildLoadoutSelectorViewModels({
      'Hojo Display': { id: 'user:hojo', entry: 'Socket-1', sockets: {} },
      Stale: { id: 'user:stale', entry: 'Socket-1', sockets: {} },
    }, 'user:hojo', 'user:hojo');

    expect(rows.map(({ name, isDefault, isRuntimeActive }) => [name, isDefault, isRuntimeActive])).toEqual([
      ['Hojo Display', true, true],
      ['Stale', false, false],
    ]);
    expect(buildLoadoutSelectorViewModels({ Hojo: { id: 'user:hojo', entry: 'Socket-1', sockets: {} } }, 'Hojo')[0]?.isDefault).toBe(false);
    expect(buildLoadoutSelectorViewModels({ Hojo: { id: 'user:hojo', entry: 'Socket-1', sockets: {} } }, 'missing')[0]?.isDefault).toBe(false);
    expect(buildLoadoutSelectorViewModels({ Hojo: { id: 'user:hojo', entry: 'Socket-1', sockets: {} } }, null, 'Hojo')[0]?.isRuntimeActive).toBe(false);
    expect(buildLoadoutSelectorViewModels({ Hojo: { id: 'user:hojo', entry: 'Socket-1', sockets: {} } }, null, 'missing')[0]?.isRuntimeActive).toBe(false);

    const staleRows = buildLoadoutSelectorViewModels({
      Hojo: { id: 'user:hojo', entry: 'Socket-1', sockets: {} },
    }, 'user:missing-default', 'user:missing-active');
    expect(staleRows[0]?.isDefault).toBe(false);
    expect(staleRows[0]?.isRuntimeActive).toBe(false);
  });

  it('switches the viewed loadout when the selectable row button is clicked', () => {
    const onSwitchEditingLoadout = vi.fn();
    renderPanel({ onSwitchEditingLoadout });

    fireEvent.click(within(cardFor('Gamma')).getByRole('button', { name: /Gamma/ }));

    expect(onSwitchEditingLoadout).toHaveBeenCalledOnce();
    expect(onSwitchEditingLoadout).toHaveBeenCalledWith('Gamma');
  });

  it('keeps vertical row hit-area ownership on real child controls instead of the non-interactive wrapper', () => {
    renderPanel();

    const betaCard = cardFor('Beta');
    const selectButton = within(betaCard).getByRole('button', { name: /Beta/ });
    expect(betaCard.tagName).toBe('DIV');
    expect(selectButton.classList.contains('loadout-card-select')).toBe(true);
    expect(selectButton.closest('.loadout-card')).toBe(betaCard);

    const css = readFileSync('src/webui/client/src/styles.css', 'utf8');
    expect(css).toMatch(/\.loadout-card\s*{(?=[^}]*display: flex;)(?=[^}]*align-items: stretch;)(?=[^}]*gap: 0\.25rem;)(?=[^}]*padding: 0;)\s*[^}]*}/s);
    expect(css).not.toMatch(/\.loadout-card\s*{[^}]*padding:\s*0\.[1-9][^;}]*rem\s+0\.[0-9][^;}]*rem;/s);
    expect(css).toMatch(/\.loadout-card-select\s*{(?=[^}]*display: flex;)(?=[^}]*flex: 1 1 auto;)(?=[^}]*align-self: stretch;)(?=[^}]*align-items: center;)(?=[^}]*padding: 0\.55rem 0\.45rem;)\s*[^}]*}/s);
    expect(css).toMatch(/[^{}]*\.loadout-lock-indicator[^{}]*{[^}]*align-self: stretch;[^}]*}/s);
    expect(css).toMatch(/[^{}]*\.loadout-actions-trigger[^{}]*{[^}]*align-self: stretch;[^}]*}/s);
  });

  it('does not switch the viewed loadout from lock, action trigger, or action menu controls', () => {
    const onSwitchEditingLoadout = vi.fn();
    const onToggleLoadoutLock = vi.fn(() => true);
    const onDuplicateLoadout = vi.fn();
    const onDeleteLoadout = vi.fn();
    renderPanel({ onSwitchEditingLoadout, onToggleLoadoutLock, onDuplicateLoadout, onDeleteLoadout });

    fireEvent.click(within(cardFor('Gamma')).getByLabelText('Lock edits'));
    fireEvent.click(within(cardFor('Gamma')).getByLabelText('Loadout actions'));
    expect(onSwitchEditingLoadout).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    fireEvent.click(within(cardFor('Gamma')).getByLabelText('Loadout actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    expect(onToggleLoadoutLock).toHaveBeenCalledWith('Gamma', 'locked');
    expect(onDuplicateLoadout).toHaveBeenCalledWith('Gamma');
    expect(onDeleteLoadout).toHaveBeenCalledWith('Gamma');
    expect(onSwitchEditingLoadout).not.toHaveBeenCalled();
  });

  it('keeps menu interactions from selecting the card and separates active from default actions', async () => {
    const onSwitchEditingLoadout = vi.fn();
    const onSetRuntimeActiveLoadout = vi.fn(async (name: string) => name);
    const onSetDefaultLoadout = vi.fn(async (name: string) => name);
    renderPanel({ onSwitchEditingLoadout, onSetRuntimeActiveLoadout, onSetDefaultLoadout });

    const betaCard = cardFor('Beta');
    fireEvent.click(within(betaCard).getByLabelText('Loadout actions'));

    expect(onSwitchEditingLoadout).not.toHaveBeenCalled();
    const menu = screen.getByRole('menu', { name: 'Actions for Beta' });
    expect(within(menu).getByRole('menuitem', { name: 'Set Active' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Default loadout' })).toHaveProperty('disabled', true);

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Set Active' }));

    await waitFor(() => expect(onSetRuntimeActiveLoadout).toHaveBeenCalledWith('Beta'));
    expect(onSetDefaultLoadout).not.toHaveBeenCalled();
    expect(onSwitchEditingLoadout).not.toHaveBeenCalled();

    fireEvent.click(within(cardFor('Gamma')).getByLabelText('Loadout actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set as Default' }));

    await waitFor(() => expect(onSetDefaultLoadout).toHaveBeenCalledWith('Gamma'));
    expect(onSetRuntimeActiveLoadout).toHaveBeenCalledTimes(1);
  });

  it('passes stable loadout ids for runtime and default actions when display names differ', async () => {
    const onSetRuntimeActiveLoadout = vi.fn(async (id: string) => id);
    const onSetDefaultLoadout = vi.fn(async (id: string) => id);
    renderPanel({
      runtimeActiveLoadoutId: 'user:alpha',
      defaultLoadoutId: null,
      loadouts: {
        Hojo: { id: 'user:hojo', entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Review' } } },
        Alpha: { id: 'user:alpha', entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Build' } } },
      },
      persistedLoadouts: {
        Hojo: { id: 'user:hojo', entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Review' } } },
        Alpha: { id: 'user:alpha', entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Build' } } },
      },
      loadoutSources: { Hojo: 'user', Alpha: 'user' },
      onSetRuntimeActiveLoadout,
      onSetDefaultLoadout,
    });

    fireEvent.click(within(cardFor('Hojo')).getByLabelText('Loadout actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set Active' }));
    await waitFor(() => expect(onSetRuntimeActiveLoadout).toHaveBeenCalledWith('user:hojo'));

    fireEvent.click(within(cardFor('Hojo')).getByLabelText('Loadout actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set as Default' }));
    await waitFor(() => expect(onSetDefaultLoadout).toHaveBeenCalledWith('user:hojo'));
  });

  it('toggles owned loadout locks from the row icon without selecting the card', () => {
    const onSwitchEditingLoadout = vi.fn();
    const onToggleLoadoutLock = vi.fn(() => true);
    renderPanel({ onSwitchEditingLoadout, onToggleLoadoutLock });

    fireEvent.click(within(cardFor('Gamma')).getByLabelText('Lock edits'));

    expect(onToggleLoadoutLock).toHaveBeenCalledWith('Gamma', 'locked');
    expect(onSwitchEditingLoadout).not.toHaveBeenCalled();
  });

  it('uses the same toggle handler for owned lock and unlock icon/menu actions', () => {
    const onToggleLoadoutLock = vi.fn(() => true);
    renderPanel({
      loadouts: { ...loadouts, Beta: { ...loadouts.Beta, lockState: 'locked' } },
      onToggleLoadoutLock,
    });

    fireEvent.click(within(cardFor('Beta')).getByLabelText('Unlock edits'));
    expect(onToggleLoadoutLock).toHaveBeenLastCalledWith('Beta', 'unlocked');

    fireEvent.click(within(cardFor('Beta')).getByLabelText('Loadout actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unlock edits' }));
    expect(onToggleLoadoutLock).toHaveBeenLastCalledWith('Beta', 'unlocked');

    fireEvent.click(within(cardFor('Gamma')).getByLabelText('Loadout actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Lock edits' }));
    expect(onToggleLoadoutLock).toHaveBeenLastCalledWith('Gamma', 'locked');
  });

  it('disables lock controls with target eligibility reason while leaving unrelated rows available', () => {
    const onToggleLoadoutLock = vi.fn(() => true);
    renderPanel({
      getLoadoutLockEligibility: vi.fn((name: string, lockState: 'locked' | 'unlocked') => (
        name === 'Alpha' && lockState === 'locked'
          ? { eligible: false, reason: 'Save or revert pending edits before locking edit mode.' }
          : { eligible: true, reason: null }
      )),
      onToggleLoadoutLock,
    });

    const alphaLock = within(cardFor('Alpha')).getByLabelText('Lock edits');
    expect(alphaLock.getAttribute('aria-disabled')).toBe('true');
    expect(alphaLock.getAttribute('title')).toBe('Save or revert pending edits before locking edit mode.');
    fireEvent.click(alphaLock);
    expect(onToggleLoadoutLock).not.toHaveBeenCalled();

    fireEvent.click(within(cardFor('Alpha')).getByLabelText('Loadout actions'));
    const lockMenuItem = screen.getByRole('menuitem', { name: 'Lock edits' });
    expect(lockMenuItem).toHaveProperty('disabled', true);
    expect(lockMenuItem.getAttribute('title')).toBe('Save or revert pending edits before locking edit mode.');

    fireEvent.click(within(cardFor('Gamma')).getByLabelText('Lock edits'));
    expect(onToggleLoadoutLock).toHaveBeenCalledWith('Gamma', 'locked');
  });

  it('keeps Built-In lock controls disabled with duplicate-to-edit tooltip copy', () => {
    const onToggleLoadoutLock = vi.fn(() => true);
    renderPanel({
      loadouts: { ...loadouts, Gamma: { ...loadouts.Gamma, source: 'default', lockState: 'unlocked' } },
      loadoutSources: { Alpha: 'user', Beta: 'user', Gamma: 'default' },
      canDeleteLoadout: (name) => name !== 'Gamma',
      onToggleLoadoutLock,
    });

    const lockIcon = within(cardFor('Gamma')).getByLabelText('Built-In read-only');
    expect(lockIcon.getAttribute('aria-disabled')).toBe('true');
    expect(lockIcon.getAttribute('title')).toBe('Built-In read-only. Duplicate to edit.');
    fireEvent.click(lockIcon);
    expect(onToggleLoadoutLock).not.toHaveBeenCalled();

    fireEvent.click(within(cardFor('Gamma')).getByLabelText('Loadout actions'));
    const menu = screen.getByRole('menu', { name: 'Actions for Gamma' });
    const lockMenuItem = within(menu).getByRole('menuitem', { name: 'Lock edits' });
    expect(lockMenuItem).toHaveProperty('disabled', true);
    expect(lockMenuItem.getAttribute('title')).toBe('Built-In read-only. Duplicate to edit.');

    const deleteMenuItem = within(menu).getByRole('menuitem', { name: 'Delete' });
    expect(deleteMenuItem).toHaveProperty('disabled', true);
    expect(deleteMenuItem.getAttribute('title')).toBe('Built-In loadouts cannot be deleted.');
  });

  it('routes Lock, Duplicate, and Delete through accessible context menu actions', () => {
    const onDuplicateLoadout = vi.fn();
    const onDeleteLoadout = vi.fn();
    const onToggleLoadoutLock = vi.fn(() => true);
    renderPanel({ onDuplicateLoadout, onDeleteLoadout, onToggleLoadoutLock });

    fireEvent.click(within(cardFor('Gamma')).getByLabelText('Loadout actions'));
    const menu = screen.getByRole('menu', { name: 'Actions for Gamma' });
    expect(within(menu).getByRole('menuitem', { name: 'Lock edits' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Duplicate' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Delete' }).classList.contains('loadout-actions-destructive')).toBe(true);

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Lock edits' }));
    expect(onToggleLoadoutLock).toHaveBeenCalledWith('Gamma', 'locked');
    expect(screen.queryByRole('menu', { name: 'Actions for Gamma' })).toBeNull();

    fireEvent.click(within(cardFor('Gamma')).getByLabelText('Loadout actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(onDuplicateLoadout).toHaveBeenCalledWith('Gamma');
    expect(screen.queryByRole('menu', { name: 'Actions for Gamma' })).toBeNull();

    fireEvent.click(within(cardFor('Gamma')).getByLabelText('Loadout actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(onDeleteLoadout).toHaveBeenCalledWith('Gamma');
  });

  it('renders compact row indicators while keeping the loadout name as the only visible text', () => {
    renderPanel({
      defaultLoadoutId: 'Beta',
      loadouts: {
        ...loadouts,
        Beta: { ...loadouts.Beta, lockState: 'locked' },
        Gamma: { ...loadouts.Gamma, source: 'default', lockState: 'locked' },
      },
      loadoutSources: { Alpha: 'user', Beta: 'user', Gamma: 'default' },
      runtimeActiveLoadoutId: 'Beta',
    });

    const betaCard = cardFor('Beta');
    expect(within(betaCard).getByText('Beta')).toBeTruthy();
    expect(within(betaCard).getByLabelText('Default loadout')).toBeTruthy();
    expect(within(betaCard).getByLabelText('Runtime active loadout')).toBeTruthy();
    expect(within(betaCard).getByLabelText('Unlock edits')).toBeTruthy();
    expect(within(betaCard).getByLabelText('Loadout actions')).toBeTruthy();
    expect(betaCard.querySelector('.loadout-card-select')?.className).toContain('loadout-card-select');
    expect(betaCard.querySelector('.loadout-card-name')?.textContent).toBe('Beta');
    expect(betaCard.querySelector('.loadout-card-meta')).toBeNull();
    expect(betaCard.querySelector('.loadout-lock-indicator')?.className).toContain('loadout-lock-indicator');
    expect(betaCard.querySelector('.loadout-actions-menu')).toBeTruthy();
    expect(betaCard.textContent).not.toMatch(/\d+ sockets?/i);
    expect(betaCard.textContent).not.toContain('user loadout');

    const gammaCard = cardFor('Gamma');
    expect(within(gammaCard).getByText('Gamma')).toBeTruthy();
    expect(within(gammaCard).getByLabelText('Built-In read-only')).toBeTruthy();
    expect(gammaCard.querySelector('.loadout-card-meta')).toBeNull();
    expect(gammaCard.textContent).not.toMatch(/\d+ sockets?/i);
    expect(gammaCard.textContent).not.toContain('Built-In');
  });

  it('protects medium loadout names from premature truncation while preserving ellipsis contracts', () => {
    const mediumName = 'Planning-Consult';
    const longName = 'Extremely-Long-Loadout-Name-With-A-Deeply-Nested-Execution-Strategy';
    renderPanel({
      loadouts: {
        [mediumName]: { id: mediumName, entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Planning' } }, lockState: 'locked' },
        [longName]: { id: longName, entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Planning' } } },
      },
      editingLoadoutName: mediumName,
      runtimeActiveLoadoutId: mediumName,
      defaultLoadoutId: mediumName,
      persistedLoadouts: {
        [mediumName]: { id: mediumName, entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Planning' } }, lockState: 'locked' },
        [longName]: { id: longName, entry: 'Socket-1', sockets: { 'Socket-1': { materia: 'Planning' } } },
      },
      loadoutSources: { [mediumName]: 'user', [longName]: 'user' },
    });

    const mediumCard = cardFor(mediumName);
    expect(within(mediumCard).getByText(mediumName).classList.contains('loadout-card-name')).toBe(true);
    expect(within(mediumCard).getByLabelText('Default loadout')).toBeTruthy();
    expect(within(mediumCard).getByLabelText('Unlock edits')).toBeTruthy();
    expect(within(mediumCard).getByLabelText('Loadout actions')).toBeTruthy();
    expect(mediumCard.querySelector('.loadout-card-select')?.getAttribute('title')).toContain(mediumName);
    expect(mediumCard.querySelector('.loadout-card-meta')).toBeNull();
    expect(mediumCard.textContent).not.toMatch(/Built-In|user loadout|\d+ sockets?/i);

    const longCard = cardFor(longName);
    expect(within(longCard).getByText(longName).classList.contains('loadout-card-name')).toBe(true);
    expect(longCard.querySelector('.loadout-card-select')?.getAttribute('title')).toContain(longName);

    const css = readFileSync('src/webui/client/src/styles.css', 'utf8');
    expect(css).toMatch(/\.loadout-card\s*{(?=[^}]*gap: 0\.25rem;)(?=[^}]*padding: 0;)\s*[^}]*}/s);
    expect(css).toMatch(/\.loadout-card-select\s*{(?=[^}]*flex: 1 1 auto;)(?=[^}]*overflow: hidden;)(?=[^}]*white-space: nowrap;)\s*[^}]*}/s);
    expect(css).toMatch(/\.loadout-card-select \.loadout-card-title\s*{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\) auto auto;[^}]*column-gap: 0\.25rem;/s);
    expect(css).toMatch(/\.loadout-card-name\s*{[^}]*min-width: 0;[^}]*max-width: none;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s);
  });

  it('uses Lucide SVG icons instead of emoji or text glyphs for touched selector indicators', () => {
    renderPanel({
      defaultLoadoutId: 'Beta',
      loadouts: {
        ...loadouts,
        Alpha: { ...loadouts.Alpha, lockState: 'unlocked' },
        Beta: { ...loadouts.Beta, lockState: 'locked' },
        Gamma: { ...loadouts.Gamma, source: 'default', lockState: 'locked' },
      },
      loadoutSources: { Alpha: 'user', Beta: 'user', Gamma: 'default' },
    });

    expect(document.body.textContent).not.toContain('🔒');
    expect(document.body.textContent).not.toContain('🔓');
    expect(document.body.textContent).not.toContain('★');
    expect(document.body.textContent).not.toContain('…');

    const alphaLock = within(cardFor('Alpha')).getByLabelText('Lock edits');
    const betaLock = within(cardFor('Beta')).getByLabelText('Unlock edits');
    const gammaLock = within(cardFor('Gamma')).getByLabelText('Built-In read-only');
    expect(alphaLock.querySelector('svg')).toBeTruthy();
    expect(betaLock.querySelector('svg')).toBeTruthy();
    expect(gammaLock.querySelector('svg')).toBeTruthy();
    expect(within(cardFor('Beta')).getByLabelText('Default loadout').querySelector('svg')).toBeTruthy();
    expect(within(cardFor('Alpha')).getByLabelText('Loadout actions').querySelector('svg')).toBeTruthy();
  });

  it('keeps the existing active-loadout quick selector and does not call the default preference setter', async () => {
    const onSetRuntimeActiveLoadout = vi.fn(async (name: string) => name);
    const onSetDefaultLoadout = vi.fn(async (name: string) => name);
    renderPanel({ onSetRuntimeActiveLoadout, onSetDefaultLoadout });

    fireEvent.change(screen.getByLabelText('Active loadout'), { target: { value: 'Gamma' } });

    await waitFor(() => expect(onSetRuntimeActiveLoadout).toHaveBeenCalledWith('Gamma'));
    expect(onSetDefaultLoadout).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Active loadout is now Gamma'));
  });
});
