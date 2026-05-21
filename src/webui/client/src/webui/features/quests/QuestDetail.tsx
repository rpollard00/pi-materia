import type { QuestSummary } from '../../types.js';
import { resultCastLabel } from './questResultCast.js';

interface QuestDetailProps {
  quest?: QuestSummary;
  boardPath?: string;
  loading?: boolean;
  error?: string;
  requeueSubmitting?: boolean;
  onRefresh: () => void;
  onRequeue?: (questId: string) => Promise<unknown> | unknown;
}

const statusLabels: Record<QuestSummary['status'], string> = {
  pending: 'Pending',
  running: 'Active',
  succeeded: 'Completed',
  failed: 'Failed',
  blocked: 'Blocked',
};

function formatDate(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function QuestDetail({ quest, boardPath, loading = false, error, requeueSubmitting = false, onRefresh, onRequeue }: QuestDetailProps) {
  if (!quest) {
    return (
      <section className="quest-detail fantasy-panel" aria-labelledby="quest-detail-title">
        <div className="quest-detail-heading">
          <div>
            <p className="quest-kicker">Quest Details</p>
            <h3 id="quest-detail-title">No quest selected</h3>
          </div>
          <button type="button" className="quest-refresh-button" onClick={onRefresh} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
        </div>
        {error ? <p className="quest-error" role="alert">{error}</p> : null}
        <p className="quest-detail-empty">Select a quest from the log, or wait for the board to receive its next adventure.</p>
        {boardPath ? <p className="quest-board-path">Board: {boardPath}</p> : null}
      </section>
    );
  }

  const createdAt = formatDate(quest.createdAt);
  const updatedAt = formatDate(quest.updatedAt);
  const finishedAt = formatDate(quest.lastResult?.finishedAt);
  const resultCast = resultCastLabel(quest);
  const canRequeue = quest.status === 'failed' || quest.status === 'blocked';

  return (
    <section className="quest-detail fantasy-panel" aria-labelledby="quest-detail-title">
      <div className="quest-detail-heading">
        <div>
          <p className="quest-kicker">Quest Details</p>
          <h3 id="quest-detail-title">{quest.title}</h3>
        </div>
        <div className="quest-detail-actions">
          {canRequeue && onRequeue ? (
            <button
              type="button"
              className="quest-requeue-button"
              onClick={() => { void onRequeue(quest.id); }}
              disabled={requeueSubmitting}
              aria-label={`Requeue ${quest.title}`}
            >
              {requeueSubmitting ? 'Requeueing…' : 'Requeue'}
            </button>
          ) : null}
          <button type="button" className="quest-refresh-button" onClick={onRefresh} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
        </div>
      </div>
      {error ? <p className="quest-error" role="alert">{error}</p> : null}

      <dl className="quest-detail-meta" aria-label="Quest metadata">
        <div><dt>Status</dt><dd><span className={`quest-status-pill quest-status-${quest.status}`}>{statusLabels[quest.status]}</span></dd></div>
        <div><dt>Loadout</dt><dd>{quest.loadoutOverride || quest.lastResult?.effectiveLoadoutName || 'Default'}</dd></div>
        <div><dt>Attempts</dt><dd>{quest.attempts}</dd></div>
        {quest.currentCastId || quest.lastCastId ? <div><dt>Cast</dt><dd>{quest.currentCastId || quest.lastCastId}</dd></div> : null}
        {createdAt ? <div><dt>Created</dt><dd>{createdAt}</dd></div> : null}
        {updatedAt ? <div><dt>Updated</dt><dd>{updatedAt}</dd></div> : null}
      </dl>

      <div className="quest-prompt-panel">
        <h4>Prompt</h4>
        <p>{quest.prompt || quest.promptPreview || 'No prompt recorded for this quest.'}</p>
      </div>

      {quest.lastResult ? (
        <div className="quest-result-panel">
          <h4>Last result</h4>
          <p>{quest.lastResult.message || quest.lastResult.error || `Finished as ${quest.lastResult.status}.`}</p>
          {resultCast ? <p className="quest-result-cast">{resultCast}</p> : null}
          {finishedAt ? <p className="quest-result-time">Finished {finishedAt}</p> : null}
        </div>
      ) : null}
      {quest.lastError ? <p className="quest-error" role="alert">Last error: {quest.lastError.message}</p> : null}
      {boardPath ? <p className="quest-board-path">Board: {boardPath}</p> : null}
    </section>
  );
}
