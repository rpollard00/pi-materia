import { createRequire } from 'node:module';
import type { ComponentProps } from 'react';
import { cleanup, render, within } from '@testing-library/react';
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
      'Socket-1': { materia: 'Build', edges: [{ when: 'always' as const, to: 'Socket-2' }] },
      'Socket-2': { materia: 'Test' },
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
      materia: { Build: { materia: 'Build' }, Test: { materia: 'Test' } },
      palette: [['Build', { materia: 'Build' }]],
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
  it('omits persistent readonly copy and toolbar lock controls while keeping edits disabled', () => {
    const { queryByRole, getByLabelText, getByTestId } = renderPanel();

    expect(queryByRole('status')).toBeNull();
    expect(queryByRole('group', { name: 'Loadout edit status' })).toBeNull();
    expect(queryByRole('button', { name: 'Duplicate to edit' })).toBeNull();
    expect(queryByRole('button', { name: /Unlock edits|Lock edits/ })).toBeNull();
    expect(getByLabelText('Edit name')).toHaveProperty('disabled', true);
    expect(getByTestId('create-task-loop')).toHaveProperty('disabled', true);
  });

  it('does not render a graph-toolbar lock toggle for locked or unlocked user loadouts', () => {
    const base = renderPanel();
    const baseViewModel = base.props.viewModel;
    const baseToolbar = base.props.toolbar;
    base.unmount();

    const locked = renderPanel({ viewModel: { ...baseViewModel, editPolicy: lockedUserPolicy }, toolbar: baseToolbar });
    expect(locked.queryByRole('group', { name: 'Loadout edit status' })).toBeNull();
    expect(locked.queryByRole('button', { name: /Unlock edits|Lock edits/ })).toBeNull();
    expect(locked.getByLabelText('Edit name')).toHaveProperty('disabled', true);
    locked.unmount();

    const unlocked = renderPanel({ viewModel: { ...baseViewModel, editPolicy: unlockedUserPolicy }, toolbar: baseToolbar });
    expect(unlocked.queryByRole('group', { name: 'Loadout edit status' })).toBeNull();
    expect(unlocked.queryByRole('button', { name: /Unlock edits|Lock edits/ })).toBeNull();
    expect(unlocked.getByLabelText('Edit name')).toHaveProperty('disabled', false);
  });

  it('renders the active session socket indicator without enabling locked edits', () => {
    const base = renderPanel();
    const baseViewModel = base.props.viewModel;
    base.unmount();
    const { getByTestId } = renderPanel({
      viewModel: {
        ...baseViewModel,
        currentMonitorSocket: 'Socket-2',
        editPolicy: lockedUserPolicy,
      },
    });

    const activeSocket = getByTestId('socket-Socket-2');
    const inactiveSocket = getByTestId('socket-Socket-1');
    expect(activeSocket.className).toContain('materia-socket-active');
    expect(activeSocket.getAttribute('aria-current')).toBe('step');
    expect(activeSocket.getAttribute('aria-label')).toContain('active session socket');
    expect(activeSocket.getAttribute('aria-readonly')).toBe('true');
    expect(activeSocket.querySelector('.materia-socket-active-indicator')).not.toBeNull();
    expect(inactiveSocket.className).not.toContain('materia-socket-active');
  });

  it('keeps active monitor hooks on loop-member sockets', () => {
    const base = renderPanel();
    const baseViewModel = base.props.viewModel;
    base.unmount();
    const { getByTestId } = renderPanel({
      viewModel: {
        ...baseViewModel,
        currentMonitorSocket: 'Socket-2',
        loopMemberships: new Map([['Socket-2', { loopIds: ['reviewLoop'], borderColor: '#22d3ee', background: 'rgba(34, 211, 238, 0.12)', textColor: '#cffafe', accent: '#22d3ee', accentSoft: 'rgba(34, 211, 238, 0.12)' }]]),
      },
    });

    const activeLoopSocket = getByTestId('socket-Socket-2');
    expect(activeLoopSocket.className).toContain('materia-socket-loop-member');
    expect(activeLoopSocket.className).toContain('materia-socket-active');
    expect(activeLoopSocket.getAttribute('data-loop-ids')).toBe('reviewLoop');
    expect(activeLoopSocket.getAttribute('aria-current')).toBe('step');
    expect(activeLoopSocket.getAttribute('aria-label')).toContain('active session socket');
    expect(activeLoopSocket.querySelector('.materia-socket-orb-stage > .materia-socket-active-indicator')).not.toBeNull();
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
