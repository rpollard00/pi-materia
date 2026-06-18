import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MonitorPanel } from './MonitorPanel.js';
import type { MonitorSnapshot, RuntimeEvent } from '../../types.js';

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

function renderPanel(overrides: Partial<ComponentProps<typeof MonitorPanel>> = {}) {
  const props: ComponentProps<typeof MonitorPanel> = {
    monitor: undefined,
    currentMonitorSocket: undefined,
    elapsed: '0:00',
    ...overrides,
  };
  render(<MonitorPanel {...props} />);
  return props;
}

afterEach(() => {
  cleanup();
});

describe('MonitorPanel runtime event shell', () => {
  it('renders the runtime event monitor shell with session header stats', () => {
    const monitor = {
      activeCast: { castId: 'cast-1', active: true, phase: 'Build', socketState: 'awaiting_agent_response', awaitingResponse: true, runDir: '/tmp', artifactRoot: '/tmp', startedAt: 1, updatedAt: 2 },
    } as MonitorSnapshot;

    renderPanel({ monitor, currentMonitorSocket: 'Socket-2', elapsed: '1:23' });

    expect(screen.getByRole('heading', { name: 'Runtime event monitor' })).toBeTruthy();
    const section = screen.getByLabelText('Live session monitor');
    expect(within(section).getByText('Socket-2')).toBeTruthy();
    expect(within(section).getByText('awaiting_agent_response')).toBeTruthy();
    expect(within(section).getByText('1:23')).toBeTruthy();
  });

  it('does not render the legacy output/artifact card headings', () => {
    renderPanel();

    expect(screen.queryByText('Emitted outputs')).toBeNull();
    expect(screen.queryByText('Artifact summary')).toBeNull();
    expect(screen.queryByText('Recent artifacts')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Live cast telemetry' })).toBeNull();
  });

  it('shows an empty state when no runtime events are present', () => {
    renderPanel({ monitor: { runtimeEvents: [] } as MonitorSnapshot });

    expect(screen.getByTestId('monitor-feed-empty').textContent).toMatch(/No runtime events yet/i);
  });

  it('defaults to Pretty mode and exposes a Pretty/Raw toggle', () => {
    renderPanel({ monitor: { runtimeEvents: [] } as MonitorSnapshot });

    const pretty = screen.getByRole('button', { name: 'Pretty' });
    const raw = screen.getByRole('button', { name: 'Raw' });
    expect(pretty.getAttribute('aria-pressed')).toBe('true');
    expect(raw.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('group', { name: 'Event view mode' })).toBeTruthy();
  });

  it('switches to Raw mode when the Raw toggle is clicked', () => {
    renderPanel({ monitor: { runtimeEvents: [makeEvent()] } as MonitorSnapshot });

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByRole('button', { name: 'Raw' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Pretty' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('renders events in pretty mode by default with canonical fields', () => {
    renderPanel({ monitor: { runtimeEvents: [makeEvent({ type: 'result.pr_created', message: 'PR #42 created', severity: 'info' })] } as MonitorSnapshot });

    const feed = screen.getByLabelText('Runtime events');
    expect(within(feed).getByText('result.pr_created')).toBeTruthy();
    expect(within(feed).getByText('PR #42 created')).toBeTruthy();
    expect(within(feed).getByText('info')).toBeTruthy();
  });

  it('renders the full event as JSON in raw mode, newest events included', () => {
    const event = makeEvent({ type: 'status.progress', message: 'Running unit tests', customMarker: 'keep-me' });
    renderPanel({ monitor: { runtimeEvents: [event] } as MonitorSnapshot });

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));

    const rawFeed = screen.getByLabelText('Runtime events (raw JSON)');
    expect(within(rawFeed).getByText(/"type":\s*"status\.progress"/)).toBeTruthy();
    expect(within(rawFeed).getByText(/"customMarker":\s*"keep-me"/)).toBeTruthy();
  });

  it('toggles to Raw then back to Pretty, restoring pretty rendering', () => {
    renderPanel({ monitor: { runtimeEvents: [makeEvent({ type: 'result.pr_created' })] } as MonitorSnapshot });

    // Fresh render defaults to Pretty.
    expect(screen.getByLabelText('Runtime events')).toBeTruthy();
    expect(screen.queryByLabelText('Runtime events (raw JSON)')).toBeNull();

    // Switch to Raw — pretty chrome is replaced by the raw JSON feed.
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByRole('button', { name: 'Raw' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('Runtime events (raw JSON)')).toBeTruthy();
    expect(screen.queryByLabelText('Runtime events')).toBeNull();

    // Switch back to Pretty — pretty chrome returns and the raw feed is gone.
    fireEvent.click(screen.getByRole('button', { name: 'Pretty' }));
    expect(screen.getByRole('button', { name: 'Pretty' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('Runtime events')).toBeTruthy();
    expect(screen.queryByLabelText('Runtime events (raw JSON)')).toBeNull();
  });

  it('renders raw JSON newest-first across multiple events', () => {
    const events = [
      makeEvent({ eventId: 'evt-3', sequence: 30, type: 'result.pr_created', message: 'newest' }),
      makeEvent({ eventId: 'evt-2', sequence: 20, type: 'status.progress', message: 'middle' }),
      makeEvent({ eventId: 'evt-1', sequence: 10, type: 'lifecycle.cast.started', message: 'oldest' }),
    ];
    renderPanel({ monitor: { runtimeEvents: events } as MonitorSnapshot });
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));

    const rawFeed = screen.getByLabelText('Runtime events (raw JSON)');
    const seqs = Array.from(rawFeed.querySelectorAll('.monitor-feed-raw-pre')).map((pre) =>
      JSON.parse(pre.textContent ?? '{}').sequence,
    );
    expect(seqs).toEqual([30, 20, 10]);
  });

  it('reports the event count and pluralizes correctly', () => {
    const { rerender } = render(
      <MonitorPanel
        monitor={{ runtimeEvents: [makeEvent()] } as MonitorSnapshot}
        currentMonitorSocket={undefined}
        elapsed="0:00"
      />,
    );
    expect(screen.getByText('1 event')).toBeTruthy();

    rerender(
      <MonitorPanel
        monitor={{ runtimeEvents: [makeEvent(), makeEvent()] } as MonitorSnapshot}
        currentMonitorSocket={undefined}
        elapsed="0:00"
      />,
    );
    expect(screen.getByText('2 events')).toBeTruthy();
  });
});

describe('MonitorPanel event feed scroll behavior', () => {
  /** The scroll container that owns the feed's scroll position. */
  function getScrollContainer(): HTMLElement {
    const node = document.querySelector('.monitor-feed-scroll');
    if (!node) throw new Error('feed scroll container not rendered');
    return node as HTMLElement;
  }

  it('does not show the Return to latest button while at the top', () => {
    renderPanel({ monitor: { runtimeEvents: [makeEvent()] } as MonitorSnapshot });

    expect(screen.queryByRole('button', { name: 'Return to latest events' })).toBeNull();
  });

  it('shows the Return to latest button when scrolled away from the newest events', () => {
    renderPanel({ monitor: { runtimeEvents: [makeEvent()] } as MonitorSnapshot });

    const scroller = getScrollContainer();
    scroller.scrollTop = 250; // scrolled back into older events
    fireEvent.scroll(scroller);

    expect(screen.getByRole('button', { name: 'Return to latest events' })).toBeTruthy();
  });

  it('hides the Return to latest button when scrolled back to the top', () => {
    renderPanel({ monitor: { runtimeEvents: [makeEvent()] } as MonitorSnapshot });

    const scroller = getScrollContainer();
    scroller.scrollTop = 250;
    fireEvent.scroll(scroller);
    expect(screen.getByRole('button', { name: 'Return to latest events' })).toBeTruthy();

    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    expect(screen.queryByRole('button', { name: 'Return to latest events' })).toBeNull();
  });

  it('re-pins to the top and hides the button when Return to latest is clicked', () => {
    renderPanel({ monitor: { runtimeEvents: [makeEvent()] } as MonitorSnapshot });

    const scroller = getScrollContainer();
    scroller.scrollTop = 400;
    fireEvent.scroll(scroller);

    const button = screen.getByRole('button', { name: 'Return to latest events' });
    fireEvent.click(button);

    expect(scroller.scrollTop).toBe(0);
    expect(screen.queryByRole('button', { name: 'Return to latest events' })).toBeNull();
  });

  it('preserves the visible scroll position when events are prepended while scrolled away (no bounce)', () => {
    // Newest-first snapshot refresh: a newer event is prepended at the top.
    const firstEvent = makeEvent({ eventId: 'evt-1', sequence: 10, type: 'status.progress' });
    const { rerender } = render(
      <MonitorPanel
        monitor={{ runtimeEvents: [firstEvent] } as MonitorSnapshot}
        currentMonitorSocket={undefined}
        elapsed="0:00"
      />,
    );

    const scroller = getScrollContainer();
    scroller.scrollTop = 300; // reading older events, away from the top
    fireEvent.scroll(scroller);
    expect(screen.getByRole('button', { name: 'Return to latest events' })).toBeTruthy();

    // A newer event streams in (newest-first -> prepended at the top).
    rerender(
      <MonitorPanel
        monitor={{
          runtimeEvents: [
            makeEvent({ eventId: 'evt-2', sequence: 20, type: 'result.pr_created' }),
            firstEvent,
          ],
        } as MonitorSnapshot}
        currentMonitorSocket={undefined}
        elapsed="0:00"
      />,
    );

    // The feed must not yank the user back to the top.
    expect(scroller.scrollTop).toBe(300);
    expect(screen.getByRole('button', { name: 'Return to latest events' })).toBeTruthy();
  });

  it('keeps the newest events visible while at the top as new events stream in', () => {
    const { rerender } = render(
      <MonitorPanel
        monitor={{ runtimeEvents: [makeEvent({ eventId: 'evt-1', sequence: 10 })] } as MonitorSnapshot}
        currentMonitorSocket={undefined}
        elapsed="0:00"
      />,
    );

    const scroller = getScrollContainer();
    expect(scroller.scrollTop).toBe(0);
    expect(screen.queryByRole('button', { name: 'Return to latest events' })).toBeNull();

    // Newest event streams in (prepended at the top). The user is at the top,
    // so the feed re-pins to keep the newest event visible.
    rerender(
      <MonitorPanel
        monitor={{
          runtimeEvents: [
            makeEvent({ eventId: 'evt-2', sequence: 20, type: 'result.pr_created' }),
            makeEvent({ eventId: 'evt-1', sequence: 10 }),
          ],
        } as MonitorSnapshot}
        currentMonitorSocket={undefined}
        elapsed="0:00"
      />,
    );

    expect(scroller.scrollTop).toBe(0);
    expect(screen.queryByRole('button', { name: 'Return to latest events' })).toBeNull();
  });

  it('preserves scroll position in Raw mode the same as Pretty mode', () => {
    const firstEvent = makeEvent({ eventId: 'evt-1', sequence: 10 });
    const { rerender } = render(
      <MonitorPanel
        monitor={{ runtimeEvents: [firstEvent] } as MonitorSnapshot}
        currentMonitorSocket={undefined}
        elapsed="0:00"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));

    const scroller = getScrollContainer();
    scroller.scrollTop = 180;
    fireEvent.scroll(scroller);
    expect(screen.getByRole('button', { name: 'Return to latest events' })).toBeTruthy();

    rerender(
      <MonitorPanel
        monitor={{
          runtimeEvents: [
            makeEvent({ eventId: 'evt-2', sequence: 20, type: 'result.pr_created' }),
            firstEvent,
          ],
        } as MonitorSnapshot}
        currentMonitorSocket={undefined}
        elapsed="0:00"
      />,
    );

    // Still in Raw mode, scrolled away: the feed must not bounce to the top.
    expect(scroller.scrollTop).toBe(180);
    expect(screen.getByRole('button', { name: 'Return to latest events' })).toBeTruthy();
  });
});
