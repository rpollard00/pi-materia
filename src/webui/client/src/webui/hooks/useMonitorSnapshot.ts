import { useEffect, useState } from 'react';
import { getMonitorSnapshot } from '../api/index.js';
import type { MonitorSnapshot } from '../types.js';

export function useMonitorSnapshot() {
  const [monitor, setMonitor] = useState<MonitorSnapshot>();

  useEffect(() => {
    let cancelled = false;
    const refresh = () => getMonitorSnapshot()
      .then((body) => {
        if (!cancelled) setMonitor(body);
      })
      .catch(() => undefined);

    const events = typeof EventSource !== 'undefined' ? new EventSource('/api/monitor/events') : undefined;
    events?.addEventListener('monitor', (event) => {
      if (!cancelled) setMonitor(JSON.parse((event as MessageEvent).data) as MonitorSnapshot);
    });
    events?.addEventListener('error', () => { void refresh(); });
    const interval = events ? undefined : window.setInterval(refresh, 1500);

    return () => {
      cancelled = true;
      events?.close();
      if (interval) window.clearInterval(interval);
    };
  }, []);

  return monitor;
}
