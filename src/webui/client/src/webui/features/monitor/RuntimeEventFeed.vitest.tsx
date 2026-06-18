import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeEvent } from '../../types.js';
import { formatEventTime } from './runtimeEventFormat.js';
import { RuntimeEventFeed } from './RuntimeEventFeed.js';

function makeEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    eventId: 'evt-001',
    type: 'result.pr_created',
    severity: 'info',
    message: 'PR #42 created',
    occurredAt: '2026-06-17T22:00:00.000Z',
    sequence: 12,
    castId: 'cast-1',
    socketId: 'Socket-7',
    materia: 'Blackbelt-GH-PR',
    materiaLabel: 'GitHub PR Creator',
    visit: 1,
    itemKey: 'WI-3',
    itemLabel: 'feat: implement retry logic',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('RuntimeEventFeed (pretty ticker)', () => {
  it('renders events newest-first in the order provided by the snapshot', () => {
    // The snapshot contract returns runtimeEvents newest-first. The feed must
    // preserve that order (it never re-sorts).
    const events = [
      makeEvent({ eventId: 'evt-3', sequence: 30, type: 'result.pr_created', message: 'newest' }),
      makeEvent({ eventId: 'evt-2', sequence: 20, type: 'status.progress', message: 'middle' }),
      makeEvent({ eventId: 'evt-1', sequence: 10, type: 'lifecycle.cast.started', message: 'oldest' }),
    ];

    const { container } = render(<RuntimeEventFeed events={events} mode="pretty" />);

    const seqs = Array.from(container.querySelectorAll('.monitor-event-seq')).map((node) =>
      Number(node.textContent?.replace('#', '')),
    );
    expect(seqs).toEqual([30, 20, 10]);

    const types = Array.from(container.querySelectorAll('.monitor-event-type')).map(
      (node) => node.textContent,
    );
    expect(types).toEqual(['result.pr_created', 'status.progress', 'lifecycle.cast.started']);
  });

  it('emphasizes all canonical fields on a collapsed pretty row', () => {
    const event = makeEvent();
    const { container } = render(<RuntimeEventFeed events={[event]} mode="pretty" />);

    const row = container.querySelector('.monitor-event');
    expect(row).toBeTruthy();
    expect(row?.className).toContain('monitor-event-severity-info');

    const badge = container.querySelector('.monitor-event-badge');
    expect(badge?.textContent).toBe('info'); // severity
    expect(container.querySelector('.monitor-event-type')?.textContent).toBe('result.pr_created'); // type
    expect(container.querySelector('.monitor-event-seq')?.textContent).toBe('#12'); // sequence
    expect(container.querySelector('.monitor-event-message')?.textContent).toBe('PR #42 created'); // message
    expect(container.querySelector('.monitor-event-time')?.textContent).toBe(
      formatEventTime(event.occurredAt),
    ); // occurredAt/time

    // Provenance line surfaces socketId, materiaLabel, itemLabel, and castId.
    const meta = container.querySelector('.monitor-event-meta');
    expect(meta).toBeTruthy();
    expect(meta?.textContent).toContain('Socket-7');
    expect(meta?.textContent).toContain('GitHub PR Creator');
    expect(meta?.textContent).toContain('feat: implement retry logic');
    expect(meta?.textContent).toContain('cast-1');
  });

  it('applies distinct severity styling for each canonical level', () => {
    const severities = ['debug', 'info', 'warning', 'error', 'critical'] as const;
    const events = severities.map((severity, index) => makeEvent({ severity, sequence: index }));
    const { container } = render(<RuntimeEventFeed events={events} mode="pretty" />);

    const rows = container.querySelectorAll('.monitor-event');
    expect(rows.length).toBe(severities.length);
    severities.forEach((severity, index) => {
      expect(rows[index].className).toContain(`monitor-event-severity-${severity}`);
      expect(rows[index].querySelector('.monitor-event-badge')?.textContent).toBe(severity);
    });
  });

  it('falls back gracefully when optional canonical fields are missing', () => {
    const sparse: RuntimeEvent = {
      eventId: 'evt-sparse',
      severity: 'warning',
      occurredAt: '2026-06-17T22:00:00.000Z',
    };

    const { container } = render(<RuntimeEventFeed events={[sparse]} mode="pretty" />);

    // type defaults to a generic placeholder; severity still rendered.
    expect(container.querySelector('.monitor-event-type')?.textContent).toBe('event');
    expect(container.querySelector('.monitor-event-badge')?.textContent).toBe('warning');

    // No message and no provenance fields -> those lines are absent.
    expect(container.querySelector('.monitor-event-message')).toBeNull();
    expect(container.querySelector('.monitor-event-seq')).toBeNull();
    expect(container.querySelector('.monitor-event-meta')).toBeNull();
  });

  it('falls back to materia id and item key when labels are absent', () => {
    const event = makeEvent({ materiaLabel: undefined, itemLabel: undefined });
    const { container } = render(<RuntimeEventFeed events={[event]} mode="pretty" />);

    const meta = container.querySelector('.monitor-event-meta')?.textContent ?? '';
    expect(meta).toContain('Blackbelt-GH-PR'); // materia id fallback
    expect(meta).toContain('WI-3'); // item key fallback
  });

  it('renders the full event as pretty-printed JSON in raw mode', () => {
    const event = makeEvent({ type: 'status.progress', message: 'Running unit tests', customMarker: 'keep-me' });
    const { container, getByText } = render(<RuntimeEventFeed events={[event]} mode="raw" />);

    const pre = container.querySelector('.monitor-feed-raw-pre');
    expect(pre).toBeTruthy();
    expect(getByText(/"type":\s*"status\.progress"/)).toBeTruthy();
    expect(getByText(/"customMarker":\s*"keep-me"/)).toBeTruthy();
  });
});
