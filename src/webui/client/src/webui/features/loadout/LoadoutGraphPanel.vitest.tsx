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
  it('renders loadout grid guidance in a collapsed details disclosure', () => {
    const { container, getByRole, getByText } = renderPanel();
    const dragGuidance = 'Drag orbs into sockets, drag socketed orbs onto the graph background to unsocket, drag socket cards to arrange them, or click a palette orb then click a socket.';
    const loopGuidance = 'To create a loop, select the cycle sockets with shift-click or a drag box; the selected cycle must have exactly one inbound edge from a Generator materia.';

    expect(getByRole('heading', { name: 'Loadout Grid' })).toBeTruthy();
    const details = container.querySelector('details') as HTMLDetailsElement | null;
    expect(details).toBeTruthy();
    expect(details?.open).toBe(false);
    const summary = getByText('How to use the loadout grid');
    expect(summary.tagName).toBe('SUMMARY');
    expect(details?.textContent).toContain(dragGuidance);
    expect(details?.textContent).toContain(loopGuidance);
    expect(getByText(dragGuidance).closest('details')?.open).toBe(false);
    expect(getByText(loopGuidance).closest('details')?.open).toBe(false);

    fireEvent.click(summary);
    expect(details?.open).toBe(true);
  });

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

  it('opens loop controls from the rendered loop cycle target', () => {
    const base = renderPanel();
    const baseViewModel = base.props.viewModel;
    base.unmount();
    const activeLoadout = {
      ...baseViewModel.activeLoadout,
      loops: { reviewLoop: { sockets: ['Socket-1', 'Socket-2'], exit: { from: 'Socket-2', when: 'satisfied' as const, to: 'end' } } },
    };
    const beginSocketRegionSelection = vi.fn();
    const { getByRole, getByTestId, queryByTestId } = renderPanel({
      viewModel: {
        ...baseViewModel,
        activeLoadout,
        loopRegions: [{ id: 'reviewLoop', label: 'Review', x: 12, y: 12, width: 280, height: 160, summary: 'Socket-1, Socket-2', cyclePath: 'M 24 24 C 120 4 220 4 300 24', accent: '#22d3ee', accentSoft: 'rgba(34, 211, 238, 0.12)' }],
      },
      canvasActions: { ...base.props.canvasActions, beginSocketRegionSelection },
    });

    expect(queryByTestId('loop-control-modal')).toBeNull();
    expect(queryByTestId('loop-editor-reviewLoop')).toBeNull();
    expect(queryByTestId('loop-editor-panel')).toBeNull();
    const cycleTarget = getByTestId('loop-cycle-edge-reviewLoop');
    expect(cycleTarget.getAttribute('role')).toBe('button');
    expect(cycleTarget.getAttribute('aria-label')).toBe('Open controls for Review loop');

    fireEvent.pointerDown(cycleTarget);
    fireEvent.click(cycleTarget);

    expect(beginSocketRegionSelection).not.toHaveBeenCalled();
    expect(getByRole('dialog')).toBe(getByTestId('loop-control-modal'));
    expect(getByTestId('loop-editor-reviewLoop')).not.toBeNull();
  });

  it('opens loop controls from the rendered loop cycle target with keyboard activation', () => {
    const base = renderPanel();
    const baseViewModel = base.props.viewModel;
    base.unmount();
    const activeLoadout = {
      ...baseViewModel.activeLoadout,
      loops: {
        enterLoop: { sockets: ['Socket-1', 'Socket-2'] },
        spaceLoop: { sockets: ['Socket-1', 'Socket-2'] },
      },
    };
    const { getByTestId, queryByTestId } = renderPanel({
      viewModel: {
        ...baseViewModel,
        activeLoadout,
        loopRegions: [
          { id: 'enterLoop', label: 'Enter', x: 12, y: 12, width: 280, height: 160, summary: 'Socket-1, Socket-2', cyclePath: 'M 24 24 C 120 4 220 4 300 24', accent: '#a78bfa', accentSoft: 'rgba(167, 139, 250, 0.12)' },
          { id: 'spaceLoop', label: 'Space', x: 32, y: 32, width: 240, height: 120, summary: 'Socket-1, Socket-2', cyclePath: 'M 60 60 C 140 40 220 40 280 60', accent: '#22d3ee', accentSoft: 'rgba(34, 211, 238, 0.12)' },
        ],
      },
    });

    expect(queryByTestId('loop-control-modal')).toBeNull();
    fireEvent.keyDown(getByTestId('loop-cycle-edge-enterLoop'), { key: 'Enter' });
    expect(getByTestId('loop-editor-enterLoop')).not.toBeNull();

    fireEvent.keyDown(getByTestId('loop-cycle-edge-spaceLoop'), { key: ' ' });
    expect(queryByTestId('loop-editor-enterLoop')).toBeNull();
    expect(getByTestId('loop-editor-spaceLoop')).not.toBeNull();
  });

  it('routes modal loop mutations through the selected loop id when editable', () => {
    const base = renderPanel();
    const baseViewModel = base.props.viewModel;
    base.unmount();
    const activeLoadout = {
      ...baseViewModel.activeLoadout,
      source: 'user' as const,
      loops: { editableLoop: { sockets: ['Socket-1', 'Socket-2'], exit: { from: 'Socket-2', when: 'satisfied' as const, to: 'end' } } },
    };
    const loopActions = {
      breakLoop: vi.fn(),
      clearLoopExit: vi.fn(),
      createTaskIteratorLoop: vi.fn(),
      updateLoopExit: vi.fn(),
    };
    const { getByTestId } = renderPanel({
      viewModel: {
        ...baseViewModel,
        activeLoadout,
        editPolicy: unlockedUserPolicy,
        loopRegions: [{ id: 'editableLoop', label: 'Editable', x: 12, y: 12, width: 280, height: 160, summary: 'Socket-1, Socket-2', cyclePath: 'M 24 24 C 120 4 220 4 300 24', accent: '#22d3ee', accentSoft: 'rgba(34, 211, 238, 0.12)' }],
      },
      loopActions,
    });

    fireEvent.click(getByTestId('loop-cycle-edge-editableLoop'));
    fireEvent.change(getByTestId('loop-exit-source-editableLoop'), { target: { value: 'Socket-1' } });
    expect(loopActions.updateLoopExit).toHaveBeenCalledWith('editableLoop', { from: 'Socket-1' });

    fireEvent.change(getByTestId('loop-exit-condition-editableLoop'), { target: { value: 'not_satisfied' } });
    expect(loopActions.updateLoopExit).toHaveBeenCalledWith('editableLoop', { when: 'not_satisfied' });

    fireEvent.change(getByTestId('loop-exit-target-editableLoop'), { target: { value: 'Socket-1' } });
    expect(loopActions.updateLoopExit).toHaveBeenCalledWith('editableLoop', { to: 'Socket-1' });

    fireEvent.click(getByTestId('loop-exit-clear-editableLoop'));
    expect(loopActions.clearLoopExit).toHaveBeenCalledWith('editableLoop');

    fireEvent.click(getByTestId('loop-break-editableLoop'));
    expect(loopActions.breakLoop).toHaveBeenCalledWith('editableLoop');
  });

  it('keeps read-only loop details viewable while disabling modal mutation controls', () => {
    const base = renderPanel();
    const baseViewModel = base.props.viewModel;
    base.unmount();
    const activeLoadout = {
      ...baseViewModel.activeLoadout,
      loops: { readonlyLoop: { sockets: ['Socket-1', 'Socket-2'], exit: { from: 'Socket-2', when: 'satisfied' as const, to: 'end' } } },
    };
    const loopActions = {
      breakLoop: vi.fn(),
      clearLoopExit: vi.fn(),
      createTaskIteratorLoop: vi.fn(),
      updateLoopExit: vi.fn(),
    };
    const { getByRole, getByTestId } = renderPanel({
      viewModel: {
        ...baseViewModel,
        activeLoadout,
        editPolicy: readonlyDefaultPolicy,
        loopRegions: [{ id: 'readonlyLoop', label: 'Read only', x: 12, y: 12, width: 280, height: 160, summary: 'Socket-1, Socket-2', cyclePath: 'M 24 24 C 120 4 220 4 300 24', accent: '#22d3ee', accentSoft: 'rgba(34, 211, 238, 0.12)' }],
      },
      loopActions,
    });

    fireEvent.click(getByTestId('loop-cycle-edge-readonlyLoop'));

    const modal = getByTestId('loop-control-modal');
    expect(modal.textContent).toContain('Members: Socket-1, Socket-2');
    expect(within(modal).getByRole('status').textContent).toBe(readonlyDefaultPolicy.reason);
    expect(getByTestId('loop-exit-source-readonlyLoop')).toHaveProperty('disabled', true);
    expect(getByTestId('loop-exit-condition-readonlyLoop')).toHaveProperty('disabled', true);
    expect(getByTestId('loop-exit-target-readonlyLoop')).toHaveProperty('disabled', true);
    expect(getByTestId('loop-exit-clear-readonlyLoop')).toHaveProperty('disabled', true);
    expect(getByTestId('loop-break-readonlyLoop')).toHaveProperty('disabled', true);

    fireEvent.click(getByRole('button', { name: 'Break loop' }));
    expect(loopActions.breakLoop).not.toHaveBeenCalled();
  });

  it('keeps locked user loop details viewable while disabling modal mutation controls', () => {
    const base = renderPanel();
    const baseViewModel = base.props.viewModel;
    base.unmount();
    const activeLoadout = {
      ...baseViewModel.activeLoadout,
      source: 'user' as const,
      loops: { lockedLoop: { sockets: ['Socket-1', 'Socket-2'], exit: { from: 'Socket-2', when: 'satisfied' as const, to: 'end' } } },
    };
    const { getByTestId } = renderPanel({
      viewModel: {
        ...baseViewModel,
        activeLoadout,
        editPolicy: lockedUserPolicy,
        loopRegions: [{ id: 'lockedLoop', label: 'Locked', x: 12, y: 12, width: 280, height: 160, summary: 'Socket-1, Socket-2', cyclePath: 'M 24 24 C 120 4 220 4 300 24', accent: '#22d3ee', accentSoft: 'rgba(34, 211, 238, 0.12)' }],
      },
    });

    fireEvent.click(getByTestId('loop-cycle-edge-lockedLoop'));

    const modal = getByTestId('loop-control-modal');
    expect(modal.textContent).toContain(lockedUserPolicy.reason);
    expect(getByTestId('loop-exit-source-lockedLoop')).toHaveProperty('disabled', true);
    expect(getByTestId('loop-break-lockedLoop')).toHaveProperty('disabled', true);
  });

  it('keeps an open loop modal synchronized with latest loop data and closes when the loop disappears', () => {
    const base = renderPanel();
    const baseViewModel = base.props.viewModel;
    base.unmount();
    const activeLoadout = {
      ...baseViewModel.activeLoadout,
      loops: { syncLoop: { sockets: ['Socket-1', 'Socket-2'] } },
    };
    const loopRegions = [{ id: 'syncLoop', label: 'Sync', x: 12, y: 12, width: 280, height: 160, summary: 'Socket-1, Socket-2', cyclePath: 'M 24 24 C 120 4 220 4 300 24', accent: '#22d3ee', accentSoft: 'rgba(34, 211, 238, 0.12)' }];
    const viewModel = { ...baseViewModel, activeLoadout, loopRegions };
    const { getByTestId, queryByTestId, rerender, props } = renderPanel({ viewModel });

    fireEvent.click(getByTestId('loop-cycle-edge-syncLoop'));
    expect(getByTestId('loop-control-modal').textContent).toContain('Members: Socket-1, Socket-2');

    const updatedLoadout = {
      ...activeLoadout,
      loops: { syncLoop: { sockets: ['Socket-1'] } },
    };
    rerender(<LoadoutGraphPanel {...props} viewModel={{ ...viewModel, activeLoadout: updatedLoadout }} />);
    expect(getByTestId('loop-control-modal').textContent).toContain('Members: Socket-1');
    expect(getByTestId('loop-control-modal').textContent).not.toContain('Socket-1, Socket-2');

    rerender(<LoadoutGraphPanel {...props} viewModel={{ ...viewModel, activeLoadout: { ...updatedLoadout, loops: {} } }} />);
    expect(queryByTestId('loop-control-modal')).toBeNull();
  });

  it('resets selected loop state when switching active loadouts even if a loop id is reused', () => {
    const base = renderPanel();
    const baseViewModel = base.props.viewModel;
    base.unmount();
    const activeLoadout = {
      ...baseViewModel.activeLoadout,
      loops: { reusedLoop: { sockets: ['Socket-1', 'Socket-2'] } },
    };
    const loopRegions = [{ id: 'reusedLoop', label: 'Reused', x: 12, y: 12, width: 280, height: 160, summary: 'Socket-1, Socket-2', cyclePath: 'M 24 24 C 120 4 220 4 300 24', accent: '#22d3ee', accentSoft: 'rgba(34, 211, 238, 0.12)' }];
    const viewModel = { ...baseViewModel, activeLoadout, loopRegions };
    const { getByTestId, queryByTestId, rerender, props } = renderPanel({ viewModel });

    fireEvent.click(getByTestId('loop-cycle-edge-reusedLoop'));
    expect(getByTestId('loop-editor-reusedLoop')).not.toBeNull();

    const nextLoadout = {
      ...activeLoadout,
      id: 'default:beta',
      loops: { reusedLoop: { sockets: ['Socket-1'] } },
    };
    rerender(<LoadoutGraphPanel {...props} viewModel={{ ...viewModel, activeLoadout: nextLoadout, activeLoadoutName: 'Beta' }} />);
    expect(queryByTestId('loop-control-modal')).toBeNull();
  });

  it('opens controls for each selected loop without auto-opening newly available loops', () => {
    const base = renderPanel();
    const baseViewModel = base.props.viewModel;
    base.unmount();
    const activeLoadout = {
      ...baseViewModel.activeLoadout,
      loops: {
        firstLoop: { sockets: ['Socket-1', 'Socket-2'] },
        secondLoop: { sockets: ['Socket-2'] },
      },
    };
    const { getByTestId, queryByTestId } = renderPanel({
      viewModel: {
        ...baseViewModel,
        activeLoadout,
        loopRegions: [
          { id: 'firstLoop', label: 'First', x: 12, y: 12, width: 280, height: 160, summary: 'Socket-1, Socket-2', cyclePath: 'M 24 24 C 120 4 220 4 300 24', accent: '#22d3ee', accentSoft: 'rgba(34, 211, 238, 0.12)' },
          { id: 'secondLoop', label: 'Second', x: 32, y: 32, width: 240, height: 120, summary: 'Socket-2', cyclePath: 'M 60 60 C 140 40 220 40 280 60', accent: '#a78bfa', accentSoft: 'rgba(167, 139, 250, 0.12)' },
        ],
      },
    });

    expect(queryByTestId('loop-control-modal')).toBeNull();
    fireEvent.click(getByTestId('loop-cycle-edge-firstLoop'));
    expect(getByTestId('loop-editor-firstLoop')).not.toBeNull();
    fireEvent.click(getByTestId('loop-cycle-edge-secondLoop'));
    expect(queryByTestId('loop-editor-firstLoop')).toBeNull();
    expect(getByTestId('loop-editor-secondLoop')).not.toBeNull();
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

describe('LoadoutGraphPanel zoom behavior', () => {
  it('does not change zoom on wheel events over the scroll area', () => {
    const { getByTestId } = renderPanel();
    const scrollArea = getByTestId('socket-grid-scroll-area');
    const zoomPercent = getByTestId('zoom-percent');

    expect(zoomPercent.textContent).toBe('100%');

    fireEvent.wheel(scrollArea, { deltaY: 120 });
    expect(zoomPercent.textContent).toBe('100%');

    fireEvent.wheel(scrollArea, { deltaY: -120 });
    expect(zoomPercent.textContent).toBe('100%');
  });

  it('zoom-in button increases zoom percentage', () => {
    const { getByTestId } = renderPanel();
    const zoomPercent = getByTestId('zoom-percent');
    const zoomIn = getByTestId('zoom-in');

    expect(zoomPercent.textContent).toBe('100%');

    fireEvent.click(zoomIn);
    expect(zoomPercent.textContent).toBe('110%');

    fireEvent.click(zoomIn);
    expect(zoomPercent.textContent).toBe('120%');
  });

  it('zoom-out button decreases zoom percentage', () => {
    const { getByTestId } = renderPanel();
    const zoomPercent = getByTestId('zoom-percent');
    const zoomOut = getByTestId('zoom-out');

    expect(zoomPercent.textContent).toBe('100%');

    fireEvent.click(zoomOut);
    expect(zoomPercent.textContent).toBe('90%');

    fireEvent.click(zoomOut);
    expect(zoomPercent.textContent).toBe('80%');
  });

  it('clamps zoom percentage within configured bounds', () => {
    const { getByTestId } = renderPanel();
    const zoomPercent = getByTestId('zoom-percent');
    const zoomIn = getByTestId('zoom-in');
    const zoomOut = getByTestId('zoom-out');

    // Clamp max at 300%
    for (let i = 0; i < 30; i++) fireEvent.click(zoomIn);
    expect(zoomPercent.textContent).toBe('300%');

    // Clamp min at 25%
    for (let i = 0; i < 30; i++) fireEvent.click(zoomOut);
    expect(zoomPercent.textContent).toBe('25%');
  });

  it('preserves socket drag-and-drop after wheel zoom is disabled', () => {
    const base = renderPanel();
    const baseViewModel = base.props.viewModel;
    base.unmount();

    const canvasActions = {
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
    };
    const { getByTestId } = renderPanel({
      viewModel: { ...baseViewModel, editPolicy: unlockedUserPolicy },
      canvasActions,
    });

    const socket = getByTestId('socket-Socket-1');
    fireEvent.pointerDown(socket);
    expect(canvasActions.beginSocketLayoutDrag).toHaveBeenCalled();

    fireEvent.click(socket);
    expect(canvasActions.handleSocketClick).toHaveBeenCalledWith('Socket-1', expect.anything());
  });
});

describe('LoadoutGraphPanel replacement modal filtering and sorting', () => {
  function renderReplacePanel() {
    const base = renderPanel();
    const baseViewModel = base.props.viewModel;
    const baseSocketModal = base.props.socketModal;
    base.unmount();

    const materia = {
      Build: { prompt: 'build', group: 'Core' },
      Audit: { prompt: 'audit', group: 'Core' },
      detectVcs: { type: 'utility' as const, utility: 'vcs.detect', label: 'Detect VCS', group: 'Utility' },
    };
    const palette = [['Build', { materia: 'Build' }], ['Audit', { materia: 'Audit' }], ['detectVcs', { materia: 'detectVcs' }]] as Array<[string, { materia: string }]>;

    return renderPanel({
      viewModel: {
        ...baseViewModel,
        materia,
        palette: palette as never,
        editPolicy: unlockedUserPolicy,
      },
      socketModal: {
        state: { ...baseSocketModal.state, socketActionMode: 'replace', socketActionId: 'Socket-1' },
        actions: baseSocketModal.actions,
      },
    });
  }

  function replacementOrder(container: HTMLElement): string[] {
    const list = container.querySelector('[data-testid="materia-replacement-list"]');
    if (!list) return [];
    return Array.from(list.querySelectorAll<HTMLButtonElement>('[data-testid^="replacement-materia-"]'))
      .map((button) => button.dataset.testid?.replace('replacement-materia-', '') ?? '');
  }

  it('renders shared filter/sort controls and defaults to name ascending', () => {
    const { container, getByTestId } = renderReplacePanel();
    expect(getByTestId('materia-replacement-list')).toBeTruthy();
    expect(getByTestId('replacement-filter-input')).toBeTruthy();
    expect(getByTestId('replacement-sort-select')).toBeTruthy();
    expect(getByTestId('replacement-sort-direction')).toBeTruthy();
    expect(replacementOrder(container)).toEqual(['Audit', 'Build', 'detectVcs']);
  });

  it('filters the replacement list by text and type', () => {
    const { container, getByTestId } = renderReplacePanel();

    fireEvent.change(getByTestId('replacement-filter-input'), { target: { value: 'core' } });
    expect(replacementOrder(container)).toEqual(['Audit', 'Build']);

    fireEvent.change(getByTestId('replacement-filter-input'), { target: { value: 'utility' } });
    expect(replacementOrder(container)).toEqual(['detectVcs']);
  });

  it('sorts utilities before agents when type is descending', () => {
    const { container, getByTestId } = renderReplacePanel();
    fireEvent.change(getByTestId('replacement-sort-select'), { target: { value: 'type' } });
    fireEvent.click(getByTestId('replacement-sort-direction'));
    expect(replacementOrder(container)).toEqual(['detectVcs', 'Build', 'Audit']);
  });

  it('shows a no-results state when no replacement materia matches', () => {
    const { getByTestId, queryByTestId } = renderReplacePanel();
    fireEvent.change(getByTestId('replacement-filter-input'), { target: { value: 'zzznomatch' } });
    expect(queryByTestId('replacement-materia-Build')).toBeNull();
    expect(getByTestId('replacement-no-results').textContent).toBe('No matching materia.');
  });
});
