import type { RuntimeEvent, RuntimeEventSeverity } from '../../types.js';
import {
  RUNTIME_EVENT_SEVERITIES,
  normalizeSeverity,
} from './runtimeEventFormat.js';

/**
 * Severity filter values surfaced by the runtime event monitor toolbar.
 *
 * `'all'` shows every event; each canonical severity restricts the feed to a
 * single level. Severities are sourced from {@link RUNTIME_EVENT_SEVERITIES}
 * so the dropdown can never drift from the event contract.
 */
export type MonitorSeverityFilter = RuntimeEventSeverity | 'all';

/** Default filter: show every event until the user narrows the feed. */
export const DEFAULT_SEVERITY_FILTER: MonitorSeverityFilter = 'all';

/** Title-case a single canonical severity for display (e.g. `warning` -> `Warning`). */
function severityLabel(severity: RuntimeEventSeverity): string {
  return severity[0].toUpperCase() + severity.slice(1);
}

/**
 * Severity filter options for the compact dropdown, in display order.
 *
 * `All levels` always leads so the broadest view is one click away, followed by
 * the canonical contract severities in their defined order. The raw `value`
 * stays lowercase to match the recorded event shape; only the label is
 * title-cased for the menu.
 */
export const SEVERITY_FILTER_OPTIONS: ReadonlyArray<{
  value: MonitorSeverityFilter;
  label: string;
}> = [
  { value: 'all', label: 'All levels' },
  ...RUNTIME_EVENT_SEVERITIES.map((severity) => ({
    value: severity,
    label: severityLabel(severity),
  })),
];

/**
 * Resolve the display label for a filter value (falls back to the raw value).
 *
 * Centralizes label lookup so the trigger title and the filtered empty state
 * stay in sync with {@link SEVERITY_FILTER_OPTIONS}.
 */
export function severityFilterLabel(filter: MonitorSeverityFilter): string {
  return SEVERITY_FILTER_OPTIONS.find((option) => option.value === filter)?.label ?? filter;
}

/**
 * Restrict a newest-first event list to the selected severity.
 *
 * Uses {@link normalizeSeverity} so events that omit or carry an unrecognized
 * severity keep normalizing to `info` (and therefore still match the `info`
 * filter). Order and identity are preserved: the caller renders newest-first.
 *
 * For `'all'` the input is returned untouched so the default path stays cheap
 * and reference-stable for memoization/scroll hooks; a narrowed filter returns
 * a fresh filtered array.
 */
export function filterRuntimeEventsBySeverity(
  events: readonly RuntimeEvent[],
  filter: MonitorSeverityFilter,
): readonly RuntimeEvent[] {
  if (filter === 'all') return events;
  return events.filter((event) => normalizeSeverity(event.severity) === filter);
}
