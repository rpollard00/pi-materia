import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipelineConfig } from '../../../loadoutModel.js';
import { LoadoutListPanel } from './LoadoutListPanel.js';

const loadouts = {
  Alpha: { entry: 'Socket-1', sockets: { 'Socket-1': { type: 'agent', materia: 'Build' } } },
  Beta: { entry: 'Socket-1', sockets: { 'Socket-1': { type: 'agent', materia: 'Test' } } },
  Gamma: { entry: 'Socket-1', sockets: { 'Socket-1': { type: 'agent', materia: 'Review' } } },
} satisfies Record<string, PipelineConfig>;

function renderPanel(overrides: Partial<ComponentProps<typeof LoadoutListPanel>> = {}) {
  const props: ComponentProps<typeof LoadoutListPanel> = {
    loadouts,
    editingLoadoutName: 'Alpha',
    runtimeActiveLoadoutName: 'Alpha',
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
  it('renders a labelled star only for the validated persisted default loadout', () => {
    renderPanel({ defaultLoadoutId: 'Beta' });

    expect(within(cardFor('Beta')).getByLabelText('Default loadout')).toBeTruthy();
    expect(within(cardFor('Alpha')).queryByLabelText('Default loadout')).toBeNull();
    expect(within(cardFor('Gamma')).queryByLabelText('Default loadout')).toBeNull();
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
    expect(within(betaCard).getByLabelText('Default loadout')).toBeTruthy();
    expect(within(betaCard).getByLabelText('Loadout locked')).toBeTruthy();
    expect(betaCard.textContent).toContain('user loadout');

    const gammaCard = cardFor('Gamma');
    expect(within(gammaCard).queryByLabelText('Default loadout')).toBeNull();
    expect(within(gammaCard).getByLabelText('Built-In read-only')).toBeTruthy();
    expect(gammaCard.textContent).toContain('Built-In');
  });

  it('does not render a stale star when the default preference points at a missing loadout', () => {
    renderPanel({ defaultLoadoutId: 'Missing' });

    expect(screen.queryByLabelText('Default loadout')).toBeNull();
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

  it('routes Duplicate and Delete through accessible context menu actions', () => {
    const onDuplicateLoadout = vi.fn();
    const onDeleteLoadout = vi.fn();
    renderPanel({ onDuplicateLoadout, onDeleteLoadout });

    fireEvent.click(within(cardFor('Gamma')).getByLabelText('Loadout actions'));
    const menu = screen.getByRole('menu', { name: 'Actions for Gamma' });
    expect(within(menu).getByRole('menuitem', { name: 'Duplicate' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Delete' }).classList.contains('loadout-actions-destructive')).toBe(true);

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Duplicate' }));
    expect(onDuplicateLoadout).toHaveBeenCalledWith('Gamma');
    expect(screen.queryByRole('menu', { name: 'Actions for Gamma' })).toBeNull();

    fireEvent.click(within(cardFor('Gamma')).getByLabelText('Loadout actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(onDeleteLoadout).toHaveBeenCalledWith('Gamma');
  });

  it('renders compact row indicators for active, lock, default, scope, and menu affordances', () => {
    renderPanel({
      defaultLoadoutId: 'Beta',
      loadouts: { ...loadouts, Beta: { ...loadouts.Beta, lockState: 'locked' } },
      runtimeActiveLoadoutName: 'Beta',
    });

    const betaCard = cardFor('Beta');
    expect(within(betaCard).getByLabelText('Default loadout')).toBeTruthy();
    expect(within(betaCard).getByLabelText('Runtime active loadout')).toBeTruthy();
    expect(within(betaCard).getByLabelText('Loadout locked')).toBeTruthy();
    expect(within(betaCard).getByLabelText('Loadout actions')).toBeTruthy();
    expect(betaCard.querySelector('.loadout-card-select')?.className).toContain('loadout-card-select');
    expect(betaCard.querySelector('.loadout-card-meta')?.textContent).toContain('user loadout');
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
