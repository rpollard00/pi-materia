import { describe, expect, it } from 'vitest';
import type { RuntimeEvent } from '../../types.js';
import {
  DEFAULT_SEVERITY,
  castLabel,
  eventKey,
  formatEventTime,
  itemLabel,
  materiaLabel,
  normalizeSeverity,
  severityClassName,
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
