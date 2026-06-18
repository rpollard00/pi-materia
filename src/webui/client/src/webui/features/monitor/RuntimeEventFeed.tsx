import type { RuntimeEvent } from '../../types.js';
import {
  castLabel,
  eventKey,
  formatEventTime,
  itemLabel,
  materiaLabel,
  normalizeSeverity,
  severityClassName,
  type MonitorEventViewMode,
} from './runtimeEventFormat.js';

/**
 * Runtime event feed for the monitor tab.
 *
 * Renders the snapshot's newest-first `runtimeEvents` in either Pretty or Raw
 * mode. The shell ({@link MonitorPanel}) owns the view mode and empty state;
 * this component focuses on rendering a non-empty event list.
 *
 * - **Pretty**: compact ticker rows emphasizing the canonical enriched fields
 *   (docs/runtime-eventing.md §3.3). Each collapsed row surfaces severity,
 *   type, message, time, sequence, and provenance (socket, materia, work item,
 *   cast) with clear severity accents and graceful fallbacks for missing
 *   optional fields. Expand/collapse and scroll behavior are layered on by
 *   later work items.
 * - **Raw**: each event pretty-printed as JSON, preserving the full recorded
 *   object verbatim (including forward-compatible unknown fields) for debugging.
 */
export interface RuntimeEventFeedProps {
  events: RuntimeEvent[];
  mode: MonitorEventViewMode;
}

export function RuntimeEventFeed({ events, mode }: RuntimeEventFeedProps) {
  if (mode === 'raw') {
    return (
      <ul className="monitor-feed-list" aria-label="Runtime events (raw JSON)">
        {events.map((event, index) => (
          <li key={eventKey(event, index)} className="monitor-feed-raw">
            <pre className="monitor-feed-raw-pre">{JSON.stringify(event, null, 2)}</pre>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ul className="monitor-feed-list" aria-label="Runtime events">
      {events.map((event, index) => {
        const severity = normalizeSeverity(event.severity);
        const provenance = [
          event.socketId,
          materiaLabel(event),
          itemLabel(event),
          castLabel(event),
        ].filter((value): value is string => typeof value === 'string' && value.length > 0);
        return (
          <li key={eventKey(event, index)} className={`monitor-event ${severityClassName(event.severity)}`}>
            <div className="monitor-event-head">
              <span className={`monitor-event-badge ${severityClassName(event.severity)}`}>{severity}</span>
              <b className="monitor-event-type">{event.type ?? 'event'}</b>
              {typeof event.sequence === 'number' && (
                <span className="monitor-event-seq">#{event.sequence}</span>
              )}
              <span className="monitor-event-time">{formatEventTime(event.occurredAt)}</span>
            </div>
            {event.message ? <p className="monitor-event-message">{event.message}</p> : null}
            {provenance.length > 0 ? <p className="monitor-event-meta">{provenance.join(' · ')}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}
