import { EllipsisVertical } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { QuestSummary } from '../../types.js';
import { resultCastLabel } from './questResultCast.js';

interface QuestCardProps {
  quest: QuestSummary;
  active?: boolean;
  selected?: boolean;
  onSelect: (questId: string) => void;
  canEdit?: boolean;
  onEdit?: (questId: string) => void;
}

const statusLabels: Record<QuestSummary['status'], string> = {
  pending: 'Pending',
  running: 'Active',
  succeeded: 'Completed',
  failed: 'Failed',
  blocked: 'Blocked',
};

function normalizedText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function questDescription(quest: QuestSummary): string {
  return normalizedText(quest.promptPreview) || normalizedText(quest.prompt) || normalizedText(quest.title);
}

function questSummary(quest: QuestSummary): string {
  const description = questDescription(quest);
  return description ? `${quest.id}: ${description}` : quest.id;
}

function stopMenuEvent(event: ReactMouseEvent | ReactPointerEvent) {
  event.stopPropagation();
}

interface QuestActionsMenuProps {
  quest: QuestSummary;
  summary: string;
  onEdit: (questId: string) => void;
}

function QuestActionsMenu({ quest, summary, onEdit }: QuestActionsMenuProps) {
  const reactId = useId();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = `quest-actions-${reactId.replace(/:/g, '')}`;

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

  function closeAndEdit() {
    setOpen(false);
    onEdit(quest.id);
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (event.key === 'Escape') {
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  return (
    <div className="quest-actions-menu" ref={menuRef} onClick={stopMenuEvent} onPointerDown={stopMenuEvent} onKeyDown={handleMenuKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="quest-actions-trigger"
        aria-label="Quest actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={`Actions for ${summary}`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <EllipsisVertical className="quest-actions-icon" aria-hidden="true" focusable="false" />
      </button>
      {open ? (
        <div id={menuId} className="quest-actions-popover" role="menu" aria-label={`Actions for ${summary}`}>
          <button type="button" role="menuitem" onClick={closeAndEdit}>
            Edit
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function QuestCard({ quest, active = false, selected = false, onSelect, canEdit = false, onEdit }: QuestCardProps) {
  const summary = questSummary(quest);
  const label = active ? `Active quest: ${summary}` : `${statusLabels[quest.status]} quest: ${summary}`;
  const castLabel = quest.status === 'pending' || quest.status === 'running' ? undefined : resultCastLabel(quest);
  const editable = canEdit && quest.status === 'pending' && Boolean(onEdit);
  return (
    <div className={`quest-card${active ? ' quest-card-active' : ''}${selected ? ' quest-card-selected' : ''}${editable ? ' quest-card-editable' : ''}`}>
      <button
        type="button"
        className="quest-card-select"
        onClick={() => onSelect(quest.id)}
        aria-pressed={selected}
        aria-label={label}
      >
        <span className="quest-card-rune" aria-hidden="true">{active ? '★' : quest.status === 'succeeded' ? '✓' : '•'}</span>
        <span className="quest-card-copy">
          <span className="quest-card-title-row">
            <span className="quest-card-title">{summary}</span>
            {active ? <span className="quest-active-badge" aria-label="Active quest">Active</span> : null}
          </span>
          {castLabel ? <span className="quest-card-result-cast">{castLabel}</span> : null}
          <span className={`quest-status-pill quest-status-${quest.status}`}>{statusLabels[quest.status]}</span>
        </span>
      </button>
      {editable && onEdit ? <QuestActionsMenu quest={quest} summary={summary} onEdit={onEdit} /> : null}
    </div>
  );
}
