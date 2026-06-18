import { describe, expect, it } from 'vitest';
import type { RuntimeEvent } from '../../types.js';
import {
  DEFAULT_SEVERITY,
  CANONICAL_EVENT_FIELDS,
  castLabel,
  eventKey,
  formatEventTime,
  itemLabel,
  materiaLabel,
  normalizeSeverity,
  runtimeMetadataFields,
  severityClassName,
  sourceMetadataFields,
  unknownEventFields,
} from './runtimeEventFormat.js';

describe('runtimeEventFormat', () => {
  it('normalizes known severities and falls back to the default', () => {
    expect(normalizeSeverity('info')).toBe('info');
    expect(normalizeSeverity('critical')).toBe('critical');
    expect(normalizeSeverity('bogus')).toBe(DEFAULT_SEVERITY);
    expect(normalizeSeverity(undefined)).toBe(DEFAULT_SEVERITY);
    expect(normalizeSeverity(42)).toBe(DEFAULT_SEVERITY);
  });

  it('derives a stable severity modifier class', () => {
    expect(severityClassName('error')).toBe('monitor-event-severity-error');
    expect(severityClassName(undefined)).toBe(`monitor-event-severity-${DEFAULT_SEVERITY}`);
  });

  it('formats valid ISO timestamps and placeholders for invalid input', () => {
    expect(formatEventTime('2026-06-17T22:00:00.000Z')).toMatch(/\d/);
    expect(formatEventTime('not-a-date')).toBe('—');
    expect(formatEventTime('')).toBe('—');
    expect(formatEventTime(undefined)).toBe('—');
  });

  it('prefers materia label over id with an empty fallback', () => {
    expect(materiaLabel({ materiaLabel: 'GitHub PR Creator', materia: 'Blackbelt-GH-PR' } as RuntimeEvent)).toBe('GitHub PR Creator');
    expect(materiaLabel({ materia: 'Blackbelt-GH-PR' } as RuntimeEvent)).toBe('Blackbelt-GH-PR');
    expect(materiaLabel({} as RuntimeEvent)).toBe('');
  });

  it('prefers work-item label over key with an empty fallback', () => {
    expect(itemLabel({ itemLabel: 'feat: retry', itemKey: 'WI-3' } as RuntimeEvent)).toBe('feat: retry');
    expect(itemLabel({ itemKey: 'WI-3' } as RuntimeEvent)).toBe('WI-3');
    expect(itemLabel({} as RuntimeEvent)).toBe('');
  });

  it('surfaces the cast id when present and an empty fallback otherwise', () => {
    expect(castLabel({ castId: 'cast-1' } as RuntimeEvent)).toBe('cast-1');
    expect(castLabel({ castId: '' } as RuntimeEvent)).toBe('');
    expect(castLabel({} as RuntimeEvent)).toBe('');
    expect(castLabel({ castId: 42 } as unknown as RuntimeEvent)).toBe('');
  });

  it('keys events by eventId, then sequence, then render index', () => {
    expect(eventKey({ eventId: 'evt-1' } as RuntimeEvent, 0)).toBe('evt-1');
    expect(eventKey({ sequence: 7 } as RuntimeEvent, 1)).toBe('seq-7');
    expect(eventKey({} as RuntimeEvent, 3)).toBe('idx-3');
  });
});

describe('expanded detail helpers', () => {
  it('extracts runtime metadata pairs in a stable order, omitting missing fields', () => {
    expect(runtimeMetadataFields({} as RuntimeEvent)).toEqual([]);

    const pairs = runtimeMetadataFields({
      eventId: 'evt-1',
      sequence: 7,
      occurredAt: '2026-06-17T22:00:00.000Z',
      castId: 'cast-1',
      socketId: 'Socket-7',
      visit: 2,
      materia: 'Blackbelt-GH-PR',
      materiaLabel: 'GitHub PR Creator',
      itemKey: 'WI-3',
      itemLabel: 'feat: retry',
    } as RuntimeEvent);

    expect(pairs.map((p) => p.label)).toEqual([
      'Event ID',
      'Sequence',
      'Occurred at',
      'Cast',
      'Socket',
      'Visit',
      'Materia',
      'Materia label',
      'Item key',
      'Item',
    ]);
    expect(pairs[0]).toEqual({ label: 'Event ID', value: 'evt-1' });
    expect(pairs[1]).toEqual({ label: 'Sequence', value: '7' });
  });

  it('extracts source provenance and tolerates a malformed source', () => {
    expect(sourceMetadataFields({} as RuntimeEvent)).toEqual([]);
    expect(sourceMetadataFields({ source: null } as unknown as RuntimeEvent)).toEqual([]);
    expect(sourceMetadataFields({ source: 'nope' } as RuntimeEvent)).toEqual([]);
    expect(
      sourceMetadataFields({ source: { materia: 'Blackbelt-GH-PR', socketId: 'Socket-7' } } as RuntimeEvent),
    ).toEqual([
      { label: 'Source materia', value: 'Blackbelt-GH-PR' },
      { label: 'Source socket', value: 'Socket-7' },
    ]);
  });

  it('isolates forward-compatible unknown fields from canonical ones', () => {
    expect(unknownEventFields({} as RuntimeEvent)).toEqual({});
    // Canonical fields are never reported as unknown.
    expect(unknownEventFields({ eventId: 'evt-1', payload: { a: 1 }, source: {} } as RuntimeEvent)).toEqual({});
    // Anything outside the contract is preserved verbatim, nested values included.
    const result = unknownEventFields({
      eventId: 'evt-1',
      custom: 'x',
      nested: { y: 2 },
    } as RuntimeEvent);
    expect(result).toEqual({ custom: 'x', nested: { y: 2 } });
  });

  it('lists the full canonical contract for unknown-field detection', () => {
    expect(CANONICAL_EVENT_FIELDS).toEqual([
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
      'type',
      'severity',
      'message',
      'payload',
      'source',
    ]);
  });
});
