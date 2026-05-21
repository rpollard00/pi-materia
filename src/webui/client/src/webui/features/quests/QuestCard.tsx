import type { QuestSummary } from '../../types.js';
import { resultCastLabel } from './questResultCast.js';

interface QuestCardProps {
  quest: QuestSummary;
  active?: boolean;
  selected?: boolean;
  onSelect: (questId: string) => void;
}

const statusLabels: Record<QuestSummary['status'], string> = {
  pending: 'Pending',
  running: 'Active',
  succeeded: 'Completed',
  failed: 'Failed',
  blocked: 'Blocked',
};

function questPreview(quest: QuestSummary): string {
  return (quest.promptPreview || quest.prompt || quest.title).replace(/\s+/g, ' ').trim();
}

export function QuestCard({ quest, active = false, selected = false, onSelect }: QuestCardProps) {
  const label = active ? `Active quest: ${quest.title}` : `${statusLabels[quest.status]} quest: ${quest.title}`;
  const castLabel = quest.status === 'pending' || quest.status === 'running' ? undefined : resultCastLabel(quest);
  return (
    <button
      type="button"
      className={`quest-card${active ? ' quest-card-active' : ''}${selected ? ' quest-card-selected' : ''}`}
      onClick={() => onSelect(quest.id)}
      aria-pressed={selected}
      aria-label={label}
    >
      <span className="quest-card-rune" aria-hidden="true">{active ? '★' : quest.status === 'succeeded' ? '✓' : '•'}</span>
      <span className="quest-card-copy">
        <span className="quest-card-title-row">
          <span className="quest-card-title">{quest.title}</span>
          {active ? <span className="quest-active-badge" aria-label="Active quest">Active</span> : null}
        </span>
        <span className="quest-card-preview">{questPreview(quest)}</span>
        {castLabel ? <span className="quest-card-result-cast">{castLabel}</span> : null}
        <span className={`quest-status-pill quest-status-${quest.status}`}>{statusLabels[quest.status]}</span>
      </span>
    </button>
  );
}
