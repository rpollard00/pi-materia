import { useState } from 'react';
import type { DragEvent } from 'react';
import type { QuestReorderPlacement, QuestSummary } from '../../types.js';
import { QuestCard } from './QuestCard.js';

interface QuestLogSidebarProps {
  activeQuest?: QuestSummary;
  pendingQuests: QuestSummary[];
  completedQuests: QuestSummary[];
  failedQuests: QuestSummary[];
  selectedQuestId?: string;
  reorderSubmitting?: boolean;
  onSelectQuest: (questId: string) => void;
  onReorderQuest?: (input: { questId: string; placement: QuestReorderPlacement; targetId?: string }) => Promise<unknown> | unknown;
}

type DropIndicator = { targetId: string; placement: 'before' | 'after' } | { targetId: 'first'; placement: 'first' };

function isPendingQuest(quest: QuestSummary): boolean {
  return quest.status === 'pending';
}

function dropPlacementFromEvent(event: DragEvent<HTMLElement>): 'before' | 'after' {
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
}

export function QuestLogSidebar({ activeQuest, pendingQuests, completedQuests, failedQuests, selectedQuestId, reorderSubmitting = false, onSelectQuest, onReorderQuest }: QuestLogSidebarProps) {
  const [showFailed, setShowFailed] = useState(false);
  const [draggedQuestId, setDraggedQuestId] = useState<string>();
  const [dropIndicator, setDropIndicator] = useState<DropIndicator>();
  const activeAndPendingCount = (activeQuest ? 1 : 0) + pendingQuests.length;
  const canReorder = Boolean(onReorderQuest) && !reorderSubmitting;

  function clearDragState() {
    setDraggedQuestId(undefined);
    setDropIndicator(undefined);
  }

  function beginDrag(event: DragEvent<HTMLElement>, quest: QuestSummary) {
    if (!canReorder || !isPendingQuest(quest)) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', quest.id);
    setDraggedQuestId(quest.id);
  }

  function draggedIdFromEvent(event: DragEvent<HTMLElement>): string | undefined {
    return draggedQuestId || event.dataTransfer.getData('text/plain') || undefined;
  }

  function allowDrop(event: DragEvent<HTMLElement>) {
    if (!canReorder || !draggedIdFromEvent(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }

  async function submitDrop(event: DragEvent<HTMLElement>, placement: QuestReorderPlacement, targetId?: string) {
    allowDrop(event);
    const questId = draggedIdFromEvent(event);
    if (!questId || !onReorderQuest || reorderSubmitting) {
      clearDragState();
      return;
    }
    if (questId === targetId) {
      clearDragState();
      return;
    }
    clearDragState();
    await onReorderQuest({ questId, placement, ...(targetId ? { targetId } : {}) });
  }

  return (
    <aside className="quest-log-sidebar fantasy-panel" aria-labelledby="quest-log-title">
      <div className="quest-log-header">
        <p className="quest-kicker">Adventurer's Ledger</p>
        <h3 id="quest-log-title">Quest Log</h3>
        <p>{activeAndPendingCount === 0 ? 'No quests are in motion.' : `${activeAndPendingCount} quest${activeAndPendingCount === 1 ? '' : 's'} in execution order.`}</p>
      </div>

      <section className="quest-log-section" aria-labelledby="quest-active-pending-title">
        <h4 id="quest-active-pending-title">Active & Pending</h4>
        <div className="quest-card-list">
          {activeQuest ? <QuestCard quest={activeQuest} active selected={selectedQuestId === activeQuest.id} onSelect={onSelectQuest} /> : null}
          {pendingQuests.length > 1 ? (
            <div
              className={`quest-drop-zone${dropIndicator?.placement === 'first' ? ' quest-drop-zone-active' : ''}`}
              onDragEnter={(event) => {
                allowDrop(event);
                setDropIndicator({ targetId: 'first', placement: 'first' });
              }}
              onDragOver={(event) => {
                allowDrop(event);
                setDropIndicator({ targetId: 'first', placement: 'first' });
              }}
              onDrop={(event) => { void submitDrop(event, 'first'); }}
              aria-hidden="true"
            >
              Drop here for first pending
            </div>
          ) : null}
          {pendingQuests.map((quest) => {
            const draggable = canReorder && isPendingQuest(quest) && pendingQuests.length > 1;
            const indicatorClass = dropIndicator && dropIndicator.targetId === quest.id ? ` quest-pending-drop-${dropIndicator.placement}` : '';
            return (
              <div
                key={quest.id}
                className={`quest-pending-row${draggedQuestId === quest.id ? ' quest-pending-row-dragging' : ''}${indicatorClass}`}
                onDragEnter={(event) => {
                  allowDrop(event);
                  setDropIndicator({ targetId: quest.id, placement: dropPlacementFromEvent(event) });
                }}
                onDragOver={(event) => {
                  allowDrop(event);
                  setDropIndicator({ targetId: quest.id, placement: dropPlacementFromEvent(event) });
                }}
                onDragLeave={() => setDropIndicator((current) => current?.targetId === quest.id ? undefined : current)}
                onDrop={(event) => {
                  const placement = dropPlacementFromEvent(event);
                  void submitDrop(event, placement === 'before' && quest.id === pendingQuests[0]?.id ? 'first' : placement, placement === 'before' && quest.id === pendingQuests[0]?.id ? undefined : quest.id);
                }}
              >
                <span
                  className="quest-drag-handle"
                  draggable={draggable}
                  role="button"
                  tabIndex={draggable ? 0 : -1}
                  aria-label={`Drag ${quest.title} to reorder pending quests`}
                  title={draggable ? 'Drag to reorder pending quest' : 'Pending quest reorder unavailable'}
                  onDragStart={(event) => beginDrag(event, quest)}
                  onDragEnd={clearDragState}
                >
                  ⋮⋮
                </span>
                <QuestCard quest={quest} selected={selectedQuestId === quest.id} onSelect={onSelectQuest} />
              </div>
            );
          })}
          {!activeQuest && pendingQuests.length === 0 ? <p className="quest-empty-state">The quest board is quiet. New pending quests will appear here.</p> : null}
          {reorderSubmitting ? <p className="quest-reorder-status" role="status">Reordering pending quests…</p> : null}
        </div>
      </section>

      <section className="quest-log-section" aria-labelledby="quest-completed-title">
        <h4 id="quest-completed-title">Completed</h4>
        <div className="quest-card-list quest-card-list-completed">
          {completedQuests.map((quest) => (
            <QuestCard key={quest.id} quest={quest} selected={selectedQuestId === quest.id} onSelect={onSelectQuest} />
          ))}
          {completedQuests.length === 0 ? <p className="quest-empty-state">No completed quests yet.</p> : null}
        </div>
      </section>

      {failedQuests.length > 0 ? (
        <section className="quest-log-section quest-failed-section" aria-labelledby="quest-hidden-title">
          <button type="button" className="quest-hidden-toggle" onClick={() => setShowFailed((value) => !value)} aria-expanded={showFailed}>
            <span id="quest-hidden-title">Failed / blocked hidden</span>
            <span>{failedQuests.length}</span>
          </button>
          {showFailed ? (
            <div className="quest-card-list quest-card-list-failed">
              {failedQuests.map((quest) => (
                <QuestCard key={quest.id} quest={quest} selected={selectedQuestId === quest.id} onSelect={onSelectQuest} />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </aside>
  );
}
