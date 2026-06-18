import { cleanup, fireEvent, render, within } from '@testing-library/react';
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

});

describe('RuntimeEventFeed (raw JSON mode)', () => {
  it('renders every event as its own pretty-printed JSON block, newest-first', () => {
    const events = [
      makeEvent({ eventId: 'evt-3', sequence: 30, type: 'result.pr_created', message: 'newest' }),
      makeEvent({ eventId: 'evt-2', sequence: 20, type: 'status.progress', message: 'middle' }),
      makeEvent({ eventId: 'evt-1', sequence: 10, type: 'lifecycle.cast.started', message: 'oldest' }),
    ];

    const { container } = render(<RuntimeEventFeed events={events} mode="raw" />);

    const pres = container.querySelectorAll('.monitor-feed-raw-pre');
    expect(pres.length).toBe(3);

    // Newest-first snapshot order is preserved verbatim (the feed never re-sorts).
    const seqs = Array.from(pres).map((pre) => JSON.parse(pre.textContent ?? '{}').sequence);
    expect(seqs).toEqual([30, 20, 10]);
  });

  it('preserves the complete event object exactly as received, including unknown and nested fields', () => {
    const event = makeEvent({
      payload: { prUrl: 'https://github.com/org/repo/pull/42', branchName: 'agent/42-add-retry' },
      source: { materia: 'Blackbelt-GH-PR', socketId: 'Socket-7' },
      customMarker: 'keep-me',
      customNested: { ok: true, count: 3 },
    });

    const { container } = render(<RuntimeEventFeed events={[event]} mode="raw" />);

    const pre = container.querySelector('.monitor-feed-raw-pre');
    expect(pre).toBeTruthy();
    // The rendered JSON round-trips back to the exact event object received.
    expect(JSON.parse(pre?.textContent ?? 'null')).toEqual(event);
  });

  it('uses raw-specific rendering and omits the pretty ticker chrome', () => {
    const { container } = render(<RuntimeEventFeed events={[makeEvent()]} mode="raw" />);

    // Raw mode renders the JSON pre block...
    expect(container.querySelector('.monitor-feed-raw-pre')).toBeTruthy();
    // ...and does not render the pretty disclosure chrome.
    expect(container.querySelector('.monitor-event')).toBeNull();
    expect(container.querySelector('.monitor-event-toggle')).toBeNull();
    expect(container.querySelector('.monitor-event-badge')).toBeNull();
  });

  it('does not reorder events when switching between pretty and raw mode', () => {
    const events = [
      makeEvent({ eventId: 'evt-3', sequence: 30, type: 'result.pr_created' }),
      makeEvent({ eventId: 'evt-2', sequence: 20, type: 'status.progress' }),
      makeEvent({ eventId: 'evt-1', sequence: 10, type: 'lifecycle.cast.started' }),
    ];

    const { container, rerender } = render(<RuntimeEventFeed events={events} mode="pretty" />);
    const prettySeqs = Array.from(container.querySelectorAll('.monitor-event-seq')).map((node) =>
      Number(node.textContent?.replace('#', '')),
    );

    rerender(<RuntimeEventFeed events={events} mode="raw" />);
    const rawSeqs = Array.from(container.querySelectorAll('.monitor-feed-raw-pre')).map((pre) =>
      JSON.parse(pre.textContent ?? '{}').sequence,
    );

    // Both modes render the identical snapshot order; switching never reorders.
    expect(rawSeqs).toEqual(prettySeqs);
    expect(rawSeqs).toEqual([30, 20, 10]);
  });
});

