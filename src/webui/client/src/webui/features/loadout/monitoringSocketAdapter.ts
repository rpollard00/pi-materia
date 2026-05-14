import type { MonitorSnapshot } from '../../types.js';

export type MonitoringSocketState = 'inactive' | 'no-active-socket' | 'active' | 'missing-socket';

export interface MonitoringSocketIndicator {
  /** Socket id from the live session snapshot, if one was reported. */
  sourceSocketId?: string;
  /** Socket id that exists in the current graph and should receive the visual indicator. */
  graphSocketId?: string;
  state: MonitoringSocketState;
}

export function resolveMonitoringSocketIndicator(
  monitor: MonitorSnapshot | undefined,
  graphSocketIds: Iterable<string>,
): MonitoringSocketIndicator {
  const activeCast = monitor?.activeCast;
  if (!activeCast?.active) return { state: 'inactive' };

  const sourceSocketId = activeCast.currentSocketId;
  if (!sourceSocketId) return { state: 'no-active-socket' };

  const graphSocketSet = graphSocketIds instanceof Set ? graphSocketIds : new Set(graphSocketIds);
  if (!graphSocketSet.has(sourceSocketId)) return { state: 'missing-socket', sourceSocketId };

  return { state: 'active', sourceSocketId, graphSocketId: sourceSocketId };
}
