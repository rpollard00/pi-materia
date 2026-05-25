import { EllipsisVertical, Flag, Lock, Star, Unlock, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { PipelineConfig } from '../../../loadoutModel.js';
import type { LoadoutSourceScope } from '../../types.js';
import type { LoadoutLockEligibility } from './loadoutLockEligibility.js';

type LoadoutLockState = 'locked' | 'unlocked';

export interface RunningLoadoutIdentity {
  loadoutId?: string;
  loadoutName?: string;
}

export interface LoadoutListPanelProps {
  loadouts: Record<string, PipelineConfig>;
  editingLoadoutName: string | undefined;
  configuredActiveLoadoutId?: string | undefined;
  /** @deprecated use configuredActiveLoadoutId */
  runtimeActiveLoadoutId?: string | undefined;
  runningLoadoutIdentity?: RunningLoadoutIdentity;
  defaultLoadoutId: string | null;
  questDefaultLoadoutId?: string | null;
  persistedLoadouts: Record<string, PipelineConfig>;
  loadoutSources: Record<string, LoadoutSourceScope>;
  canDeleteLoadout: (name: string) => boolean;
  onCreateLoadout: () => void;
  onSwitchEditingLoadout: (name: string) => void;
  onDeleteLoadout: (name: string) => void;
  onDuplicateLoadout: (name: string) => void;
  onSetDefaultLoadout: (loadoutId: string) => Promise<string | null>;
  onSetQuestDefaultLoadout: (loadoutId: string | null) => Promise<string | null>;
  onSetRuntimeActiveLoadout: (loadoutId: string) => Promise<string>;
  getLoadoutLockEligibility: (name: string, lockState: LoadoutLockState) => LoadoutLockEligibility;
  onToggleLoadoutLock: (name: string, lockState: LoadoutLockState) => boolean;
}

export interface LoadoutSelectorViewModel {
  name: string;
  loadout: PipelineConfig;
  isDefault: boolean;
  isConfiguredActive: boolean;
  isRunningNow: boolean;
  /** @deprecated use isConfiguredActive */
  isRuntimeActive: boolean;
}

function matchesLoadoutIdentity(name: string, loadout: PipelineConfig, identity?: RunningLoadoutIdentity): boolean {
  if (!identity) return false;
  if (identity.loadoutId) return loadout.id === identity.loadoutId;
  return Boolean(identity.loadoutName) && name === identity.loadoutName;
}

export function buildLoadoutSelectorViewModels(loadouts: Record<string, PipelineConfig>, defaultLoadoutId: string | null, configuredActiveLoadoutId?: string, runningLoadoutIdentity?: RunningLoadoutIdentity): LoadoutSelectorViewModel[] {
  // Config load stamps stable loadout.id values; selector state must
  // not fall back to display names or object keys when IDs are stale/unknown.
  return Object.keys(loadouts).map((name) => {
    const loadout = loadouts[name];
    const isConfiguredActive = Boolean(configuredActiveLoadoutId) && loadout.id === configuredActiveLoadoutId;
    return {
      name,
      loadout,
      isDefault: Boolean(defaultLoadoutId) && loadout.id === defaultLoadoutId,
      isConfiguredActive,
      isRuntimeActive: isConfiguredActive,
      isRunningNow: runningLoadoutIdentity ? matchesLoadoutIdentity(name, loadout, runningLoadoutIdentity) : isConfiguredActive,
    };
  });
}

interface LoadoutActionsMenuProps {
  name: string;
  isConfiguredActive: boolean;
  isDefaultLoadout: boolean;
  isQuestDefaultLoadout: boolean;
  canSetRuntimeActive: boolean;
  canSetDefault: boolean;
  canSetQuestDefault: boolean;
  deleteDisabled: boolean;
  deleteTitle: string;
  lockAction: LoadoutLockAction;
  onSetRuntimeActive: (name: string) => void;
  onSetDefault: (name: string) => void;
  onSetQuestDefault: (name: string) => void;
  onToggleLock: (name: string, lockState: LoadoutLockState) => void;
  onDuplicate: (name: string) => void;
  onDelete: (name: string) => void;
}

function stopMenuEvent(event: ReactMouseEvent | KeyboardEvent) {
  event.stopPropagation();
}

function loadoutScopeDescription(scope: LoadoutSourceScope): string {
  if (scope === 'default') return 'Built-In read-only loadout';
  if (scope === 'explicit') return 'Explicit config loadout';
  if (scope === 'project') return 'Project loadout';
  return 'User loadout';
}

function loadoutSourceLabel(scope: LoadoutSourceScope): string {
  if (scope === 'default') return 'Built-In';
  if (scope === 'explicit') return 'Explicit';
  if (scope === 'project') return 'Project';
  return 'User';
}

function loadoutLockStateLabel(loadout: PipelineConfig, scope: LoadoutSourceScope): string {
  if (scope === 'default') return 'Read-only';
  return loadout.lockState === 'locked' ? 'Locked' : 'Editable';
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

function loadoutLockAction(loadout: PipelineConfig, scope: LoadoutSourceScope, eligibility: LoadoutLockEligibility): LoadoutLockAction {
  if (scope === 'default') {
    return { iconKey: 'lock', label: 'Built-In read-only', title: eligibility.reason ?? 'Built-In read-only. Duplicate to edit.', menuLabel: 'Lock edits', nextState: 'locked', disabled: true };
  }
  if (loadout.lockState === 'locked') {
    return { iconKey: 'lock', label: 'Unlock edits', title: eligibility.reason ?? 'Unlock edits', menuLabel: 'Unlock edits', nextState: 'unlocked', disabled: !eligibility.eligible };
  }
  return { iconKey: 'unlock', label: 'Lock edits', title: eligibility.reason ?? 'Lock edits', menuLabel: 'Lock edits', nextState: 'locked', disabled: !eligibility.eligible };
}

function LoadoutActionsMenu({ name, isConfiguredActive, isDefaultLoadout, isQuestDefaultLoadout, canSetRuntimeActive, canSetDefault, canSetQuestDefault, deleteDisabled, deleteTitle, lockAction, onSetRuntimeActive, onSetDefault, onSetQuestDefault, onToggleLock, onDuplicate, onDelete }: LoadoutActionsMenuProps) {
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
          <button type="button" role="menuitem" disabled={!canSetRuntimeActive} title={isConfiguredActive ? 'This loadout is already the configured active loadout.' : 'Use this loadout for newly started casts and quests without an override.'} onClick={() => runAction(onSetRuntimeActive)}>
            {isConfiguredActive ? 'Configured active loadout' : 'Set configured active'}
          </button>
          <button type="button" role="menuitem" disabled={!canSetDefault} title={isDefaultLoadout ? 'This loadout is already the default.' : undefined} onClick={() => runAction(onSetDefault)}>
            {isDefaultLoadout ? 'Default loadout' : 'Set as Default'}
          </button>
          <button type="button" role="menuitem" disabled={!canSetQuestDefault} title={isQuestDefaultLoadout ? 'This loadout is already the quest default loadout.' : undefined} onClick={() => runAction(onSetQuestDefault)}>
            {isQuestDefaultLoadout ? 'Quest default loadout' : 'Set as Quest Default'}
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

export function LoadoutListPanel({ loadouts, editingLoadoutName, configuredActiveLoadoutId, runtimeActiveLoadoutId, runningLoadoutIdentity, defaultLoadoutId, questDefaultLoadoutId = null, persistedLoadouts, loadoutSources, canDeleteLoadout, onCreateLoadout, onSwitchEditingLoadout, onDeleteLoadout, onDuplicateLoadout, onSetDefaultLoadout, onSetQuestDefaultLoadout, onSetRuntimeActiveLoadout, getLoadoutLockEligibility, onToggleLoadoutLock }: LoadoutListPanelProps) {
  const activeConfiguredLoadoutId = configuredActiveLoadoutId ?? runtimeActiveLoadoutId;
  const [activeChangePending, setActiveChangePending] = useState(false);
  const [activeChangeMessage, setActiveChangeMessage] = useState('');
  const [questDefaultChangePending, setQuestDefaultChangePending] = useState(false);
  const persistedRows = buildLoadoutSelectorViewModels(persistedLoadouts, defaultLoadoutId, activeConfiguredLoadoutId).filter(({ loadout }) => Boolean(loadout.id));
  const loadoutRows = buildLoadoutSelectorViewModels(loadouts, defaultLoadoutId, activeConfiguredLoadoutId, runningLoadoutIdentity);

  async function changeRuntimeActiveLoadout(loadoutId: string, displayName?: string) {
    // This quick selector changes only the runtime/session active loadout. It
    // intentionally does not update the durable defaultLoadoutId preference.
    if (!loadoutId || loadoutId === activeConfiguredLoadoutId || activeChangePending) return;
    setActiveChangePending(true);
    setActiveChangeMessage(`Changing active loadout to ${displayName ?? loadoutId}…`);
    try {
      const activeName = await onSetRuntimeActiveLoadout(loadoutId);
      setActiveChangeMessage(`Active loadout is now ${activeName}.`);
    } catch (error) {
      setActiveChangeMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setActiveChangePending(false);
    }
  }

  async function changeQuestDefaultLoadout(loadoutId: string | null) {
    const nextId = loadoutId?.trim() || null;
    if (nextId === questDefaultLoadoutId || questDefaultChangePending) return;
    setQuestDefaultChangePending(true);
    try {
      await onSetQuestDefaultLoadout(nextId);
    } catch {
      // The shared config hook reports quest-default persistence failures via the app status/toast surface.
    } finally {
      setQuestDefaultChangePending(false);
    }
  }

  return (
    <aside className="fantasy-panel loadout-side-panel p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-bold">Loadouts</h2>
        <button className="materia-button" onClick={onCreateLoadout}>New</button>
      </div>
      <label className="mb-3 block text-xs uppercase tracking-[0.18em] text-cyan-200">
        Configured active loadout
        <select
          className="mt-1 w-full rounded-xl border border-cyan-200/20 bg-slate-950/80 px-3 py-2 text-sm normal-case tracking-normal text-cyan-100 disabled:opacity-60"
          value={activeConfiguredLoadoutId ?? ''}
          disabled={activeChangePending || persistedRows.length === 0}
          onChange={(event) => void changeRuntimeActiveLoadout(event.target.value, event.currentTarget.selectedOptions[0]?.textContent ?? undefined)}
          aria-label="Configured active loadout"
        >
          {persistedRows.map(({ name, loadout }) => <option key={loadout.id} value={loadout.id}>{name}</option>)}
        </select>
      </label>
      {activeChangeMessage && <p className="mb-3 text-xs text-slate-300" role="status">{activeChangeMessage}</p>}
      <div className="space-y-2" role="list" aria-label="Available loadouts">
        {loadoutRows.map(({ name, loadout, isDefault, isConfiguredActive, isRunningNow }) => {
          const sourceScope = loadoutSources[name] ?? 'user';
          const defaultLoadout = sourceScope === 'default';
          const deleteDisabled = !canDeleteLoadout(name);
          const persisted = Boolean(persistedLoadouts[name]?.id);
          const isDefaultLoadout = isDefault;
          const isQuestDefaultLoadout = Boolean(questDefaultLoadoutId) && loadout.id === questDefaultLoadoutId;
          const nextLockState = loadout.lockState === 'locked' ? 'unlocked' : 'locked';
          const lockAction = loadoutLockAction(loadout, sourceScope, getLoadoutLockEligibility(name, nextLockState));
          const LockIcon = loadoutLockIcons[lockAction.iconKey];
          const isEditing = name === editingLoadoutName;
          const statusLabels = [
            isEditing ? 'Editing' : null,
            isConfiguredActive ? 'Configured active' : null,
            runningLoadoutIdentity && isRunningNow ? 'Running now' : null,
            isDefaultLoadout ? 'Default' : null,
            isQuestDefaultLoadout ? 'Quest default' : null,
            loadoutSourceLabel(sourceScope),
            loadoutLockStateLabel(loadout, sourceScope),
          ].filter(Boolean) as string[];
          return (
            <div key={name} role="listitem" className={`loadout-card ${isEditing ? 'loadout-card-active' : ''}`}>
              <button type="button" onClick={() => onSwitchEditingLoadout(name)} className="loadout-card-select" title={`${name} — ${statusLabels.join(', ')}`} aria-label={`${name}. ${statusLabels.join(', ')}.`} aria-current={isEditing ? 'true' : undefined}>
                <span className="loadout-card-title">
                  <span className="loadout-card-name">{name}</span>
                  <span className="loadout-status-badges">
                    {isQuestDefaultLoadout && (
                      <span className="loadout-quest-default-indicator" aria-label="Quest default loadout" title="Quest default loadout">
                        <Flag className="loadout-icon loadout-icon-filled" aria-hidden="true" focusable="false" />
                      </span>
                    )}
                    {isDefaultLoadout && (
                      <span className="loadout-default-indicator" aria-label="Default loadout" title="Default loadout">
                        <Star className="loadout-icon loadout-icon-filled" aria-hidden="true" focusable="false" />
                      </span>
                    )}
                    {isConfiguredActive && <span className="loadout-configured-active-dot" aria-label="Configured active status" title="Configured active loadout" />}
                  </span>
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
                isConfiguredActive={isConfiguredActive}
                isDefaultLoadout={isDefaultLoadout}
                isQuestDefaultLoadout={isQuestDefaultLoadout}
                canSetRuntimeActive={persisted && !isConfiguredActive && !activeChangePending}
                canSetDefault={persisted && !isDefaultLoadout}
                canSetQuestDefault={persisted && !isQuestDefaultLoadout && !questDefaultChangePending}
                deleteDisabled={deleteDisabled}
                deleteTitle={defaultLoadout ? 'Built-In loadouts cannot be deleted.' : deleteDisabled ? 'Create or keep another loadout before deleting this one.' : `Delete ${name}`}
                lockAction={lockAction}
                onSetRuntimeActive={() => void changeRuntimeActiveLoadout(loadout.id ?? '', name)}
                onSetDefault={() => void onSetDefaultLoadout(loadout.id ?? '').catch(() => undefined)}
                onSetQuestDefault={() => void changeQuestDefaultLoadout(loadout.id ?? '')}
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
