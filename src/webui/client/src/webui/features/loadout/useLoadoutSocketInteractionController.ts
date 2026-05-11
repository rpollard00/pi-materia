import { useRef, useState } from 'react';
import type { DragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { MateriaConfig, PipelineConfig } from '../../../loadoutModel.js';
import { getSocketLayout, isEmptySocket } from '../../../loadoutModel.js';
import { clearMateriaFromSocket, setSocketLayouts, setSocketMateria, swapSocketMateria } from '../../../loadoutTransforms.js';
import { socketCardWidth, socketLayoutOffsetX, socketLayoutOffsetY, socketLayoutUnitX, socketLayoutUnitY, socketStageHeight } from '../../constants.js';
import type { DragPayload, MonitorSnapshot, PositionedSocket, SocketLayoutDragState, SocketRegionSelectionDragState } from '../../types.js';
import { layoutValueForPosition, rectanglesIntersect } from '../../utils/graphLayout.js';
import { parseDragPayload } from '../../utils/forms.js';
import { useLoadoutGraphViewModel } from './useLoadoutGraphViewModel.js';

export interface LoadoutSocketInteractionControllerOptions {
  activeLoadout: PipelineConfig | undefined;
  activeLoadoutName: string;
  deleteLoadoutDraft: (name: string) => boolean;
  draftConfig: MateriaConfig | undefined;
  loadouts: Record<string, PipelineConfig>;
  monitor: MonitorSnapshot | undefined;
  setStatus: (status: string) => void;
  switchLoadoutDraft: (name: string) => void;
  updateLoadoutDraft: (loadoutName: string, updater: (loadout: PipelineConfig) => PipelineConfig) => void;
  updateLoadoutLayout: (loadoutName: string, updater: (loadout: PipelineConfig) => PipelineConfig) => void;
  onModalErrorReset?: () => void;
  onSocketPropertyErrorReset?: () => void;
}

export function useLoadoutSocketInteractionController({
  activeLoadout,
  activeLoadoutName,
  deleteLoadoutDraft,
  draftConfig,
  loadouts,
  monitor,
  setStatus,
  switchLoadoutDraft,
  updateLoadoutDraft,
  updateLoadoutLayout,
  onModalErrorReset,
  onSocketPropertyErrorReset,
}: LoadoutSocketInteractionControllerOptions) {
  const [selectedMateriaId, setSelectedMateriaId] = useState<string | undefined>();
  const [socketActionId, setSocketActionId] = useState<string | undefined>();
  const [socketActionMode, setSocketActionMode] = useState<'actions' | 'replace' | 'edit' | 'connect'>('actions');
  const [socketLayoutDrag, setSocketLayoutDrag] = useState<SocketLayoutDragState | undefined>();
  const [selectedLoopSocketIds, setSelectedLoopSocketIds] = useState<string[]>([]);
  const [socketRegionSelectionDrag, setSocketRegionSelectionDrag] = useState<SocketRegionSelectionDragState | undefined>();
  const suppressSocketClickRef = useRef(false);

  const viewModel = useLoadoutGraphViewModel({ activeLoadout, draftConfig, selectedLoopSocketIds, socketRegionSelectionDrag, monitor });
  const { loadoutGraph, palette } = viewModel;

  function resetLoadoutSelectionChrome() {
    setSelectedMateriaId(undefined);
    setSocketActionId(undefined);
    setSocketActionMode('actions');
    setSelectedLoopSocketIds([]);
  }

  function switchLoadout(name: string) {
    switchLoadoutDraft(name);
    resetLoadoutSelectionChrome();
  }

  function deleteLoadout(name: string) {
    const deleted = deleteLoadoutDraft(name);
    if (deleted) resetLoadoutSelectionChrome();
    return deleted;
  }

  function openSocketActionModal(socketId: string, mode: 'actions' | 'replace' | 'edit' | 'connect' = 'actions') {
    setSocketActionId(socketId);
    setSocketActionMode(mode);
  }

  function closeSocketActionModal() {
    setSocketActionId(undefined);
    setSocketActionMode('actions');
    onModalErrorReset?.();
  }

  function putMateria(socketId: string, materiaId: string, fromSocket?: string) {
    if (!activeLoadoutName || !draftConfig) return false;
    const currentLoadout = loadouts[activeLoadoutName];
    const currentTarget = currentLoadout?.sockets?.[socketId];
    if (!currentLoadout?.sockets || !currentTarget) {
      setStatus(`Ignored drop: socket ${socketId} is not available in the active loadout.`);
      return false;
    }

    if (fromSocket && fromSocket !== socketId) {
      const currentSource = currentLoadout.sockets[fromSocket];
      if (isEmptySocket(currentSource)) {
        setStatus('Ignored drop: dragged socket materia is no longer available.');
        return false;
      }
    } else {
      const currentSource = palette.find(([id]) => id === materiaId)?.[1];
      if (!currentSource || isEmptySocket(currentSource)) {
        setStatus(`Ignored drop: materia ${materiaId} is not available.`);
        return false;
      }
    }

    updateLoadoutDraft(activeLoadoutName, (loadout) => {
      if (!loadout.sockets) return loadout;
      if (fromSocket && fromSocket !== socketId) return swapSocketMateria(loadout, fromSocket, socketId);
      const sourceNode = palette.find(([id]) => id === materiaId)?.[1];
      return sourceNode ? setSocketMateria(loadout, socketId, sourceNode) : loadout;
    });
    setSelectedMateriaId(undefined);
    setStatus(`Staged ${materiaId} in socket ${socketId}; socket graph links and layout were preserved.`);
    return true;
  }

  function removeMateria(socketId: string) {
    if (!activeLoadoutName) return false;
    const currentNode = loadouts[activeLoadoutName]?.sockets?.[socketId];
    if (!currentNode) {
      setStatus(`Ignored unsocket: socket ${socketId} is not available in the active loadout.`);
      return false;
    }
    if (isEmptySocket(currentNode)) {
      setStatus(`Ignored unsocket: socket ${socketId} is already empty.`);
      return false;
    }
    updateLoadoutDraft(activeLoadoutName, (loadout) => loadout.sockets?.[socketId] ? clearMateriaFromSocket(loadout, socketId) : loadout);
    setSocketActionId(undefined);
    setSocketActionMode('actions');
    setStatus(`Cleared materia from ${socketId}; socket graph links and layout were preserved.`);
    return true;
  }

  function toggleLoopSocketSelection(socketId: string) {
    setSelectedLoopSocketIds((current) => current.includes(socketId) ? current.filter((id) => id !== socketId) : [...current, socketId]);
  }

  function handleSocketClick(socketId: string, event: ReactMouseEvent<HTMLButtonElement>) {
    if (suppressSocketClickRef.current) {
      suppressSocketClickRef.current = false;
      return;
    }
    if (event.shiftKey) {
      toggleLoopSocketSelection(socketId);
      setSocketActionId(undefined);
      onSocketPropertyErrorReset?.();
      return;
    }
    if (selectedMateriaId) {
      putMateria(socketId, selectedMateriaId);
      return;
    }
    setSocketActionId(socketId);
    setSocketActionMode('actions');
    onSocketPropertyErrorReset?.();
  }

  function beginSocketLayoutDrag(socket: PositionedSocket, event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.shiftKey) return;
    if (event.button !== 0 || selectedMateriaId) return;
    const target = event.target as HTMLElement;
    if (target.closest('[draggable="true"]')) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setSocketLayoutDrag({
      socketId: socket.id,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: socket.x,
      originY: socket.y,
      currentX: socket.x,
      currentY: socket.y,
      moved: false,
    });
  }

  function moveSocketLayoutDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    setSocketLayoutDrag((current) => {
      if (!current || current.pointerId !== event.pointerId) return current;
      const deltaX = event.clientX - current.startClientX;
      const deltaY = event.clientY - current.startClientY;
      const moved = current.moved || Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4;
      return { ...current, currentX: Math.max(0, current.originX + deltaX), currentY: Math.max(0, current.originY + deltaY), moved };
    });
  }

  function finishSocketLayoutDrag(socketId: string, event: ReactPointerEvent<HTMLButtonElement>) {
    const current = socketLayoutDrag;
    if (!current || current.pointerId !== event.pointerId || current.socketId !== socketId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setSocketLayoutDrag(undefined);
    const deltaX = event.clientX - current.startClientX;
    const deltaY = event.clientY - current.startClientY;
    const moved = current.moved || Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4;
    if (!moved || !activeLoadoutName) return;
    suppressSocketClickRef.current = true;
    const finalX = Math.max(0, current.originX + deltaX);
    const finalY = Math.max(0, current.originY + deltaY);
    const layoutX = layoutValueForPosition(finalX, socketLayoutOffsetX, socketLayoutUnitX);
    const layoutY = layoutValueForPosition(finalY, socketLayoutOffsetY, socketLayoutUnitY);
    updateLoadoutLayout(activeLoadoutName, (loadout) => {
      const sockets = loadout.sockets;
      if (!sockets?.[socketId]) return loadout;
      const layouts: Parameters<typeof setSocketLayouts>[1] = { [socketId]: { x: layoutX, y: layoutY } };
      for (const socket of loadoutGraph.sockets) {
        if (!sockets[socket.id] || socket.id === socketId || getSocketLayout(loadout, socket.id)) continue;
        layouts[socket.id] = {
          x: layoutValueForPosition(socket.x, socketLayoutOffsetX, socketLayoutUnitX),
          y: layoutValueForPosition(socket.y, socketLayoutOffsetY, socketLayoutUnitY),
        };
      }
      return setSocketLayouts(loadout, layouts);
    });
    setStatus(`Moved socket ${socketId}; explicit layout will be saved with the loadout.`);
  }

  function cancelSocketLayoutDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (socketLayoutDrag?.pointerId !== event.pointerId) return;
    setSocketLayoutDrag(undefined);
  }

  function canvasPoint(event: ReactPointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function beginSocketRegionSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || selectedMateriaId || event.target !== event.currentTarget) return;
    const point = canvasPoint(event);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setSocketRegionSelectionDrag({ pointerId: event.pointerId, startX: point.x, startY: point.y, currentX: point.x, currentY: point.y });
    setSocketActionId(undefined);
  }

  function moveSocketRegionSelection(event: ReactPointerEvent<HTMLDivElement>) {
    const point = canvasPoint(event);
    const pointerId = event.pointerId;
    setSocketRegionSelectionDrag((current) => {
      if (!current || current.pointerId !== pointerId) return current;
      return { ...current, currentX: point.x, currentY: point.y };
    });
  }

  function finishSocketRegionSelection(event: ReactPointerEvent<HTMLDivElement>) {
    const current = socketRegionSelectionDrag;
    if (!current || current.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const point = canvasPoint(event);
    const rect = { x: Math.min(current.startX, point.x), y: Math.min(current.startY, point.y), width: Math.abs(point.x - current.startX), height: Math.abs(point.y - current.startY) };
    const selected = loadoutGraph.sockets.filter((socket) => rectanglesIntersect(rect, { x: socket.x, y: socket.y, width: socketCardWidth, height: socketStageHeight })).map((socket) => socket.id);
    setSocketRegionSelectionDrag(undefined);
    setSelectedLoopSocketIds(selected);
    if (selected.length > 0) setStatus(`Selected loop sockets: ${selected.join(', ')}.`);
  }

  function cancelSocketRegionSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (socketRegionSelectionDrag?.pointerId !== event.pointerId) return;
    setSocketRegionSelectionDrag(undefined);
  }

  function replaceMateriaFromModal(socketId: string, materiaId: string) {
    if (putMateria(socketId, materiaId)) {
      setSocketActionId(undefined);
      setSocketActionMode('actions');
    }
  }

  function handleDrop(socketId: string, event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    const raw = event.dataTransfer.getData('application/json');
    if (!raw) return;
    const payload = parseDragPayload(raw);
    if (!payload) {
      setStatus('Ignored drop: unsupported drag payload.');
      return;
    }
    putMateria(socketId, payload.materiaId, payload.kind === 'socket' ? payload.fromSocket : undefined);
  }

  function handleGraphDrop(event: DragEvent) {
    event.preventDefault();
    const raw = event.dataTransfer.getData('application/json');
    if (!raw) return;
    const payload = parseDragPayload(raw);
    if (!payload) {
      setStatus('Ignored drop: unsupported drag payload.');
      return;
    }
    if (payload.kind !== 'socket' || !payload.fromSocket) {
      setStatus('Ignored drop: drag palette materia onto a socket to place it.');
      return;
    }
    if (payload.fromLoadout && payload.fromLoadout !== activeLoadoutName) {
      setStatus('Ignored unsocket: dragged materia belongs to a different loadout.');
      return;
    }
    removeMateria(payload.fromSocket);
  }

  function dragMateria(payload: DragPayload, event: DragEvent) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/json', JSON.stringify(payload));
  }

  return {
    viewModel,
    selectedMateriaId,
    setSelectedMateriaId,
    socketActionId,
    setSocketActionId,
    socketActionMode,
    setSocketActionMode,
    socketLayoutDrag,
    selectedLoopSocketIds,
    setSelectedLoopSocketIds,
    socketRegionSelectionDrag,
    resetLoadoutSelectionChrome,
    switchLoadout,
    deleteLoadout,
    openSocketActionModal,
    closeSocketActionModal,
    putMateria,
    removeMateria,
    handleSocketClick,
    beginSocketLayoutDrag,
    moveSocketLayoutDrag,
    finishSocketLayoutDrag,
    cancelSocketLayoutDrag,
    beginSocketRegionSelection,
    moveSocketRegionSelection,
    finishSocketRegionSelection,
    cancelSocketRegionSelection,
    handleDrop,
    handleGraphDrop,
    dragMateria,
    replaceMateriaFromModal,
    toggleLoopSocketSelection,
  };
}
