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

function activeCastMatchesViewedLoadout(
  activeCast: NonNullable<MonitorSnapshot['activeCast']>,
  viewedLoadoutIdentity: ViewedLoadoutIdentity | undefined,
): boolean {
  const runningLoadoutId = nonEmptyIdentity(activeCast.loadoutId);
  const runningLoadoutName = nonEmptyIdentity(activeCast.loadoutName);
  const viewedLoadoutId = nonEmptyIdentity(viewedLoadoutIdentity?.viewedLoadoutId);
  const viewedLoadoutName = nonEmptyIdentity(viewedLoadoutIdentity?.viewedLoadoutName);

  if (runningLoadoutId) return viewedLoadoutId === runningLoadoutId;

  if (runningLoadoutName) return viewedLoadoutName === runningLoadoutName;

  // Monitor snapshots emitted before executing loadout identity was reported can only be
  // scoped by the socket id. Keep that legacy API path explicit and covered by tests.
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

  if (!activeCastMatchesViewedLoadout(activeCast, viewedLoadoutIdentity)) return { state: 'inactive' };

  const graphSocketSet = graphSocketIds instanceof Set ? graphSocketIds : new Set(graphSocketIds);
  if (!graphSocketSet.has(sourceSocketId)) return { state: 'missing-socket', sourceSocketId };

  return { state: 'active', sourceSocketId, graphSocketId: sourceSocketId };
}
