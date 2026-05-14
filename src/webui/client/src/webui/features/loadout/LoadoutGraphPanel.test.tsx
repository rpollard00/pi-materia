import { createRequire } from 'node:module';
import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoadoutEditPolicy } from '../../../../../../domain/loadout.js';
import { LoadoutGraphPanel } from './LoadoutGraphPanel.js';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string) => { window: Window & typeof globalThis } };
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window as never;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.MouseEvent = dom.window.MouseEvent;

const readonlyDefaultPolicy: LoadoutEditPolicy = {
  canEdit: false,
  readonly: true,
  lockState: 'policy-locked',
  reason: 'Shipped default loadouts are read-only. Duplicate this loadout to edit it.',
  reasonCode: 'shipped_default_readonly',
};

const lockedUserPolicy: LoadoutEditPolicy = {
  canEdit: false,
  readonly: false,
  lockState: 'locked',
  reason: 'This loadout is locked. Unlock edit mode before making changes.',
  reasonCode: 'user_locked',
};

const unlockedUserPolicy: LoadoutEditPolicy = {
  canEdit: true,
  readonly: false,
  lockState: 'unlocked',
  reason: 'This loadout is editable.',
  reasonCode: 'editable',
};

function renderPanel(overrides: Partial<ComponentProps<typeof LoadoutGraphPanel>> = {}) {
  const activeLoadout = {
    id: 'default:alpha',
    source: 'default' as const,
    lockState: 'unlocked' as const,
    entry: 'Socket-1',
    sockets: {
      'Socket-1': { type: 'agent' as const, materia: 'Build', edges: [{ when: 'always' as const, to: 'Socket-2' }] },
      'Socket-2': { type: 'agent' as const, materia: 'Test' },
    },
  };
  const props: ComponentProps<typeof LoadoutGraphPanel> = {
    viewModel: {
      activeLoadout,
      activeLoadoutName: 'Alpha',
      currentMonitorSocket: undefined,
      loadoutGraph: { width: 360, height: 240, sockets: [
        { id: 'Socket-1', socket: activeLoadout.sockets['Socket-1'], index: 0, x: 24, y: 24 },
        { id: 'Socket-2', socket: activeLoadout.sockets['Socket-2'], index: 1, x: 180, y: 24 },
      ], edges: [] } as never,
      loopExitBadges: new Map(),
      loopMemberships: new Map(),
      loopRegions: [],
      loopSelectionRectangle: undefined,
      materia: { Build: { type: 'agent', materia: 'Build' }, Test: { type: 'agent', materia: 'Test' } },
      palette: [['Build', { type: 'agent', materia: 'Build' }]],
      routedEdges: [],
      selectedLoopSocketIds: [],
      selectedLoopSocketSet: new Set(),
      selectedMateriaId: undefined,
      socketLayoutDrag: undefined,
      createLoopDisabled: true,
      editPolicy: readonlyDefaultPolicy,
      socketDisplayLabel: (id) => id,
      socketLabel: (id) => id,
    },
    toolbar: {
      loadoutNameInput: 'Alpha',
      setLoadoutNameInput: vi.fn(),
      commitActiveLoadoutRename: vi.fn(),
      duplicateActiveLoadout: vi.fn(() => true),
      setActiveLoadoutLockState: vi.fn(() => true),
    },
    canvasActions: {
      beginSocketLayoutDrag: vi.fn(),
      beginSocketRegionSelection: vi.fn(),
      cancelSocketLayoutDrag: vi.fn(),
      cancelSocketRegionSelection: vi.fn(),
      dragMateria: vi.fn(),
      finishSocketLayoutDrag: vi.fn(),
      finishSocketRegionSelection: vi.fn(),
      handleDrop: vi.fn(),
      handleGraphDrop: vi.fn(),
      handleSocketClick: vi.fn(),
      moveSocketLayoutDrag: vi.fn(),
      moveSocketRegionSelection: vi.fn(),
      toggleEdgeCondition: vi.fn(),
      toggleLoopExitCondition: vi.fn(),
    },
    loopActions: {
      breakLoop: vi.fn(),
      clearLoopExit: vi.fn(),
      createTaskIteratorLoop: vi.fn(),
      updateLoopExit: vi.fn(),
    },
    socketModal: {
      state: {
        edgeCondition: 'satisfied',
        edgeMutationError: '',
        edgeTargetId: 'Socket-2',
        socketActionId: undefined,
        socketActionMode: 'actions',
        socketPropertyError: '',
        socketPropertyForm: { maxVisits: '', maxEdgeTraversals: '', maxOutputBytes: '', layoutX: '', layoutY: '' },
      },
      actions: {
        closeSocketActionModal: vi.fn(),
        createConnectedSocket: vi.fn(),
        createEdge: vi.fn(),
        deleteSocket: vi.fn(),
        openEdgeConnector: vi.fn(),
        openSocketPropertyEditor: vi.fn(),
        removeEdge: vi.fn(),
        removeLegacyNextEdge: vi.fn(),
        removeLoopExitConnection: vi.fn(),
        removeMateria: vi.fn(),
        replaceMateriaFromModal: vi.fn(),
        saveSocketProperties: vi.fn(),
        setEdgeCondition: vi.fn(),
        setEdgeTargetId: vi.fn(),
        setSocketActionMode: vi.fn(),
        setSocketPropertyForm: vi.fn(),
      },
    },
    ...overrides,
  };
  return { props, ...render(<LoadoutGraphPanel {...props} />) }; 
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LoadoutGraphPanel readonly defaults', () => {
  it('surfaces readonly shipped defaults with a duplicate CTA and disables toolbar edits', () => {
    const { props, getByRole, getByLabelText, getByTestId } = renderPanel();

    expect(getByRole('status').textContent).toContain('read-only');
    expect(getByRole('group', { name: 'Loadout edit status' }).textContent).toContain('Read-only');
    fireEvent.click(getByRole('button', { name: 'Duplicate to edit' }));
    expect(props.toolbar.duplicateActiveLoadout).toHaveBeenCalledOnce();
    expect(getByLabelText('Edit name')).toHaveProperty('disabled', true);
    expect(getByTestId('create-task-loop')).toHaveProperty('disabled', true);
    expect(() => getByRole('button', { name: /Unlock edits|Lock edits/ })).toThrow();
  });

  it('exposes a persisted lock toggle for locked and unlocked user loadouts', () => {
    const base = renderPanel();
    const baseViewModel = base.props.viewModel;
    const baseToolbar = base.props.toolbar;
    base.unmount();

    const locked = renderPanel({ viewModel: { ...baseViewModel, editPolicy: lockedUserPolicy }, toolbar: { ...baseToolbar, setActiveLoadoutLockState: vi.fn(() => true) } });
    expect(locked.getByRole('group', { name: 'Loadout edit status' }).textContent).toContain('Locked');
    fireEvent.click(locked.getByRole('button', { name: 'Unlock edits' }));
    expect(locked.props.toolbar.setActiveLoadoutLockState).toHaveBeenCalledWith('unlocked');
    locked.unmount();

    const unlocked = renderPanel({ viewModel: { ...baseViewModel, editPolicy: unlockedUserPolicy }, toolbar: { ...baseToolbar, setActiveLoadoutLockState: vi.fn(() => true) } });
    expect(unlocked.getByRole('group', { name: 'Loadout edit status' }).textContent).toContain('Edit mode');
    fireEvent.click(unlocked.getByRole('button', { name: 'Lock edits' }));
    expect(unlocked.props.toolbar.setActiveLoadoutLockState).toHaveBeenCalledWith('locked');
  });

  it('marks socket cards readonly and disables socket action mutations', () => {
    const baseActions = {
      closeSocketActionModal: vi.fn(),
      createConnectedSocket: vi.fn(),
      createEdge: vi.fn(),
      deleteSocket: vi.fn(),
      openEdgeConnector: vi.fn(),
      openSocketPropertyEditor: vi.fn(),
      removeEdge: vi.fn(),
      removeLegacyNextEdge: vi.fn(),
      removeLoopExitConnection: vi.fn(),
      removeMateria: vi.fn(),
      replaceMateriaFromModal: vi.fn(),
      saveSocketProperties: vi.fn(),
      setEdgeCondition: vi.fn(),
      setEdgeTargetId: vi.fn(),
      setSocketActionMode: vi.fn(),
      setSocketPropertyForm: vi.fn(),
    };
    const { getByTestId } = renderPanel({
      socketModal: {
        state: {
          edgeCondition: 'satisfied',
          edgeMutationError: '',
          edgeTargetId: 'Socket-2',
          socketActionId: 'Socket-1',
          socketActionMode: 'actions',
          socketPropertyError: '',
          socketPropertyForm: { maxVisits: '', maxEdgeTraversals: '', maxOutputBytes: '', layoutX: '', layoutY: '' },
        },
        actions: baseActions,
      },
    });

    expect(getByTestId('socket-Socket-1').getAttribute('aria-readonly')).toBe('true');
    const modal = getByTestId('socket-action-modal');
    expect(within(modal).getByRole('button', { name: 'Clear socket' })).toHaveProperty('disabled', true);
    expect(within(modal).getByRole('button', { name: 'Replace' })).toHaveProperty('disabled', true);
    expect(within(modal).getByRole('button', { name: 'Edit' })).toHaveProperty('disabled', true);
    expect(within(modal).getByRole('button', { name: 'New Socket' })).toHaveProperty('disabled', true);
    expect(within(modal).getByRole('button', { name: 'Connect Edge' })).toHaveProperty('disabled', true);
  });
});
