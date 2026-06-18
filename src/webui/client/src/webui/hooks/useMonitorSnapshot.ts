import { useEffect, useState } from 'react';
import { getMonitorSnapshot } from '../api/index.js';
import type { MonitorSnapshot } from '../types.js';

export function useMonitorSnapshot() {
  const [monitor, setMonitor] = useState<MonitorSnapshot>();

  useEffect(() => {
    let cancelled = false;
    let sseError = false;
    let pollingTimer: number | undefined;

    const apply = (body: MonitorSnapshot) => {
      if (!cancelled) setMonitor(body);
    };

    const refresh = () => {
      getMonitorSnapshot()
        .then(apply)
        .catch(() => undefined);
    };

    const startPolling = () => {
      if (pollingTimer || cancelled) return;
      // Steady polling while SSE is down. The initial refresh() above
      // already fetched the first snapshot.
      pollingTimer = window.setInterval(refresh, 1500);
    };

    const stopPolling = () => {
      if (pollingTimer) {
        window.clearInterval(pollingTimer);
        pollingTimer = undefined;
      }
    };

    // Fetch an initial snapshot before setting up the SSE stream so the
    // stream's live data takes precedence when it arrives.
    refresh();

    const events = typeof EventSource !== 'undefined'
      ? new EventSource('/api/monitor/events')
      : undefined;

    if (events) {
      events.addEventListener('monitor', (event) => {
        try {
          apply(JSON.parse((event as MessageEvent).data) as MonitorSnapshot);
        } catch {
          // Tolerate malformed SSE data; keep the last known snapshot.
        }
      });

      events.addEventListener('error', () => {
        sseError = true;
        startPolling();
      });

      events.addEventListener('open', () => {
        // SSE reconnected — stop polling and rely on live updates again.
        if (sseError) {
          sseError = false;
          stopPolling();
        }
      });
    } else {
      // No EventSource available; fetch initial snapshot and start polling.
      startPolling();
    }

    return () => {
      cancelled = true;
      events?.close();
      stopPolling();
    };
  }, []);

  return monitor;
}
