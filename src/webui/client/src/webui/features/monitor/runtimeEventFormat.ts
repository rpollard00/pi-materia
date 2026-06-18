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
