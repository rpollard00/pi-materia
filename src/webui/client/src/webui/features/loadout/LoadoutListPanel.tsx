import { EllipsisVertical, Lock, Star, Unlock, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { PipelineConfig } from '../../../loadoutModel.js';
import type { LoadoutSourceScope } from '../../types.js';

type LoadoutLockState = 'locked' | 'unlocked';

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
  onToggleLoadoutLock: (name: string, lockState: LoadoutLockState) => boolean;
}

interface LoadoutActionsMenuProps {
  name: string;
  isRuntimeActive: boolean;
  isDefaultLoadout: boolean;
  canSetRuntimeActive: boolean;
  canSetDefault: boolean;
  deleteDisabled: boolean;
  deleteTitle: string;
  lockAction: LoadoutLockAction;
  onSetRuntimeActive: (name: string) => void;
  onSetDefault: (name: string) => void;
  onToggleLock: (name: string, lockState: LoadoutLockState) => void;
  onDuplicate: (name: string) => void;
  onDelete: (name: string) => void;
}

function stopMenuEvent(event: ReactMouseEvent | KeyboardEvent) {
  event.stopPropagation();
}

function loadoutScopeDescription(scope: LoadoutSourceScope): string {
  if (scope === 'default') return 'Built-In read-only loadout';
  return `${scope} loadout`;
}

type LoadoutLockIconKey = 'lock' | 'unlock';

const loadoutLockIcons: Record<LoadoutLockIconKey, LucideIcon> = {
  lock: Lock,
  unlock: Unlock,
};

interface LoadoutLockAction {
  iconKey: LoadoutLockIconKey;
  label: string;
  title: string;
  menuLabel: string;
  nextState: LoadoutLockState;
  disabled: boolean;
}

function loadoutLockAction(loadout: PipelineConfig, scope: LoadoutSourceScope): LoadoutLockAction {
  if (scope === 'default') {
    return { iconKey: 'lock', label: 'Built-In read-only', title: 'Built-In read-only. Duplicate to edit.', menuLabel: 'Lock edits', nextState: 'locked', disabled: true };
  }
  if (loadout.lockState === 'locked') {
    return { iconKey: 'lock', label: 'Unlock edits', title: 'Unlock edits', menuLabel: 'Unlock edits', nextState: 'unlocked', disabled: false };
  }
  return { iconKey: 'unlock', label: 'Lock edits', title: 'Lock edits', menuLabel: 'Lock edits', nextState: 'locked', disabled: false };
}

function LoadoutActionsMenu({ name, isRuntimeActive, isDefaultLoadout, canSetRuntimeActive, canSetDefault, deleteDisabled, deleteTitle, lockAction, onSetRuntimeActive, onSetDefault, onToggleLock, onDuplicate, onDelete }: LoadoutActionsMenuProps) {
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
        <EllipsisVertical className="loadout-icon" aria-hidden="true" focusable="false" />
      </button>
      {open && (
        <div id={menuId} className="loadout-actions-popover" role="menu" aria-label={`Actions for ${name}`}>
          <button type="button" role="menuitem" disabled={!canSetRuntimeActive} title={isRuntimeActive ? 'This loadout is already active.' : undefined} onClick={() => runAction(onSetRuntimeActive)}>
            {isRuntimeActive ? 'Active loadout' : 'Set Active'}
          </button>
          <button type="button" role="menuitem" disabled={!canSetDefault} title={isDefaultLoadout ? 'This loadout is already the default.' : undefined} onClick={() => runAction(onSetDefault)}>
            {isDefaultLoadout ? 'Default loadout' : 'Set as Default'}
          </button>
          <button type="button" role="menuitem" disabled={lockAction.disabled} title={lockAction.title} onClick={() => runAction((loadoutName) => onToggleLock(loadoutName, lockAction.nextState))}>
            {lockAction.menuLabel}
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

export function LoadoutListPanel({ loadouts, editingLoadoutName, runtimeActiveLoadoutName, defaultLoadoutId, persistedLoadouts, loadoutSources, canDeleteLoadout, onCreateLoadout, onSwitchEditingLoadout, onDeleteLoadout, onDuplicateLoadout, onSetDefaultLoadout, onSetRuntimeActiveLoadout, onToggleLoadoutLock }: LoadoutListPanelProps) {
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
          const lockAction = loadoutLockAction(loadout, sourceScope);
          const LockIcon = loadoutLockIcons[lockAction.iconKey];
          return (
            <div key={name} className={`loadout-card ${name === editingLoadoutName ? 'loadout-card-active' : ''}`}>
              <button type="button" onClick={() => onSwitchEditingLoadout(name)} className="loadout-card-select" title={`${name} — ${loadoutScopeDescription(sourceScope)}`}>
                <span className="loadout-card-title">
                  <span className="loadout-card-name">{name}</span>
                  {isDefaultLoadout && (
                    <span className="loadout-default-indicator" role="img" aria-label="Default loadout" title="Default loadout">
                      <Star className="loadout-icon loadout-icon-filled" aria-hidden="true" focusable="false" />
                    </span>
                  )}
                  {isRuntimeActive && <span className="loadout-active-indicator" aria-label="Runtime active loadout" title="Active loadout" />}
                </span>
              </button>
              <button
                type="button"
                className="loadout-lock-indicator"
                aria-label={lockAction.label}
                aria-disabled={lockAction.disabled}
                title={lockAction.title}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!lockAction.disabled) onToggleLoadoutLock(name, lockAction.nextState);
                }}
              >
                <LockIcon className="loadout-icon" aria-hidden="true" focusable="false" />
              </button>
              <LoadoutActionsMenu
                name={name}
                isRuntimeActive={isRuntimeActive}
                isDefaultLoadout={isDefaultLoadout}
                canSetRuntimeActive={persisted && !isRuntimeActive && !activeChangePending}
                canSetDefault={persisted && !isDefaultLoadout}
                deleteDisabled={deleteDisabled}
                deleteTitle={defaultLoadout ? 'Built-In loadouts cannot be deleted.' : deleteDisabled ? 'Create or keep another loadout before deleting this one.' : `Delete ${name}`}
                lockAction={lockAction}
                onSetRuntimeActive={(loadoutName) => void changeRuntimeActiveLoadout(loadoutName)}
                onSetDefault={(loadoutName) => void onSetDefaultLoadout(loadoutName).catch(() => undefined)}
                onToggleLock={onToggleLoadoutLock}
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
