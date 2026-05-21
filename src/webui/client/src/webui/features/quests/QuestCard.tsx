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

export function QuestCard({ quest, active = false, selected = false, onSelect }: QuestCardProps) {
  const summary = questSummary(quest);
  const label = active ? `Active quest: ${summary}` : `${statusLabels[quest.status]} quest: ${summary}`;
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
          <span className="quest-card-title">{summary}</span>
          {active ? <span className="quest-active-badge" aria-label="Active quest">Active</span> : null}
        </span>
        {castLabel ? <span className="quest-card-result-cast">{castLabel}</span> : null}
        <span className={`quest-status-pill quest-status-${quest.status}`}>{statusLabels[quest.status]}</span>
      </span>
    </button>
  );
}
