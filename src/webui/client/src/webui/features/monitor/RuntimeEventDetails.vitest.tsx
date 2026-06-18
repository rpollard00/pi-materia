import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeEvent } from '../../types.js';
import { RuntimeEventDetails } from './RuntimeEventDetails.js';

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

describe('RuntimeEventDetails', () => {
  it('renders runtime metadata, source, and payload sections', () => {
    const event = makeEvent({
      payload: { prUrl: 'https://github.com/org/repo/pull/42' },
      source: { materia: 'Blackbelt-GH-PR', socketId: 'Socket-7' },
    });
    const { container, getByText } = render(<RuntimeEventDetails event={event} id="det-1" />);

    const root = container.querySelector('.monitor-event-details') as HTMLElement;
    expect(root).toBeTruthy();
    expect(root.id).toBe('det-1');

    // Runtime metadata (raw ISO timestamp + ids elided by the collapsed ticker).
    expect(getByText('Event ID')).toBeTruthy();
    expect(getByText('evt-001')).toBeTruthy();
    expect(getByText('Occurred at')).toBeTruthy();
    expect(getByText('2026-06-17T22:00:00.000Z')).toBeTruthy();
    // Self-reported source provenance.
    expect(getByText('Source materia')).toBeTruthy();
    expect(getByText('Source socket')).toBeTruthy();
    // Payload pretty-printed as JSON.
    expect(getByText('Payload')).toBeTruthy();
    expect(getByText(/"prUrl":/)).toBeTruthy();
  });

  it('renders forward-compatible unknown fields under an additional section', () => {
    const event = makeEvent({ customMarker: 'keep-me', nested: { a: 1 }, payload: { ok: true } });
    const { getByText } = render(<RuntimeEventDetails event={event} id="det-2" />);

    expect(getByText('Additional fields')).toBeTruthy();
    expect(getByText(/"customMarker":\s*"keep-me"/)).toBeTruthy();
    expect(getByText(/"nested":/)).toBeTruthy();
  });

  it('omits the payload section when payload is missing or non-object', () => {
    const { queryByText, rerender } = render(
      <RuntimeEventDetails event={makeEvent({ payload: undefined })} id="det-3" />,
    );
    expect(queryByText('Payload')).toBeNull();

    rerender(<RuntimeEventDetails event={makeEvent({ payload: 'nope' as unknown as Record<string, unknown> })} id="det-3" />);
    expect(queryByText('Payload')).toBeNull();
  });

  it('shows a placeholder when the event has no expandable details', () => {
    const sparse = { type: 'event' } as RuntimeEvent;
    const { getByText, container } = render(<RuntimeEventDetails event={sparse} id="det-4" />);
    expect(getByText('No additional details')).toBeTruthy();
    expect(container.querySelector('.monitor-event-detail-pre')).toBeNull();
    expect(container.querySelector('.monitor-event-detail-list')).toBeNull();
  });
});
