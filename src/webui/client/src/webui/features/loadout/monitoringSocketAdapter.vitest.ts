import { describe, expect, it } from 'vitest';
import type { MonitorSnapshot } from '../../types.js';
import { resolveMonitoringSocketIndicator } from './monitoringSocketAdapter.js';

function monitor(activeCast: Partial<NonNullable<MonitorSnapshot['activeCast']>> & { loadoutId?: string; loadoutName?: string }, loadoutIdentity: Pick<MonitorSnapshot, 'activeLoadoutId' | 'activeLoadout'> = {}): MonitorSnapshot {
  return {
    ...loadoutIdentity,
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
  } as MonitorSnapshot;
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

  it('suppresses matching socket ids when the viewed loadout id is not the executing activeCast loadout id', () => {
    expect(resolveMonitoringSocketIndicator(
      monitor({ currentSocketId: 'Socket-2', loadoutId: 'runtime:alpha', loadoutName: 'Alpha' }, { activeLoadoutId: 'runtime:beta', activeLoadout: 'Beta' }),
      ['Socket-1', 'Socket-2'],
      { viewedLoadoutId: 'runtime:beta', viewedLoadoutName: 'Beta' },
    )).toEqual({ state: 'inactive' });
  });

  it('returns the active graph socket when the viewed loadout id matches the executing activeCast loadout id', () => {
    expect(resolveMonitoringSocketIndicator(
      monitor({ currentSocketId: 'Socket-2', loadoutId: 'runtime:alpha', loadoutName: 'Renamed Alpha' }, { activeLoadoutId: 'runtime:beta', activeLoadout: 'Beta' }),
      ['Socket-1', 'Socket-2'],
      { viewedLoadoutId: 'runtime:alpha', viewedLoadoutName: 'Local Alpha Name' },
    )).toEqual({
      state: 'active',
      sourceSocketId: 'Socket-2',
      graphSocketId: 'Socket-2',
    });
  });

  it('uses activeCast display-name fallback when stable cast ids are unavailable', () => {
    expect(resolveMonitoringSocketIndicator(
      monitor({ currentSocketId: 'Socket-2', loadoutName: 'Current Alpha' }, { activeLoadout: 'Current Beta' }),
      ['Socket-1', 'Socket-2'],
      { viewedLoadoutName: 'Current Alpha' },
    )).toEqual({
      state: 'active',
      sourceSocketId: 'Socket-2',
      graphSocketId: 'Socket-2',
    });

    expect(resolveMonitoringSocketIndicator(
      monitor({ currentSocketId: 'Socket-2', loadoutName: 'Current Alpha' }, { activeLoadout: 'Current Alpha' }),
      ['Socket-1', 'Socket-2'],
      { viewedLoadoutName: 'Current Beta' },
    )).toEqual({ state: 'inactive' });
  });

  it('prefers stable activeCast ids over matching names when both sides provide ids', () => {
    expect(resolveMonitoringSocketIndicator(
      monitor({ currentSocketId: 'Socket-2', loadoutId: 'runtime:alpha', loadoutName: 'Shared Display Name' }, { activeLoadoutId: 'runtime:beta', activeLoadout: 'Shared Display Name' }),
      ['Socket-1', 'Socket-2'],
      { viewedLoadoutId: 'runtime:beta', viewedLoadoutName: 'Shared Display Name' },
    )).toEqual({ state: 'inactive' });
  });

  it('keeps the documented current socket-only fallback when monitor snapshots lack loadout identity', () => {
    expect(resolveMonitoringSocketIndicator(
      monitor({ currentSocketId: 'Socket-2' }),
      ['Socket-1', 'Socket-2'],
      { viewedLoadoutId: 'runtime:beta', viewedLoadoutName: 'Beta' },
    )).toEqual({
      state: 'active',
      sourceSocketId: 'Socket-2',
      graphSocketId: 'Socket-2',
    });
  });

  it('scopes quest cast sockets by the executing activeCast stable loadout id before socket matching', () => {
    const questMonitor = monitor({ currentSocketId: 'Socket-2', loadoutId: 'default:full-auto', loadoutName: 'Full-Auto' }, { activeLoadoutId: 'user:hojo', activeLoadout: 'Hojo' });

    expect(resolveMonitoringSocketIndicator(
      questMonitor,
      ['Socket-1', 'Socket-2'],
      { viewedLoadoutId: 'user:hojo', viewedLoadoutName: 'Hojo' },
    )).toEqual({ state: 'inactive' });
    expect(resolveMonitoringSocketIndicator(
      questMonitor,
      ['Socket-1', 'Socket-2'],
      { viewedLoadoutId: 'default:full-auto', viewedLoadoutName: 'Renamed Full Auto' },
    )).toEqual({
      state: 'active',
      sourceSocketId: 'Socket-2',
      graphSocketId: 'Socket-2',
    });
  });

  it('reports a missing socket for the executing loadout instead of mapping the socket onto another loadout', () => {
    const questMonitor = monitor({ currentSocketId: 'Socket-9', loadoutId: 'default:full-auto', loadoutName: 'Full-Auto' }, { activeLoadoutId: 'user:hojo', activeLoadout: 'Hojo' });

    expect(resolveMonitoringSocketIndicator(
      questMonitor,
      ['Socket-1', 'Socket-2'],
      { viewedLoadoutId: 'user:hojo', viewedLoadoutName: 'Hojo' },
    )).toEqual({ state: 'inactive' });
    expect(resolveMonitoringSocketIndicator(
      questMonitor,
      ['Socket-1', 'Socket-2'],
      { viewedLoadoutId: 'default:full-auto', viewedLoadoutName: 'Full-Auto' },
    )).toEqual({
      state: 'missing-socket',
      sourceSocketId: 'Socket-9',
    });
  });

  it('reports missing-socket without inventing graph state', () => {
    expect(resolveMonitoringSocketIndicator(monitor({ currentSocketId: 'Socket-9' }), ['Socket-1', 'Socket-2'])).toEqual({
      state: 'missing-socket',
      sourceSocketId: 'Socket-9',
    });
  });
});
