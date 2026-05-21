import type { QuestSummary } from '../../types.js';

export function resultCastId(quest: QuestSummary): string | undefined {
  return quest.lastResult?.castId || quest.lastCastId;
}

export function resultCastLabel(quest: QuestSummary): string | undefined {
  const castId = resultCastId(quest);
  if (!castId) return undefined;
  return quest.status === 'succeeded' ? `Completed in cast ${castId}` : `Result cast ${castId}`;
}
