import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { PipelineConfig } from '../../../loadoutModel.js';
import type { LoadoutSourceScope } from '../../types.js';

export interface LoadoutListPanelProps {
  loadouts: Record<string, PipelineConfig>;
  editingLoadoutName: string | undefined;
  runtimeActiveLoadoutName: string | undefined;
  defaultLoadoutId: string | null;
  persistedLoadouts: Record<string, PipelineConfig>;
  loadoutSources: Record<string, LoadoutSourceScope>;
  canDeleteLoadout: (name: string) => boolean;
  onCreateLoadout: () => void;
  onSwitchEditingLoadout: (name: string) => void;
  onDeleteLoadout: (name: string) => void;
  onDuplicateLoadout: (name: string) => void;
  onSetDefaultLoadout: (name: string) => Promise<string | null>;
  onSetRuntimeActiveLoadout: (name: string) => Promise<string>;
}

interface LoadoutActionsMenuProps {
  name: string;
  isRuntimeActive: boolean;
  isDefaultLoadout: boolean;
  canSetRuntimeActive: boolean;
  canSetDefault: boolean;
  deleteDisabled: boolean;
  deleteTitle: string;
  onSetRuntimeActive: (name: string) => void;
  onSetDefault: (name: string) => void;
  onDuplicate: (name: string) => void;
  onDelete: (name: string) => void;
}

function stopMenuEvent(event: ReactMouseEvent | KeyboardEvent) {
  event.stopPropagation();
}

function loadoutScopeLabel(scope: LoadoutSourceScope): string {
  if (scope === 'default') return 'Built-In';
  return `${scope} loadout`;
}

function loadoutLockIndicator(loadout: PipelineConfig, scope: LoadoutSourceScope) {
  if (scope === 'default') {
    return { icon: '🔒', label: 'Built-In read-only', title: 'Built-In read-only. Duplicate to edit.' };
  }
  if (loadout.lockState === 'locked') {
    return { icon: '🔒', label: 'Loadout locked', title: 'Unlock edits' };
  }
  return { icon: '🔓', label: 'Loadout unlocked', title: 'Lock edits' };
}

