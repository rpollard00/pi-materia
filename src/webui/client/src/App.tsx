import { useMemo, useRef, useState } from 'react';
import type { DragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { MateriaEdgeCondition } from '../../../types.js';
import { formatGraphValidationErrors, stageValidatedPipelineGraphTransform } from '../../../graphValidation.js';
import {
  buildMateriaPalette,
  canDeleteSocket,
  extractMateriaReference,
  findLoopExitConnectionContext,
  formatSocketLabel,
  getNodeLabel,
  getSocketLayout,
  resolveSocketDisplayLabel,
  isEmptySocket,
  isEntrySocket,
  nodeColor,
  type LegacyPipelineNode,
  type PipelineConfig,
  type PipelineNode,
} from './loadoutModel.js';
import {
  addEdgeToLoadout,
  clearLoopExitInLoadout,
  clearMateriaFromSocket,
  createConnectedEmptySocket,
  createTaskLoop,
  deleteLoopFromLoadout,
  deleteSocketImmutable,
  removeEdgeFromLoadout,
  removeLegacyNextFromLoadout,
  removeLoopExitRouteFromLoadout,
  setSocketLayouts,
  setSocketLimits,
  setSocketMateria,
  swapSocketMateria,
  toggleEdgeConditionInLoadout,
  toggleLoopExitRouteCondition,
  updateLoopExitInLoadout,
  upsertLoopExitRouteInLoadout,
  type LoadoutTransform,
} from './loadoutTransforms.js';
import {
  edgeConditionLabels,
  socketCardWidth,
  socketLayoutOffsetX,
  socketLayoutOffsetY,
  socketLayoutUnitX,
  socketLayoutUnitY,
  socketStageHeight,
} from './webui/constants.js';
import type {
  DragPayload,
  LoadoutEdge,
  PositionedSocket,
  SocketLayoutDragState,
  SocketPropertyFormState,
  SocketRegionSelectionDragState,
} from './webui/types.js';
import { AppShell } from './webui/components/AppShell.js';
import { LoadoutListPanel } from './webui/features/loadout/LoadoutListPanel.js';
import { MateriaPalettePanel } from './webui/features/loadout/MateriaPalettePanel.js';
import { StageApplyPanel } from './webui/features/loadout/StageApplyPanel.js';
import { LoadoutGraphPanel } from './webui/features/loadout/LoadoutGraphPanel.js';
import { MateriaEditorPanel } from './webui/features/materia-editor/MateriaEditorPanel.js';
import { MonitorPanel } from './webui/features/monitor/MonitorPanel.js';
import { formatElapsed } from './webui/utils/display.js';
import {
  buildLoadouts,
  buildSocketHoverDetails,
  edgeConditionClass,
  edgeConditionLabel,
  formatIteratorBehavior,
  formatLoopDisplayLabel,
  generatorEdgeLabel,
  getLoadoutEdges,
  getLoopExitBadges,
  getLoopMemberships,
  getLoopRegions,
  hasIteratorBehavior,
  isGeneratorOutputEdge,
  isGeneratorSocket,
  iteratorBadgeLabel,
  layoutSockets,
  layoutValueForPosition,
  materiaGeneratorOutput,
  rectanglesIntersect,
  routeLoadoutEdges,
  toggledEdgeCondition,
} from './webui/utils/graphLayout.js';
import {
  emptySocketPropertyForm,
  parseDragPayload,
  parseOptionalFiniteNumber,
  parseOptionalPositiveInteger,
  socketPropertyFormFromNode,
} from './webui/utils/forms.js';
import { useAppNavigation } from './webui/hooks/useAppNavigation.js';
import { useCastCompletionToasts } from './webui/hooks/useCastCompletionToasts.js';
import { useMonitorSnapshot } from './webui/hooks/useMonitorSnapshot.js';
import { useWebuiConfig } from './webui/hooks/useWebuiConfig.js';
import { useMateriaEditorController } from './webui/features/materia-editor/useMateriaEditorController.js';

export function App() {
  const { selectedTab, selectTab } = useAppNavigation();
  const {
    activeLoadout,
    activeLoadoutName,
    canDeleteLoadout,
    canRevert,
    commitActiveLoadoutRename,
    createLoadout,
    deleteLoadout: deleteLoadoutDraft,
    draftConfig,
    isDirty,
    loadoutNameInput,
    loadoutSources,
    loadouts,
    persistedActiveLoadoutName,
    persistedLoadouts,
    reloadConfig,
    revertDraft,
    saveDraft,
    saveTarget,
    setLoadoutNameInput,
    setPersistedActiveLoadout,
    setSaveTarget,
    setStatus,
    source,
    status,
    switchLoadout: switchLoadoutDraft,
    updateLoadoutDraft,
    updateLoadoutLayout,
  } = useWebuiConfig();
  const [selectedMateriaId, setSelectedMateriaId] = useState<string | undefined>();
  const [socketActionId, setSocketActionId] = useState<string | undefined>();
  const [socketActionMode, setSocketActionMode] = useState<'actions' | 'replace' | 'edit' | 'connect'>('actions');
  const [socketPropertyForm, setSocketPropertyForm] = useState<SocketPropertyFormState>(() => emptySocketPropertyForm());
  const [socketPropertyError, setSocketPropertyError] = useState('');
  const [edgeTargetId, setEdgeTargetId] = useState('');
  const [edgeCondition, setEdgeCondition] = useState<MateriaEdgeCondition>('satisfied');
  const [edgeMutationError, setEdgeMutationError] = useState('');
  const [socketLayoutDrag, setSocketLayoutDrag] = useState<SocketLayoutDragState | undefined>();
  const [selectedLoopSocketIds, setSelectedLoopSocketIds] = useState<string[]>([]);
  const [socketRegionSelectionDrag, setSocketRegionSelectionDrag] = useState<SocketRegionSelectionDragState | undefined>();
  const suppressSocketClickRef = useRef(false);
  const monitor = useMonitorSnapshot();
  useCastCompletionToasts(monitor);

  const materia = draftConfig?.materia ?? {};
  const semanticEdges = useMemo(() => getLoadoutEdges(activeLoadout), [activeLoadout?.nodes, activeLoadout?.loops]);
  const loadoutGraph = useMemo(
    () => layoutSockets(activeLoadout, semanticEdges, materia),
    [activeLoadout?.entry, activeLoadout?.nodes, activeLoadout?.loops, activeLoadout?.layout, semanticEdges, materia],
  );
  const socketPositions = useMemo(() => new Map(loadoutGraph.sockets.map((socket) => [socket.id, socket])), [loadoutGraph.sockets]);
  const loopRegions = useMemo(() => getLoopRegions(activeLoadout, socketPositions, materia), [activeLoadout?.loops, activeLoadout?.nodes, socketPositions, materia]);
  const loopMemberships = useMemo(() => getLoopMemberships(activeLoadout), [activeLoadout?.loops]);
  const loopExitBadges = useMemo(() => getLoopExitBadges(activeLoadout), [activeLoadout?.loops]);
  const routedEdges = useMemo(() => routeLoadoutEdges(loadoutGraph.edges, socketPositions), [loadoutGraph.edges, socketPositions]);
  const selectedLoopSocketSet = useMemo(() => new Set(selectedLoopSocketIds), [selectedLoopSocketIds]);
  const selectedLoopSockets = useMemo(() => loadoutGraph.sockets.filter((socket) => selectedLoopSocketSet.has(socket.id)), [loadoutGraph.sockets, selectedLoopSocketSet]);
  const socketLabel = (id: string) => formatSocketLabel(id, activeLoadout?.nodes?.[id]);
  const socketDisplayLabel = (id: string) => resolveSocketDisplayLabel(activeLoadout, id);
  const loopSelectionRectangle = socketRegionSelectionDrag ? {
    x: Math.min(socketRegionSelectionDrag.startX, socketRegionSelectionDrag.currentX),
    y: Math.min(socketRegionSelectionDrag.startY, socketRegionSelectionDrag.currentY),
    width: Math.abs(socketRegionSelectionDrag.currentX - socketRegionSelectionDrag.startX),
    height: Math.abs(socketRegionSelectionDrag.currentY - socketRegionSelectionDrag.startY),
  } : undefined;
  const createLoopDisabled = selectedLoopSocketIds.length === 0;
  const palette = useMemo(() => buildMateriaPalette(materia), [materia]);
  const currentMonitorNode = monitor?.activeCast?.currentNode;
  const elapsed = formatElapsed(monitor?.activeCast?.startedAt ?? monitor?.uiStartedAt, monitor?.now);
  const materiaEditorController = useMateriaEditorController({ materia, selectedTab, status, setStatus, reloadConfig });

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

  function putMateria(socketId: string, materiaId: string, fromSocket?: string) {
    if (!activeLoadoutName || !draftConfig) return false;
    const currentLoadout = loadouts[activeLoadoutName];
    const currentTarget = currentLoadout?.nodes?.[socketId];
    if (!currentLoadout?.nodes || !currentTarget) {
      setStatus(`Ignored drop: socket ${socketId} is not available in the active loadout.`);
      return false;
    }

    if (fromSocket && fromSocket !== socketId) {
      const currentSource = currentLoadout.nodes[fromSocket];
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
      if (!loadout.nodes) return loadout;
      if (fromSocket && fromSocket !== socketId) return swapSocketMateria(loadout, fromSocket, socketId);
      const sourceNode = palette.find(([id]) => id === materiaId)?.[1];
      return sourceNode ? setSocketMateria(loadout, socketId, sourceNode) : loadout;
    });
    setSelectedMateriaId(undefined);
    setStatus(`Staged ${materiaId} in socket ${socketId}; socket graph links and layout were preserved.`);
    return true;
  }

  function deleteSocket(socketId: string) {
    const node = activeLoadout?.nodes?.[socketId];
    if (!node || !activeLoadoutName) return false;
    if (!canDeleteSocket(node)) {
      setStatus(`Cannot delete ${socketId}: entry sockets are protected.`);
      return false;
    }
    const deleted = commitGraphMutation(
      `Deleted socket ${socketId}.`,
      (loadout) => deleteSocketImmutable(loadout, socketId),
      `Deleted socket ${socketId}; graph edges and loop metadata were cleaned up.`,
      (message) => `Cannot delete socket ${socketId}: ${message}`,
    );
    if (deleted) {
      setSocketActionId(undefined);
      setSocketActionMode('actions');
      setSelectedLoopSocketIds((current) => current.filter((id) => id !== socketId));
    }
    return deleted;
  }

  function removeMateria(socketId: string) {
    if (!activeLoadoutName) return false;
    const currentNode = loadouts[activeLoadoutName]?.nodes?.[socketId];
    if (!currentNode) {
      setStatus(`Ignored unsocket: socket ${socketId} is not available in the active loadout.`);
      return false;
    }
    if (isEmptySocket(currentNode)) {
      setStatus(`Ignored unsocket: socket ${socketId} is already empty.`);
      return false;
    }
    updateLoadoutDraft(activeLoadoutName, (loadout) => loadout.nodes?.[socketId] ? clearMateriaFromSocket(loadout, socketId) : loadout);
    setSocketActionId(undefined);
    setSocketActionMode('actions');
    setStatus(`Cleared materia from ${socketId}; socket graph links and layout were preserved.`);
    return true;
  }

  function createConnectedSocket(afterSocketId: string) {
    if (!activeLoadoutName || !activeLoadout) return;
    const loopExitContext = findLoopExitConnectionContext(activeLoadout, afterSocketId);
    if (loopExitContext?.loop.exits?.some((route) => route.from === afterSocketId && route.condition === 'always')) {
      const message = `Loop exit ${socketLabel(afterSocketId)} already has an ${edgeConditionLabel('always')} route. Remove or edit the existing route before creating a new loop-exit socket.`;
      setEdgeMutationError(message);
      setStatus(`Cannot create socket after ${socketLabel(afterSocketId)}: ${message}`);
      return;
    }
    const result = stageValidatedPipelineGraphTransform(activeLoadout as never, (loadout: PipelineConfig) => createConnectedEmptySocket(loadout, afterSocketId) as never);
    if (!result.ok) {
      setStatus(`Cannot create socket after ${socketLabel(afterSocketId)}: ${formatGraphValidationErrors(result.errors)}`);
      return;
    }
    updateLoadoutDraft(activeLoadoutName, () => result.graph as PipelineConfig);
    setSocketActionId(undefined);
    setSocketActionMode('actions');
    setStatus(loopExitContext ? `Created a socket and loop-exit route from ${afterSocketId}.` : `Created a connected empty socket after ${afterSocketId}.`);
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
      setSocketPropertyError('');
      return;
    }
    if (selectedMateriaId) {
      putMateria(socketId, selectedMateriaId);
      return;
    }
    setSocketActionId(socketId);
    setSocketActionMode('actions');
    setSocketPropertyError('');
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
      return {
        ...current,
        currentX: Math.max(0, current.originX + deltaX),
        currentY: Math.max(0, current.originY + deltaY),
        moved,
      };
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
      const nodes = loadout.nodes;
      if (!nodes?.[socketId]) return loadout;
      const layouts: Parameters<typeof setSocketLayouts>[1] = { [socketId]: { x: layoutX, y: layoutY } };
      for (const socket of loadoutGraph.sockets) {
        if (!nodes[socket.id] || socket.id === socketId || getSocketLayout(loadout, socket.id)) continue;
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
    const rect = {
      x: Math.min(current.startX, point.x),
      y: Math.min(current.startY, point.y),
      width: Math.abs(point.x - current.startX),
      height: Math.abs(point.y - current.startY),
    };
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

  function openSocketPropertyEditor(socketId: string) {
    setSocketPropertyForm(socketPropertyFormFromNode(activeLoadout?.nodes?.[socketId], getSocketLayout(activeLoadout, socketId)));
    setSocketPropertyError('');
    setEdgeMutationError('');
    setSocketActionMode('edit');
  }

  function openEdgeConnector(socketId: string) {
    const firstOtherSocket = Object.keys(activeLoadout?.nodes ?? {}).find((id) => id !== socketId) ?? '';
    setEdgeTargetId(firstOtherSocket);
    setEdgeCondition(findLoopExitConnectionContext(activeLoadout, socketId) ? 'always' : 'satisfied');
    setEdgeMutationError('');
    setSocketActionMode('connect');
  }

  function commitGraphMutation(description: string, transform: LoadoutTransform, onSuccess: string, onError: (message: string) => string) {
    if (!activeLoadoutName || !activeLoadout) return false;
    const result = stageValidatedPipelineGraphTransform(activeLoadout as never, (loadout: PipelineConfig) => transform(loadout) as never, {
      isGeneratorNode: (nodeId) => {
        const referenced = extractMateriaReference(activeLoadout.nodes?.[nodeId]);
        return Boolean(referenced && materiaGeneratorOutput(materia[referenced.materia]));
      },
    });
    if (!result.ok) {
      const message = formatGraphValidationErrors(result.errors);
      setEdgeMutationError(message);
      setStatus(onError(message));
      return false;
    }
    updateLoadoutDraft(activeLoadoutName, () => result.graph as PipelineConfig);
    setEdgeMutationError('');
    setStatus(onSuccess || description);
    return true;
  }

  function createTaskIteratorLoop() {
    if (!activeLoadout?.nodes || selectedLoopSockets.length === 0) {
      setStatus('Cannot create loop; select the cycle sockets first with shift-click or a drag box.');
      return;
    }
    const selectedIds = selectedLoopSockets.map((socket) => socket.id);
    const selected = new Set(selectedIds);
    const generatorInputs = loadoutGraph.edges.flatMap((edge) => {
      if (selected.has(edge.from) || !selected.has(edge.to)) return [];
      const referenced = extractMateriaReference(activeLoadout.nodes?.[edge.from]);
      const output = referenced ? materiaGeneratorOutput(materia[referenced.materia]) : undefined;
      return output ? [{ from: edge.from, output }] : [];
    });
    const uniqueGeneratorInputs = Array.from(new Map(generatorInputs.map((input) => [`${input.from}\u0000${input.output}`, input])).values());
    if (uniqueGeneratorInputs.length !== 1) {
      setStatus(`Cannot create loop; selected sockets need exactly one inbound Generator edge, found ${uniqueGeneratorInputs.length}.`);
      return;
    }
    const generator = uniqueGeneratorInputs[0];
    const baseId = 'loopSelection';
    const existingLoops = activeLoadout.loops ?? {};
    let loopId = baseId;
    let suffix = 2;
    while (existingLoops[loopId]) loopId = `${baseId}${suffix++}`;
    const selectedLabels = selectedIds.map((id) => resolveSocketDisplayLabel(activeLoadout, id));
    const label = `Loop: ${selectedIds.join(' → ')}`;
    const isSingleSocketLoop = selectedIds.length === 1;
    const exitCondition: MateriaEdgeCondition = isSingleSocketLoop ? 'always' : 'satisfied';
    const created = commitGraphMutation(
      `Staged loop around ${selectedLabels.join(', ')}.`,
      (loadout) => createTaskLoop(loadout, loopId, label, selectedIds, { from: generator.from, output: generator.output }, { from: selectedIds[selectedIds.length - 1], when: exitCondition, to: 'end' }),
      `Staged loop around ${selectedLabels.join(', ')} consuming ${generator.from}.${generator.output}; loop.exit will compile into parse/advance runtime control flow.`,
      (message) => `Cannot create loop: ${message}`,
    );
    if (created) {
      setSocketActionId(undefined);
      setSelectedLoopSocketIds([]);
    }
  }

  function updateLoopExit(loopId: string, patch: Partial<{ from: string; when: MateriaEdgeCondition; to: string }>) {
    const loop = activeLoadout?.loops?.[loopId];
    if (!loop) return;
    const currentExit = loop.exit ?? { from: loop.nodes[loop.nodes.length - 1] ?? '', when: 'satisfied' as MateriaEdgeCondition, to: 'end' };
    const nextExit = { ...currentExit, ...patch };
    commitGraphMutation(
      `Updated loop ${loopId} exit.`,
      (loadout) => updateLoopExitInLoadout(loadout, loopId, nextExit),
      `Staged loop ${loopId} exit as ${nextExit.from}.${edgeConditionLabel(nextExit.when)} → ${nextExit.to}; it will compile into runtime parse/advance control flow.`,
      (message) => `Cannot update loop ${loopId} exit: ${message}`,
    );
  }

  function clearLoopExit(loopId: string) {
    commitGraphMutation(
      `Cleared loop ${loopId} exit.`,
      (loadout) => clearLoopExitInLoadout(loadout, loopId),
      `Cleared loop ${loopId} exit condition.`,
      (message) => `Cannot clear loop ${loopId} exit: ${message}`,
    );
  }

  function breakLoop(loopId: string) {
    const loop = activeLoadout?.loops?.[loopId];
    if (!loop) return;
    const label = formatLoopDisplayLabel(activeLoadout, loopId, loop.nodes, loop.label);
    commitGraphMutation(
      `Broke loop ${loopId}.`,
      (loadout) => deleteLoopFromLoadout(loadout, loopId),
      `Broke loop ${label}; sockets and edges were preserved.`,
      (message) => `Cannot break loop ${label}: ${message}`,
    );
  }

  function validateLoopExitRouteRequest(from: string, to: string, condition: MateriaEdgeCondition, loopExitContext: ReturnType<typeof findLoopExitConnectionContext>): string | undefined {
    if (!loopExitContext) return undefined;
    if (!activeLoadout?.nodes?.[from]) return `Loop-exit source ${from} is no longer available.`;
    if (!activeLoadout.nodes?.[to]) return `Choose an existing target socket for the loop-exit route.`;
    if (loopExitContext.loop.exit?.from !== from) return `Socket ${socketLabel(from)} is no longer the configured exit source for loop ${loopExitContext.loopId}.`;
    const parseMode = activeLoadout.nodes[from]?.parse;
    if ((condition === 'satisfied' || condition === 'not_satisfied') && parseMode !== 'json') {
      return `Loop-exit ${edgeConditionLabel(condition)} routes require ${socketLabel(from)} to parse JSON so runtime can read the canonical satisfied field. Set parse to "json" or choose Always.`;
    }
    return undefined;
  }

  function createEdge(from: string) {
    const to = edgeTargetId;
    if (!to) {
      const message = 'Choose a target socket.';
      setEdgeMutationError(message);
      setStatus(`Cannot create edge from ${from}: ${message}`);
      return;
    }
    const loopExitContext = findLoopExitConnectionContext(activeLoadout, from);
    const loopExitValidationError = validateLoopExitRouteRequest(from, to, edgeCondition, loopExitContext);
    if (loopExitValidationError) {
      setEdgeMutationError(loopExitValidationError);
      setStatus(`Cannot create loop-exit route ${socketLabel(from)} → ${to ? socketLabel(to) : 'target'}: ${loopExitValidationError}`);
      return;
    }
    const existingRoute = loopExitContext?.loop.exits?.find((route) => route.from === from && route.condition === edgeCondition);
    if (existingRoute && existingRoute.targetSocketId !== to) {
      const confirmed = window.confirm(`Replace the existing ${edgeConditionLabel(edgeCondition)} loop-exit route from ${socketLabel(from)} to ${socketLabel(existingRoute.targetSocketId)} with a route to ${socketLabel(to)}? Only one route per loop-exit condition is allowed.`);
      if (!confirmed) {
        const message = `Kept existing ${edgeConditionLabel(edgeCondition)} loop-exit route to ${socketLabel(existingRoute.targetSocketId)}.`;
        setEdgeMutationError(message);
        setStatus(message);
        return;
      }
    }
    const created = commitGraphMutation(
      loopExitContext ? `Staged loop-exit route ${from} → ${to}.` : `Staged edge ${from} → ${to}.`,
      (loadout) => loopExitContext
        ? upsertLoopExitRouteInLoadout(loadout, loopExitContext.loopId, from, edgeCondition, to)
        : addEdgeToLoadout(loadout, from, to, edgeCondition),
      loopExitContext
        ? `${existingRoute ? 'Replaced' : 'Staged'} loop-exit route ${socketLabel(from)} → ${socketLabel(to)} as ${edgeConditionLabel(edgeCondition)}.`
        : `Staged edge ${socketLabel(from)} → ${socketLabel(to)} as ${edgeConditionLabel(edgeCondition)}.`,
      (message) => loopExitContext ? `Cannot create loop-exit route ${socketLabel(from)} → ${socketLabel(to)}: ${message}` : `Cannot create edge ${socketLabel(from)} → ${socketLabel(to)}: ${message}`,
    );
    if (created) {
      setSocketActionId(undefined);
      setSocketActionMode('actions');
    }
  }

  function removeLoopExitConnection(loopId: string, routeId: string) {
    const route = activeLoadout?.loops?.[loopId]?.exits?.find((candidate) => candidate.id === routeId);
    if (!route) return;
    const removed = commitGraphMutation(
      `Removed loop-exit route ${loopId}:${routeId}.`,
      (loadout) => removeLoopExitRouteFromLoadout(loadout, loopId, routeId),
      `Removed loop-exit route from ${route.from} to ${route.targetSocketId}; no normal edges were created.`,
      (message) => `Cannot remove loop-exit route ${loopId}:${routeId}: ${message}`,
    );
    if (removed) {
      setSocketActionId(undefined);
      setSocketActionMode('actions');
    }
  }

  function toggleLoopExitCondition(loopId: string, routeId: string) {
    const route = activeLoadout?.loops?.[loopId]?.exits?.find((candidate) => candidate.id === routeId);
    if (!route) return;
    const nextCondition = toggledEdgeCondition(route.condition);
    commitGraphMutation(
      `Toggled loop-exit route ${loopId}:${routeId}.`,
      (loadout) => toggleLoopExitRouteCondition(loadout, loopId, routeId, nextCondition),
      `Staged loop-exit route ${socketLabel(route.from)} → ${socketLabel(route.targetSocketId)} as ${edgeConditionLabel(nextCondition)}; no normal edges were created.`,
      (message) => `Cannot toggle loop-exit route ${loopId}:${routeId}: ${message}`,
    );
  }

  function removeEdge(from: string, edgeIndex: number) {
    const edge = activeLoadout?.nodes?.[from]?.edges?.[edgeIndex];
    if (!edge) return;
    const removed = commitGraphMutation(
      `Removed edge ${from} → ${edge.to}.`,
      (loadout) => removeEdgeFromLoadout(loadout, from, edgeIndex),
      `Removed edge ${from} → ${edge.to}; sockets were preserved.`,
      (message) => `Cannot remove edge ${from} → ${edge.to}: ${message}`,
    );
    if (removed) {
      setSocketActionId(undefined);
      setSocketActionMode('actions');
    }
  }

  function removeLegacyNextEdge(from: string) {
    const to = (activeLoadout?.nodes?.[from] as LegacyPipelineNode | undefined)?.next;
    if (!to) return;
    const removed = commitGraphMutation(
      `Removed legacy flow ${from} → ${to}.`,
      (loadout) => removeLegacyNextFromLoadout(loadout, from),
      `Removed legacy flow ${from} → ${to}; conditional edges and sockets were preserved.`,
      (message) => `Cannot remove legacy flow ${from} → ${to}: ${message}`,
    );
    if (removed) {
      setSocketActionId(undefined);
      setSocketActionMode('actions');
    }
  }

  function saveSocketProperties(socketId: string) {
    if (!activeLoadoutName || !activeLoadout?.nodes?.[socketId]) return;
    const errors: string[] = [];
    const maxVisits = parseOptionalPositiveInteger('Max visits', socketPropertyForm.maxVisits, errors);
    const maxEdgeTraversals = parseOptionalPositiveInteger('Retry / edge traversal limit', socketPropertyForm.maxEdgeTraversals, errors);
    const maxOutputBytes = parseOptionalPositiveInteger('Max output bytes', socketPropertyForm.maxOutputBytes, errors);
    const layoutX = parseOptionalFiniteNumber('Layout X', socketPropertyForm.layoutX, errors);
    const layoutY = parseOptionalFiniteNumber('Layout Y', socketPropertyForm.layoutY, errors);
    if (errors.length > 0) {
      const message = errors.join(' ');
      setSocketPropertyError(message);
      setStatus(`Cannot save socket ${socketId}: ${message}`);
      return;
    }

    const limits: PipelineNode['limits'] = {};
    if (maxVisits !== undefined) limits.maxVisits = maxVisits;
    if (maxEdgeTraversals !== undefined) limits.maxEdgeTraversals = maxEdgeTraversals;
    if (maxOutputBytes !== undefined) limits.maxOutputBytes = maxOutputBytes;
    const nextLimits = Object.keys(limits).length > 0 ? limits : undefined;
    const layout: Parameters<typeof setSocketLayouts>[1][string] = {};
    if (layoutX !== undefined) layout.x = layoutX;
    if (layoutY !== undefined) layout.y = layoutY;
    const nextLayout = Object.keys(layout).length > 0 ? layout : undefined;
    const currentNode = activeLoadout.nodes[socketId];
    const limitsChanged = (currentNode.limits?.maxVisits ?? undefined) !== (nextLimits?.maxVisits ?? undefined)
      || (currentNode.limits?.maxEdgeTraversals ?? undefined) !== (nextLimits?.maxEdgeTraversals ?? undefined)
      || (currentNode.limits?.maxOutputBytes ?? undefined) !== (nextLimits?.maxOutputBytes ?? undefined);
    const currentLayout = getSocketLayout(activeLoadout, socketId);
    const layoutChanged = (currentLayout?.x ?? undefined) !== (nextLayout?.x ?? undefined) || (currentLayout?.y ?? undefined) !== (nextLayout?.y ?? undefined);

    if (limitsChanged) {
      updateLoadoutDraft(activeLoadoutName, (loadout) => loadout.nodes?.[socketId] ? setSocketLimits(loadout, socketId, nextLimits) : loadout);
    }
    if (layoutChanged) {
      updateLoadoutLayout(activeLoadoutName, (loadout) => setSocketLayouts(loadout, { [socketId]: nextLayout }));
    }
    setSocketActionId(undefined);
    setSocketActionMode('actions');
    setSocketPropertyError('');
    setStatus(`Updated socket properties for ${socketId}.`);
  }

  function closeSocketActionModal() {
    setSocketActionId(undefined);
    setSocketActionMode('actions');
    setSocketPropertyError('');
    setEdgeMutationError('');
  }

  function toggleEdgeCondition(edge: LoadoutEdge) {
    if (!activeLoadoutName || !activeLoadout) return;
    const edgeIndex = edge.edgeIndex;
    const result = stageValidatedPipelineGraphTransform(activeLoadout as never, (loadout: PipelineConfig) => toggleEdgeConditionInLoadout(loadout, edge.from, edge.to, edge.when, toggledEdgeCondition(edge.when), edgeIndex) as never);
    if (!result.ok) {
      setStatus(`Cannot toggle edge ${edge.from} → ${edge.to}: ${formatGraphValidationErrors(result.errors)}`);
      return;
    }
    updateLoadoutDraft(activeLoadoutName, () => result.graph as PipelineConfig);
    const updatedGraph = result.graph as PipelineConfig;
    const updatedEdge = edge.edgeIndex === undefined ? updatedGraph.nodes?.[edge.from]?.edges?.find((candidate) => candidate.to === edge.to) : updatedGraph.nodes?.[edge.from]?.edges?.[edge.edgeIndex];
    setStatus(`Staged edge ${socketLabel(edge.from)} → ${socketLabel(edge.to)} as ${edgeConditionLabel(updatedEdge?.when)}.`);
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

  return (
    <AppShell
      source={source}
      isDirty={isDirty}
      selectedTab={selectedTab}
      onSelectTab={selectTab}
      loadoutWorkspace={(
        <div className="loadout-workspace grid gap-6 xl:grid-cols-[16rem_minmax(0,1fr)_18rem]">
          <LoadoutListPanel
            loadouts={loadouts}
            activeLoadoutName={activeLoadoutName}
            persistedActiveLoadoutName={persistedActiveLoadoutName}
            persistedLoadouts={persistedLoadouts}
            loadoutSources={loadoutSources}
            canDeleteLoadout={canDeleteLoadout}
            onCreateLoadout={createLoadout}
            onSwitchLoadout={switchLoadout}
            onDeleteLoadout={deleteLoadout}
            onSetActiveLoadout={setPersistedActiveLoadout}
          />

          <LoadoutGraphPanel
            activeLoadout={activeLoadout}
            activeLoadoutName={activeLoadoutName}
            currentMonitorNode={currentMonitorNode}
            edgeCondition={edgeCondition}
            edgeMutationError={edgeMutationError}
            edgeTargetId={edgeTargetId}
            loadoutGraph={loadoutGraph}
            loadoutNameInput={loadoutNameInput}
            loopExitBadges={loopExitBadges}
            loopMemberships={loopMemberships}
            loopRegions={loopRegions}
            loopSelectionRectangle={loopSelectionRectangle}
            materia={materia}
            palette={palette}
            routedEdges={routedEdges}
            selectedLoopSocketIds={selectedLoopSocketIds}
            selectedLoopSocketSet={selectedLoopSocketSet}
            selectedMateriaId={selectedMateriaId}
            socketActionId={socketActionId}
            socketActionMode={socketActionMode}
            socketLayoutDrag={socketLayoutDrag}
            socketPropertyError={socketPropertyError}
            socketPropertyForm={socketPropertyForm}
            createLoopDisabled={createLoopDisabled}
            beginSocketLayoutDrag={beginSocketLayoutDrag}
            beginSocketRegionSelection={beginSocketRegionSelection}
            breakLoop={breakLoop}
            cancelSocketLayoutDrag={cancelSocketLayoutDrag}
            cancelSocketRegionSelection={cancelSocketRegionSelection}
            clearLoopExit={clearLoopExit}
            closeSocketActionModal={closeSocketActionModal}
            commitActiveLoadoutRename={commitActiveLoadoutRename}
            createConnectedSocket={createConnectedSocket}
            createEdge={createEdge}
            createTaskIteratorLoop={createTaskIteratorLoop}
            deleteSocket={deleteSocket}
            dragMateria={dragMateria}
            finishSocketLayoutDrag={finishSocketLayoutDrag}
            finishSocketRegionSelection={finishSocketRegionSelection}
            handleDrop={handleDrop}
            handleGraphDrop={handleGraphDrop}
            handleSocketClick={handleSocketClick}
            moveSocketLayoutDrag={moveSocketLayoutDrag}
            moveSocketRegionSelection={moveSocketRegionSelection}
            openEdgeConnector={openEdgeConnector}
            openSocketPropertyEditor={openSocketPropertyEditor}
            removeEdge={removeEdge}
            removeLegacyNextEdge={removeLegacyNextEdge}
            removeLoopExitConnection={removeLoopExitConnection}
            toggleLoopExitCondition={toggleLoopExitCondition}
            removeMateria={removeMateria}
            replaceMateriaFromModal={replaceMateriaFromModal}
            saveSocketProperties={saveSocketProperties}
            setEdgeCondition={setEdgeCondition}
            setEdgeTargetId={setEdgeTargetId}
            setLoadoutNameInput={setLoadoutNameInput}
            setSocketActionMode={setSocketActionMode}
            setSocketPropertyForm={setSocketPropertyForm}
            socketDisplayLabel={socketDisplayLabel}
            socketLabel={socketLabel}
            toggleEdgeCondition={toggleEdgeCondition}
            updateLoopExit={updateLoopExit}
          />

          <aside className="loadout-side-panel flex flex-col gap-6">
            <MateriaPalettePanel
              palette={palette}
              materia={materia}
              selectedMateriaId={selectedMateriaId}
              onDragMateria={dragMateria}
              onSelectMateria={setSelectedMateriaId}
            />

            <StageApplyPanel
              saveTarget={saveTarget}
              isDirty={isDirty}
              canRevert={canRevert}
              status={status}
              onSaveTargetChange={setSaveTarget}
              onSave={() => saveDraft().catch(() => undefined)}
              onRevert={revertDraft}
            />
          </aside>
        </div>
      )}
      materiaEditorWorkspace={<MateriaEditorPanel controller={materiaEditorController} />}
      monitorWorkspace={<MonitorPanel monitor={monitor} currentMonitorNode={currentMonitorNode} elapsed={elapsed} />}
    />
  );
}
