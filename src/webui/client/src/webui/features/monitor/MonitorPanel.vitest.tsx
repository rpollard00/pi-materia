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

/**
 * Severity filter dropdown coverage.
 *
 * The runtime event monitor exposes a compact, palette-style severity filter
 * built on the shared CompactOptionMenu. These tests prove the dropdown is
 * populated from the event contract, defaults to showing everything, narrows
 * the feed for each canonical level (including normalizing missing/invalid
 * severities to info), applies to both Pretty and Raw views, and shares the
 * accessible menu behavior with the materia palette sort dropdown.
 */
describe('MonitorPanel severity filter', () => {
  /** Pretty-mode feed messages currently rendered, in order. */
  function prettyMessages(): string[] {
    const feed = screen.queryByLabelText('Runtime events');
    if (!feed) return [];
    return Array.from(feed.querySelectorAll('.monitor-event-message')).map(
      (node) => node.textContent ?? '',
    );
  }

  /** Raw-mode event sequences currently rendered, in order. */
  function rawSequences(): number[] {
    return Array.from(document.querySelectorAll('.monitor-feed-raw-pre')).map((pre) =>
      JSON.parse(pre.textContent ?? '{}').sequence,
    );
  }

  function openSeverityMenu(): HTMLElement {
    fireEvent.click(screen.getByTestId('monitor-severity-trigger'));
    return screen.getByTestId('monitor-severity-menu');
  }

  function selectSeverity(value: string): void {
    fireEvent.click(screen.getByTestId('monitor-severity-trigger'));
    fireEvent.click(screen.getByTestId(`monitor-severity-option-${value}`));
  }

  const mixedSeverityEvents: RuntimeEvent[] = [
    makeEvent({ eventId: 'sev-1', sequence: 1, severity: 'debug', type: 'status.progress', message: 'Debug line' }),
    makeEvent({ eventId: 'sev-2', sequence: 2, severity: 'info', type: 'status.progress', message: 'Info line' }),
    makeEvent({ eventId: 'sev-3', sequence: 3, severity: 'warning', type: 'status.progress', message: 'Warning line' }),
    makeEvent({ eventId: 'sev-4', sequence: 4, severity: 'error', type: 'status.progress', message: 'Error line' }),
    makeEvent({ eventId: 'sev-5', sequence: 5, severity: 'critical', type: 'status.progress', message: 'Critical line' }),
  ];

  it('renders the severity filter trigger in the feed toolbar', () => {
    renderPanel({ monitor: { runtimeEvents: mixedSeverityEvents } as MonitorSnapshot });

    const trigger = screen.getByTestId('monitor-severity-trigger');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // The trigger lives next to the Pretty/Raw toggle in the toolbar group.
    expect(trigger.closest('.monitor-feed-toolbar')).toBeTruthy();
  });

  it('lists All levels plus every contract severity in order, using shared menu semantics', () => {
    renderPanel({ monitor: { runtimeEvents: mixedSeverityEvents } as MonitorSnapshot });

    const menu = openSeverityMenu();
    expect(menu.getAttribute('role')).toBe('menu');
    expect(screen.getByTestId('monitor-severity-trigger').getAttribute('aria-expanded')).toBe('true');

    const options = Array.from(menu.querySelectorAll('[role="menuitemradio"]'));
    expect(options.map((option) => option.getAttribute('data-testid'))).toEqual([
      'monitor-severity-option-all',
      'monitor-severity-option-debug',
      'monitor-severity-option-info',
      'monitor-severity-option-warning',
      'monitor-severity-option-error',
      'monitor-severity-option-critical',
    ]);
    expect(options.map((option) => option.textContent)).toEqual([
      'All levels',
      'Debug',
      'Info',
      'Warning',
      'Error',
      'Critical',
    ]);
  });

  it('defaults to All levels with that option marked active', () => {
    renderPanel({ monitor: { runtimeEvents: mixedSeverityEvents } as MonitorSnapshot });

    const menu = openSeverityMenu();
    const checked = Array.from(menu.querySelectorAll('[role="menuitemradio"]')).filter(
      (option) => option.getAttribute('aria-checked') === 'true',
    );
    expect(checked).toHaveLength(1);
    expect(checked[0]?.getAttribute('data-testid')).toBe('monitor-severity-option-all');
    expect(screen.getByTestId('monitor-severity-option-all').className).toContain('monitor-severity-option-active');

    // Default view shows every event with an unfiltered count.
    expect(prettyMessages()).toEqual(['Debug line', 'Info line', 'Warning line', 'Error line', 'Critical line']);
    expect(screen.getByText('5 events')).toBeTruthy();
  });

  it('filters the Pretty feed to each canonical level and updates the count', () => {
    const cases: Array<[string, string]> = [
      ['debug', 'Debug line'],
      ['info', 'Info line'],
      ['warning', 'Warning line'],
      ['error', 'Error line'],
      ['critical', 'Critical line'],
    ];

    renderPanel({ monitor: { runtimeEvents: mixedSeverityEvents } as MonitorSnapshot });

    for (const [level, expectedMessage] of cases) {
      selectSeverity(level);
      expect(prettyMessages()).toEqual([expectedMessage]);
      // Filtered count is reported as "N of total".
      expect(screen.getByText(`1 of 5 events`)).toBeTruthy();
    }
  });

  it('restores the full feed when All levels is selected again', () => {
    renderPanel({ monitor: { runtimeEvents: mixedSeverityEvents } as MonitorSnapshot });

    selectSeverity('error');
    expect(prettyMessages()).toEqual(['Error line']);

    selectSeverity('all');
    expect(prettyMessages()).toEqual(['Debug line', 'Info line', 'Warning line', 'Error line', 'Critical line']);
    expect(screen.getByText('5 events')).toBeTruthy();
  });

  it('treats a missing severity as info so it matches the info filter only', () => {
    const events: RuntimeEvent[] = [
      makeEvent({ eventId: 'mis-1', sequence: 1, severity: undefined, message: 'No severity here' }),
      makeEvent({ eventId: 'mis-2', sequence: 2, severity: 'debug', message: 'Real debug' }),
    ];
    renderPanel({ monitor: { runtimeEvents: events } as MonitorSnapshot });

    // Default shows both, with the missing-severity event normalized to info.
    const feed = screen.getByLabelText('Runtime events');
    expect(within(feed).getByText('No severity here')).toBeTruthy();

    selectSeverity('info');
    expect(prettyMessages()).toEqual(['No severity here']);

    selectSeverity('debug');
    expect(prettyMessages()).toEqual(['Real debug']);

    // The missing-severity event never leaks into a non-info level.
    selectSeverity('warning');
    expect(prettyMessages()).toEqual([]);
  });

  it('treats an unrecognized severity as info', () => {
    const events: RuntimeEvent[] = [
      makeEvent({
        eventId: 'bad-1',
        sequence: 1,
        severity: 'bogus' as RuntimeEvent['severity'],
        message: 'Bad severity',
      }),
    ];
    renderPanel({ monitor: { runtimeEvents: events } as MonitorSnapshot });

    selectSeverity('info');
    expect(prettyMessages()).toEqual(['Bad severity']);
  });

  it('applies the active filter to both Pretty and Raw views', () => {
    renderPanel({ monitor: { runtimeEvents: mixedSeverityEvents } as MonitorSnapshot });

    // Narrow to warning in Pretty mode.
    selectSeverity('warning');
    expect(prettyMessages()).toEqual(['Warning line']);

    // Switching to Raw keeps the same filtered set — the filter is mode-agnostic.
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(rawSequences()).toEqual([3]);

    // Switching back to Pretty still shows only the warning event.
    fireEvent.click(screen.getByRole('button', { name: 'Pretty' }));
    expect(prettyMessages()).toEqual(['Warning line']);
  });

  it('reflects the filter in Raw mode even when switched before filtering', () => {
    renderPanel({ monitor: { runtimeEvents: mixedSeverityEvents } as MonitorSnapshot });

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(rawSequences()).toEqual([1, 2, 3, 4, 5]);

    selectSeverity('critical');
    expect(rawSequences()).toEqual([5]);
  });

  it('shows a clear no-match empty state and zero count when no events match the level', () => {
    const events: RuntimeEvent[] = [
      makeEvent({ eventId: 'p-1', sequence: 1, severity: 'debug', message: 'only debug' }),
      makeEvent({ eventId: 'p-2', sequence: 2, severity: 'info', message: 'only info' }),
    ];
    renderPanel({ monitor: { runtimeEvents: events } as MonitorSnapshot });

    selectSeverity('critical');

    // The no-match empty state (distinct from the no-events-at-all state) names
    // the selected level and points back to All levels.
    const empty = screen.getByTestId('monitor-feed-empty');
    expect(empty.textContent).toMatch(/No events match the selected level/i);
    expect(empty.textContent).toMatch(/Critical/);
    expect(empty.textContent).toMatch(/All levels/);
    // The toolbar count reports no events are visible.
    expect(screen.getByText('No events')).toBeTruthy();
    // No feed is rendered when nothing matches.
    expect(screen.queryByLabelText('Runtime events')).toBeNull();
    expect(screen.queryByLabelText('Runtime events (raw JSON)')).toBeNull();
  });

  it('keeps the no-events-at-all copy distinct from the no-match copy', () => {
    // Zero recorded events still shows the "no runtime events yet" state even
    // after a filter is chosen, because there is nothing to filter.
    renderPanel({ monitor: { runtimeEvents: [] } as MonitorSnapshot });

    selectSeverity('error');
    expect(screen.getByTestId('monitor-feed-empty').textContent).toMatch(/No runtime events yet/i);
  });

  it('shares the compact menu behavior: option select closes the menu', () => {
    renderPanel({ monitor: { runtimeEvents: mixedSeverityEvents } as MonitorSnapshot });

    openSeverityMenu();
    expect(screen.getByTestId('monitor-severity-menu')).toBeTruthy();
    fireEvent.click(screen.getByTestId('monitor-severity-option-error'));
    expect(screen.queryByTestId('monitor-severity-menu')).toBeNull();

    // Reopening reflects the newly active value.
    const menu = openSeverityMenu();
    const checked = Array.from(menu.querySelectorAll('[role="menuitemradio"]')).filter(
      (option) => option.getAttribute('aria-checked') === 'true',
    );
    expect(checked[0]?.getAttribute('data-testid')).toBe('monitor-severity-option-error');
  });

  it('shares the compact menu behavior: outside click and Escape close, Escape restores focus', () => {
    renderPanel({ monitor: { runtimeEvents: mixedSeverityEvents } as MonitorSnapshot });

    // Outside pointer down closes the open menu.
    openSeverityMenu();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('monitor-severity-menu')).toBeNull();

    // Escape closes the menu and returns focus to the trigger.
    const trigger = screen.getByTestId('monitor-severity-trigger');
    fireEvent.click(trigger);
    expect(screen.getByTestId('monitor-severity-menu')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('monitor-severity-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
