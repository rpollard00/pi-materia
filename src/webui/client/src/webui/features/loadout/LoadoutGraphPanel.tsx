import type { CSSProperties, Dispatch, DragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, SetStateAction } from 'react';
import type { LoadoutEditPolicy, LoadoutUserLockState } from '../../../../../../domain/loadout.js';
import type { MateriaEdgeCondition } from '../../../../../../types.js';
import {
  canDeleteSocket,
  formatSocketLabel,
  getSocketLabel,
  isEmptySocket,
  isEntrySocket,
  socketColor,
  type LegacyPipelineSocket,
  type PipelineConfig,
  type PipelineSocket,
} from '../../../loadoutModel.js';
import { edgeConditionLabels } from '../../constants.js';
import type {
  DragPayload,
  LayoutSocketsResult,
  LoopExitBadge,
  LoopMembership,
  LoopRegion,
  RoutedLoadoutEdge,
  SocketLayoutDragState,
  SocketPropertyFormState,
} from '../../types.js';
import { Orb } from '../../components/Orb.js';
import {
  buildSocketHoverDetails,
  edgeConditionClass,
  edgeConditionLabel,
  formatIteratorBehavior,
  formatLoopDisplayLabel,
  generatorEdgeLabel,
  hasIteratorBehavior,
  isGeneratorOutputEdge,
  isGeneratorSocket,
  iteratorBadgeLabel,
} from '../../utils/graphLayout.js';

export type SocketActionMode = 'actions' | 'replace' | 'edit' | 'connect';

type GraphSocket = LayoutSocketsResult['sockets'][number];

interface LoopSelectionRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LoadoutGraphViewModel {
  activeLoadout?: PipelineConfig;
  activeLoadoutName?: string;
  currentMonitorSocket?: string;
  loadoutGraph: LayoutSocketsResult;
  loopExitBadges: Map<string, LoopExitBadge>;
  loopMemberships: Map<string, LoopMembership>;
  loopRegions: LoopRegion[];
  loopSelectionRectangle?: LoopSelectionRectangle;
  materia: Record<string, PipelineSocket>;
  palette: Array<[string, PipelineSocket]>;
  routedEdges: RoutedLoadoutEdge[];
  selectedLoopSocketIds: string[];
  selectedLoopSocketSet: Set<string>;
  selectedMateriaId?: string;
  socketLayoutDrag?: SocketLayoutDragState;
  createLoopDisabled: boolean;
  editPolicy: LoadoutEditPolicy;
  socketDisplayLabel: (socketId: string) => string;
  socketLabel: (socketId: string) => string;
}

interface LoadoutGraphToolbarState {
  loadoutNameInput: string;
  setLoadoutNameInput: Dispatch<SetStateAction<string>>;
  commitActiveLoadoutRename: () => void;
  duplicateActiveLoadout: () => boolean;
  setActiveLoadoutLockState: (lockState: LoadoutUserLockState) => boolean;
}

