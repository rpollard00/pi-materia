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
