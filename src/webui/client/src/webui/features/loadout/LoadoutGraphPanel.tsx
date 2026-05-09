import type { CSSProperties, Dispatch, DragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, SetStateAction } from 'react';
import type { MateriaEdgeCondition } from '../../../../../../types.js';
import {
  canDeleteSocket,
  formatSocketLabel,
  getNodeLabel,
  isEmptySocket,
  isEntrySocket,
  nodeColor,
  type LegacyPipelineNode,
  type PipelineConfig,
  type PipelineNode,
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

interface LoopSelectionRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LoadoutGraphPanelProps {
  activeLoadout?: PipelineConfig;
  activeLoadoutName?: string;
  currentMonitorNode?: string;
  edgeCondition: MateriaEdgeCondition;
  edgeMutationError: string;
  edgeTargetId: string;
  loadoutGraph: LayoutSocketsResult;
  loadoutNameInput: string;
  loopExitBadges: Map<string, LoopExitBadge>;
  loopMemberships: Map<string, LoopMembership>;
  loopRegions: LoopRegion[];
  loopSelectionRectangle?: LoopSelectionRectangle;
  materia: Record<string, PipelineNode>;
  palette: Array<[string, PipelineNode]>;
  routedEdges: RoutedLoadoutEdge[];
  selectedLoopSocketIds: string[];
  selectedLoopSocketSet: Set<string>;
  selectedMateriaId?: string;
  socketActionId?: string;
  socketActionMode: SocketActionMode;
  socketLayoutDrag?: SocketLayoutDragState;
  socketPropertyError: string;
  socketPropertyForm: SocketPropertyFormState;
  createLoopDisabled: boolean;
  beginSocketLayoutDrag: (socket: LayoutSocketsResult['sockets'][number], event: ReactPointerEvent<HTMLButtonElement>) => void;
  beginSocketRegionSelection: (event: ReactPointerEvent<HTMLDivElement>) => void;
  breakLoop: (loopId: string) => void;
  cancelSocketLayoutDrag: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  cancelSocketRegionSelection: (event: ReactPointerEvent<HTMLDivElement>) => void;
  clearLoopExit: (loopId: string) => void;
  closeSocketActionModal: () => void;
  commitActiveLoadoutRename: () => void;
  createConnectedSocket: (socketId: string) => void;
  createEdge: (socketId: string) => void;
  createTaskIteratorLoop: () => void;
  deleteSocket: (socketId: string) => void;
  dragMateria: (payload: DragPayload, event: DragEvent) => void;
  finishSocketLayoutDrag: (socketId: string, event: ReactPointerEvent<HTMLButtonElement>) => void;
  finishSocketRegionSelection: (event: ReactPointerEvent<HTMLDivElement>) => void;
  handleDrop: (socketId: string, event: DragEvent) => void;
  handleGraphDrop: (event: DragEvent) => void;
  handleSocketClick: (socketId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  moveSocketLayoutDrag: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  moveSocketRegionSelection: (event: ReactPointerEvent<HTMLDivElement>) => void;
  openEdgeConnector: (socketId: string) => void;
  openSocketPropertyEditor: (socketId: string) => void;
  removeEdge: (socketId: string, edgeIndex: number) => void;
  removeLegacyNextEdge: (socketId: string) => void;
  removeMateria: (socketId: string) => void;
  replaceMateriaFromModal: (socketId: string, materiaId: string) => void;
  saveSocketProperties: (socketId: string) => void;
  setEdgeCondition: Dispatch<SetStateAction<MateriaEdgeCondition>>;
  setEdgeTargetId: Dispatch<SetStateAction<string>>;
  setLoadoutNameInput: Dispatch<SetStateAction<string>>;
  setSocketActionMode: Dispatch<SetStateAction<SocketActionMode>>;
  setSocketPropertyForm: Dispatch<SetStateAction<SocketPropertyFormState>>;
  socketDisplayLabel: (socketId: string) => string;
  socketLabel: (socketId: string) => string;
  toggleEdgeCondition: (edge: RoutedLoadoutEdge['edge']) => void;
  updateLoopExit: (loopId: string, patch: Partial<{ from: string; when: MateriaEdgeCondition; to: string }>) => void;
}

export function LoadoutGraphPanel(props: LoadoutGraphPanelProps) {
  const {
    activeLoadout, activeLoadoutName, currentMonitorNode, edgeCondition, edgeMutationError, edgeTargetId,
    loadoutGraph, loadoutNameInput, loopExitBadges, loopMemberships, loopRegions, loopSelectionRectangle,
    materia, palette, routedEdges, selectedLoopSocketIds, selectedLoopSocketSet, selectedMateriaId, socketActionId,
    socketActionMode, socketLayoutDrag, socketPropertyError, socketPropertyForm, createLoopDisabled,
    beginSocketLayoutDrag, beginSocketRegionSelection, breakLoop, cancelSocketLayoutDrag, cancelSocketRegionSelection,
    clearLoopExit, closeSocketActionModal, commitActiveLoadoutRename, createConnectedSocket, createEdge,
    createTaskIteratorLoop, deleteSocket, dragMateria, finishSocketLayoutDrag, finishSocketRegionSelection,
    handleDrop, handleGraphDrop, handleSocketClick, moveSocketLayoutDrag, moveSocketRegionSelection, openEdgeConnector,
    openSocketPropertyEditor, removeEdge, removeLegacyNextEdge, removeMateria, replaceMateriaFromModal, saveSocketProperties,
    setEdgeCondition, setEdgeTargetId, setLoadoutNameInput, setSocketActionMode, setSocketPropertyForm,
    socketDisplayLabel, socketLabel, toggleEdgeCondition, updateLoopExit,
  } = props;

  return (
    <section className="fantasy-panel loadout-graph-panel p-6">
      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-2xl font-bold">Visual materia grid</h2>
          <p className="text-sm text-slate-400">Drag orbs into sockets, drag socketed orbs onto the graph background to unsocket, drag socket cards to arrange them, or click a palette orb then click a socket.</p>
          <p className="mt-1 text-xs text-cyan-200/80">To create a loop, select the cycle sockets with shift-click or a drag box; the selected cycle must have exactly one inbound edge from a Generator materia.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="materia-button-secondary" data-testid="create-task-loop" onClick={createTaskIteratorLoop} disabled={createLoopDisabled} title={createLoopDisabled ? 'Select loop sockets with shift-click or a drag box first.' : `Create loop from selected sockets: ${selectedLoopSocketIds.map(socketLabel).join(', ')}`}>Create Loop</button>
        <label className="text-sm text-slate-300">Edit name
          <input
            className="ml-3 rounded-xl border border-cyan-200/20 bg-slate-950/80 px-3 py-2 text-cyan-100"
            value={loadoutNameInput}
            onChange={(event) => setLoadoutNameInput(event.target.value)}
            onBlur={() => commitActiveLoadoutRename()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
        </label>
        </div>
      </div>

      <div className="loadout-graph-viewport" data-testid="socket-grid-viewport" onDragOver={(event) => event.preventDefault()} onDrop={handleGraphDrop}>
        <div
          className="loadout-graph-canvas"
          data-testid="socket-grid"
          style={{ width: `${loadoutGraph.width}px`, height: `${loadoutGraph.height}px` }}
          onPointerDown={beginSocketRegionSelection}
          onPointerMove={moveSocketRegionSelection}
          onPointerUp={finishSocketRegionSelection}
          onPointerCancel={cancelSocketRegionSelection}
        >
        <svg className="loadout-edge-layer" width={loadoutGraph.width} height={loadoutGraph.height} aria-label="Loadout edges">
          <defs>
            <marker id="materia-edge-arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth"><path d="M2,2 L10,6 L2,10 Z" className="loadout-edge-arrow" /></marker>
            <marker id="materia-generator-edge-arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth"><path d="M2,2 L10,6 L2,10 Z" className="loadout-generator-edge-arrow" /></marker>
            <marker id="materia-loop-cycle-arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth"><path d="M2,2 L10,6 L2,10 Z" className="loadout-loop-cycle-arrow" /></marker>
          </defs>
          {loopRegions.map((loop) => (
            <g key={loop.id} className="loadout-loop-cycle-edge" data-testid={`loop-cycle-edge-${loop.id}`} aria-label={`${loop.label} cycle indicator`} style={{ '--loop-accent': loop.accent, '--loop-accent-soft': loop.accentSoft } as CSSProperties}>
              <path d={loop.cyclePath} className="loadout-loop-cycle-edge-echo" />
              <path d={loop.cyclePath} markerEnd="url(#materia-loop-cycle-arrow)" />
            </g>
          ))}
          {routedEdges.map(({ edge, path, labelX, labelY, labelRotate, routeClass }) => {
            const isGeneratorInput = isGeneratorOutputEdge(edge, activeLoadout, materia);
            const edgeLabel = generatorEdgeLabel(edge, activeLoadout, materia);
            const markerEnd = isGeneratorInput ? 'url(#materia-generator-edge-arrow)' : 'url(#materia-edge-arrow)';
            return (
              <g key={edge.id} data-testid={`edge-${edge.from}-${edge.to}-${edge.edgeIndex ?? 'next'}`} role="button" tabIndex={0} className={`loadout-edge loadout-edge-${edgeConditionClass(edge.when)} loadout-edge-route-${routeClass} ${isGeneratorInput ? 'loadout-edge-generator-input' : ''} loadout-edge-clickable`} onClick={() => toggleEdgeCondition(edge)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleEdgeCondition(edge); } }}>
                <path d={path} markerEnd={markerEnd} />
                <text x={labelX} y={labelY} transform={`rotate(${labelRotate} ${labelX} ${labelY})`}>{edgeLabel}</text>
              </g>
            );
          })}
        </svg>
        {loopRegions.map((loop) => (
          <div key={loop.id} className="loadout-loop-region" data-testid={`loop-region-${loop.id}`} style={{ left: `${loop.x}px`, top: `${loop.y}px`, width: `${loop.width}px`, height: `${loop.height}px`, '--loop-accent': loop.accent, '--loop-accent-soft': loop.accentSoft } as CSSProperties} title={loop.summary} aria-label={`${loop.label} loop: ${loop.summary}`}>
            <span className="loadout-loop-badge">Loop</span><span className="loadout-loop-title">{loop.label}</span><span className="loadout-loop-summary">{loop.summary}</span>
          </div>
        ))}
        {loopSelectionRectangle && <div className="loadout-loop-selection-rectangle" data-testid="loop-selection-rectangle" style={{ left: `${loopSelectionRectangle.x}px`, top: `${loopSelectionRectangle.y}px`, width: `${loopSelectionRectangle.width}px`, height: `${loopSelectionRectangle.height}px` }} />}
        {loadoutGraph.sockets.map((socket) => {
          const { id, node, index, x, y } = socket;
          const dragPreview = socketLayoutDrag?.socketId === id ? socketLayoutDrag : undefined;
          const socketX = dragPreview?.currentX ?? x;
          const socketY = dragPreview?.currentY ?? y;
          const nodeLabel = getNodeLabel(id, node);
          const socketHoverDetails = buildSocketHoverDetails(id, node, materia, activeLoadout);
          const isIterator = hasIteratorBehavior(node, materia);
          const isGenerator = isGeneratorSocket(node, materia);
          const iteratorDetails = isIterator ? formatIteratorBehavior(node, materia) : undefined;
          const isLoopSelected = selectedLoopSocketSet.has(id);
          const isEntry = isEntrySocket(node);
          const loopMembership = loopMemberships.get(id);
          const loopExitBadge = loopExitBadges.get(id);
          const socketStyle = loopMembership ? { left: `${socketX}px`, top: `${socketY}px`, '--loop-accent': loopMembership.accent, '--loop-accent-soft': loopMembership.accentSoft } as CSSProperties : { left: `${socketX}px`, top: `${socketY}px` };
          return (
          <button key={id} data-testid={`socket-${id}`} className={`materia-socket graph-materia-socket ${selectedMateriaId ? 'materia-socket-selectable' : ''} ${id === currentMonitorNode ? 'materia-socket-active' : ''} ${dragPreview ? 'graph-materia-socket-dragging' : ''} ${isIterator ? 'materia-socket-iterator' : ''} ${isGenerator ? 'materia-socket-generator' : ''} ${loopMembership ? 'materia-socket-loop-member' : ''} ${loopExitBadge ? 'materia-socket-loop-exit' : ''} ${isLoopSelected ? 'materia-socket-loop-selected' : ''}`} style={socketStyle} data-loop-ids={loopMembership?.loopIds.join(' ')} data-loop-exit-ids={loopExitBadge?.loopIds.join(' ')} aria-pressed={isLoopSelected} onClick={(event) => handleSocketClick(id, event)} onPointerDown={(event) => beginSocketLayoutDrag(socket, event)} onPointerMove={moveSocketLayoutDrag} onPointerUp={(event) => finishSocketLayoutDrag(id, event)} onPointerCancel={cancelSocketLayoutDrag} onDragOver={(event) => event.preventDefault()} onDrop={(event) => handleDrop(id, event)} title={socketHoverDetails} aria-label={`${nodeLabel} socket details`}>
            <div className="materia-socket-orb-stage"><div draggable={!isEmptySocket(node)} onDragStart={(event) => dragMateria({ kind: 'socket', materiaId: id, fromLoadout: activeLoadoutName, fromSocket: id }, event)}><Orb color={nodeColor(id, index, materia, node)} label={socketHoverDetails} empty={isEmptySocket(node)} iterator={isIterator} /></div>{isIterator && <span className={`materia-iterator-badge graph-iterator-badge ${isGenerator ? 'materia-generator-badge' : ''}`} title={iteratorDetails}>{iteratorBadgeLabel(iteratorDetails)}</span>}</div>
            {isEntry && <span className="entry-rune">Entry</span>}
            {loopExitBadge && <span className="loop-exit-rune" title={loopExitBadge.title} style={{ '--loop-accent': loopExitBadge.accent, '--loop-accent-soft': loopExitBadge.accentSoft } as CSSProperties}>Loop exit</span>}
            <span className="materia-socket-label">{nodeLabel}</span>
          </button>);
        })}
        </div>
      </div>

      {Object.keys(activeLoadout?.loops ?? {}).length > 0 && (
        <div className="mt-4 rounded-2xl border border-cyan-200/15 bg-slate-950/55 p-4" data-testid="loop-editor-panel">
          <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-200">Loop exits</h3>
          <p className="mt-1 text-xs text-slate-400">Loop exits are compiled into runtime parse/advance control flow on the exit source; they are not decorative metadata. Validation will block conflicting socket parse, advance, or continuation routes before save/run.</p>
          <div className="mt-3 grid gap-3">
            {Object.entries(activeLoadout?.loops ?? {}).map(([loopId, loop]) => {
              const exit = loop.exit ?? { from: loop.nodes[loop.nodes.length - 1] ?? '', when: 'satisfied' as MateriaEdgeCondition, to: 'end' };
              return (
                <div key={loopId} className="flex flex-wrap items-end gap-3 rounded-xl border border-cyan-200/10 bg-slate-900/60 p-3" data-testid={`loop-editor-${loopId}`}>
                  <div className="min-w-48 flex-1"><div className="font-semibold text-cyan-100">{formatLoopDisplayLabel(activeLoadout, loopId, loop.nodes, loop.label)}</div><div className="text-xs text-slate-400">Members: {loop.nodes.map(socketDisplayLabel).join(', ')}</div></div>
                  <label className="text-xs uppercase tracking-[0.16em] text-slate-400">Exit source<select className="mt-1 block rounded-xl border border-cyan-200/20 bg-slate-950/80 px-3 py-2 text-cyan-100" data-testid={`loop-exit-source-${loopId}`} value={exit.from} onChange={(event) => updateLoopExit(loopId, { from: event.target.value })}>{loop.nodes.map((nodeId) => <option key={nodeId} value={nodeId}>{socketDisplayLabel(nodeId)}</option>)}</select></label>
                  <label className="text-xs uppercase tracking-[0.16em] text-slate-400">Exit condition<select className="mt-1 block rounded-xl border border-cyan-200/20 bg-slate-950/80 px-3 py-2 text-cyan-100" data-testid={`loop-exit-condition-${loopId}`} value={exit.when} onChange={(event) => updateLoopExit(loopId, { when: event.target.value as MateriaEdgeCondition })}>{Object.entries(edgeConditionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                  <label className="text-xs uppercase tracking-[0.16em] text-slate-400">Exit target<select className="mt-1 block rounded-xl border border-cyan-200/20 bg-slate-950/80 px-3 py-2 text-cyan-100" data-testid={`loop-exit-target-${loopId}`} value={exit.to} onChange={(event) => updateLoopExit(loopId, { to: event.target.value })}><option value="end">end</option>{Object.keys(activeLoadout?.nodes ?? {}).map((nodeId) => <option key={nodeId} value={nodeId}>{socketLabel(nodeId)}</option>)}</select></label>
                  {loop.exit && <button type="button" className="materia-button-secondary" data-testid={`loop-exit-clear-${loopId}`} onClick={() => clearLoopExit(loopId)}>Clear exit</button>}
                  <button type="button" className="materia-button-secondary" data-testid={`loop-break-${loopId}`} onClick={() => breakLoop(loopId)}>Break loop</button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {socketActionId && activeLoadout?.nodes?.[socketActionId] && (
        <div className="socket-action-backdrop" role="presentation" onMouseDown={closeSocketActionModal}>
          <section className="socket-action-modal" role="dialog" aria-modal="true" aria-labelledby="socket-action-title" data-testid="socket-action-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-4"><div><p className="text-xs uppercase tracking-[0.3em] text-cyan-200">{socketActionMode === 'replace' ? 'replace materia' : socketActionMode === 'edit' ? 'edit socket properties' : socketActionMode === 'connect' ? 'connect edge' : 'socket actions'}</p><h3 id="socket-action-title" className="mt-1 text-2xl font-black text-white">{formatSocketLabel(socketActionId, activeLoadout.nodes[socketActionId])}</h3><p className="mt-1 text-sm text-slate-300">Socket id: {socketActionId}</p></div><button type="button" className="materia-button-secondary" onClick={closeSocketActionModal}>{socketActionMode === 'replace' || socketActionMode === 'edit' || socketActionMode === 'connect' ? 'Cancel' : 'Close'}</button></div>
            {socketActionMode === 'replace' ? (
              <div className="mt-5"><p className="text-sm text-slate-300">Choose reusable materia to assign to this socket. Socket id, edges, traversal settings, and layout metadata will be preserved.</p><div className="materia-replacement-list mt-4" role="list" aria-label="Available replacement materia" data-testid="materia-replacement-list">{palette.map(([id, node], index) => (<button key={id} type="button" className="materia-replacement-row" data-testid={`replacement-materia-${id}`} onClick={() => replaceMateriaFromModal(socketActionId, id)}><Orb small color={nodeColor(id, index, materia, node)} label={id} /><span className="flex min-w-0 flex-col text-left"><span className="truncate font-black text-cyan-50">{id}</span><span className="truncate text-xs text-slate-300">{getNodeLabel(id, node)}</span></span></button>))}</div>{palette.length === 0 && <p className="mt-4 text-sm text-amber-200">No available materia definitions found.</p>}</div>
            ) : socketActionMode === 'edit' ? (
              <div className="mt-5 space-y-4" data-testid="socket-property-editor"><p className="text-sm text-slate-300">Edit socket-level traversal limits and explicit layout coordinates. Empty fields clear that socket property.</p><div className="grid gap-3 sm:grid-cols-3"><label className="graph-field">Max visits<input data-testid="socket-max-visits" inputMode="numeric" value={socketPropertyForm.maxVisits} onChange={(event) => setSocketPropertyForm({ ...socketPropertyForm, maxVisits: event.target.value })} placeholder="default" /></label><label className="graph-field">Retries / edge traversals<input data-testid="socket-max-edge-traversals" inputMode="numeric" value={socketPropertyForm.maxEdgeTraversals} onChange={(event) => setSocketPropertyForm({ ...socketPropertyForm, maxEdgeTraversals: event.target.value })} placeholder="default" /></label><label className="graph-field">Max output bytes<input data-testid="socket-max-output-bytes" inputMode="numeric" value={socketPropertyForm.maxOutputBytes} onChange={(event) => setSocketPropertyForm({ ...socketPropertyForm, maxOutputBytes: event.target.value })} placeholder="default" /></label></div><div className="grid gap-3 sm:grid-cols-2"><label className="graph-field">Layout X<input data-testid="socket-layout-x" value={socketPropertyForm.layoutX} onChange={(event) => setSocketPropertyForm({ ...socketPropertyForm, layoutX: event.target.value })} placeholder="auto" /></label><label className="graph-field">Layout Y<input data-testid="socket-layout-y" value={socketPropertyForm.layoutY} onChange={(event) => setSocketPropertyForm({ ...socketPropertyForm, layoutY: event.target.value })} placeholder="auto" /></label></div>{socketPropertyError && <p className="socket-property-error" role="alert">{socketPropertyError}</p>}<div className="flex flex-wrap gap-3"><button type="button" className="materia-button" data-testid="save-socket-properties" onClick={() => saveSocketProperties(socketActionId)}>Save socket properties</button><button type="button" className="materia-button-secondary" onClick={closeSocketActionModal}>Cancel</button></div></div>
            ) : socketActionMode === 'connect' ? (
              <div className="mt-5 space-y-4" data-testid="edge-connector"><p className="text-sm text-slate-300">Create a validated canonical edge from this socket to an existing socket.</p><div className="grid gap-3 sm:grid-cols-2"><label className="graph-field">Target socket<select data-testid="edge-target" value={edgeTargetId} onChange={(event) => setEdgeTargetId(event.target.value)}><option value="">choose socket…</option>{Object.keys(activeLoadout.nodes ?? {}).filter((id) => id !== socketActionId).map((id) => <option key={id} value={id}>{socketLabel(id)}</option>)}</select></label><label className="graph-field">Condition<select data-testid="edge-condition" value={edgeCondition} onChange={(event) => setEdgeCondition(event.target.value as MateriaEdgeCondition)}><option value="always">Always</option><option value="satisfied">Satisfied</option><option value="not_satisfied">Not Satisfied</option></select></label></div>{edgeMutationError && <p className="socket-property-error" role="alert">{edgeMutationError}</p>}<div className="flex flex-wrap gap-3"><button type="button" className="materia-button" data-testid="create-edge" onClick={() => createEdge(socketActionId)}>Create edge</button><button type="button" className="materia-button-secondary" onClick={closeSocketActionModal}>Cancel</button></div></div>
            ) : (
              <div className="mt-5 space-y-4"><p className="text-sm text-slate-300">Tip: drag this socket's orb onto the graph background to clear it without opening this menu.</p><div className="grid gap-3 sm:grid-cols-2"><button type="button" className="socket-action-button socket-action-button-muted" onClick={() => removeMateria(socketActionId)}>Clear socket</button><button type="button" className="socket-action-button" onClick={() => setSocketActionMode('replace')}>Replace</button><button type="button" className="socket-action-button" onClick={() => openSocketPropertyEditor(socketActionId)}>Edit</button><button type="button" className="socket-action-button" onClick={() => createConnectedSocket(socketActionId)}>New Socket</button><button type="button" className="socket-action-button" onClick={() => openEdgeConnector(socketActionId)}>Connect Edge</button><button type="button" className="socket-action-button socket-action-button-danger" data-testid={`delete-socket-${socketActionId}`} disabled={!canDeleteSocket(activeLoadout.nodes[socketActionId])} title={canDeleteSocket(activeLoadout.nodes[socketActionId]) ? 'Delete this socket and clean graph references' : 'Entry sockets cannot be deleted'} onClick={() => deleteSocket(socketActionId)}>Delete Socket</button></div><div className="edge-removal-list" data-testid="edge-removal-list"><p className="text-xs uppercase tracking-[0.24em] text-cyan-200">Outgoing edges</p>{((activeLoadout.nodes[socketActionId] as LegacyPipelineNode).next) && (<button type="button" className="edge-removal-row" data-testid={`remove-next-edge-${socketActionId}`} onClick={() => removeLegacyNextEdge(socketActionId)}>Remove legacy flow to {socketLabel((activeLoadout.nodes[socketActionId] as LegacyPipelineNode).next as string)}</button>)}{(activeLoadout.nodes[socketActionId].edges ?? []).map((edge, index) => (<button key={`${edge.to}-${index}`} type="button" className="edge-removal-row" data-testid={`remove-edge-${socketActionId}-${index}`} onClick={() => removeEdge(socketActionId, index)}>Remove {edgeConditionLabel(edge.when)} edge to {socketLabel(edge.to)}</button>))}{!(activeLoadout.nodes[socketActionId] as LegacyPipelineNode).next && (activeLoadout.nodes[socketActionId].edges ?? []).length === 0 && <p className="mt-2 text-sm text-slate-400">No outgoing edges from this socket.</p>}</div></div>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
