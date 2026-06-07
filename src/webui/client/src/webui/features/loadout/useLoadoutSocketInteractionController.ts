import { useRef, useState } from 'react';
import type { DragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { LoadoutEditPolicy } from '../../../../../../domain/loadout.js';
import type { MateriaConfig, PipelineConfig } from '../../../loadoutModel.js';
import { getSocketLayout, isEmptySocket } from '../../../loadoutModel.js';
import { clearMateriaFromSocket, setSocketLayouts, setSocketMateria, swapSocketMateria } from '../../../loadoutTransforms.js';
import { socketCardWidth, socketLayoutOffsetX, socketLayoutOffsetY, socketLayoutUnitX, socketLayoutUnitY, socketStageHeight } from '../../constants.js';
import type { DragPayload, MonitorSnapshot, PositionedSocket, SocketLayoutDragState, SocketRegionSelectionDragState } from '../../types.js';
import type { LoadoutStatusToastIntent, SetLoadoutStatus } from '../../utils/loadoutNotifications.js';
import { scaleCanvasPoint } from '../../utils/canvasPoint.js';
import { layoutValueForPosition, rectanglesIntersect } from '../../utils/graphLayout.js';
import { parseDragPayload } from '../../utils/forms.js';
import { useLoadoutGraphViewModel } from './useLoadoutGraphViewModel.js';

export interface LoadoutSocketInteractionControllerOptions {
  activeLoadout: PipelineConfig | undefined;
  activeLoadoutName: string;
  editPolicy: LoadoutEditPolicy;
  deleteLoadoutDraft: (name: string) => boolean;
  draftConfig: MateriaConfig | undefined;
  loadouts: Record<string, PipelineConfig>;
  monitor: MonitorSnapshot | undefined;
  setStatus: SetLoadoutStatus;
  switchLoadoutDraft: (name: string) => void;
  updateLoadoutDraft: (loadoutName: string, updater: (loadout: PipelineConfig) => PipelineConfig) => boolean;
  updateLoadoutLayout: (loadoutName: string, updater: (loadout: PipelineConfig) => PipelineConfig) => boolean;
  onModalErrorReset?: () => void;
  onSocketPropertyErrorReset?: () => void;
}

export function useLoadoutSocketInteractionController({
  activeLoadout,
  activeLoadoutName,
  editPolicy,
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
  const notifyStatus = (message: string, toast: LoadoutStatusToastIntent = 'none') => {
    setStatus(message, toast);
  };
  const [selectedMateriaId, setSelectedMateriaId] = useState<string | undefined>();
  const [socketActionId, setSocketActionId] = useState<string | undefined>();
  const [socketActionMode, setSocketActionMode] = useState<'actions' | 'replace' | 'edit' | 'connect'>('actions');
  const [socketLayoutDrag, setSocketLayoutDrag] = useState<SocketLayoutDragState | undefined>();
  const [selectedLoopSocketIds, setSelectedLoopSocketIds] = useState<string[]>([]);
  const [socketRegionSelectionDrag, setSocketRegionSelectionDrag] = useState<SocketRegionSelectionDragState | undefined>();
  const suppressSocketClickRef = useRef(false);

  const viewModel = useLoadoutGraphViewModel({ activeLoadout, draftConfig, selectedLoopSocketIds, socketRegionSelectionDrag, monitor, viewedLoadoutName: activeLoadoutName });
  const { loadoutGraph, palette } = viewModel;

  function resetLoadoutSelectionChrome() {
    setSelectedMateriaId(undefined);
    setSocketActionId(undefined);
    setSocketActionMode('actions');
    setSelectedLoopSocketIds([]);
    onModalErrorReset?.();
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

  function readonlyBlocked(action: string) {
    if (editPolicy.canEdit) return false;
    notifyStatus(`${action} blocked: ${editPolicy.reason}`, 'validation');
    return true;
  }

  function putMateria(socketId: string, materiaId: string, fromSocket?: string) {
    if (readonlyBlocked(`Edit socket ${socketId}`)) return false;
    if (!activeLoadoutName || !draftConfig) return false;
    const currentLoadout = loadouts[activeLoadoutName];
    const currentTarget = currentLoadout?.sockets?.[socketId];
    if (!currentLoadout?.sockets || !currentTarget) {
      notifyStatus(`Ignored drop: socket ${socketId} is not available in the active loadout.`, 'validation');
      return false;
    }

    if (fromSocket && fromSocket !== socketId) {
      const currentSource = currentLoadout.sockets[fromSocket];
      if (isEmptySocket(currentSource)) {
        notifyStatus('Ignored drop: dragged socket materia is no longer available.', 'validation');
        return false;
      }
    } else {
      const currentSource = palette.find(([id]) => id === materiaId)?.[1];
      if (!currentSource || isEmptySocket(currentSource)) {
        notifyStatus(`Ignored drop: materia ${materiaId} is not available.`, 'validation');
        return false;
      }
    }

    const updated = updateLoadoutDraft(activeLoadoutName, (loadout) => {
      if (!loadout.sockets) return loadout;
      if (fromSocket && fromSocket !== socketId) return swapSocketMateria(loadout, fromSocket, socketId);
      const sourceSocket = palette.find(([id]) => id === materiaId)?.[1];
      return sourceSocket ? setSocketMateria(loadout, socketId, sourceSocket) : loadout;
    });
    if (!updated) return false;
    setSelectedMateriaId(undefined);
    notifyStatus(`Staged ${materiaId} in socket ${socketId}; socket graph links and layout were preserved.`);
    return true;
  }

  function removeMateria(socketId: string) {
    if (readonlyBlocked(`Clear socket ${socketId}`)) return false;
    if (!activeLoadoutName) return false;
    const currentSocket = loadouts[activeLoadoutName]?.sockets?.[socketId];
    if (!currentSocket) {
      notifyStatus(`Ignored unsocket: socket ${socketId} is not available in the active loadout.`, 'validation');
      return false;
    }
    if (isEmptySocket(currentSocket)) {
      notifyStatus(`Ignored unsocket: socket ${socketId} is already empty.`, 'validation');
      return false;
    }
    if (!updateLoadoutDraft(activeLoadoutName, (loadout) => loadout.sockets?.[socketId] ? clearMateriaFromSocket(loadout, socketId) : loadout)) return false;
    closeSocketActionModal();
    notifyStatus(`Cleared materia from ${socketId}; socket graph links and layout were preserved.`);
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
      closeSocketActionModal();
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
    if (!editPolicy.canEdit) return;
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
    if (updateLoadoutLayout(activeLoadoutName, (loadout) => {
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
    })) {
      notifyStatus(`Moved socket ${socketId}; explicit layout will be saved with the loadout.`);
    }
  }

  function cancelSocketLayoutDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (socketLayoutDrag?.pointerId !== event.pointerId) return;
    setSocketLayoutDrag(undefined);
  }

  function canvasPoint(event: ReactPointerEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    const rect = el.getBoundingClientRect();
    return scaleCanvasPoint({
      clientX: event.clientX,
      clientY: event.clientY,
      offsetWidth: el.offsetWidth,
      offsetHeight: el.offsetHeight,
      rectWidth: rect.width,
      rectHeight: rect.height,
      rectLeft: rect.left,
      rectTop: rect.top,
    });
  }

  function beginSocketRegionSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || selectedMateriaId || event.target !== event.currentTarget) return;
    const point = canvasPoint(event);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setSocketRegionSelectionDrag({ pointerId: event.pointerId, startX: point.x, startY: point.y, currentX: point.x, currentY: point.y });
    closeSocketActionModal();
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
    if (selected.length > 0) notifyStatus(`Selected loop sockets: ${selected.join(', ')}.`);
  }

  function cancelSocketRegionSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (socketRegionSelectionDrag?.pointerId !== event.pointerId) return;
    setSocketRegionSelectionDrag(undefined);
  }

  function replaceMateriaFromModal(socketId: string, materiaId: string) {
    if (putMateria(socketId, materiaId)) closeSocketActionModal();
  }

  function handleDrop(socketId: string, event: DragEvent) {
    event.preventDefault();
    if (readonlyBlocked(`Drop materia on socket ${socketId}`)) return;
    event.stopPropagation();
    const raw = event.dataTransfer.getData('application/json');
    if (!raw) return;
    const payload = parseDragPayload(raw);
    if (!payload) {
      notifyStatus('Ignored drop: unsupported drag payload.', 'validation');
      return;
    }
    putMateria(socketId, payload.materiaId, payload.kind === 'socket' ? payload.fromSocket : undefined);
  }

  function handleGraphDrop(event: DragEvent) {
    event.preventDefault();
    if (readonlyBlocked('Unsocket materia')) return;
    const raw = event.dataTransfer.getData('application/json');
    if (!raw) return;
    const payload = parseDragPayload(raw);
    if (!payload) {
      notifyStatus('Ignored drop: unsupported drag payload.', 'validation');
      return;
    }
    if (payload.kind !== 'socket' || !payload.fromSocket) {
      notifyStatus('Ignored drop: drag palette materia onto a socket to place it.', 'validation');
      return;
    }
    if (payload.fromLoadout && payload.fromLoadout !== activeLoadoutName) {
      notifyStatus('Ignored unsocket: dragged materia belongs to a different loadout.', 'validation');
      return;
    }
    removeMateria(payload.fromSocket);
  }

  function dragMateria(payload: DragPayload, event: DragEvent) {
    if (!editPolicy.canEdit) {
      event.preventDefault();
      readonlyBlocked('Drag materia');
      return;
    }
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
