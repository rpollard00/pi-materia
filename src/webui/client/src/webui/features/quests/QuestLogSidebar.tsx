import { useState } from 'react';
import type { QuestSummary } from '../../types.js';
import { QuestCard } from './QuestCard.js';

interface QuestLogSidebarProps {
  activeQuest?: QuestSummary;
  pendingQuests: QuestSummary[];
  completedQuests: QuestSummary[];
  failedQuests: QuestSummary[];
  selectedQuestId?: string;
  onSelectQuest: (questId: string) => void;
}

export function QuestLogSidebar({ activeQuest, pendingQuests, completedQuests, failedQuests, selectedQuestId, onSelectQuest }: QuestLogSidebarProps) {
  const [showFailed, setShowFailed] = useState(false);
  const activeAndPendingCount = (activeQuest ? 1 : 0) + pendingQuests.length;

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
          {pendingQuests.map((quest) => (
            <QuestCard key={quest.id} quest={quest} selected={selectedQuestId === quest.id} onSelect={onSelectQuest} />
          ))}
          {!activeQuest && pendingQuests.length === 0 ? <p className="quest-empty-state">The quest board is quiet. New pending quests will appear here.</p> : null}
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
