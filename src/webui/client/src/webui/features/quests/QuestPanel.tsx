import { useEffect, useMemo, useState } from 'react';
import type { PipelineConfig } from '../../../loadoutModel.js';
import type { QuestSummary } from '../../types.js';
import { QuestCreateForm } from './QuestCreateForm.js';
import { QuestDetail } from './QuestDetail.js';
import { QuestLogSidebar } from './QuestLogSidebar.js';
import { useQuestBoard } from './useQuestBoard.js';

const activeStatuses = new Set(['running']);
const pendingStatuses = new Set(['pending']);
const completedStatuses = new Set(['succeeded']);
const failedStatuses = new Set(['failed', 'blocked']);

function uniqueQuests(quests: Array<QuestSummary | undefined>): QuestSummary[] {
  const seen = new Set<string>();
  const result: QuestSummary[] = [];
  for (const quest of quests) {
    if (!quest || seen.has(quest.id)) continue;
    seen.add(quest.id);
    result.push(quest);
  }
  return result;
}

interface QuestPanelProps {
  persistedLoadouts?: Record<string, PipelineConfig>;
}

export function QuestPanel({ persistedLoadouts = {} }: QuestPanelProps) {
  const { board, loading, error, refresh, add, submitting, reorder, reorderSubmitting, requeue, requeueSubmitting } = useQuestBoard();
  const [selectedQuestId, setSelectedQuestId] = useState<string>();

  const grouped = useMemo(() => {
    const allQuests = board?.quests ?? [];
    const activeQuest = board?.activeQuest ?? board?.runningQuest ?? allQuests.find((quest) => activeStatuses.has(quest.status));
    const pendingQuests = uniqueQuests([...(board?.pendingQuests ?? []), ...allQuests.filter((quest) => pendingStatuses.has(quest.status))])
      .filter((quest) => quest.id !== activeQuest?.id && quest.status === 'pending');
    const completedQuests = uniqueQuests([...(board?.completedQuests ?? []), ...allQuests.filter((quest) => completedStatuses.has(quest.status))])
      .filter((quest) => quest.status === 'succeeded');
    const failedQuests = uniqueQuests([...(board?.failedQuests ?? []), ...allQuests.filter((quest) => failedStatuses.has(quest.status))])
      .filter((quest) => quest.status === 'failed' || quest.status === 'blocked');
    return { activeQuest, pendingQuests, completedQuests, failedQuests };
  }, [board]);

  const defaultDetailQuests = useMemo(() => uniqueQuests([
    grouped.activeQuest,
    ...grouped.pendingQuests,
    ...grouped.completedQuests,
  ]), [grouped]);

  const selectableQuests = useMemo(() => uniqueQuests([
    ...defaultDetailQuests,
    ...grouped.failedQuests,
  ]), [defaultDetailQuests, grouped.failedQuests]);

  useEffect(() => {
    if (selectedQuestId && selectableQuests.some((quest) => quest.id === selectedQuestId)) return;
    setSelectedQuestId(defaultDetailQuests[0]?.id);
  }, [defaultDetailQuests, selectableQuests, selectedQuestId]);

  const selectedQuest = selectableQuests.find((quest) => quest.id === selectedQuestId);

  return (
    <section className="quest-workspace" aria-labelledby="quests-panel-title">
      <div className="quest-workspace-banner fantasy-panel">
        <div>
          <p className="quest-kicker">Quest Log</p>
          <h2 id="quests-panel-title">Quests</h2>
          <p>Track the active adventure, pending work, and completed victories from the project quest board.</p>
        </div>
        <div className="quest-counts" aria-label="Quest counts">
          <span><strong>{grouped.activeQuest ? 1 : 0}</strong> active</span>
          <span><strong>{grouped.pendingQuests.length}</strong> pending</span>
          <span><strong>{grouped.completedQuests.length}</strong> complete</span>
        </div>
      </div>

      <QuestCreateForm persistedLoadouts={persistedLoadouts} onAddQuest={add} submitting={submitting} />

      <div className="quest-workspace-grid">
        <QuestLogSidebar
          activeQuest={grouped.activeQuest}
          pendingQuests={grouped.pendingQuests}
          completedQuests={grouped.completedQuests}
          failedQuests={grouped.failedQuests}
          selectedQuestId={selectedQuestId}
          reorderSubmitting={reorderSubmitting}
          onSelectQuest={setSelectedQuestId}
          onReorderQuest={reorder}
        />
        <QuestDetail
          quest={selectedQuest}
          boardPath={board?.boardPath}
          loading={loading}
          error={error}
          requeueSubmitting={requeueSubmitting}
          onRefresh={() => { void refresh(); }}
          onRequeue={(questId) => requeue({ questId })}
        />
      </div>
    </section>
  );
}
