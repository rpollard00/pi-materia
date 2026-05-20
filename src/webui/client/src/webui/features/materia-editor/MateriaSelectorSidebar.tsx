import { EllipsisVertical, Lock, Plus, Unlock } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { Orb } from '../../components/Orb.js';
import type { LoadoutSourceScope } from '../../types.js';
import type { MateriaLockState, MateriaSelectorItem } from './materiaEditPolicy.js';

export interface MateriaSelectorSidebarProps {
  items: MateriaSelectorItem[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDuplicate: (id: string) => void;
  onToggleLock: (id: string, lockState: MateriaLockState) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
}

interface MateriaActionsMenuProps {
  item: MateriaSelectorItem;
  onDuplicate: (id: string) => void;
  onToggleLock: (id: string, lockState: MateriaLockState) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
}

function stopMenuEvent(event: ReactMouseEvent | KeyboardEvent) {
  event.stopPropagation();
}

interface MateriaSelectorBadge {
  label: string;
  title: string;
  className: string;
}

function sourceLabel(source: LoadoutSourceScope | undefined): string {
  if (source === 'default') return 'Built-in';
  if (source === 'user') return 'User';
  if (source === 'project') return 'Project';
  if (source === 'explicit') return 'Explicit';
  return 'Unsaved';
}

function sourceTitle(item: MateriaSelectorItem): string {
  const source = sourceLabel(item.source);
  if (item.isOverriddenBuiltIn) return `${source} override of built-in materia`;
  if (item.isBuiltIn) return 'Built-in materia';
  return `${source} materia`;
}

function getGroupBadge(item: MateriaSelectorItem): MateriaSelectorBadge | null {
  if (!item.group) return null;
  return {
    label: item.group,
    title: `${item.group} materia group`,
    className: 'materia-selector-badge materia-selector-badge-group',
  };
}

function getOriginStatusBadge(item: MateriaSelectorItem): MateriaSelectorBadge {
  if (item.isOverriddenBuiltIn) {
    return {
      label: 'Customized',
      title: sourceTitle(item),
      className: `materia-selector-badge materia-selector-badge-source materia-selector-badge-source-${item.source ?? 'unsaved'} materia-selector-badge-customized`,
    };
  }

  if (item.isBuiltIn) {
    return {
      label: 'Built-in',
      title: sourceTitle(item),
      className: 'materia-selector-badge materia-selector-badge-source materia-selector-badge-built-in',
    };
  }

  return {
    label: 'Custom',
    title: sourceTitle(item),
    className: `materia-selector-badge materia-selector-badge-source materia-selector-badge-source-${item.source ?? 'unsaved'} materia-selector-badge-custom`,
  };
}

function getLockedBadge(item: MateriaSelectorItem): MateriaSelectorBadge | null {
  if (item.lockState !== 'locked') return null;
  return {
    label: 'Locked',
    title: 'Locked materia',
    className: 'materia-selector-badge materia-selector-badge-locked',
  };
}

function renderBadge(badge: MateriaSelectorBadge | null) {
  if (!badge) return null;
  return <span className={badge.className} title={badge.title}>{badge.label}</span>;
}

function lockMenuLabel(item: MateriaSelectorItem): string {
  return item.lockState === 'locked' ? 'Unlock' : 'Lock';
}

function nextLockState(item: MateriaSelectorItem): MateriaLockState {
  return item.lockState === 'locked' ? 'unlocked' : 'locked';
}

function runAction(action: () => void | Promise<void>) {
  void action();
}

function MateriaActionsMenu({ item, onDuplicate, onToggleLock, onDelete }: MateriaActionsMenuProps) {
  const reactId = useId();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = `materia-actions-${reactId.replace(/:/g, '')}`;
  const lockDisabled = !item.canToggleLock;
  const deleteDisabled = !item.canDelete;
  const duplicateTitle = `Duplicate ${item.id}`;

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

  function closeAndRun(action: () => void | Promise<void>) {
    setOpen(false);
    runAction(action);
  }

  return (
    <div className="materia-selector-actions-menu" ref={menuRef} onClick={stopMenuEvent} onKeyDown={stopMenuEvent}>
      <button
        ref={triggerRef}
        type="button"
        className="materia-selector-actions-trigger"
        aria-label={`Actions for ${item.id}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={`Actions for ${item.id}`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <EllipsisVertical className="materia-selector-icon" aria-hidden="true" focusable="false" />
      </button>
      {open && (
        <div id={menuId} className="materia-selector-actions-popover" role="menu" aria-label={`Actions for ${item.id}`}>
          <button type="button" role="menuitem" title={duplicateTitle} onClick={() => closeAndRun(() => onDuplicate(item.id))}>
            Duplicate
          </button>
          <button type="button" role="menuitem" disabled={lockDisabled} title={item.lockTitle} onClick={() => closeAndRun(() => onToggleLock(item.id, nextLockState(item)))}>
            {lockMenuLabel(item)}
          </button>
          <button type="button" role="menuitem" className="materia-selector-actions-destructive" disabled={deleteDisabled} title={item.deleteTitle} onClick={() => closeAndRun(() => onDelete(item.id))}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

export function MateriaSelectorSidebar({ items, selectedId, onSelect, onNew, onDuplicate, onToggleLock, onDelete }: MateriaSelectorSidebarProps) {
  return (
    <aside className="fantasy-panel materia-selector-sidebar p-4" aria-label="Materia selector">
      <div className="materia-selector-header">
        <div>
          <p className="materia-selector-eyebrow">materia catalog</p>
          <h2 className="materia-selector-title">Materia</h2>
        </div>
        <button type="button" className="materia-button materia-selector-new-button" onClick={onNew}>
          <Plus className="materia-selector-icon" aria-hidden="true" focusable="false" />
          New
        </button>
      </div>

      <div className="materia-selector-list" role="list" aria-label="Available materia">
        {items.length === 0 ? (
          <p className="materia-selector-empty">No reusable materia definitions are available.</p>
        ) : (
          items.map((item) => {
            const selected = item.id === selectedId;
            const LockIcon = item.lockState === 'locked' ? Lock : Unlock;
            const groupBadge = getGroupBadge(item);
            const originStatusBadge = getOriginStatusBadge(item);
            const lockedBadge = getLockedBadge(item);
            return (
              <div
                key={item.id}
                className={`materia-selector-row${selected ? ' materia-selector-row-active' : ''}${item.lockState === 'locked' ? ' materia-selector-row-locked' : ''}`}
                role="listitem"
              >
                <button
                  type="button"
                  className="materia-selector-row-select"
                  data-materia-id={item.id}
                  onClick={() => onSelect(item.id)}
                  title={`${item.id} — ${sourceTitle(item)}`}
                  aria-current={selected ? 'true' : undefined}
                >
                  <span className="materia-selector-row-orb" aria-hidden="true">
                    <Orb color={item.color} label={`${item.label || item.id} materia color`} small />
                  </span>
                  <span className="materia-selector-row-content">
                    <span className="materia-selector-row-main">
                      <span className="materia-selector-row-title">
                        <span className="materia-selector-row-label">{item.label || item.id}</span>
                      </span>
                      {item.description && <span className="materia-selector-row-description">{item.description}</span>}
                    </span>
                    <span className="materia-selector-row-meta" aria-label="Materia metadata">
                      {renderBadge(groupBadge)}
                      {renderBadge(originStatusBadge)}
                      {renderBadge(lockedBadge)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="materia-selector-lock-indicator"
                  aria-label={item.lockTitle}
                  aria-disabled={!item.canToggleLock}
                  title={item.lockTitle}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (item.canToggleLock) runAction(() => onToggleLock(item.id, nextLockState(item)));
                  }}
                >
                  <LockIcon className="materia-selector-icon" aria-hidden="true" focusable="false" />
                </button>
                <MateriaActionsMenu item={item} onDuplicate={onDuplicate} onToggleLock={onToggleLock} onDelete={onDelete} />
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
