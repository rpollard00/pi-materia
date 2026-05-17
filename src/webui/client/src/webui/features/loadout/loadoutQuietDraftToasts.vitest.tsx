import { createRequire } from 'node:module';
import { useState } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { LoadoutEditPolicy } from '../../../../../../domain/loadout.js';
import type { MateriaConfig, PipelineConfig } from '../../../loadoutModel.js';
import { clearToasts, useToasts } from '../../../toast/index.js';
import { emitLoadoutStatusToast, type LoadoutStatusOptions, type LoadoutStatusToastIntent } from '../../utils/loadoutNotifications.js';
import { getLoadoutEdges } from '../../utils/graphLayout.js';
import { useLoadoutGraphMutationController } from './useLoadoutGraphMutationController.js';
import { useLoadoutSocketInteractionController } from './useLoadoutSocketInteractionController.js';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string) => { window: Window & typeof globalThis } };
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window as never;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.MouseEvent = dom.window.MouseEvent;

const editablePolicy: LoadoutEditPolicy = {
  canEdit: true,
  readonly: false,
  lockState: 'unlocked',
  reason: 'This loadout is editable.',
  reasonCode: 'editable',
};

const lockedPolicy: LoadoutEditPolicy = {
  canEdit: false,
  readonly: false,
  lockState: 'locked',
  reason: 'This loadout is locked. Unlock edit mode before making changes.',
  reasonCode: 'user_locked',
};

function initialLoadout(): PipelineConfig {
  return {
    id: 'Alpha',
    entry: 'Socket-1',
    sockets: {
      'Socket-1': { materia: 'Build', edges: [{ when: 'always', to: 'Socket-2' }] },
      'Socket-2': { materia: 'Test' },
    },
  };
}

function initialConfig(loadout = initialLoadout()): MateriaConfig {
  return {
    activeLoadout: 'Alpha',
    materia: {
      Build: { tools: 'coding', prompt: 'Build.' },
      Test: { tools: 'readOnly', prompt: 'Test.' },
    },
    loadouts: { Alpha: loadout },
  };
}

function StatusProbe({ status }: { status: string }) {
  const toasts = useToasts();
  return (
    <>
      <output aria-label="status">{status}</output>
      <output aria-label="toast-count">{String(toasts.length)}</output>
      <output aria-label="toasts">{JSON.stringify(toasts)}</output>
    </>
  );
}

function GraphMutationProbe({ policy = editablePolicy }: { policy?: LoadoutEditPolicy }) {
  const [loadout, setLoadout] = useState(() => initialLoadout());
  const [status, setLocalStatus] = useState('ready');
  const setStatus = (message: string, options?: LoadoutStatusOptions | LoadoutStatusToastIntent) => {
    emitLoadoutStatusToast(message, options);
    setLocalStatus(message);
  };
  const controller = useLoadoutGraphMutationController({
    activeLoadout: loadout,
    activeLoadoutName: 'Alpha',
    editPolicy: policy,
    loadoutGraph: { edges: getLoadoutEdges(loadout) },
    materia: initialConfig(loadout).materia ?? {},
    selectedLoopSockets: [],
    setSelectedLoopSocketIds: () => undefined,
    setStatus,
    updateLoadoutDraft: (_name, updater) => {
      setLoadout((current) => updater(current));
      return true;
    },
    updateLoadoutLayout: (_name, updater) => {
      setLoadout((current) => updater(current));
      return true;
    },
    closeSocketActionModal: () => undefined,
    openSocketActionModal: () => undefined,
    socketLabel: (id) => id,
    socketDisplayLabel: (id) => id,
  });
  return (
    <>
      <StatusProbe status={status} />
      <output aria-label="socket-ids">{Object.keys(loadout.sockets ?? {}).join(',')}</output>
      <output aria-label="first-edge-condition">{loadout.sockets?.['Socket-1']?.edges?.[0]?.when ?? ''}</output>
      <button type="button" onClick={() => controller.createConnectedSocket('Socket-1')}>create socket</button>
      <button type="button" onClick={() => controller.toggleEdgeCondition({ id: 'Socket-1:0', from: 'Socket-1', to: 'Socket-2', when: 'always', kind: 'normal', edgeIndex: 0 })}>toggle edge</button>
      <button type="button" onClick={() => controller.saveSocketProperties('Socket-1')}>save socket properties</button>
    </>
  );
}

