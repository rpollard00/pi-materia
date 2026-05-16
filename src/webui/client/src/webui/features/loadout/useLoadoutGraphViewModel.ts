import { useCallback, useMemo } from 'react';
import type { MateriaConfig, PipelineConfig } from '../../../loadoutModel.js';
import { resolveMonitoringSocketIndicator } from './monitoringSocketAdapter.js';
import { buildMateriaPalette, formatSocketLabel, resolveSocketDisplayLabel } from '../../../loadoutModel.js';
import type { MonitorSnapshot, SocketRegionSelectionDragState } from '../../types.js';
import { formatElapsed } from '../../utils/display.js';
import {
  getLoadoutEdges,
  getLoopExitBadges,
  getLoopMemberships,
  getLoopRegions,
  layoutSockets,
  routeLoadoutEdges,
} from '../../utils/graphLayout.js';

export interface LoadoutGraphViewModelOptions {
  activeLoadout: PipelineConfig | undefined;
  draftConfig: MateriaConfig | undefined;
  selectedLoopSocketIds: string[];
  socketRegionSelectionDrag: SocketRegionSelectionDragState | undefined;
  monitor: MonitorSnapshot | undefined;
  viewedLoadoutName: string;
}

export function useLoadoutGraphViewModel({
  activeLoadout,
  draftConfig,
  selectedLoopSocketIds,
  socketRegionSelectionDrag,
  monitor,
  viewedLoadoutName,
}: LoadoutGraphViewModelOptions) {
  const materia = draftConfig?.materia ?? {};
  const semanticEdges = useMemo(() => getLoadoutEdges(activeLoadout), [activeLoadout?.sockets, activeLoadout?.loops]);
  const loadoutGraph = useMemo(
    () => layoutSockets(activeLoadout, semanticEdges, materia),
    [activeLoadout?.entry, activeLoadout?.sockets, activeLoadout?.loops, activeLoadout?.layout, semanticEdges, materia],
  );
  const socketPositions = useMemo(() => new Map(loadoutGraph.sockets.map((socket) => [socket.id, socket])), [loadoutGraph.sockets]);
  const loopRegions = useMemo(() => getLoopRegions(activeLoadout, socketPositions, materia), [activeLoadout?.loops, activeLoadout?.sockets, socketPositions, materia]);
  const loopMemberships = useMemo(() => getLoopMemberships(activeLoadout), [activeLoadout?.loops]);
  const loopExitBadges = useMemo(() => getLoopExitBadges(activeLoadout), [activeLoadout?.loops]);
  const routedEdges = useMemo(() => routeLoadoutEdges(loadoutGraph.edges, socketPositions), [loadoutGraph.edges, socketPositions]);
  const selectedLoopSocketSet = useMemo(() => new Set(selectedLoopSocketIds), [selectedLoopSocketIds]);
  const selectedLoopSockets = useMemo(() => loadoutGraph.sockets.filter((socket) => selectedLoopSocketSet.has(socket.id)), [loadoutGraph.sockets, selectedLoopSocketSet]);
  const socketLabel = useCallback((id: string) => formatSocketLabel(id, activeLoadout?.sockets?.[id]), [activeLoadout?.sockets]);
  const socketDisplayLabel = useCallback((id: string) => resolveSocketDisplayLabel(activeLoadout, id), [activeLoadout]);
  const loopSelectionRectangle = socketRegionSelectionDrag ? {
    x: Math.min(socketRegionSelectionDrag.startX, socketRegionSelectionDrag.currentX),
    y: Math.min(socketRegionSelectionDrag.startY, socketRegionSelectionDrag.currentY),
    width: Math.abs(socketRegionSelectionDrag.currentX - socketRegionSelectionDrag.startX),
    height: Math.abs(socketRegionSelectionDrag.currentY - socketRegionSelectionDrag.startY),
  } : undefined;
  const createLoopDisabled = selectedLoopSocketIds.length === 0;
  const palette = useMemo(() => buildMateriaPalette(materia), [materia]);
  const viewedLoadoutIdentity = useMemo(
    () => ({ viewedLoadoutId: activeLoadout?.id, viewedLoadoutName }),
    [activeLoadout?.id, viewedLoadoutName],
  );
  const monitoringSocket = useMemo(
    () => resolveMonitoringSocketIndicator(monitor, socketPositions.keys(), viewedLoadoutIdentity),
    [
      monitor?.activeCast?.active,
      monitor?.activeCast?.currentSocketId,
      monitor?.activeLoadoutId,
      monitor?.activeLoadout,
      socketPositions,
      viewedLoadoutIdentity,
    ],
  );
  const currentMonitorSocket = monitor?.activeCast?.currentSocketId;
  const activeMonitorSocketId = monitoringSocket.graphSocketId;
  const elapsed = formatElapsed(monitor?.activeCast?.startedAt ?? monitor?.uiStartedAt, monitor?.now);

  return {
    materia,
    palette,
    semanticEdges,
    loadoutGraph,
    socketPositions,
    loopRegions,
    loopMemberships,
    loopExitBadges,
    routedEdges,
    selectedLoopSocketSet,
    selectedLoopSockets,
    loopSelectionRectangle,
    createLoopDisabled,
    socketLabel,
    socketDisplayLabel,
    currentMonitorSocket,
    activeMonitorSocketId,
    monitoringSocket,
    elapsed,
  };
}
