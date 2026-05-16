import type { MonitorSnapshot } from '../../types.js';

export type MonitoringSocketState = 'inactive' | 'no-active-socket' | 'active' | 'missing-socket';

export interface MonitoringSocketIndicator {
  /** Socket id from the live session snapshot, if one was reported. */
  sourceSocketId?: string;
  /** Socket id that exists in the current graph and should receive the visual indicator. */
  graphSocketId?: string;
  state: MonitoringSocketState;
}

export interface ViewedLoadoutIdentity {
  viewedLoadoutId?: string;
  viewedLoadoutName?: string;
}

function nonEmptyIdentity(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function monitorMatchesViewedLoadout(
  monitor: MonitorSnapshot,
  viewedLoadoutIdentity: ViewedLoadoutIdentity | undefined,
): boolean {
  const runtimeLoadoutId = nonEmptyIdentity(monitor.activeLoadoutId);
  const runtimeLoadoutName = nonEmptyIdentity(monitor.activeLoadout);
  const viewedLoadoutId = nonEmptyIdentity(viewedLoadoutIdentity?.viewedLoadoutId);
  const viewedLoadoutName = nonEmptyIdentity(viewedLoadoutIdentity?.viewedLoadoutName);

  if (runtimeLoadoutId && viewedLoadoutId) return runtimeLoadoutId === viewedLoadoutId;

  if (runtimeLoadoutName && viewedLoadoutName) return runtimeLoadoutName === viewedLoadoutName;

  if (runtimeLoadoutId || runtimeLoadoutName) return false;

  // Legacy monitor snapshots emitted before loadout identity was reported can only be
  // scoped by the socket id. Keep that compatibility path explicit and covered by tests.
  return true;
}

export function resolveMonitoringSocketIndicator(
  monitor: MonitorSnapshot | undefined,
  graphSocketIds: Iterable<string>,
  viewedLoadoutIdentity?: ViewedLoadoutIdentity,
): MonitoringSocketIndicator {
  const monitorSnapshot = monitor;
  if (!monitorSnapshot) return { state: 'inactive' };

  const activeCast = monitorSnapshot.activeCast;
  if (!activeCast?.active) return { state: 'inactive' };

  const sourceSocketId = activeCast.currentSocketId;
  if (!sourceSocketId) return { state: 'no-active-socket' };

  if (!monitorMatchesViewedLoadout(monitorSnapshot, viewedLoadoutIdentity)) return { state: 'inactive' };

  const graphSocketSet = graphSocketIds instanceof Set ? graphSocketIds : new Set(graphSocketIds);
  if (!graphSocketSet.has(sourceSocketId)) return { state: 'missing-socket', sourceSocketId };

  return { state: 'active', sourceSocketId, graphSocketId: sourceSocketId };
}
