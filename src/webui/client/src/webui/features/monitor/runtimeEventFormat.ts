import type { RuntimeEvent, RuntimeEventSeverity } from '../../types.js';

/**
 * Formatting helpers for the runtime event monitor feed.
 *
 * These pure helpers keep event rendering small, deterministic, and testable.
 * They mirror the canonical enriched event shape from
 * docs/runtime-eventing.md §3.3 and tolerate partial/malformed recorded events
 * (all inputs are typed `unknown` where the recorded artifact may omit fields).
 */

/** Monitor feed view modes for the Pretty/Raw toggle. */
export type MonitorEventViewMode = 'pretty' | 'raw';

/** Canonical severity levels (docs/runtime-eventing.md §2.3). */
const SEVERITIES: ReadonlySet<string> = new Set([
  'debug',
  'info',
  'warning',
  'error',
  'critical',
]);

/** Severity used when an event omits or carries an unrecognized severity. */
export const DEFAULT_SEVERITY: RuntimeEventSeverity = 'info';

/**
 * Normalize an unknown severity value into a canonical severity.
 *
 * Unknown/non-string values fall back to {@link DEFAULT_SEVERITY} so the feed
 * never throws on a partially recorded event.
 */
export function normalizeSeverity(severity: unknown): RuntimeEventSeverity {
  return typeof severity === 'string' && SEVERITIES.has(severity)
    ? (severity as RuntimeEventSeverity)
    : DEFAULT_SEVERITY;
}

/** Stable CSS modifier class identifying the canonical severity for styling. */
export function severityClassName(severity: unknown): string {
  return `monitor-event-severity-${normalizeSeverity(severity)}`;
}

/**
 * Format an event's `occurredAt` ISO timestamp as a compact local time.
 *
 * Returns an em-dash placeholder for missing/invalid timestamps so the ticker
 * layout stays stable.
 */
export function formatEventTime(occurredAt: unknown): string {
  if (typeof occurredAt !== 'string' || occurredAt.length === 0) return '—';
  const date = new Date(occurredAt);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return '—';
  return date.toLocaleTimeString();
}

/** Prefer the materia display label, falling back to the materia id. */
export function materiaLabel(event: RuntimeEvent): string {
  return event.materiaLabel || event.materia || '';
}

/** Prefer the work-item label, falling back to the work-item key. */
export function itemLabel(event: RuntimeEvent): string {
  return event.itemLabel || event.itemKey || '';
}

/**
 * Return the cast id when present and useful for the collapsed ticker.
 *
 * `castId` is shared across all events in a single-cast feed, so the caller
 * is free to omit it; this helper only surfaces the value so the provenance
 * line never throws on a partial event.
 */
export function castLabel(event: RuntimeEvent): string {
  return typeof event.castId === 'string' && event.castId.length > 0 ? event.castId : '';
}

/**
 * Stable React key for an event.
 *
 * Prefers the enriched `eventId`; falls back to `sequence` then the render
 * index so partially recorded events still key deterministically.
 */
export function eventKey(event: RuntimeEvent, index: number): string {
  if (typeof event.eventId === 'string' && event.eventId.length > 0) return event.eventId;
  if (typeof event.sequence === 'number') return `seq-${event.sequence}`;
  return `idx-${index}`;
}

/**
 * Canonical event field names (runtime-enriched + materia-emitted).
 *
 * Used to separate forward-compatible unknown fields from the canonical
 * contract when rendering expanded details (docs/runtime-eventing.md §3.3).
 */
export const CANONICAL_EVENT_FIELDS: readonly string[] = [
  // Runtime-enriched
  'eventId',
  'occurredAt',
  'sequence',
  'castId',
  'socketId',
  'materia',
  'materiaLabel',
  'visit',
  'itemKey',
  'itemLabel',
  // Materia-emitted
  'type',
  'severity',
  'message',
  'payload',
  'source',
];

const CANONICAL_EVENT_FIELD_SET: ReadonlySet<string> = new Set(CANONICAL_EVENT_FIELDS);

/** A labeled key/value pair rendered in the expanded event details. */
export interface EventDetailField {
  label: string;
  value: string;
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Runtime metadata pairs for the expanded details view.
 *
 * Surfaces the enriched provenance fields verbatim (raw `occurredAt` ISO,
 * `eventId`, `visit`, materia/item ids) that the compact ticker elides or
 * formats. Missing fields are omitted so the details view stays readable.
 */
export function runtimeMetadataFields(event: RuntimeEvent): EventDetailField[] {
  const fields: EventDetailField[] = [];
  const push = (label: string, value: string | null) => {
    if (value !== null) fields.push({ label, value });
  };
  push('Event ID', textValue(event.eventId));
  push('Sequence', typeof event.sequence === 'number' ? String(event.sequence) : null);
  push('Occurred at', textValue(event.occurredAt));
  push('Cast', textValue(event.castId));
  push('Socket', textValue(event.socketId));
  push('Visit', typeof event.visit === 'number' ? String(event.visit) : null);
  push('Materia', textValue(event.materia));
  push('Materia label', textValue(event.materiaLabel));
  push('Item key', textValue(event.itemKey));
  push('Item', textValue(event.itemLabel));
  return fields;
}

/**
 * Self-reported source provenance pairs (`source.materia` / `source.socketId`).
 *
 * Returns an empty list when `source` is absent, null, or non-object so a
 * malformed recorded event never throws.
 */
export function sourceMetadataFields(event: RuntimeEvent): EventDetailField[] {
  const source = event.source;
  const fields: EventDetailField[] = [];
  if (source === null || typeof source !== 'object') return fields;
  const record = source as { materia?: unknown; socketId?: unknown };
  const materia = textValue(record.materia);
  const socketId = textValue(record.socketId);
  if (materia !== null) fields.push({ label: 'Source materia', value: materia });
  if (socketId !== null) fields.push({ label: 'Source socket', value: socketId });
  return fields;
}

/**
 * Return a shallow copy of the event's forward-compatible unknown fields.
 *
 * Any key outside the canonical contract (§3.3) is preserved verbatim so the
 * expanded details and raw debugging views surface everything that was
 * recorded, including nested values.
 */
export function unknownEventFields(event: RuntimeEvent): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (!CANONICAL_EVENT_FIELD_SET.has(key)) {
      result[key] = value;
    }
  }
  return result;
}