function LoadoutActionsMenu({ name, isRuntimeActive, isDefaultLoadout, canSetRuntimeActive, canSetDefault, deleteDisabled, deleteTitle, onSetRuntimeActive, onSetDefault, onDuplicate, onDelete }: LoadoutActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = `loadout-actions-${name.replace(/[^a-zA-Z0-9_-]+/g, '-') || 'loadout'}`;

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  function runAction(action: (loadoutName: string) => void) {
    setOpen(false);
    action(name);
  }

  return (
    <div className="loadout-actions-menu" ref={menuRef} onClick={stopMenuEvent}>
      <button
        ref={triggerRef}
        type="button"
        className="loadout-actions-trigger"
        aria-label="Loadout actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={`Actions for ${name}`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        …
      </button>
      {open && (
        <div id={menuId} className="loadout-actions-popover" role="menu" aria-label={`Actions for ${name}`}>
          <button type="button" role="menuitem" disabled={!canSetRuntimeActive} title={isRuntimeActive ? 'This loadout is already active.' : undefined} onClick={() => runAction(onSetRuntimeActive)}>
            {isRuntimeActive ? 'Active loadout' : 'Set Active'}
          </button>
          <button type="button" role="menuitem" disabled={!canSetDefault} title={isDefaultLoadout ? 'This loadout is already the default.' : undefined} onClick={() => runAction(onSetDefault)}>
            {isDefaultLoadout ? 'Default loadout' : 'Set as Default'}
          </button>
          <button type="button" role="menuitem" onClick={() => runAction(onDuplicate)}>
            Duplicate
          </button>
          <button type="button" role="menuitem" className="loadout-actions-destructive" disabled={deleteDisabled} title={deleteTitle} onClick={() => runAction(onDelete)}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

export function LoadoutListPanel({ loadouts, editingLoadoutName, runtimeActiveLoadoutName, defaultLoadoutId, persistedLoadouts, loadoutSources, canDeleteLoadout, onCreateLoadout, onSwitchEditingLoadout, onDeleteLoadout, onDuplicateLoadout, onSetDefaultLoadout, onSetRuntimeActiveLoadout }: LoadoutListPanelProps) {
  const [activeChangePending, setActiveChangePending] = useState(false);
  const [activeChangeMessage, setActiveChangeMessage] = useState('');
  const persistedNames = Object.keys(persistedLoadouts);
  const validatedDefaultLoadoutId = defaultLoadoutId && persistedLoadouts[defaultLoadoutId] ? defaultLoadoutId : null;

  async function changeRuntimeActiveLoadout(name: string) {
    // This quick selector changes only the runtime/session active loadout. It
    // intentionally does not update the durable defaultLoadoutId preference.
    if (!name || name === runtimeActiveLoadoutName || activeChangePending) return;
    setActiveChangePending(true);
    setActiveChangeMessage(`Changing active loadout to ${name}…`);
    try {
      const activeName = await onSetRuntimeActiveLoadout(name);
      setActiveChangeMessage(`Active loadout is now ${activeName}.`);
    } catch (error) {
      setActiveChangeMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setActiveChangePending(false);
    }
  }

  return (
    <aside className="fantasy-panel loadout-side-panel p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-bold">Loadouts</h2>
        <button className="materia-button" onClick={onCreateLoadout}>New</button>
      </div>
      <label className="mb-3 block text-xs uppercase tracking-[0.18em] text-cyan-200">
        Active loadout
        <select
          className="mt-1 w-full rounded-xl border border-cyan-200/20 bg-slate-950/80 px-3 py-2 text-sm normal-case tracking-normal text-cyan-100 disabled:opacity-60"
          value={runtimeActiveLoadoutName ?? ''}
          disabled={activeChangePending || persistedNames.length === 0}
          onChange={(event) => void changeRuntimeActiveLoadout(event.target.value)}
          aria-label="Active loadout"
        >
          {persistedNames.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      {activeChangeMessage && <p className="mb-3 text-xs text-slate-300" role="status">{activeChangeMessage}</p>}
      <div className="space-y-2" role="list" aria-label="Available loadouts">
        {Object.keys(loadouts).map((name) => {
          const loadout = loadouts[name];
          const sourceScope = loadoutSources[name] ?? 'user';
          const defaultLoadout = sourceScope === 'default';
          const deleteDisabled = !canDeleteLoadout(name);
          const isRuntimeActive = name === runtimeActiveLoadoutName;
          const persisted = Boolean(persistedLoadouts[name]);
          const isDefaultLoadout = persisted && name === validatedDefaultLoadoutId;
          const lockIndicator = loadoutLockIndicator(loadout, sourceScope);
          return (
            <div key={name} className={`loadout-card ${name === editingLoadoutName ? 'loadout-card-active' : ''}`}>
              <button type="button" onClick={() => onSwitchEditingLoadout(name)} className="loadout-card-select">
                <span className="loadout-card-title">
                  <span className="loadout-card-name">{name}</span>
                  {isDefaultLoadout && (
                    <span className="loadout-default-indicator" role="img" aria-label="Default loadout" title="Default loadout">
                      ★
                    </span>
                  )}
                  {isRuntimeActive && <span className="loadout-active-indicator" aria-label="Runtime active loadout" title="Active loadout" />}
                  <span className="loadout-lock-indicator" role="img" aria-label={lockIndicator.label} title={lockIndicator.title}>{lockIndicator.icon}</span>
                </span>
                <small className="loadout-card-meta">{Object.keys(loadout.sockets ?? {}).length} sockets · {loadoutScopeLabel(sourceScope)}</small>
              </button>
              <LoadoutActionsMenu
                name={name}
                isRuntimeActive={isRuntimeActive}
                isDefaultLoadout={isDefaultLoadout}
                canSetRuntimeActive={persisted && !isRuntimeActive && !activeChangePending}
                canSetDefault={persisted && !isDefaultLoadout}
                deleteDisabled={deleteDisabled}
                deleteTitle={defaultLoadout ? 'Built-In loadouts cannot be deleted.' : deleteDisabled ? 'Create or keep another loadout before deleting this one.' : `Delete ${name}`}
                onSetRuntimeActive={(loadoutName) => void changeRuntimeActiveLoadout(loadoutName)}
                onSetDefault={(loadoutName) => void onSetDefaultLoadout(loadoutName).catch(() => undefined)}
                onDuplicate={onDuplicateLoadout}
                onDelete={onDeleteLoadout}
              />
            </div>
          );
        })}
      </div>
    </aside>
  );
}
