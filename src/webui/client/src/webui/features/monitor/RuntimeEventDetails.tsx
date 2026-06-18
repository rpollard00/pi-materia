import type { RuntimeEvent } from '../../types.js';
import {
  runtimeMetadataFields,
  sourceMetadataFields,
  unknownEventFields,
} from './runtimeEventFormat.js';

export interface RuntimeEventDetailsProps {
  event: RuntimeEvent;
  /** Id shared with the row toggle's `aria-controls` for the disclosure widget. */
  id: string;
}

/**
 * Expanded details for a single runtime event in the pretty feed.
 *
 * Renders structured runtime metadata, self-reported source provenance, the
 * materia-emitted payload, and any forward-compatible unknown fields. Nested
 * values are pretty-printed as JSON for readable debugging
 * (docs/runtime-eventing.md §3.3).
 *
 * This component only renders when a row is expanded; the collapsed ticker
 * summary is owned by {@link RuntimeEventFeed}.
 */
export function RuntimeEventDetails({ event, id }: RuntimeEventDetailsProps) {
  const metadata = runtimeMetadataFields(event);
  const sourceFields = sourceMetadataFields(event);
  const payload = event.payload !== null && typeof event.payload === 'object' ? event.payload : null;
  const unknowns = unknownEventFields(event);
  const hasUnknowns = Object.keys(unknowns).length > 0;
  const hasAny = metadata.length > 0 || sourceFields.length > 0 || payload !== null || hasUnknowns;

  return (
    <div id={id} className="monitor-event-details">
      {metadata.length > 0 ? (
        <dl className="monitor-event-detail-list">
          {metadata.map((field) => (
            <div className="monitor-event-detail-row" key={field.label}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {sourceFields.length > 0 ? (
        <dl className="monitor-event-detail-list">
          {sourceFields.map((field) => (
            <div className="monitor-event-detail-row" key={field.label}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {payload !== null ? (
        <div className="monitor-event-detail-block">
          <p className="monitor-event-detail-label">Payload</p>
          <pre className="monitor-event-detail-pre">{JSON.stringify(payload, null, 2)}</pre>
        </div>
      ) : null}

      {hasUnknowns ? (
        <div className="monitor-event-detail-block">
          <p className="monitor-event-detail-label">Additional fields</p>
          <pre className="monitor-event-detail-pre">{JSON.stringify(unknowns, null, 2)}</pre>
        </div>
      ) : null}

      {!hasAny ? <p className="monitor-event-detail-empty">No additional details</p> : null}
    </div>
  );
}
