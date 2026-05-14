import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { LoadoutEditPolicy } from '../../../../../../domain/loadout.js';
import type { MateriaEdgeCondition } from '../../../../../../types.js';
import { formatGraphValidationErrors, stageValidatedPipelineGraphTransform } from '../../../../../../graph/graphValidation.js';
import { fromWebUiLoadoutDto, toWebUiLoadoutDto } from '../../../../../loadoutDto.js';
import {
  canDeleteSocket,
  extractMateriaReference,
  findLoopExitConnectionContext,
  getSocketLayout,
  type LegacyPipelineSocket,
  type PipelineConfig,
  type PipelineSocket,
} from '../../../loadoutModel.js';
import {
  addEdgeToLoadout,
  clearLoopExitInLoadout,
  createConnectedEmptySocket,
  createTaskLoop,
  deleteLoopFromLoadout,
  deleteSocketImmutable,
  removeEdgeFromLoadout,
  removeLegacyNextFromLoadout,
  removeLoopExitRouteFromLoadout,
  setSocketLayouts,
  setSocketLimits,
  toggleEdgeConditionInLoadout,
  toggleLoopExitRouteCondition,
  updateLoopExitInLoadout,
  upsertLoopExitRouteInLoadout,
  type LoadoutTransform,
} from '../../../loadoutTransforms.js';
import type { LoadoutEdge, SocketPropertyFormState } from '../../types.js';
import {
  emptySocketPropertyForm,
  parseOptionalFiniteNumber,
  parseOptionalPositiveInteger,
  socketPropertyFormFromSocket,
} from '../../utils/forms.js';
import {
  edgeConditionLabel,
  formatLoopDisplayLabel,
  materiaGeneratorOutput,
  toggledEdgeCondition,
} from '../../utils/graphLayout.js';

function stageValidatedWebUiLoadoutTransform(loadout: PipelineConfig, transform: LoadoutTransform, options?: Parameters<typeof stageValidatedPipelineGraphTransform>[2]) {
  const result = stageValidatedPipelineGraphTransform(
    fromWebUiLoadoutDto(loadout as never),
    (coreLoadout) => fromWebUiLoadoutDto(transform(toWebUiLoadoutDto(coreLoadout) as PipelineConfig) as never),
    options,
  );
  return result.ok ? { ...result, graph: toWebUiLoadoutDto(result.graph) as PipelineConfig } : result;
}

export interface LoadoutGraphMutationControllerOptions {
  activeLoadout: PipelineConfig | undefined;
  activeLoadoutName: string;
  editPolicy: LoadoutEditPolicy;
  loadoutGraph: { edges: LoadoutEdge[] };
  materia: Record<string, PipelineSocket>;
  selectedLoopSockets: Array<{ id: string }>;
  setSelectedLoopSocketIds: Dispatch<SetStateAction<string[]>>;
  setStatus: (status: string) => void;
  updateLoadoutDraft: (loadoutName: string, updater: (loadout: PipelineConfig) => PipelineConfig) => boolean;
  updateLoadoutLayout: (loadoutName: string, updater: (loadout: PipelineConfig) => PipelineConfig) => boolean;
  closeSocketActionModal: () => void;
  openSocketActionModal: (socketId: string, mode?: 'actions' | 'replace' | 'edit' | 'connect') => void;
  socketLabel: (socketId: string) => string;
  socketDisplayLabel: (socketId: string) => string;
}

