import { describe, expect, it } from 'vitest';
import type { RuntimeEvent } from '../../types.js';
import { RUNTIME_EVENT_SEVERITIES } from './runtimeEventFormat.js';
import {
  DEFAULT_SEVERITY_FILTER,
  SEVERITY_FILTER_OPTIONS,
  filterRuntimeEventsBySeverity,
  severityFilterLabel,
  type MonitorSeverityFilter,
} from './runtimeEventSeverityFilter.js';

function event(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    eventId: 'evt-1',
    type: 'status.progress',
    severity: 'info',
    message: 'working',
    occurredAt: '2026-06-18T12:00:00.000Z',
    sequence: 1,
    ...overrides,
  };
}

describe('runtimeEventSeverityFilter options', () => {
  it('leads with an All levels option and follows with every contract severity in order', () => {
    expect(SEVERITY_FILTER_OPTIONS[0]).toEqual({ value: 'all', label: 'All levels' });

    const severities = SEVERITY_FILTER_OPTIONS.slice(1);
    expect(severities.map((option) => option.value)).toEqual([...RUNTIME_EVENT_SEVERITIES]);
    expect(severities.map((option) => option.label)).toEqual(
      RUNTIME_EVENT_SEVERITIES.map((severity) => severity[0].toUpperCase() + severity.slice(1)),
    );
  });

  it('keeps raw lowercase values so the filter cannot drift from the event contract', () => {
    // Display labels are title-cased, but the selectable value stays lowercase
    // to match the recorded event shape.
    for (const option of SEVERITY_FILTER_OPTIONS.slice(1)) {
      expect(option.value).toBe(option.label.toLowerCase());
    }
  });

  it('defaults to showing every event', () => {
    expect(DEFAULT_SEVERITY_FILTER).toBe('all');
  });
});

describe('severityFilterLabel', () => {
  it('resolves the display label for every option', () => {
    const expected: Record<MonitorSeverityFilter, string> = {
      all: 'All levels',
      debug: 'Debug',
      info: 'Info',
      warning: 'Warning',
      error: 'Error',
      critical: 'Critical',
    };
    for (const value of Object.keys(expected) as MonitorSeverityFilter[]) {
      expect(severityFilterLabel(value)).toBe(expected[value]);
    }
  });

  it('falls back to the raw value for an unrecognized filter', () => {
    // Defensive: keeps the empty-state copy readable even if a new value is
    // introduced before its label lands.
    expect(severityFilterLabel('bogus' as MonitorSeverityFilter)).toBe('bogus');
  });
});

describe('filterRuntimeEventsBySeverity', () => {
  const events: RuntimeEvent[] = [
    event({ eventId: 'e1', sequence: 1, severity: 'debug', message: 'debug-msg' }),
    event({ eventId: 'e2', sequence: 2, severity: 'info', message: 'info-msg' }),
    event({ eventId: 'e3', sequence: 3, severity: 'warning', message: 'warn-msg' }),
    event({ eventId: 'e4', sequence: 4, severity: 'error', message: 'error-msg' }),
    event({ eventId: 'e5', sequence: 5, severity: 'critical', message: 'critical-msg' }),
  ];

  it('returns the input untouched for the all filter so the default path stays reference-stable', () => {
    const result = filterRuntimeEventsBySeverity(events, 'all');
    expect(result).toBe(events);
  });

  it.each([
    ['debug', ['debug-msg']],
    ['info', ['info-msg']],
    ['warning', ['warn-msg']],
    ['error', ['error-msg']],
    ['critical', ['critical-msg']],
  ] as const)('restricts the feed to the %s level only', (filter, expectedMessages) => {
    const result = filterRuntimeEventsBySeverity(events, filter);
    expect(result.map((entry) => entry.message)).toEqual(expectedMessages);
  });

  it('preserves the newest-first order and event identity of the narrowed list', () => {
    const result = filterRuntimeEventsBySeverity(events, 'error');
    expect(result.map((entry) => entry.eventId)).toEqual(['e4']);
    // The filtered entries are the same objects, not copies.
    expect(result[0]).toBe(events[3]);
  });

  it('normalizes a missing severity to info so it still matches the info filter', () => {
    const withMissing: RuntimeEvent[] = [
      event({ eventId: 'm1', sequence: 10, message: 'missing-sev' }), // severity omitted
      event({ eventId: 'm2', sequence: 11, severity: 'info', message: 'explicit-info' }),
    ];

    expect(filterRuntimeEventsBySeverity(withMissing, 'info').map((entry) => entry.eventId)).toEqual([
      'm1',
      'm2',
    ]);
    // A missing severity never matches a non-info level.
    expect(filterRuntimeEventsBySeverity(withMissing, 'warning')).toEqual([]);
  });

  it('treats an unrecognized severity as info', () => {
    const withInvalid: RuntimeEvent[] = [
      event({ eventId: 'x1', sequence: 20, severity: 'bogus' as RuntimeEvent['severity'], message: 'bad-sev' }),
    ];

    expect(filterRuntimeEventsBySeverity(withInvalid, 'info').map((entry) => entry.eventId)).toEqual(['x1']);
    expect(filterRuntimeEventsBySeverity(withInvalid, 'critical')).toEqual([]);
  });

  it('returns a fresh array (not the input) when narrowing', () => {
    const result = filterRuntimeEventsBySeverity(events, 'warning');
    expect(result).not.toBe(events);
    expect(Array.isArray(result)).toBe(true);
  });
});
