import { describe, expect, it } from 'vitest';
import type { MonitorSnapshot } from '../../types.js';
import { resolveMonitoringSocketIndicator } from './monitoringSocketAdapter.js';

function monitor(activeCast: Partial<NonNullable<MonitorSnapshot['activeCast']>>): MonitorSnapshot {
  return {
    activeCast: {
      castId: 'cast-1',
      active: true,
      phase: 'Build',
      awaitingResponse: true,
      runDir: '/tmp/run',
      artifactRoot: '/tmp/artifacts',
      startedAt: 1,
      updatedAt: 2,
      ...activeCast,
    },
  };
}

describe('resolveMonitoringSocketIndicator', () => {
  it('returns inactive when there is no active in-progress cast', () => {
    expect(resolveMonitoringSocketIndicator(undefined, ['Socket-1'])).toEqual({ state: 'inactive' });
    expect(resolveMonitoringSocketIndicator(monitor({ active: false, currentSocketId: 'Socket-1' }), ['Socket-1'])).toEqual({ state: 'inactive' });
  });

  it('returns no-active-socket when the session is active but has not reported a socket', () => {
    expect(resolveMonitoringSocketIndicator(monitor({ currentSocketId: undefined }), ['Socket-1'])).toEqual({ state: 'no-active-socket' });
  });

  it('maps an active session socket to a graph socket id', () => {
    expect(resolveMonitoringSocketIndicator(monitor({ currentSocketId: 'Socket-2' }), ['Socket-1', 'Socket-2'])).toEqual({
      state: 'active',
      sourceSocketId: 'Socket-2',
      graphSocketId: 'Socket-2',
    });
  });

  it('reports missing-socket without inventing graph state', () => {
    expect(resolveMonitoringSocketIndicator(monitor({ currentSocketId: 'Socket-9' }), ['Socket-1', 'Socket-2'])).toEqual({
      state: 'missing-socket',
      sourceSocketId: 'Socket-9',
    });
  });
});