export function useLoadoutGraphMutationController({
  activeLoadout,
  activeLoadoutName,
  editPolicy,
  loadoutGraph,
  materia,
  selectedLoopSockets,
  setSelectedLoopSocketIds,
  setStatus,
  updateLoadoutDraft,
  updateLoadoutLayout,
  closeSocketActionModal,
  openSocketActionModal,
  socketLabel,
  socketDisplayLabel,
}: LoadoutGraphMutationControllerOptions) {
  const [socketPropertyForm, setSocketPropertyForm] = useState<SocketPropertyFormState>(() => emptySocketPropertyForm());
  const [socketPropertyError, setSocketPropertyError] = useState('');
  const [edgeTargetId, setEdgeTargetId] = useState('');
  const [edgeCondition, setEdgeCondition] = useState<MateriaEdgeCondition>('satisfied');
  const [edgeMutationError, setEdgeMutationError] = useState('');

  function resetModalErrors() {
    setSocketPropertyError('');
    setEdgeMutationError('');
  }

  function resetSocketPropertyError() {
    setSocketPropertyError('');
  }

  function readonlyBlocked(action: string) {
    if (editPolicy.canEdit) return false;
    setEdgeMutationError(editPolicy.reason);
    setSocketPropertyError(editPolicy.reason);
    setStatus(`${action} blocked: ${editPolicy.reason}`);
    return true;
  }

  function deleteSocket(socketId: string) {
    if (readonlyBlocked(`Delete socket ${socketId}`)) return false;
    const socket = activeLoadout?.sockets?.[socketId];
    if (!socket || !activeLoadoutName) return false;
    if (!canDeleteSocket(socket)) {
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
      closeSocketActionModal();
      setSelectedLoopSocketIds((current) => current.filter((id) => id !== socketId));
    }
    return deleted;
  }

  function createConnectedSocket(afterSocketId: string) {
    if (readonlyBlocked(`Create socket after ${socketLabel(afterSocketId)}`)) return;
    if (!activeLoadoutName || !activeLoadout) return;
    const loopExitContext = findLoopExitConnectionContext(activeLoadout, afterSocketId);
    if (loopExitContext?.loop.exits?.some((route) => route.from === afterSocketId && route.condition === 'always')) {
      const message = `Loop exit ${socketLabel(afterSocketId)} already has an ${edgeConditionLabel('always')} route. Remove or edit the existing route before creating a new loop-exit socket.`;
      setEdgeMutationError(message);
      setStatus(`Cannot create socket after ${socketLabel(afterSocketId)}: ${message}`);
      return;
    }
    const result = stageValidatedWebUiLoadoutTransform(activeLoadout, (loadout) => createConnectedEmptySocket(loadout, afterSocketId));
    if (!result.ok) {
      setStatus(`Cannot create socket after ${socketLabel(afterSocketId)}: ${formatGraphValidationErrors(result.errors)}`);
      return;
    }
    if (updateLoadoutDraft(activeLoadoutName, () => result.graph as PipelineConfig)) {
      closeSocketActionModal();
      setStatus(loopExitContext ? `Created a socket and loop-exit route from ${afterSocketId}.` : `Created a connected empty socket after ${afterSocketId}.`);
    }
  }

  function openSocketPropertyEditor(socketId: string) {
    if (readonlyBlocked(`Edit socket ${socketLabel(socketId)}`)) return;
    setSocketPropertyForm(socketPropertyFormFromSocket(activeLoadout?.sockets?.[socketId], getSocketLayout(activeLoadout, socketId)));
    setSocketPropertyError('');
    setEdgeMutationError('');
    openSocketActionModal(socketId, 'edit');
  }

  function openEdgeConnector(socketId: string) {
    if (readonlyBlocked(`Connect edge from ${socketLabel(socketId)}`)) return;
    const firstOtherSocket = Object.keys(activeLoadout?.sockets ?? {}).find((id) => id !== socketId) ?? '';
    setEdgeTargetId(firstOtherSocket);
    setEdgeCondition(findLoopExitConnectionContext(activeLoadout, socketId) ? 'always' : 'satisfied');
    setEdgeMutationError('');
    openSocketActionModal(socketId, 'connect');
  }

  function commitGraphMutation(description: string, transform: LoadoutTransform, onSuccess: string, onError: (message: string) => string) {
    if (readonlyBlocked(description)) return false;
    if (!activeLoadoutName || !activeLoadout) return false;
    const result = stageValidatedWebUiLoadoutTransform(activeLoadout, transform, {
      isGeneratorSocket: (socketId) => {
        const referenced = extractMateriaReference(activeLoadout.sockets?.[socketId]);
        return Boolean(referenced && materiaGeneratorOutput(materia[referenced.materia]));
      },
    });
    if (!result.ok) {
      const message = formatGraphValidationErrors(result.errors);
      setEdgeMutationError(message);
      setStatus(onError(message));
      return false;
    }
    if (!updateLoadoutDraft(activeLoadoutName, () => result.graph as PipelineConfig)) return false;
    setEdgeMutationError('');
    setStatus(onSuccess || description);
    return true;
  }

  function createTaskIteratorLoop() {
    if (readonlyBlocked('Create loop')) return;
    if (!activeLoadout?.sockets || selectedLoopSockets.length === 0) {
      setStatus('Cannot create loop; select the cycle sockets first with shift-click or a drag box.');
      return;
    }
    const selectedIds = selectedLoopSockets.map((socket) => socket.id);
    const selected = new Set(selectedIds);
    const generatorInputs = loadoutGraph.edges.flatMap((edge) => {
      if (selected.has(edge.from) || !selected.has(edge.to)) return [];
      const referenced = extractMateriaReference(activeLoadout.sockets?.[edge.from]);
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
    const selectedLabels = selectedIds.map((id) => socketDisplayLabel(id));
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
      closeSocketActionModal();
      setSelectedLoopSocketIds([]);
    }
  }

  function updateLoopExit(loopId: string, patch: Partial<{ from: string; when: MateriaEdgeCondition; to: string }>) {
    const loop = activeLoadout?.loops?.[loopId];
    if (!loop) return;
    const currentExit = loop.exit ?? { from: loop.sockets[loop.sockets.length - 1] ?? '', when: 'satisfied' as MateriaEdgeCondition, to: 'end' };
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
    const label = formatLoopDisplayLabel(activeLoadout, loopId, loop.sockets, loop.label);
    commitGraphMutation(
      `Broke loop ${loopId}.`,
      (loadout) => deleteLoopFromLoadout(loadout, loopId),
      `Broke loop ${label}; sockets and edges were preserved.`,
      (message) => `Cannot break loop ${label}: ${message}`,
    );
  }

  function validateLoopExitRouteRequest(from: string, to: string, condition: MateriaEdgeCondition, loopExitContext: ReturnType<typeof findLoopExitConnectionContext>): string | undefined {
    if (!loopExitContext) return undefined;
    if (!activeLoadout?.sockets?.[from]) return `Loop-exit source ${from} is no longer available.`;
    if (!activeLoadout.sockets?.[to]) return `Choose an existing target socket for the loop-exit route.`;
    if (loopExitContext.loop.exit?.from !== from) return `Socket ${socketLabel(from)} is no longer the configured exit source for loop ${loopExitContext.loopId}.`;
    const parseMode = activeLoadout.sockets[from]?.parse;
    if ((condition === 'satisfied' || condition === 'not_satisfied') && parseMode !== 'json') {
      return `Loop-exit ${edgeConditionLabel(condition)} routes require ${socketLabel(from)} to parse JSON so runtime can read the canonical satisfied field. Set parse to "json" or choose Always.`;
    }
    return undefined;
  }

  function createEdge(from: string) {
    if (readonlyBlocked(`Create edge from ${socketLabel(from)}`)) return;
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
    if (created) closeSocketActionModal();
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
    if (removed) closeSocketActionModal();
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
    const edge = activeLoadout?.sockets?.[from]?.edges?.[edgeIndex];
    if (!edge) return;
    const removed = commitGraphMutation(
      `Removed edge ${from} → ${edge.to}.`,
      (loadout) => removeEdgeFromLoadout(loadout, from, edgeIndex),
      `Removed edge ${from} → ${edge.to}; sockets were preserved.`,
      (message) => `Cannot remove edge ${from} → ${edge.to}: ${message}`,
    );
    if (removed) closeSocketActionModal();
  }

  function removeLegacyNextEdge(from: string) {
    const to = (activeLoadout?.sockets?.[from] as LegacyPipelineSocket | undefined)?.next;
    if (!to) return;
    const removed = commitGraphMutation(
      `Removed legacy flow ${from} → ${to}.`,
      (loadout) => removeLegacyNextFromLoadout(loadout, from),
      `Removed legacy flow ${from} → ${to}; conditional edges and sockets were preserved.`,
      (message) => `Cannot remove legacy flow ${from} → ${to}: ${message}`,
    );
    if (removed) closeSocketActionModal();
  }

  function saveSocketProperties(socketId: string) {
    if (readonlyBlocked(`Save socket properties for ${socketLabel(socketId)}`)) return;
    if (!activeLoadoutName || !activeLoadout?.sockets?.[socketId]) return;
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

    const limits: PipelineSocket['limits'] = {};
    if (maxVisits !== undefined) limits.maxVisits = maxVisits;
    if (maxEdgeTraversals !== undefined) limits.maxEdgeTraversals = maxEdgeTraversals;
    if (maxOutputBytes !== undefined) limits.maxOutputBytes = maxOutputBytes;
    const nextLimits = Object.keys(limits).length > 0 ? limits : undefined;
    const layout: Parameters<typeof setSocketLayouts>[1][string] = {};
    if (layoutX !== undefined) layout.x = layoutX;
    if (layoutY !== undefined) layout.y = layoutY;
    const nextLayout = Object.keys(layout).length > 0 ? layout : undefined;
    const currentSocket = activeLoadout.sockets[socketId];
    const limitsChanged = (currentSocket.limits?.maxVisits ?? undefined) !== (nextLimits?.maxVisits ?? undefined)
      || (currentSocket.limits?.maxEdgeTraversals ?? undefined) !== (nextLimits?.maxEdgeTraversals ?? undefined)
      || (currentSocket.limits?.maxOutputBytes ?? undefined) !== (nextLimits?.maxOutputBytes ?? undefined);
    const currentLayout = getSocketLayout(activeLoadout, socketId);
    const layoutChanged = (currentLayout?.x ?? undefined) !== (nextLayout?.x ?? undefined) || (currentLayout?.y ?? undefined) !== (nextLayout?.y ?? undefined);

    const limitsSaved = limitsChanged ? updateLoadoutDraft(activeLoadoutName, (loadout) => loadout.sockets?.[socketId] ? setSocketLimits(loadout, socketId, nextLimits) : loadout) : false;
    const layoutSaved = layoutChanged ? updateLoadoutLayout(activeLoadoutName, (loadout) => setSocketLayouts(loadout, { [socketId]: nextLayout })) : false;
    if (limitsChanged || layoutChanged) {
      if (!limitsSaved && !layoutSaved) return;
    }
    closeSocketActionModal();
    setSocketPropertyError('');
    setStatus(`Updated socket properties for ${socketId}.`);
  }

  function toggleEdgeCondition(edge: LoadoutEdge) {
    if (readonlyBlocked(`Toggle edge ${socketLabel(edge.from)} → ${socketLabel(edge.to)}`)) return;
    if (!activeLoadoutName || !activeLoadout) return;
    const edgeIndex = edge.edgeIndex;
    const result = stageValidatedWebUiLoadoutTransform(activeLoadout, (loadout) => toggleEdgeConditionInLoadout(loadout, edge.from, edge.to, edge.when, toggledEdgeCondition(edge.when), edgeIndex));
    if (!result.ok) {
      setStatus(`Cannot toggle edge ${edge.from} → ${edge.to}: ${formatGraphValidationErrors(result.errors)}`);
      return;
    }
    const webUiGraph = toWebUiLoadoutDto(result.graph as never) as PipelineConfig;
    if (!updateLoadoutDraft(activeLoadoutName, () => webUiGraph)) return;
    const updatedGraph = webUiGraph;
    const updatedEdge = edge.edgeIndex === undefined ? updatedGraph.sockets?.[edge.from]?.edges?.find((candidate) => candidate.to === edge.to) : updatedGraph.sockets?.[edge.from]?.edges?.[edge.edgeIndex];
    setStatus(`Staged edge ${socketLabel(edge.from)} → ${socketLabel(edge.to)} as ${edgeConditionLabel(updatedEdge?.when)}.`);
  }

  return {
    socketPropertyForm,
    setSocketPropertyForm,
    socketPropertyError,
    edgeTargetId,
    setEdgeTargetId,
    edgeCondition,
    setEdgeCondition,
    edgeMutationError,
    resetModalErrors,
    resetSocketPropertyError,
    openSocketPropertyEditor,
    openEdgeConnector,
    commitGraphMutation,
    deleteSocket,
    createConnectedSocket,
    createTaskIteratorLoop,
    updateLoopExit,
    clearLoopExit,
    breakLoop,
    validateLoopExitRouteRequest,
    createEdge,
    removeLoopExitConnection,
    toggleLoopExitCondition,
    removeEdge,
    removeLegacyNextEdge,
    saveSocketProperties,
    toggleEdgeCondition,
  };
}