interface LoadoutGraphCanvasActions {
  beginSocketLayoutDrag: (socket: GraphSocket, event: ReactPointerEvent<HTMLButtonElement>) => void;
  beginSocketRegionSelection: (event: ReactPointerEvent<HTMLDivElement>) => void;
  cancelSocketLayoutDrag: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  cancelSocketRegionSelection: (event: ReactPointerEvent<HTMLDivElement>) => void;
  dragMateria: (payload: DragPayload, event: DragEvent) => void;
  finishSocketLayoutDrag: (socketId: string, event: ReactPointerEvent<HTMLButtonElement>) => void;
  finishSocketRegionSelection: (event: ReactPointerEvent<HTMLDivElement>) => void;
  handleDrop: (socketId: string, event: DragEvent) => void;
  handleGraphDrop: (event: DragEvent) => void;
  handleSocketClick: (socketId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  moveSocketLayoutDrag: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  moveSocketRegionSelection: (event: ReactPointerEvent<HTMLDivElement>) => void;
  toggleEdgeCondition: (edge: RoutedLoadoutEdge['edge']) => void;
  toggleLoopExitCondition: (loopId: string, routeId: string) => void;
}

interface LoadoutGraphLoopActions {
  breakLoop: (loopId: string) => void;
  clearLoopExit: (loopId: string) => void;
  createTaskIteratorLoop: () => void;
  updateLoopExit: (loopId: string, patch: Partial<{ from: string; when: MateriaEdgeCondition; to: string }>) => void;
}

interface LoadoutGraphSocketModalState {
  edgeCondition: MateriaEdgeCondition;
  edgeMutationError: string;
  edgeTargetId: string;
  socketActionId?: string;
  socketActionMode: SocketActionMode;
  socketPropertyError: string;
  socketPropertyForm: SocketPropertyFormState;
}

interface LoadoutGraphSocketModalActions {
  closeSocketActionModal: () => void;
  createConnectedSocket: (socketId: string) => void;
  createEdge: (socketId: string) => void;
  deleteSocket: (socketId: string) => void;
  openEdgeConnector: (socketId: string) => void;
  openSocketPropertyEditor: (socketId: string) => void;
  removeEdge: (socketId: string, edgeIndex: number) => void;
  removeLegacyNextEdge: (socketId: string) => void;
  removeLoopExitConnection: (loopId: string, routeId: string) => void;
  removeMateria: (socketId: string) => void;
  replaceMateriaFromModal: (socketId: string, materiaId: string) => void;
  saveSocketProperties: (socketId: string) => void;
  setEdgeCondition: Dispatch<SetStateAction<MateriaEdgeCondition>>;
  setEdgeTargetId: Dispatch<SetStateAction<string>>;
  setSocketActionMode: Dispatch<SetStateAction<SocketActionMode>>;
  setSocketPropertyForm: Dispatch<SetStateAction<SocketPropertyFormState>>;
}

interface LoadoutGraphPanelProps {
  viewModel: LoadoutGraphViewModel;
  toolbar: LoadoutGraphToolbarState;
  canvasActions: LoadoutGraphCanvasActions;
  loopActions: LoadoutGraphLoopActions;
  socketModal: {
    state: LoadoutGraphSocketModalState;
    actions: LoadoutGraphSocketModalActions;
  };
}

export function LoadoutGraphPanel({ viewModel, toolbar, canvasActions, loopActions, socketModal }: LoadoutGraphPanelProps) {
  return (
    <section className="fantasy-panel loadout-graph-panel p-6">
      <GraphToolbar
        createLoopDisabled={viewModel.createLoopDisabled}
        createTaskIteratorLoop={loopActions.createTaskIteratorLoop}
        duplicateActiveLoadout={toolbar.duplicateActiveLoadout}
        editPolicy={viewModel.editPolicy}
        loadoutNameInput={toolbar.loadoutNameInput}
        setActiveLoadoutLockState={toolbar.setActiveLoadoutLockState}
        selectedLoopSocketIds={viewModel.selectedLoopSocketIds}
        setLoadoutNameInput={toolbar.setLoadoutNameInput}
        commitActiveLoadoutRename={toolbar.commitActiveLoadoutRename}
        socketLabel={viewModel.socketLabel}
      />

      <GraphCanvas
        activeLoadout={viewModel.activeLoadout}
        activeLoadoutName={viewModel.activeLoadoutName}
        currentMonitorSocket={viewModel.currentMonitorSocket}
        loadoutGraph={viewModel.loadoutGraph}
        loopExitBadges={viewModel.loopExitBadges}
        loopMemberships={viewModel.loopMemberships}
        loopRegions={viewModel.loopRegions}
        loopSelectionRectangle={viewModel.loopSelectionRectangle}
        materia={viewModel.materia}
        routedEdges={viewModel.routedEdges}
        selectedLoopSocketSet={viewModel.selectedLoopSocketSet}
        selectedMateriaId={viewModel.selectedMateriaId}
        socketLayoutDrag={viewModel.socketLayoutDrag}
        editPolicy={viewModel.editPolicy}
        beginSocketLayoutDrag={canvasActions.beginSocketLayoutDrag}
        beginSocketRegionSelection={canvasActions.beginSocketRegionSelection}
        cancelSocketLayoutDrag={canvasActions.cancelSocketLayoutDrag}
        cancelSocketRegionSelection={canvasActions.cancelSocketRegionSelection}
        dragMateria={canvasActions.dragMateria}
        finishSocketLayoutDrag={canvasActions.finishSocketLayoutDrag}
        finishSocketRegionSelection={canvasActions.finishSocketRegionSelection}
        handleDrop={canvasActions.handleDrop}
        handleGraphDrop={canvasActions.handleGraphDrop}
        handleSocketClick={canvasActions.handleSocketClick}
        moveSocketLayoutDrag={canvasActions.moveSocketLayoutDrag}
        moveSocketRegionSelection={canvasActions.moveSocketRegionSelection}
        toggleEdgeCondition={canvasActions.toggleEdgeCondition}
        toggleLoopExitCondition={canvasActions.toggleLoopExitCondition}
      />

      <LoopEditorPanel
        activeLoadout={viewModel.activeLoadout}
        editPolicy={viewModel.editPolicy}
        breakLoop={loopActions.breakLoop}
        clearLoopExit={loopActions.clearLoopExit}
        socketDisplayLabel={viewModel.socketDisplayLabel}
        socketLabel={viewModel.socketLabel}
        updateLoopExit={loopActions.updateLoopExit}
      />

      <SocketActionModal
        activeLoadout={viewModel.activeLoadout}
        edgeCondition={socketModal.state.edgeCondition}
        edgeMutationError={socketModal.state.edgeMutationError}
        edgeTargetId={socketModal.state.edgeTargetId}
        materia={viewModel.materia}
        palette={viewModel.palette}
        socketActionId={socketModal.state.socketActionId}
        socketActionMode={socketModal.state.socketActionMode}
        socketPropertyError={socketModal.state.socketPropertyError}
        socketPropertyForm={socketModal.state.socketPropertyForm}
        editPolicy={viewModel.editPolicy}
        closeSocketActionModal={socketModal.actions.closeSocketActionModal}
        createConnectedSocket={socketModal.actions.createConnectedSocket}
        createEdge={socketModal.actions.createEdge}
        deleteSocket={socketModal.actions.deleteSocket}
        openEdgeConnector={socketModal.actions.openEdgeConnector}
        openSocketPropertyEditor={socketModal.actions.openSocketPropertyEditor}
        removeEdge={socketModal.actions.removeEdge}
        removeLegacyNextEdge={socketModal.actions.removeLegacyNextEdge}
        removeLoopExitConnection={socketModal.actions.removeLoopExitConnection}
        removeMateria={socketModal.actions.removeMateria}
        replaceMateriaFromModal={socketModal.actions.replaceMateriaFromModal}
        saveSocketProperties={socketModal.actions.saveSocketProperties}
        setEdgeCondition={socketModal.actions.setEdgeCondition}
        setEdgeTargetId={socketModal.actions.setEdgeTargetId}
        setSocketActionMode={socketModal.actions.setSocketActionMode}
        setSocketPropertyForm={socketModal.actions.setSocketPropertyForm}
        socketLabel={viewModel.socketLabel}
      />
    </section>
  );
}

interface GraphToolbarProps {
  createLoopDisabled: boolean;
  createTaskIteratorLoop: () => void;
  loadoutNameInput: string;
  selectedLoopSocketIds: string[];
  setLoadoutNameInput: Dispatch<SetStateAction<string>>;
  commitActiveLoadoutRename: () => void;
  duplicateActiveLoadout: () => boolean;
  editPolicy: LoadoutEditPolicy;
  setActiveLoadoutLockState: (lockState: LoadoutUserLockState) => boolean;
  socketLabel: (socketId: string) => string;
}

function GraphToolbar({ createLoopDisabled, createTaskIteratorLoop, duplicateActiveLoadout, editPolicy, loadoutNameInput, selectedLoopSocketIds, setLoadoutNameInput, setActiveLoadoutLockState, commitActiveLoadoutRename, socketLabel }: GraphToolbarProps) {
  const lockStatus = editPolicy.readonly ? 'Read-only' : editPolicy.lockState === 'locked' ? 'Locked' : 'Edit mode';
  const canToggleLock = !editPolicy.readonly;
  return (
    <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div>
        <h2 className="text-2xl font-bold">Visual materia grid</h2>
        <p className="text-sm text-slate-400">Drag orbs into sockets, drag socketed orbs onto the graph background to unsocket, drag socket cards to arrange them, or click a palette orb then click a socket.</p>
        <p className="mt-1 text-xs text-cyan-200/80">To create a loop, select the cycle sockets with shift-click or a drag box; the selected cycle must have exactly one inbound edge from a Generator materia.</p>
        {!editPolicy.canEdit ? (
          <div className="mt-3 rounded-xl border border-amber-300/30 bg-amber-950/30 px-4 py-3 text-sm text-amber-100" role="status">
            <span>{editPolicy.reason}</span>
            {editPolicy.reasonCode === 'shipped_default_readonly' ? <button type="button" className="materia-button-secondary ml-3" onClick={duplicateActiveLoadout}>Duplicate to edit</button> : null}
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="rounded-xl border border-cyan-200/15 bg-slate-950/70 px-3 py-2 text-sm text-cyan-100" role="group" aria-label="Loadout edit status" title={editPolicy.reason}>
          <span className="font-semibold">{lockStatus}</span>
          <span className="ml-2 text-xs text-slate-400">{editPolicy.reason}</span>
        </div>
        {canToggleLock ? (
          <button type="button" className="materia-button-secondary" data-testid="loadout-lock-toggle" aria-pressed={editPolicy.lockState === 'locked'} title={editPolicy.lockState === 'locked' ? 'Unlock edit mode for this loadout' : 'Lock this loadout for monitoring and inspection'} onClick={() => setActiveLoadoutLockState(editPolicy.lockState === 'locked' ? 'unlocked' : 'locked')}>
            {editPolicy.lockState === 'locked' ? 'Unlock edits' : 'Lock edits'}
          </button>
        ) : null}
        <button type="button" className="materia-button-secondary" data-testid="create-task-loop" onClick={createTaskIteratorLoop} disabled={createLoopDisabled} title={createLoopDisabled ? (!editPolicy.canEdit ? editPolicy.reason : 'Select loop sockets with shift-click or a drag box first.') : `Create loop from selected sockets: ${selectedLoopSocketIds.map(socketLabel).join(', ')}`}>Create Loop</button>
        <label className="text-sm text-slate-300">Edit name
          <input
            className="ml-3 rounded-xl border border-cyan-200/20 bg-slate-950/80 px-3 py-2 text-cyan-100"
            value={loadoutNameInput}
            onChange={(event) => setLoadoutNameInput(event.target.value)}
            onBlur={() => commitActiveLoadoutRename()}
            disabled={!editPolicy.canEdit}
            title={!editPolicy.canEdit ? editPolicy.reason : undefined}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
        </label>
      </div>
    </div>
  );
}

interface GraphCanvasProps {
  activeLoadout?: PipelineConfig;
  activeLoadoutName?: string;
  currentMonitorSocket?: string;
  loadoutGraph: LayoutSocketsResult;
  loopExitBadges: Map<string, LoopExitBadge>;
  loopMemberships: Map<string, LoopMembership>;
  loopRegions: LoopRegion[];
  loopSelectionRectangle?: LoopSelectionRectangle;
  materia: Record<string, PipelineSocket>;
  routedEdges: RoutedLoadoutEdge[];
  selectedLoopSocketSet: Set<string>;
  selectedMateriaId?: string;
  socketLayoutDrag?: SocketLayoutDragState;
  editPolicy: LoadoutEditPolicy;
  beginSocketLayoutDrag: (socket: GraphSocket, event: ReactPointerEvent<HTMLButtonElement>) => void;
  beginSocketRegionSelection: (event: ReactPointerEvent<HTMLDivElement>) => void;
  cancelSocketLayoutDrag: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  cancelSocketRegionSelection: (event: ReactPointerEvent<HTMLDivElement>) => void;
  dragMateria: (payload: DragPayload, event: DragEvent) => void;
  finishSocketLayoutDrag: (socketId: string, event: ReactPointerEvent<HTMLButtonElement>) => void;
  finishSocketRegionSelection: (event: ReactPointerEvent<HTMLDivElement>) => void;
  handleDrop: (socketId: string, event: DragEvent) => void;
  handleGraphDrop: (event: DragEvent) => void;
  handleSocketClick: (socketId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  moveSocketLayoutDrag: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  moveSocketRegionSelection: (event: ReactPointerEvent<HTMLDivElement>) => void;
  toggleEdgeCondition: (edge: RoutedLoadoutEdge['edge']) => void;
  toggleLoopExitCondition: (loopId: string, routeId: string) => void;
}

function GraphCanvas(props: GraphCanvasProps) {
  const {
    activeLoadout, activeLoadoutName, currentMonitorSocket, loadoutGraph, loopExitBadges, loopMemberships,
    loopRegions, loopSelectionRectangle, materia, routedEdges, selectedLoopSocketSet, selectedMateriaId,
    socketLayoutDrag, editPolicy, beginSocketLayoutDrag, beginSocketRegionSelection, cancelSocketLayoutDrag,
    cancelSocketRegionSelection, dragMateria, finishSocketLayoutDrag, finishSocketRegionSelection, handleDrop,
    handleGraphDrop, handleSocketClick, moveSocketLayoutDrag, moveSocketRegionSelection, toggleEdgeCondition,
    toggleLoopExitCondition,
  } = props;

  return (
    <div className="loadout-graph-viewport" data-testid="socket-grid-viewport" onDragOver={(event) => { if (editPolicy.canEdit) event.preventDefault(); }} onDrop={editPolicy.canEdit ? handleGraphDrop : undefined} aria-readonly={!editPolicy.canEdit} title={!editPolicy.canEdit ? editPolicy.reason : undefined}>
      <div
        className="loadout-graph-canvas"
        data-testid="socket-grid"
        style={{ width: `${loadoutGraph.width}px`, height: `${loadoutGraph.height}px` }}
        onPointerDown={beginSocketRegionSelection}
        onPointerMove={moveSocketRegionSelection}
        onPointerUp={finishSocketRegionSelection}
        onPointerCancel={cancelSocketRegionSelection}
      >
        <EdgeLayer
          activeLoadout={activeLoadout}
          height={loadoutGraph.height}
          loopRegions={loopRegions}
          materia={materia}
          routedEdges={routedEdges}
          toggleEdgeCondition={toggleEdgeCondition}
          toggleLoopExitCondition={toggleLoopExitCondition}
          editPolicy={editPolicy}
          width={loadoutGraph.width}
        />
        <LoopRegionsLayer loopRegions={loopRegions} loopSelectionRectangle={loopSelectionRectangle} />
        {loadoutGraph.sockets.map((socket) => (
          <SocketCard
            key={socket.id}
            activeLoadout={activeLoadout}
            activeLoadoutName={activeLoadoutName}
            currentMonitorSocket={currentMonitorSocket}
            dragMateria={dragMateria}
            handleDrop={handleDrop}
            handleSocketClick={handleSocketClick}
            loopExitBadge={loopExitBadges.get(socket.id)}
            loopMembership={loopMemberships.get(socket.id)}
            materia={materia}
            selectedLoopSocketSet={selectedLoopSocketSet}
            selectedMateriaId={selectedMateriaId}
            socket={socket}
            socketLayoutDrag={socketLayoutDrag}
            editPolicy={editPolicy}
            beginSocketLayoutDrag={beginSocketLayoutDrag}
            cancelSocketLayoutDrag={cancelSocketLayoutDrag}
            finishSocketLayoutDrag={finishSocketLayoutDrag}
            moveSocketLayoutDrag={moveSocketLayoutDrag}
          />
        ))}
      </div>
    </div>
  );
}

interface EdgeLayerProps {
  activeLoadout?: PipelineConfig;
  height: number;
  loopRegions: LoopRegion[];
  materia: Record<string, PipelineSocket>;
  routedEdges: RoutedLoadoutEdge[];
  toggleEdgeCondition: (edge: RoutedLoadoutEdge['edge']) => void;
  toggleLoopExitCondition: (loopId: string, routeId: string) => void;
  editPolicy: LoadoutEditPolicy;
  width: number;
}

function EdgeLayer({ activeLoadout, height, loopRegions, materia, routedEdges, toggleEdgeCondition, toggleLoopExitCondition, editPolicy, width }: EdgeLayerProps) {
  return (
    <svg className="loadout-edge-layer" width={width} height={height} aria-label="Loadout edges">
      <defs>
        <marker id="materia-edge-arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth"><path d="M2,2 L10,6 L2,10 Z" className="loadout-edge-arrow" /></marker>
        <marker id="materia-generator-edge-arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth"><path d="M2,2 L10,6 L2,10 Z" className="loadout-generator-edge-arrow" /></marker>
        <marker id="materia-loop-cycle-arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth"><path d="M2,2 L10,6 L2,10 Z" className="loadout-loop-cycle-arrow" /></marker>
        <marker id="materia-loop-exit-edge-arrow-default" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth"><path d="M2,2 L10,6 L2,10 Z" className="loadout-loop-exit-edge-arrow loadout-loop-exit-edge-arrow-default" /></marker>
        <marker id="materia-loop-exit-edge-arrow-satisfied" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth"><path d="M2,2 L10,6 L2,10 Z" className="loadout-loop-exit-edge-arrow loadout-loop-exit-edge-arrow-satisfied" /></marker>
        <marker id="materia-loop-exit-edge-arrow-unsatisfied" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth"><path d="M2,2 L10,6 L2,10 Z" className="loadout-loop-exit-edge-arrow loadout-loop-exit-edge-arrow-unsatisfied" /></marker>
      </defs>
      {loopRegions.map((loop) => (
        <g key={loop.id} className="loadout-loop-cycle-edge" data-testid={`loop-cycle-edge-${loop.id}`} aria-label={`${loop.label} cycle indicator`} style={{ '--loop-accent': loop.accent, '--loop-accent-soft': loop.accentSoft } as CSSProperties}>
          <path d={loop.cyclePath} className="loadout-loop-cycle-edge-echo" />
          <path d={loop.cyclePath} markerEnd="url(#materia-loop-cycle-arrow)" />
        </g>
      ))}
      {routedEdges.map(({ edge, path, labelX, labelY, labelRotate, routeClass }) => {
        const isGeneratorInput = isGeneratorOutputEdge(edge, activeLoadout, materia);
        const isLoopExitEdge = edge.kind === 'loop-exit';
        const edgeLabel = generatorEdgeLabel(edge, activeLoadout, materia);
        const conditionClass = edgeConditionClass(edge.when);
        const markerEnd = isLoopExitEdge ? `url(#materia-loop-exit-edge-arrow-${conditionClass})` : isGeneratorInput ? 'url(#materia-generator-edge-arrow)' : 'url(#materia-edge-arrow)';
        const edgeTestId = isLoopExitEdge && edge.loopId && edge.loopExitRouteId ? `loop-exit-edge-${edge.loopId}-${edge.loopExitRouteId}` : `edge-${edge.from}-${edge.to}-${edge.edgeIndex ?? 'next'}`;
        const activateEdge = () => {
          if (!editPolicy.canEdit) return;
          if (isLoopExitEdge && edge.loopId && edge.loopExitRouteId) toggleLoopExitCondition(edge.loopId, edge.loopExitRouteId);
          else toggleEdgeCondition(edge);
        };
        return (
          <g key={edge.id} data-testid={edgeTestId} data-edge-kind={edge.kind} role="button" tabIndex={editPolicy.canEdit ? 0 : -1} aria-disabled={!editPolicy.canEdit} aria-label={`${edgeLabel} from ${edge.from} to ${edge.to}`} className={`loadout-edge loadout-edge-${conditionClass} loadout-edge-route-${routeClass} ${isGeneratorInput ? 'loadout-edge-generator-input' : ''} ${isLoopExitEdge ? 'loadout-edge-loop-exit' : ''} ${editPolicy.canEdit ? 'loadout-edge-clickable' : ''}`} onClick={activateEdge} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activateEdge(); } }}>
            <path d={path} markerEnd={markerEnd} />
            <text x={labelX} y={labelY} transform={`rotate(${labelRotate} ${labelX} ${labelY})`}>{edgeLabel}</text>
          </g>
        );
      })}
    </svg>
  );
}

interface LoopRegionsLayerProps {
  loopRegions: LoopRegion[];
  loopSelectionRectangle?: LoopSelectionRectangle;
}

function LoopRegionsLayer({ loopRegions, loopSelectionRectangle }: LoopRegionsLayerProps) {
  return (
    <>
      {loopRegions.map((loop) => (
        <div key={loop.id} className="loadout-loop-region" data-testid={`loop-region-${loop.id}`} style={{ left: `${loop.x}px`, top: `${loop.y}px`, width: `${loop.width}px`, height: `${loop.height}px`, '--loop-accent': loop.accent, '--loop-accent-soft': loop.accentSoft } as CSSProperties} title={loop.summary} aria-label={`${loop.label} loop: ${loop.summary}`}>
          <span className="loadout-loop-badge">Loop</span><span className="loadout-loop-title">{loop.label}</span><span className="loadout-loop-summary">{loop.summary}</span>
        </div>
      ))}
      {loopSelectionRectangle && <div className="loadout-loop-selection-rectangle" data-testid="loop-selection-rectangle" style={{ left: `${loopSelectionRectangle.x}px`, top: `${loopSelectionRectangle.y}px`, width: `${loopSelectionRectangle.width}px`, height: `${loopSelectionRectangle.height}px` }} />}
    </>
  );
}

interface SocketCardProps {
  activeLoadout?: PipelineConfig;
  activeLoadoutName?: string;
  currentMonitorSocket?: string;
  dragMateria: (payload: DragPayload, event: DragEvent) => void;
  handleDrop: (socketId: string, event: DragEvent) => void;
  handleSocketClick: (socketId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  loopExitBadge?: LoopExitBadge;
  loopMembership?: LoopMembership;
  materia: Record<string, PipelineSocket>;
  selectedLoopSocketSet: Set<string>;
  selectedMateriaId?: string;
  socket: GraphSocket;
  socketLayoutDrag?: SocketLayoutDragState;
  editPolicy: LoadoutEditPolicy;
  beginSocketLayoutDrag: (socket: GraphSocket, event: ReactPointerEvent<HTMLButtonElement>) => void;
  cancelSocketLayoutDrag: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  finishSocketLayoutDrag: (socketId: string, event: ReactPointerEvent<HTMLButtonElement>) => void;
  moveSocketLayoutDrag: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

function SocketCard(props: SocketCardProps) {
  const {
    activeLoadout, activeLoadoutName, currentMonitorSocket, dragMateria, handleDrop, handleSocketClick,
    loopExitBadge, loopMembership, materia, selectedLoopSocketSet, selectedMateriaId, socket: graphSocket, socketLayoutDrag,
    editPolicy, beginSocketLayoutDrag, cancelSocketLayoutDrag, finishSocketLayoutDrag, moveSocketLayoutDrag,
  } = props;
  const { id, socket, index, x, y } = graphSocket;
  const dragPreview = socketLayoutDrag?.socketId === id ? socketLayoutDrag : undefined;
  const socketX = dragPreview?.currentX ?? x;
  const socketY = dragPreview?.currentY ?? y;
  const socketLabel = getSocketLabel(id, socket);
  const socketHoverDetails = buildSocketHoverDetails(id, socket, materia, activeLoadout);
  const isIterator = hasIteratorBehavior(socket, materia);
  const isGenerator = isGeneratorSocket(socket, materia);
  const iteratorDetails = isIterator ? formatIteratorBehavior(socket, materia) : undefined;
  const isLoopSelected = selectedLoopSocketSet.has(id);
  const isEntry = isEntrySocket(socket);
  const isActiveMonitorSocket = id === currentMonitorSocket;
  const socketStyle = loopMembership ? { left: `${socketX}px`, top: `${socketY}px`, '--loop-accent': loopMembership.accent, '--loop-accent-soft': loopMembership.accentSoft } as CSSProperties : { left: `${socketX}px`, top: `${socketY}px` };

  return (
    <button data-testid={`socket-${id}`} className={`materia-socket graph-materia-socket ${selectedMateriaId && editPolicy.canEdit ? 'materia-socket-selectable' : ''} ${isActiveMonitorSocket ? 'materia-socket-active' : ''} ${dragPreview ? 'graph-materia-socket-dragging' : ''} ${isIterator ? 'materia-socket-iterator' : ''} ${isGenerator ? 'materia-socket-generator' : ''} ${loopMembership ? 'materia-socket-loop-member' : ''} ${loopExitBadge ? 'materia-socket-loop-exit' : ''} ${isLoopSelected ? 'materia-socket-loop-selected' : ''}`} style={socketStyle} data-loop-ids={loopMembership?.loopIds.join(' ')} data-loop-exit-ids={loopExitBadge?.loopIds.join(' ')} aria-pressed={isLoopSelected} onClick={(event) => handleSocketClick(id, event)} onPointerDown={(event) => beginSocketLayoutDrag(graphSocket, event)} onPointerMove={moveSocketLayoutDrag} onPointerUp={(event) => finishSocketLayoutDrag(id, event)} onPointerCancel={cancelSocketLayoutDrag} onDragOver={(event) => { if (editPolicy.canEdit) event.preventDefault(); }} onDrop={editPolicy.canEdit ? (event) => handleDrop(id, event) : undefined} title={!editPolicy.canEdit ? `${socketHoverDetails}\n${editPolicy.reason}` : socketHoverDetails} aria-label={`${socketLabel} socket details${isActiveMonitorSocket ? '; active session socket' : ''}`} aria-readonly={!editPolicy.canEdit} aria-current={isActiveMonitorSocket ? 'step' : undefined}>
      <div className="materia-socket-orb-stage"><div draggable={editPolicy.canEdit && !isEmptySocket(socket)} onDragStart={(event) => dragMateria({ kind: 'socket', materiaId: id, fromLoadout: activeLoadoutName, fromSocket: id }, event)}><Orb color={socketColor(id, index, materia, socket)} label={socketHoverDetails} empty={isEmptySocket(socket)} iterator={isIterator} /></div>{isActiveMonitorSocket && <span className="materia-socket-active-indicator" aria-hidden="true" />}{isIterator && <span className={`materia-iterator-badge graph-iterator-badge ${isGenerator ? 'materia-generator-badge' : ''}`} title={iteratorDetails}>{iteratorBadgeLabel(iteratorDetails)}</span>}</div>
      {isEntry && <span className="entry-rune">Entry</span>}
      {loopExitBadge && <span className="loop-exit-rune" title={loopExitBadge.title} style={{ '--loop-accent': loopExitBadge.accent, '--loop-accent-soft': loopExitBadge.accentSoft } as CSSProperties}>Loop exit</span>}
      <span className="materia-socket-label">{socketLabel}</span>
    </button>
  );
}

interface LoopEditorPanelProps {
  activeLoadout?: PipelineConfig;
  editPolicy: LoadoutEditPolicy;
  breakLoop: (loopId: string) => void;
  clearLoopExit: (loopId: string) => void;
  socketDisplayLabel: (socketId: string) => string;
  socketLabel: (socketId: string) => string;
  updateLoopExit: (loopId: string, patch: Partial<{ from: string; when: MateriaEdgeCondition; to: string }>) => void;
}

function LoopEditorPanel({ activeLoadout, editPolicy, breakLoop, clearLoopExit, socketDisplayLabel, socketLabel, updateLoopExit }: LoopEditorPanelProps) {
  if (Object.keys(activeLoadout?.loops ?? {}).length === 0) return null;

  return (
    <div className="mt-4 rounded-2xl border border-cyan-200/15 bg-slate-950/55 p-4" data-testid="loop-editor-panel">
      <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-200">Loop exits</h3>
      <p className="mt-1 text-xs text-slate-400">Loop exits are compiled into runtime parse/advance control flow on the exit source; they are not decorative metadata. Validation will block conflicting socket parse, advance, or continuation routes before save/run.</p>
      <div className="mt-3 grid gap-3">
        {Object.entries(activeLoadout?.loops ?? {}).map(([loopId, loop]) => {
          const exit = loop.exit ?? { from: loop.sockets[loop.sockets.length - 1] ?? '', when: 'satisfied' as MateriaEdgeCondition, to: 'end' };
          return (
            <div key={loopId} className="flex flex-wrap items-end gap-3 rounded-xl border border-cyan-200/10 bg-slate-900/60 p-3" data-testid={`loop-editor-${loopId}`}>
              <div className="min-w-48 flex-1"><div className="font-semibold text-cyan-100">{formatLoopDisplayLabel(activeLoadout, loopId, loop.sockets, loop.label)}</div><div className="text-xs text-slate-400">Members: {loop.sockets.map(socketDisplayLabel).join(', ')}</div></div>
              <label className="text-xs uppercase tracking-[0.16em] text-slate-400">Exit source<select className="mt-1 block rounded-xl border border-cyan-200/20 bg-slate-950/80 px-3 py-2 text-cyan-100" data-testid={`loop-exit-source-${loopId}`} value={exit.from} disabled={!editPolicy.canEdit} title={!editPolicy.canEdit ? editPolicy.reason : undefined} onChange={(event) => updateLoopExit(loopId, { from: event.target.value })}>{loop.sockets.map((socketId) => <option key={socketId} value={socketId}>{socketDisplayLabel(socketId)}</option>)}</select></label>
              <label className="text-xs uppercase tracking-[0.16em] text-slate-400">Exit condition<select className="mt-1 block rounded-xl border border-cyan-200/20 bg-slate-950/80 px-3 py-2 text-cyan-100" data-testid={`loop-exit-condition-${loopId}`} value={exit.when} disabled={!editPolicy.canEdit} title={!editPolicy.canEdit ? editPolicy.reason : undefined} onChange={(event) => updateLoopExit(loopId, { when: event.target.value as MateriaEdgeCondition })}>{Object.entries(edgeConditionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="text-xs uppercase tracking-[0.16em] text-slate-400">Exit target<select className="mt-1 block rounded-xl border border-cyan-200/20 bg-slate-950/80 px-3 py-2 text-cyan-100" data-testid={`loop-exit-target-${loopId}`} value={exit.to} disabled={!editPolicy.canEdit} title={!editPolicy.canEdit ? editPolicy.reason : undefined} onChange={(event) => updateLoopExit(loopId, { to: event.target.value })}><option value="end">end</option>{Object.keys(activeLoadout?.sockets ?? {}).map((socketId) => <option key={socketId} value={socketId}>{socketLabel(socketId)}</option>)}</select></label>
              {loop.exit && <button type="button" className="materia-button-secondary" data-testid={`loop-exit-clear-${loopId}`} disabled={!editPolicy.canEdit} title={!editPolicy.canEdit ? editPolicy.reason : undefined} onClick={() => clearLoopExit(loopId)}>Clear exit</button>}
              <button type="button" className="materia-button-secondary" data-testid={`loop-break-${loopId}`} disabled={!editPolicy.canEdit} title={!editPolicy.canEdit ? editPolicy.reason : undefined} onClick={() => breakLoop(loopId)}>Break loop</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface SocketActionModalProps {
  activeLoadout?: PipelineConfig;
  edgeCondition: MateriaEdgeCondition;
  edgeMutationError: string;
  edgeTargetId: string;
  materia: Record<string, PipelineSocket>;
  palette: Array<[string, PipelineSocket]>;
  socketActionId?: string;
  socketActionMode: SocketActionMode;
  socketPropertyError: string;
  socketPropertyForm: SocketPropertyFormState;
  editPolicy: LoadoutEditPolicy;
  closeSocketActionModal: () => void;
  createConnectedSocket: (socketId: string) => void;
  createEdge: (socketId: string) => void;
  deleteSocket: (socketId: string) => void;
  openEdgeConnector: (socketId: string) => void;
  openSocketPropertyEditor: (socketId: string) => void;
  removeEdge: (socketId: string, edgeIndex: number) => void;
  removeLegacyNextEdge: (socketId: string) => void;
  removeLoopExitConnection: (loopId: string, routeId: string) => void;
  removeMateria: (socketId: string) => void;
  replaceMateriaFromModal: (socketId: string, materiaId: string) => void;
  saveSocketProperties: (socketId: string) => void;
  setEdgeCondition: Dispatch<SetStateAction<MateriaEdgeCondition>>;
  setEdgeTargetId: Dispatch<SetStateAction<string>>;
  setSocketActionMode: Dispatch<SetStateAction<SocketActionMode>>;
  setSocketPropertyForm: Dispatch<SetStateAction<SocketPropertyFormState>>;
  socketLabel: (socketId: string) => string;
}

function SocketActionModal(props: SocketActionModalProps) {
  const {
    activeLoadout, edgeCondition, edgeMutationError, edgeTargetId, materia, palette, socketActionId,
    socketActionMode, socketPropertyError, socketPropertyForm, editPolicy, closeSocketActionModal, createConnectedSocket,
    createEdge, deleteSocket, openEdgeConnector, openSocketPropertyEditor, removeEdge, removeLegacyNextEdge,
    removeLoopExitConnection, removeMateria, replaceMateriaFromModal, saveSocketProperties, setEdgeCondition,
    setEdgeTargetId, setSocketActionMode, setSocketPropertyForm, socketLabel,
  } = props;

  if (!socketActionId || !activeLoadout?.sockets?.[socketActionId]) return null;
  const readonlyTitle = !editPolicy.canEdit ? editPolicy.reason : undefined;

  return (
    <div className="socket-action-backdrop" role="presentation" onMouseDown={closeSocketActionModal}>
      <section className="socket-action-modal" role="dialog" aria-modal="true" aria-labelledby="socket-action-title" data-testid="socket-action-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4"><div><p className="text-xs uppercase tracking-[0.3em] text-cyan-200">{socketActionMode === 'replace' ? 'replace materia' : socketActionMode === 'edit' ? 'edit socket properties' : socketActionMode === 'connect' ? 'connect edge' : 'socket actions'}</p><h3 id="socket-action-title" className="mt-1 text-2xl font-black text-white">{formatSocketLabel(socketActionId, activeLoadout.sockets[socketActionId])}</h3><p className="mt-1 text-sm text-slate-300">Socket id: {socketActionId}</p></div><button type="button" className="materia-button-secondary" onClick={closeSocketActionModal}>{socketActionMode === 'replace' || socketActionMode === 'edit' || socketActionMode === 'connect' ? 'Cancel' : 'Close'}</button></div>
        {!editPolicy.canEdit && <p className="mt-4 rounded-xl border border-amber-300/30 bg-amber-950/30 px-4 py-3 text-sm text-amber-100" role="status">{editPolicy.reason}</p>}
        {socketActionMode === 'replace' ? (
          <div className="mt-5"><p className="text-sm text-slate-300">Choose reusable materia to assign to this socket. Socket id, edges, traversal settings, and layout metadata will be preserved.</p><div className="materia-replacement-list mt-4" role="list" aria-label="Available replacement materia" data-testid="materia-replacement-list">{palette.map(([id, socket], index) => (<button key={id} type="button" className="materia-replacement-row" data-testid={`replacement-materia-${id}`} disabled={!editPolicy.canEdit} title={readonlyTitle} onClick={() => replaceMateriaFromModal(socketActionId, id)}><Orb small color={socketColor(id, index, materia, socket)} label={id} /><span className="flex min-w-0 flex-col text-left"><span className="truncate font-black text-cyan-50">{id}</span><span className="truncate text-xs text-slate-300">{getSocketLabel(id, socket)}</span></span></button>))}</div>{palette.length === 0 && <p className="mt-4 text-sm text-amber-200">No available materia definitions found.</p>}</div>
        ) : socketActionMode === 'edit' ? (
          <div className="mt-5 space-y-4" data-testid="socket-property-editor"><p className="text-sm text-slate-300">Edit socket-level traversal limits and explicit layout coordinates. Empty fields clear that socket property.</p><div className="grid gap-3 sm:grid-cols-3"><label className="graph-field">Max visits<input data-testid="socket-max-visits" inputMode="numeric" value={socketPropertyForm.maxVisits} onChange={(event) => setSocketPropertyForm({ ...socketPropertyForm, maxVisits: event.target.value })} placeholder="default" /></label><label className="graph-field">Retries / edge traversals<input data-testid="socket-max-edge-traversals" inputMode="numeric" value={socketPropertyForm.maxEdgeTraversals} onChange={(event) => setSocketPropertyForm({ ...socketPropertyForm, maxEdgeTraversals: event.target.value })} placeholder="default" /></label><label className="graph-field">Max output bytes<input data-testid="socket-max-output-bytes" inputMode="numeric" value={socketPropertyForm.maxOutputBytes} onChange={(event) => setSocketPropertyForm({ ...socketPropertyForm, maxOutputBytes: event.target.value })} placeholder="default" /></label></div><div className="grid gap-3 sm:grid-cols-2"><label className="graph-field">Layout X<input data-testid="socket-layout-x" value={socketPropertyForm.layoutX} onChange={(event) => setSocketPropertyForm({ ...socketPropertyForm, layoutX: event.target.value })} placeholder="auto" /></label><label className="graph-field">Layout Y<input data-testid="socket-layout-y" value={socketPropertyForm.layoutY} onChange={(event) => setSocketPropertyForm({ ...socketPropertyForm, layoutY: event.target.value })} placeholder="auto" /></label></div>{socketPropertyError && <p className="socket-property-error" role="alert">{socketPropertyError}</p>}<div className="flex flex-wrap gap-3"><button type="button" className="materia-button" data-testid="save-socket-properties" disabled={!editPolicy.canEdit} title={readonlyTitle} onClick={() => saveSocketProperties(socketActionId)}>Save socket properties</button><button type="button" className="materia-button-secondary" onClick={closeSocketActionModal}>Cancel</button></div></div>
        ) : socketActionMode === 'connect' ? (
          <div className="mt-5 space-y-4" data-testid="edge-connector"><p className="text-sm text-slate-300">Create a validated {activeLoadout.loops && Object.values(activeLoadout.loops).some((loop) => loop.exit?.from === socketActionId) ? 'loop-exit route' : 'canonical edge'} from this socket to an existing socket.</p><div className="grid gap-3 sm:grid-cols-2"><label className="graph-field">Target socket<select data-testid="edge-target" value={edgeTargetId} onChange={(event) => setEdgeTargetId(event.target.value)}><option value="">choose socket…</option>{Object.keys(activeLoadout.sockets ?? {}).filter((id) => id !== socketActionId).map((id) => <option key={id} value={id}>{socketLabel(id)}</option>)}</select></label><label className="graph-field">Condition<select data-testid="edge-condition" value={edgeCondition} onChange={(event) => setEdgeCondition(event.target.value as MateriaEdgeCondition)}><option value="always">Always</option><option value="satisfied">Satisfied</option><option value="not_satisfied">Not Satisfied</option></select></label></div>{edgeMutationError && <p className="socket-property-error" role="alert">{edgeMutationError}</p>}<div className="flex flex-wrap gap-3"><button type="button" className="materia-button" data-testid="create-edge" disabled={!editPolicy.canEdit} title={readonlyTitle} onClick={() => createEdge(socketActionId)}>Create edge</button><button type="button" className="materia-button-secondary" onClick={closeSocketActionModal}>Cancel</button></div></div>
        ) : (
          <div className="mt-5 space-y-4"><p className="text-sm text-slate-300">Tip: drag this socket's orb onto the graph background to clear it without opening this menu.</p><div className="grid gap-3 sm:grid-cols-2"><button type="button" className="socket-action-button socket-action-button-muted" disabled={!editPolicy.canEdit} title={readonlyTitle} onClick={() => removeMateria(socketActionId)}>Clear socket</button><button type="button" className="socket-action-button" disabled={!editPolicy.canEdit} title={readonlyTitle} onClick={() => setSocketActionMode('replace')}>Replace</button><button type="button" className="socket-action-button" disabled={!editPolicy.canEdit} title={readonlyTitle} onClick={() => openSocketPropertyEditor(socketActionId)}>Edit</button><button type="button" className="socket-action-button" disabled={!editPolicy.canEdit} title={readonlyTitle} onClick={() => createConnectedSocket(socketActionId)}>New Socket</button><button type="button" className="socket-action-button" disabled={!editPolicy.canEdit} title={readonlyTitle} onClick={() => openEdgeConnector(socketActionId)}>Connect Edge</button><button type="button" className="socket-action-button socket-action-button-danger" data-testid={`delete-socket-${socketActionId}`} disabled={!editPolicy.canEdit || !canDeleteSocket(activeLoadout.sockets[socketActionId])} title={!editPolicy.canEdit ? editPolicy.reason : canDeleteSocket(activeLoadout.sockets[socketActionId]) ? 'Delete this socket and clean graph references' : 'Entry sockets cannot be deleted'} onClick={() => deleteSocket(socketActionId)}>Delete Socket</button></div><div className="edge-removal-list" data-testid="edge-removal-list"><p className="text-xs uppercase tracking-[0.24em] text-cyan-200">Outgoing edges</p>{((activeLoadout.sockets[socketActionId] as LegacyPipelineSocket).next) && (<button type="button" className="edge-removal-row" data-testid={`remove-next-edge-${socketActionId}`} disabled={!editPolicy.canEdit} title={readonlyTitle} onClick={() => removeLegacyNextEdge(socketActionId)}>Remove legacy flow to {socketLabel((activeLoadout.sockets[socketActionId] as LegacyPipelineSocket).next as string)}</button>)}{(activeLoadout.sockets[socketActionId].edges ?? []).map((edge, index) => (<button key={`${edge.to}-${index}`} type="button" className="edge-removal-row" data-testid={`remove-edge-${socketActionId}-${index}`} disabled={!editPolicy.canEdit} title={readonlyTitle} onClick={() => removeEdge(socketActionId, index)}>Remove {edgeConditionLabel(edge.when)} edge to {socketLabel(edge.to)}</button>))}{Object.entries(activeLoadout.loops ?? {}).flatMap(([loopId, loop]) => (loop.exits ?? []).filter((route) => route.from === socketActionId).map((route) => (<button key={`${loopId}-${route.id}`} type="button" className="edge-removal-row" data-testid={`remove-loop-exit-route-${loopId}-${route.id}`} disabled={!editPolicy.canEdit} title={readonlyTitle} onClick={() => removeLoopExitConnection(loopId, route.id)}>Remove loop-exit {edgeConditionLabel(route.condition)} route to {socketLabel(route.targetSocketId)}</button>)))}{!(activeLoadout.sockets[socketActionId] as LegacyPipelineSocket).next && (activeLoadout.sockets[socketActionId].edges ?? []).length === 0 && Object.values(activeLoadout.loops ?? {}).every((loop) => !(loop.exits ?? []).some((route) => route.from === socketActionId)) && <p className="mt-2 text-sm text-slate-400">No outgoing edges from this socket.</p>}</div></div>
        )}
      </section>
    </div>
  );
}
