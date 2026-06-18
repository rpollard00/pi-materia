import { useState } from 'react';
import type { RuntimeEvent } from '../../types.js';
import { RuntimeEventDetails } from './RuntimeEventDetails.js';
import {
  castLabel,
  eventKey,
  formatEventTime,
  itemLabel,
  materiaLabel,
  normalizeSeverity,
  rawEventJson,
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
 *   optional fields. Each row is a disclosure widget: expanding it reveals
 *   structured runtime metadata, source, payload, and unknown fields without
 *   disturbing the compact ticker. Expansion state is keyed by stable event id
 *   so it survives SSE snapshot refreshes.
 * - **Raw**: each event pretty-printed as JSON, preserving the full recorded
 *   object verbatim (including forward-compatible unknown fields) for debugging.
 */
export interface RuntimeEventFeedProps {
  events: readonly RuntimeEvent[];
  mode: MonitorEventViewMode;
}

/** Expansion state keyed by stable event id so it survives snapshot refreshes. */
type ExpansionState = Record<string, boolean>;

export function RuntimeEventFeed({ events, mode }: RuntimeEventFeedProps) {
  const [expanded, setExpanded] = useState<ExpansionState>({});

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = { ...prev };
      if (next[key]) {
        delete next[key];
      } else {
        next[key] = true;
      }
      return next;
    });
  };

  if (mode === 'raw') {
    return (
      <ul className="monitor-feed-list" aria-label="Runtime events (raw JSON)">
        {events.map((event, index) => (
          <li key={eventKey(event, index)} className="monitor-feed-raw">
            <pre className="monitor-feed-raw-pre">{rawEventJson(event)}</pre>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ul className="monitor-feed-list" aria-label="Runtime events">
      {events.map((event, index) => {
        const key = eventKey(event, index);
        const severity = normalizeSeverity(event.severity);
        const isExpanded = expanded[key] === true;
        const detailsId = `monitor-event-details-${key}`;
        const provenance = [
          event.socketId,
          materiaLabel(event),
          itemLabel(event),
          castLabel(event),
        ].filter((value): value is string => typeof value === 'string' && value.length > 0);
        const summary = event.type ?? 'event';
        const toggleLabel = `${isExpanded ? 'Collapse' : 'Expand'} ${summary} event${
          typeof event.sequence === 'number' ? ` #${event.sequence}` : ''
        }`;
        return (
          <li
            key={key}
            className={`monitor-event ${severityClassName(event.severity)}${
              isExpanded ? ' monitor-event-expanded' : ''
            }`}
          >
            <button
              type="button"
              className="monitor-event-toggle"
              aria-expanded={isExpanded}
              aria-controls={detailsId}
              aria-label={toggleLabel}
              onClick={() => toggleExpanded(key)}
            >
              <span className={`monitor-event-badge ${severityClassName(event.severity)}`}>{severity}</span>
              <b className="monitor-event-type">{summary}</b>
              {typeof event.sequence === 'number' && (
                <span className="monitor-event-seq">#{event.sequence}</span>
              )}
              <span className="monitor-event-time">{formatEventTime(event.occurredAt)}</span>
              <span className="monitor-event-caret" aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
            </button>
            {event.message ? <p className="monitor-event-message">{event.message}</p> : null}
            {provenance.length > 0 ? <p className="monitor-event-meta">{provenance.join(' · ')}</p> : null}
            {isExpanded ? <RuntimeEventDetails event={event} id={detailsId} /> : null}
          </li>
        );
      })}
    </ul>
  );
}
