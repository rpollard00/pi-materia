import { useMemo, useState } from 'react';
import type { MonitorSnapshot } from '../../types.js';
import { RuntimeEventFeed } from './RuntimeEventFeed.js';
import { SeverityFilterMenu } from './SeverityFilterMenu.js';
import type { MonitorEventViewMode } from './runtimeEventFormat.js';
import {
  DEFAULT_SEVERITY_FILTER,
  filterRuntimeEventsBySeverity,
  severityFilterLabel,
  type MonitorSeverityFilter,
} from './runtimeEventSeverityFilter.js';
import { useEventFeedScroll } from './useEventFeedScroll.js';

export interface MonitorPanelProps {
  monitor: MonitorSnapshot | undefined;
  currentMonitorSocket: string | undefined;
  elapsed: string;
}

/**
 * Runtime event monitor shell.
 *
 * Replaces the legacy emitted-outputs / artifact-summary / recent-artifacts
 * cards with a single runtime event feed (docs/runtime-eventing.md §5).
 *
 * The shell keeps the useful session header stats (socket, state, elapsed),
 * renders a Pretty/Raw toggle (Pretty selected by default), and shows an empty
 * state when no `runtimeEvents` are present. Existing snapshot fields remain
 * available on the prop for compatibility but the old cards are no longer
 * rendered. Feed rendering, expansion, raw mode, and scroll behavior are
 * layered on by the feed component and subsequent work items.
 */
export function MonitorPanel({ monitor, currentMonitorSocket, elapsed }: MonitorPanelProps) {
  const [viewMode, setViewMode] = useState<MonitorEventViewMode>('pretty');
  const [severityFilter, setSeverityFilter] = useState<MonitorSeverityFilter>(DEFAULT_SEVERITY_FILTER);
  const runtimeEvents = monitor?.runtimeEvents ?? [];
  // Apply the severity filter before anything else reads the event list so the
  // feed, the scroll controller, the count, and the empty state all see the
  // same filtered result for both Pretty and Raw modes. Memoized on the
  // snapshot array + filter so the scroll hook's identity-based dependency
  // only re-runs when one of those actually changes.
  const filteredEvents = useMemo(
    () => filterRuntimeEventsBySeverity(runtimeEvents, severityFilter),
    [runtimeEvents, severityFilter],
  );
  const totalCount = runtimeEvents.length;
  const filteredCount = filteredEvents.length;
  const isFiltered = severityFilter !== 'all';
  const hasNoEventsAtAll = totalCount === 0;
  // Newest events live at the top of the feed. While the user is at/near the
  // top the feed re-pins to the latest events; once they scroll back into older
  // events the visible position is preserved across snapshot refreshes, with a
  // Return to latest affordance to jump back to the top.
  const feedScroll = useEventFeedScroll(filteredEvents);

  return (
    <section className="fantasy-panel p-6" aria-label="Live session monitor">
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm uppercase tracking-[0.35em] text-cyan-200">session monitor</p>
          <h2 className="mt-2 text-3xl font-black text-white">Runtime event monitor</h2>
          <p className="mt-2 max-w-4xl text-sm text-slate-400">
            Live runtime event stream for the Pi session that launched <code>/materia ui</code>. Events emitted by materia and runtime lifecycle transitions stream in as the cast progresses, newest first.
          </p>
        </div>
        <div className="monitor-stat-grid">
          <div><span>socket</span><b>{currentMonitorSocket ?? 'idle'}</b></div>
          <div><span>state</span><b>{monitor?.activeCast?.socketState ?? 'no active cast'}</b></div>
          <div><span>elapsed</span><b>{elapsed}</b></div>
        </div>
      </div>

      <div className="monitor-feed-toolbar">
        <div className="monitor-feed-toolbar-group">
          <div className="monitor-view-toggle" role="group" aria-label="Event view mode">
            <button
              type="button"
              aria-pressed={viewMode === 'pretty'}
              className={viewMode === 'pretty' ? 'is-active' : undefined}
              onClick={() => setViewMode('pretty')}
            >
              Pretty
            </button>
            <button
              type="button"
              aria-pressed={viewMode === 'raw'}
              className={viewMode === 'raw' ? 'is-active' : undefined}
              onClick={() => setViewMode('raw')}
            >
              Raw
            </button>
          </div>
          <SeverityFilterMenu value={severityFilter} onChange={setSeverityFilter} />
        </div>
        <p className="monitor-feed-count" aria-live="polite">
          {filteredCount === 0
            ? 'No events'
            : isFiltered
              ? `${filteredCount} of ${totalCount} event${totalCount === 1 ? '' : 's'}`
              : `${filteredCount} event${filteredCount === 1 ? '' : 's'}`}
        </p>
      </div>

      <article className="monitor-card monitor-feed-card">
        {hasNoEventsAtAll ? (
          <div className="monitor-feed-empty" data-testid="monitor-feed-empty">
            <p className="monitor-feed-empty-title">No runtime events yet</p>
            <p className="monitor-feed-empty-hint">
              Events emitted by materia and runtime lifecycle transitions will appear here as the cast progresses.
            </p>
          </div>
        ) : filteredCount === 0 ? (
          <div className="monitor-feed-empty" data-testid="monitor-feed-empty">
            <p className="monitor-feed-empty-title">No events match the selected level</p>
            <p className="monitor-feed-empty-hint">
              No runtime events are recorded at the{' '}
              <strong>{severityFilterLabel(severityFilter)}</strong> level. Choose a different severity or
              <strong> All levels</strong> to see more events.
            </p>
          </div>
        ) : (
          <div className="monitor-feed-scroll-wrap">
            <div
              className="monitor-scroll monitor-feed-scroll"
              ref={feedScroll.containerRef}
              onScroll={feedScroll.onScroll}
              role="log"
              aria-label="Runtime events feed"
              aria-live="polite"
            >
              <RuntimeEventFeed events={filteredEvents} mode={viewMode} />
            </div>
            {feedScroll.showReturnToLatest ? (
              <button
                type="button"
                className="monitor-feed-latest"
                onClick={feedScroll.scrollToLatest}
                aria-label="Return to latest events"
              >
                <span aria-hidden="true">↑</span> Return to latest
              </button>
            ) : null}
          </div>
        )}
      </article>
    </section>
  );
}
