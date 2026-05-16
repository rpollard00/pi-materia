import { describe, expect, it } from 'vitest';
import type { MonitorSnapshot } from '../../types.js';
import { resolveMonitoringSocketIndicator, type MonitoringSocketIndicator } from './monitoringSocketAdapter.js';

function monitor(activeCast: Partial<NonNullable<MonitorSnapshot['activeCast']>>, loadoutIdentity: Pick<MonitorSnapshot, 'activeLoadoutId' | 'activeLoadout'> = {}): MonitorSnapshot {
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
  };
}

type IdentityAwareResolver = (
  monitor: MonitorSnapshot | undefined,
  graphSocketIds: Iterable<string>,
  viewedLoadoutIdentity?: { viewedLoadoutId?: string; viewedLoadoutName?: string },
) => MonitoringSocketIndicator;

const resolveWithViewedLoadout = resolveMonitoringSocketIndicator as IdentityAwareResolver;

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

  it('suppresses matching socket ids when the viewed loadout id is not the runtime active loadout id', () => {
    expect(resolveWithViewedLoadout(
      monitor({ currentSocketId: 'Socket-2' }, { activeLoadoutId: 'runtime:alpha', activeLoadout: 'Alpha' }),
      ['Socket-1', 'Socket-2'],
      { viewedLoadoutId: 'runtime:beta', viewedLoadoutName: 'Beta' },
    )).toEqual({ state: 'inactive' });
  });

  it('returns the active graph socket when the viewed loadout id matches the runtime active loadout id', () => {
    expect(resolveWithViewedLoadout(
      monitor({ currentSocketId: 'Socket-2' }, { activeLoadoutId: 'runtime:alpha', activeLoadout: 'Renamed Alpha' }),
      ['Socket-1', 'Socket-2'],
      { viewedLoadoutId: 'runtime:alpha', viewedLoadoutName: 'Local Alpha Name' },
    )).toEqual({
      state: 'active',
      sourceSocketId: 'Socket-2',
      graphSocketId: 'Socket-2',
    });
  });

  it('uses activeLoadout display-name fallback only when stable ids are unavailable', () => {
    expect(resolveWithViewedLoadout(
      monitor({ currentSocketId: 'Socket-2' }, { activeLoadout: 'Legacy Alpha' }),
      ['Socket-1', 'Socket-2'],
      { viewedLoadoutName: 'Legacy Alpha' },
    )).toEqual({
      state: 'active',
      sourceSocketId: 'Socket-2',
      graphSocketId: 'Socket-2',
    });

    expect(resolveWithViewedLoadout(
      monitor({ currentSocketId: 'Socket-2' }, { activeLoadout: 'Legacy Alpha' }),
      ['Socket-1', 'Socket-2'],
      { viewedLoadoutName: 'Legacy Beta' },
    )).toEqual({ state: 'inactive' });
  });

  it('prefers stable ids over matching names when both sides provide ids', () => {
    expect(resolveWithViewedLoadout(
      monitor({ currentSocketId: 'Socket-2' }, { activeLoadoutId: 'runtime:alpha', activeLoadout: 'Shared Display Name' }),
      ['Socket-1', 'Socket-2'],
      { viewedLoadoutId: 'runtime:beta', viewedLoadoutName: 'Shared Display Name' },
    )).toEqual({ state: 'inactive' });
  });

  it('keeps the documented legacy socket-only fallback when monitor snapshots lack loadout identity', () => {
    expect(resolveWithViewedLoadout(
      monitor({ currentSocketId: 'Socket-2' }),
      ['Socket-1', 'Socket-2'],
      { viewedLoadoutId: 'runtime:beta', viewedLoadoutName: 'Beta' },
    )).toEqual({
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