describe('RuntimeEventFeed (expandable pretty details)', () => {
  it('renders collapsed rows by default with an accessible disclosure toggle', () => {
    const { container } = render(<RuntimeEventFeed events={[makeEvent()]} mode="pretty" />);

    const toggle = container.querySelector('.monitor-event-toggle') as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBeTruthy();
    expect(toggle.getAttribute('aria-label')).toContain('Expand');

    // Collapsed: no details region is rendered.
    expect(container.querySelector('.monitor-event-details')).toBeNull();
  });

  it('expands on click to reveal runtime metadata, source, and payload', () => {
    const event = makeEvent({
      payload: { prUrl: 'https://github.com/org/repo/pull/42', branchName: 'agent/42-add-retry' },
      source: { materia: 'Blackbelt-GH-PR', socketId: 'Socket-7' },
    });
    const { container } = render(<RuntimeEventFeed events={[event]} mode="pretty" />);

    const toggle = container.querySelector('.monitor-event-toggle') as HTMLButtonElement;
    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toContain('Collapse');

    const details = container.querySelector('.monitor-event-details') as HTMLElement;
    expect(details).toBeTruthy();
    expect(details.id).toBe(toggle.getAttribute('aria-controls'));

    // Runtime metadata (raw timestamp + ids elided by the compact ticker).
    expect(within(details).getByText('Event ID')).toBeTruthy();
    expect(within(details).getByText('evt-001')).toBeTruthy();
    expect(within(details).getByText('Occurred at')).toBeTruthy();
    expect(within(details).getByText('2026-06-17T22:00:00.000Z')).toBeTruthy();
    // Self-reported source provenance.
    expect(within(details).getByText('Source materia')).toBeTruthy();
    expect(within(details).getByText('Source socket')).toBeTruthy();
    // Payload pretty-printed as JSON.
    expect(within(details).getByText('Payload')).toBeTruthy();
    expect(
      within(details).getByText(/"prUrl":\s*"https:\/\/github\.com\/org\/repo\/pull\/42"/),
    ).toBeTruthy();
  });

  it('collapses an expanded event when toggled again', () => {
    const { container } = render(
      <RuntimeEventFeed events={[makeEvent({ payload: { phase: 'validation' } })]} mode="pretty" />,
    );

    const toggle = container.querySelector('.monitor-event-toggle') as HTMLButtonElement;
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.monitor-event-details')).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.monitor-event-details')).toBeNull();
  });

  it('preserves expansion across snapshot refreshes keyed by eventId', () => {
    const event = makeEvent({ eventId: 'evt-persist', payload: { phase: 'validation' } });
    const { container, rerender } = render(<RuntimeEventFeed events={[event]} mode="pretty" />);

    const toggle = container.querySelector('.monitor-event-toggle') as HTMLButtonElement;
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    // Simulate an SSE snapshot refresh: a newer event is prepended (newest-first)
    // while the expanded event reappears with the same eventId.
    const refreshed: RuntimeEvent[] = [
      makeEvent({ eventId: 'evt-newer', sequence: 99, type: 'status.progress', message: 'newer' }),
      { ...event },
    ];
    rerender(<RuntimeEventFeed events={refreshed} mode="pretty" />);

    const rows = container.querySelectorAll('.monitor-event');
    const persistedRow = Array.from(rows).find(
      (row) => row.querySelector('.monitor-event-type')?.textContent === 'result.pr_created',
    );
    expect(persistedRow).toBeTruthy();
    const persistedToggle = persistedRow?.querySelector('.monitor-event-toggle') as HTMLButtonElement;
    expect(persistedToggle.getAttribute('aria-expanded')).toBe('true');
    expect(persistedRow?.querySelector('.monitor-event-details')).toBeTruthy();
  });

  it('expands each row independently', () => {
    const events = [
      makeEvent({ eventId: 'evt-a', sequence: 1 }),
      makeEvent({ eventId: 'evt-b', sequence: 2, payload: { ok: true } }),
    ];
    const { container } = render(<RuntimeEventFeed events={events} mode="pretty" />);

    const toggles = container.querySelectorAll('.monitor-event-toggle');
    fireEvent.click(toggles[1]);

    expect(toggles[0].getAttribute('aria-expanded')).toBe('false');
    expect(toggles[1].getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('.monitor-event-details').length).toBe(1);
  });

  it('exposes an accessible expand/collapse label including sequence', () => {
    const { container } = render(
      <RuntimeEventFeed events={[makeEvent({ sequence: 42, type: 'result.pr_created' })]} mode="pretty" />,
    );

    const toggle = container.querySelector('.monitor-event-toggle') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-label')).toBe('Expand result.pr_created event #42');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-label')).toBe('Collapse result.pr_created event #42');
  });
});
