import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMonitorSnapshot } from './useMonitorSnapshot.js';

function Harness({ enabled }: { enabled?: boolean }) {
  const monitor = useMonitorSnapshot(enabled === undefined ? {} : { enabled });
  return <span data-testid="monitor-defined">{monitor ? 'yes' : 'no'}</span>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useMonitorSnapshot', () => {
  it('does not fetch or open an event stream when disabled (no local session / central mode)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    const eventSourceConstruct = vi.fn();
    class MockEventSource {
      url: string;
      constructor(url: string) {
        this.url = url;
        eventSourceConstruct(url);
      }
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', MockEventSource);

    render(<Harness enabled={false} />);

    // Allow any pending effects/microtasks to flush.
    await act(async () => { await Promise.resolve(); });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(eventSourceConstruct).not.toHaveBeenCalled();
  });

  it('fetches the snapshot and opens the event stream when enabled (default local workflow)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    const eventSourceConstruct = vi.fn();
    class MockEventSource {
      url: string;
      constructor(url: string) {
        this.url = url;
        eventSourceConstruct(url);
      }
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', MockEventSource);

    render(<Harness enabled={true} />);

    await act(async () => { await Promise.resolve(); });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledWith('/api/monitor');
    expect(eventSourceConstruct).toHaveBeenCalledWith('/api/monitor/events');
  });
});