function SocketInteractionProbe({ policy = editablePolicy }: { policy?: LoadoutEditPolicy }) {
  const [config, setConfig] = useState(() => initialConfig());
  const [status, setLocalStatus] = useState('ready');
  const loadout = config.loadouts?.Alpha;
  const setStatus = (message: string, options?: LoadoutStatusOptions | LoadoutStatusToastIntent) => {
    emitLoadoutStatusToast(message, options);
    setLocalStatus(message);
  };
  const controller = useLoadoutSocketInteractionController({
    activeLoadout: loadout,
    activeLoadoutName: 'Alpha',
    editPolicy: policy,
    deleteLoadoutDraft: () => true,
    draftConfig: config,
    loadouts: config.loadouts ?? {},
    monitor: undefined,
    setStatus,
    switchLoadoutDraft: () => undefined,
    updateLoadoutDraft: (_name, updater) => {
      setConfig((current) => ({ ...current, loadouts: { ...current.loadouts, Alpha: updater(current.loadouts!.Alpha) } }));
      return true;
    },
    updateLoadoutLayout: (_name, updater) => {
      setConfig((current) => ({ ...current, loadouts: { ...current.loadouts, Alpha: updater(current.loadouts!.Alpha) } }));
      return true;
    },
  });
  return (
    <>
      <StatusProbe status={status} />
      <output aria-label="socket-2-materia">{config.loadouts?.Alpha.sockets?.['Socket-2']?.materia ?? ''}</output>
      <button type="button" onClick={() => controller.putMateria('Socket-2', 'Build')}>put materia</button>
      <button type="button" onClick={() => controller.removeMateria('Socket-2')}>remove materia</button>
    </>
  );
}

afterEach(() => {
  cleanup();
  clearToasts();
});

describe('quiet draft loadout edit toasts', () => {
  it('updates status and state without success/info toasts for routine graph edits', () => {
    const view = render(<GraphMutationProbe />);

    fireEvent.click(view.getByRole('button', { name: 'create socket' }));
    expect(view.getByLabelText('socket-ids').textContent).toContain('Socket-3');
    expect(view.getByLabelText('status').textContent).toContain('Created a connected empty socket');
    expect(view.getByLabelText('toast-count').textContent).toBe('0');

    fireEvent.click(view.getByRole('button', { name: 'toggle edge' }));
    expect(view.getByLabelText('first-edge-condition').textContent).not.toBe('always');
    expect(view.getByLabelText('status').textContent).toContain('Staged edge Socket-1');
    expect(view.getByLabelText('toast-count').textContent).toBe('0');

    fireEvent.click(view.getByRole('button', { name: 'save socket properties' }));
    expect(view.getByLabelText('status').textContent).toContain('No socket property changes');
    expect(view.getByLabelText('toast-count').textContent).toBe('0');
  });

  it('updates status and state without success/info toasts for routine materia edits', () => {
    const view = render(<SocketInteractionProbe />);

    fireEvent.click(view.getByRole('button', { name: 'put materia' }));
    expect(view.getByLabelText('socket-2-materia').textContent).toBe('Build');
    expect(view.getByLabelText('status').textContent).toContain('Staged Build in socket Socket-2');
    expect(view.getByLabelText('toast-count').textContent).toBe('0');

    fireEvent.click(view.getByRole('button', { name: 'remove materia' }));
    expect(view.getByLabelText('socket-2-materia').textContent).toBe('');
    expect(view.getByLabelText('status').textContent).toContain('Cleared materia from Socket-2');
    expect(view.getByLabelText('toast-count').textContent).toBe('0');
  });

  it('preserves and dedupes validation toasts for blocked draft edits', () => {
    const view = render(<GraphMutationProbe policy={lockedPolicy} />);

    fireEvent.click(view.getByRole('button', { name: 'create socket' }));
    expect(view.getByLabelText('status').textContent).toContain('blocked: This loadout is locked');
    expect(view.getByLabelText('toast-count').textContent).toBe('1');
    expect(view.getByLabelText('toasts').textContent).toContain('validation');

    fireEvent.click(view.getByRole('button', { name: 'create socket' }));
    expect(view.getByLabelText('status').textContent).toContain('blocked: This loadout is locked');
    expect(view.getByLabelText('toast-count').textContent).toBe('1');
    const toasts = JSON.parse(view.getByLabelText('toasts').textContent ?? '[]') as Array<{ id?: string; variant?: string }>;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toEqual(expect.objectContaining({ variant: 'validation' }));
  });
});
