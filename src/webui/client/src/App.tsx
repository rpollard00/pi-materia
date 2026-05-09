import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { MateriaEdgeCondition } from '../../../types.js';
import { isGeneratorMateria } from '../../../generator.js';
import { formatGraphValidationErrors, stageValidatedPipelineGraphChange } from '../../../graphValidation.js';
import {
  assertValidLoadoutSaveSemantics,
  buildMateriaPalette,
  clearSocketMateria,
  canDeleteSocket,
  deleteSocketFromLoadout,
  extractMateriaReference,
  formatSocketLabel,
  getNodeLabel,
  resolveSocketDisplayLabel,
  isEmptySocket,
  isEntrySocket,
  makeEmptyEntryLoadout,
  makeEmptySocket,
  makeNewSocketId,
  materiaColorChoices,
  nodeColor,
  normalizeMateriaConfigEdges,
  placeMateriaInSocket,
  type MateriaConfig,
  type LegacyPipelineNode,
  type PipelineConfig,
  type PipelineNode,
} from './loadoutModel.js';
import {
  edgeConditionLabels,
  materiaSavedEventName,
  materiaTabs,
  socketCardWidth,
  socketLayoutOffsetX,
  socketLayoutOffsetY,
  socketLayoutUnitX,
  socketLayoutUnitY,
  socketStageHeight,
} from './webui/constants.js';
import type {
  ConfigResponse,
  DragPayload,
  LoadoutEdge,
  LoadoutSourceScope,
  MateriaFormState,
  MateriaSavedEventDetail,
  MateriaTabId,
  ModelCatalogLoadState,
  ModelCatalogResponse,
  MonitorSnapshot,
  OriginalMateriaModelSettings,
  PositionedSocket,
  RoleGenerationResponse,
  SaveTarget,
  SocketLayoutDragState,
  SocketPropertyFormState,
  SocketRegionSelectionDragState,
} from './webui/types.js';
import { formatElapsed, formatTime, materiaColorClass } from './webui/utils/display.js';
import {
  buildLoadouts,
  buildSocketHoverDetails,
  edgeConditionClass,
  edgeConditionLabel,
  formatIteratorBehavior,
  formatLoopDisplayLabel,
  generatorEdgeLabel,
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
  buildMateriaPatch,
  canonicalWorkItemsGeneratorConfig,
  cloneConfig,
  emptyMateriaForm,
  emptySocketPropertyForm,
  parseDragPayload,
  parseOptionalFiniteNumber,
  parseOptionalPositiveInteger,
  socketPropertyFormFromNode,
} from './webui/utils/forms.js';
import {
  canKeepThinkingForModel,
  emptyModelCatalog,
  modelSelectOptions,
  normalizeModelCatalog,
  selectedCatalogModel,
  thinkingLabel,
  thinkingSelectOptions,
} from './webui/utils/modelCatalog.js';
import { tabFromLocation } from './webui/utils/tabs.js';

function makeNewLoadoutName(loadouts: Record<string, PipelineConfig>) {
  let index = Object.keys(loadouts).length + 1;
  let name = `New Loadout ${index}`;
  while (loadouts[name]) name = `New Loadout ${++index}`;
  return name;
}

async function fetchModelCatalog(): Promise<ModelCatalogResponse> {
  const response = await fetch('/api/models');
  if (!response.ok) throw new Error(`Model catalog request failed with HTTP ${response.status}`);
  return normalizeModelCatalog(await response.json());
}

async function fetchMateriaConfig(): Promise<{ config: MateriaConfig; source: string; loadoutSources: Record<string, LoadoutSourceScope> }> {
  const response = await fetch('/api/config');
  const body = await response.json() as ConfigResponse;
  return { config: normalizeMateriaConfigEdges(body.config ?? (body as MateriaConfig)), source: body.source ?? 'unknown', loadoutSources: body.loadoutSources ?? {} };
}

function mergeReloadedConfigIntoDraft(current: MateriaConfig | undefined, reloaded: MateriaConfig, preserveLoadoutEdits: boolean): MateriaConfig {
  if (!preserveLoadoutEdits || !current) return normalizeMateriaConfigEdges(reloaded);
  return normalizeMateriaConfigEdges({
    ...cloneConfig(current),
    materia: reloaded.materia ? cloneConfig(reloaded.materia) : undefined,
  });
}

function dispatchMateriaSavedEvent(detail: MateriaSavedEventDetail) {
  window.dispatchEvent(new CustomEvent<MateriaSavedEventDetail>(materiaSavedEventName, { detail }));
}

function Orb({ color, label, small = false, empty = false, iterator = false }: { color: string; label: string; small?: boolean; empty?: boolean; iterator?: boolean }) {
  return <div aria-hidden className={`${small ? 'materia-orb-small' : 'materia-orb'} ${empty ? 'materia-orb-empty' : materiaColorClass(color)} ${iterator && !empty ? 'materia-orb-iterator' : ''}`} title={label} />;
}

export function App() {
  const [selectedTab, setSelectedTab] = useState<MateriaTabId>(() => tabFromLocation());
  const [baselineConfig, setBaselineConfig] = useState<MateriaConfig | undefined>();
  const [draftConfig, setDraftConfig] = useState<MateriaConfig | undefined>();
  const draftConfigRef = useRef<MateriaConfig | undefined>(undefined);
  const [source, setSource] = useState<string>('loading');
  const [loadoutSources, setLoadoutSources] = useState<Record<string, LoadoutSourceScope>>({});
  const [deletedLoadoutNames, setDeletedLoadoutNames] = useState<string[]>([]);
  const [loadoutNameInput, setLoadoutNameInput] = useState('');
  const [status, setStatus] = useState('Loading materia configuration…');
  const [selectedMateriaId, setSelectedMateriaId] = useState<string | undefined>();
  const [saveTarget, setSaveTarget] = useState<SaveTarget>('user');
  const [dragOverTrash, setDragOverTrash] = useState(false);
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
  const [monitor, setMonitor] = useState<MonitorSnapshot>();
  const [materiaForm, setMateriaForm] = useState<MateriaFormState>(() => emptyMateriaForm());
  const [originalMateriaModelSettings, setOriginalMateriaModelSettings] = useState<OriginalMateriaModelSettings | undefined>();
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogResponse>(() => emptyModelCatalog());
  const [modelCatalogStatus, setModelCatalogStatus] = useState<ModelCatalogLoadState>('idle');
  const [modelCatalogError, setModelCatalogError] = useState('');
  const modelCatalogRequestedRef = useRef(false);
  const [materiaColorOpen, setMateriaColorOpen] = useState(false);
  const materiaColorDropdownRef = useRef<HTMLFieldSetElement | null>(null);
  const [roleBrief, setRoleBrief] = useState('');
  const [generatedRolePrompt, setGeneratedRolePrompt] = useState('');
  const [roleGenerationError, setRoleGenerationError] = useState('');
  const [roleGenerating, setRoleGenerating] = useState(false);

  useEffect(() => {
    const handlePopState = () => setSelectedTab(tabFromLocation());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (!materiaColorOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (materiaColorDropdownRef.current?.contains(event.target as Node)) return;
      setMateriaColorOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMateriaColorOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [materiaColorOpen]);

  useEffect(() => {
    draftConfigRef.current = draftConfig;
  }, [draftConfig]);

  useEffect(() => {
    let cancelled = false;
    reloadConfig({ cancelled: () => cancelled }).catch((error) => {
      if (cancelled) return;
      setStatus(`Using demo loadout data: ${error instanceof Error ? error.message : String(error)}`);
      const fallback: MateriaConfig = {
        activeLoadout: 'Demo Loadout',
        loadouts: {
          'Demo Loadout': {
            entry: 'Socket-1',
            nodes: {
              'Socket-1': { type: 'agent', materia: 'planner', edges: [{ when: 'always', to: 'Socket-2' }] },
              'Socket-2': { type: 'agent', materia: 'Build', edges: [{ when: 'always', to: 'Socket-3' }] },
              'Socket-3': { type: 'agent', materia: 'Auto-Eval', edges: [{ when: 'always', to: 'Socket-4' }] },
              'Socket-4': { type: 'agent', materia: 'Maintain' },
            },
          },
        },
      };
      const normalizedFallback = normalizeMateriaConfigEdges(fallback);
      setBaselineConfig(cloneConfig(normalizedFallback));
      setDraftConfig(normalizedFallback);
      setLoadoutNameInput(normalizedFallback.activeLoadout ?? '');
      setSource('demo');
      setLoadoutSources({ 'Demo Loadout': 'default' });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => fetch('/api/monitor').then((response) => response.json() as Promise<MonitorSnapshot>).then((body) => { if (!cancelled) setMonitor(body); }).catch(() => undefined);
    const events = typeof EventSource !== 'undefined' ? new EventSource('/api/monitor/events') : undefined;
    events?.addEventListener('monitor', (event) => {
      if (!cancelled) setMonitor(JSON.parse((event as MessageEvent).data) as MonitorSnapshot);
    });
    events?.addEventListener('error', () => { void refresh(); });
    const interval = events ? undefined : window.setInterval(refresh, 1500);
    return () => {
      cancelled = true;
      events?.close();
      if (interval) window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (selectedTab !== 'materia-editor' || modelCatalogRequestedRef.current) return;
    modelCatalogRequestedRef.current = true;
    setModelCatalogStatus('loading');
    setModelCatalogError('');
    fetchModelCatalog().then((catalog) => {
      setModelCatalog(catalog);
      setModelCatalogStatus('ready');
    }).catch((error) => {
      setModelCatalog(emptyModelCatalog());
      setModelCatalogStatus('error');
      setModelCatalogError(error instanceof Error ? error.message : String(error));
    });
  }, [selectedTab]);

  const loadouts = useMemo(() => buildLoadouts(draftConfig ?? {}), [draftConfig]);
  const activeLoadoutName = draftConfig?.activeLoadout && loadouts[draftConfig.activeLoadout] ? draftConfig.activeLoadout : Object.keys(loadouts)[0];
  const activeLoadout = activeLoadoutName ? loadouts[activeLoadoutName] : undefined;
  const loadoutGraph = useMemo(() => layoutSockets(activeLoadout), [activeLoadout]);
  const socketPositions = useMemo(() => new Map(loadoutGraph.sockets.map((socket) => [socket.id, socket])), [loadoutGraph.sockets]);
  const loopRegions = useMemo(() => getLoopRegions(activeLoadout, socketPositions), [activeLoadout, socketPositions]);
  const loopMemberships = useMemo(() => getLoopMemberships(activeLoadout), [activeLoadout]);
  const loopExitBadges = useMemo(() => getLoopExitBadges(activeLoadout), [activeLoadout]);
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
  const materia = draftConfig?.materia ?? {};
  const editableDefinitionIds = useMemo(() => Object.keys(materia).sort((a, b) => a.localeCompare(b)), [materia]);
  const palette = useMemo(() => buildMateriaPalette(materia), [materia]);
  const isDirty = JSON.stringify(baselineConfig) !== JSON.stringify(draftConfig);
  const currentMonitorNode = monitor?.activeCast?.currentNode;
  const elapsed = formatElapsed(monitor?.activeCast?.startedAt ?? monitor?.uiStartedAt, monitor?.now);
  const modelOptions = useMemo(() => modelSelectOptions(modelCatalog, originalMateriaModelSettings), [modelCatalog, originalMateriaModelSettings]);
  const thinkingOptions = useMemo(() => thinkingSelectOptions(modelCatalog, materiaForm, originalMateriaModelSettings), [modelCatalog, materiaForm.editingNodeId, materiaForm.model, materiaForm.thinking, originalMateriaModelSettings]);
  const activeModelDescription = modelCatalog.activeModel?.label ?? modelCatalog.activeModelValue;
  const selectedModel = selectedCatalogModel(modelCatalog, materiaForm.model);
  const thinkingLevelsForSelection = selectedModel?.supportedThinkingLevels ?? [];

  function updateDraft(updater: (config: MateriaConfig) => void) {
    setDraftConfig((current) => {
      const next = cloneConfig(current ?? {});
      if (!next.loadouts) next.loadouts = buildLoadouts(next);
      updater(next);
      return normalizeMateriaConfigEdges(next);
    });
  }

  async function reloadConfig({ preserveLoadoutEdits = false, readyStatus = 'Draft ready. Changes are staged until you save.', cancelled = () => false }: { preserveLoadoutEdits?: boolean; readyStatus?: string; cancelled?: () => boolean } = {}) {
    const loaded = await fetchMateriaConfig();
    if (cancelled()) return;
    const normalizedLoaded = normalizeMateriaConfigEdges(loaded.config);
    const nextDraft = mergeReloadedConfigIntoDraft(draftConfigRef.current, loaded.config, preserveLoadoutEdits);
    const nextLoadouts = buildLoadouts(nextDraft);
    const nextActive = nextDraft.activeLoadout && nextLoadouts[nextDraft.activeLoadout] ? nextDraft.activeLoadout : Object.keys(nextLoadouts)[0] ?? '';
    setBaselineConfig(normalizedLoaded);
    setDraftConfig(nextDraft);
    setLoadoutNameInput(nextActive);
    setSource(loaded.source);
    setLoadoutSources(loaded.loadoutSources ?? {});
    if (!preserveLoadoutEdits) setDeletedLoadoutNames([]);
    setStatus(readyStatus);
  }

  function resetMateriaEditorForm() {
    setMateriaForm(emptyMateriaForm());
    setOriginalMateriaModelSettings(undefined);
  }

  function handleMateriaModelChange(model: string) {
    setMateriaForm((current) => ({
      ...current,
      model,
      thinking: canKeepThinkingForModel(modelCatalog, model, current.thinking, current, originalMateriaModelSettings) ? current.thinking : '',
    }));
  }

  useEffect(() => {
    let cancelled = false;
    const handleMateriaSaved = (event: Event) => {
      const detail = (event as CustomEvent<MateriaSavedEventDetail>).detail;
      const name = detail?.name ?? detail?.id ?? 'materia';
      const behavior = detail?.behavior ?? 'prompt';
      const scope = detail?.scope ?? 'configured';
      void reloadConfig({
        preserveLoadoutEdits: true,
        readyStatus: `Saved reusable ${behavior} materia ${name} to ${scope} scope. Loadout draft edits were left unchanged.`,
        cancelled: () => cancelled,
      });
    };
    window.addEventListener(materiaSavedEventName, handleMateriaSaved);
    return () => {
      cancelled = true;
      window.removeEventListener(materiaSavedEventName, handleMateriaSaved);
    };
  }, []);

  function switchLoadout(name: string) {
    updateDraft((config) => {
      config.activeLoadout = name;
    });
    setLoadoutNameInput(name);
    setSelectedMateriaId(undefined);
    setSocketActionId(undefined);
    setSocketActionMode('actions');
    setSelectedLoopSocketIds([]);
    setStatus(`Active loadout staged: ${name}`);
  }

  function commitActiveLoadoutRename(rawName = loadoutNameInput) {
    if (!activeLoadoutName) return false;
    const nextName = rawName.trim();
    if (!nextName) {
      setStatus('Cannot rename loadout: name cannot be empty.');
      return false;
    }
    if (nextName === activeLoadoutName) {
      setLoadoutNameInput(activeLoadoutName);
      return true;
    }
    if (loadouts[nextName]) {
      setStatus(`Cannot rename loadout: ${nextName} already exists.`);
      return false;
    }
    const previousName = activeLoadoutName;
    updateDraft((config) => {
      const draftLoadouts = buildLoadouts(config);
      if (!draftLoadouts[previousName] || draftLoadouts[nextName]) return;
      draftLoadouts[nextName] = draftLoadouts[previousName];
      delete draftLoadouts[previousName];
      config.loadouts = draftLoadouts;
      config.activeLoadout = nextName;
    });
    setDeletedLoadoutNames((current) => {
      const withoutRevertedTarget = current.filter((name) => name !== nextName);
      if (!baselineConfig?.loadouts?.[previousName] || withoutRevertedTarget.includes(previousName)) return withoutRevertedTarget;
      return [...withoutRevertedTarget, previousName];
    });
    if (baselineConfig?.loadouts?.[previousName]) {
      const sourceScope = loadoutSources[previousName];
      if (sourceScope === 'project' || sourceScope === 'explicit') setSaveTarget(sourceScope);
    }
    setLoadoutNameInput(nextName);
    setStatus(`Renamed loadout to ${nextName}. Save to persist.`);
    return true;
  }

  function createLoadout() {
    let createdName = '';
    updateDraft((config) => {
      const draftLoadouts = buildLoadouts(config);
      const name = makeNewLoadoutName(draftLoadouts);
      createdName = name;
      draftLoadouts[name] = makeEmptyEntryLoadout();
      config.loadouts = draftLoadouts;
      config.activeLoadout = name;
    });
    setLoadoutNameInput(createdName);
    setStatus('Created a new draft loadout with one empty entry socket. Rename and save when ready.');
  }

  function canDeleteLoadout(name: string) {
    return Boolean(name && loadouts[name] && loadoutSources[name] !== 'default' && Object.keys(loadouts).length > 1);
  }

  function deleteLoadout(name: string) {
    if (!loadouts[name]) return false;
    if (loadoutSources[name] === 'default') {
      setStatus(`Cannot delete ${name}: shipped default loadouts are protected.`);
      return false;
    }
    const remainingNames = Object.keys(loadouts).filter((candidate) => candidate !== name);
    if (remainingNames.length === 0) {
      setStatus('Cannot delete the only loadout; create another loadout first.');
      return false;
    }
    const fallbackName = activeLoadoutName === name ? remainingNames[0] : activeLoadoutName;
    updateDraft((config) => {
      const draftLoadouts = buildLoadouts(config);
      delete draftLoadouts[name];
      config.loadouts = draftLoadouts;
      config.activeLoadout = fallbackName;
    });
    setLoadoutNameInput(fallbackName ?? '');
    if (baselineConfig?.loadouts?.[name]) {
      setDeletedLoadoutNames((current) => current.includes(name) ? current : [...current, name]);
      const sourceScope = loadoutSources[name];
      if (sourceScope === 'project' || sourceScope === 'explicit') setSaveTarget(sourceScope);
    }
    setSelectedMateriaId(undefined);
    setSocketActionId(undefined);
    setSocketActionMode('actions');
    setSelectedLoopSocketIds([]);
    setStatus(`Deleted loadout ${name}. Active loadout is now ${fallbackName}. Save to persist.`);
    return true;
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

    updateDraft((config) => {
      const loadout = buildLoadouts(config)[activeLoadoutName];
      if (!loadout?.nodes) return;
      if (fromSocket && fromSocket !== socketId) {
        const target = loadout.nodes[socketId];
        const source = loadout.nodes[fromSocket];
        if (isEmptySocket(source) || !target) return;
        loadout.nodes[socketId] = placeMateriaInSocket(target, source);
        loadout.nodes[fromSocket] = placeMateriaInSocket(source, target);
      } else {
        const sourceNode = palette.find(([id]) => id === materiaId)?.[1];
        const target = loadout.nodes[socketId];
        if (sourceNode && !isEmptySocket(sourceNode) && target) loadout.nodes[socketId] = placeMateriaInSocket(target, sourceNode);
      }
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
      (loadout) => {
        deleteSocketFromLoadout(loadout as PipelineConfig, socketId);
      },
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
    updateDraft((config) => {
      const loadout = buildLoadouts(config)[activeLoadoutName];
      if (!loadout?.nodes || !loadout.nodes[socketId]) return;
      loadout.nodes[socketId] = clearSocketMateria(loadout.nodes[socketId]);
    });
    setSocketActionId(undefined);
    setSocketActionMode('actions');
    setStatus(`Cleared materia from ${socketId}; socket graph links and layout were preserved.`);
    return true;
  }

  function createConnectedSocket(afterSocketId: string) {
    if (!activeLoadoutName || !activeLoadout) return;
    const result = stageValidatedPipelineGraphChange(activeLoadout as import('../../../types.js').MateriaPipelineConfig, (loadout) => {
      if (!loadout.nodes?.[afterSocketId]) return;
      const source = loadout.nodes[afterSocketId] as PipelineNode;
      const newId = makeNewSocketId(loadout.nodes as Record<string, PipelineNode>);
      const priorAlways = source.edges?.find((edge) => edge.when === 'always')?.to;
      const sourceLayout = source.layout;
      loadout.nodes[newId] = makeEmptySocket({
        edges: priorAlways ? [{ when: 'always', to: priorAlways }] : undefined,
        layout: sourceLayout ? { x: (sourceLayout.x ?? 0) + 1, y: sourceLayout.y ?? 0 } : undefined,
      }) as unknown as import('../../../types.js').MateriaPipelineNodeConfig;
      source.edges = [...(source.edges ?? []).filter((edge) => edge.when !== 'always'), { when: 'always', to: newId }];
    });
    if (!result.ok) {
      setStatus(`Cannot create socket after ${socketLabel(afterSocketId)}: ${formatGraphValidationErrors(result.errors)}`);
      return;
    }
    updateDraft((config) => {
      const draftLoadouts = buildLoadouts(config);
      draftLoadouts[activeLoadoutName] = result.graph as PipelineConfig;
      config.loadouts = draftLoadouts;
    });
    setSocketActionId(undefined);
    setSocketActionMode('actions');
    setStatus(`Created a connected empty socket after ${afterSocketId}.`);
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
    updateDraft((config) => {
      const loadout = buildLoadouts(config)[activeLoadoutName];
      const nodes = loadout?.nodes;
      const node = nodes?.[socketId];
      if (!node || !nodes) return;
      for (const socket of loadoutGraph.sockets) {
        const socketNode = nodes[socket.id];
        if (!socketNode || socket.id === socketId || (typeof socketNode.layout?.x === 'number' && typeof socketNode.layout?.y === 'number')) continue;
        socketNode.layout = {
          ...(socketNode.layout ?? {}),
          x: layoutValueForPosition(socket.x, socketLayoutOffsetX, socketLayoutUnitX),
          y: layoutValueForPosition(socket.y, socketLayoutOffsetY, socketLayoutUnitY),
        };
      }
      node.layout = { ...(node.layout ?? {}), x: layoutX, y: layoutY };
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
    setSocketPropertyForm(socketPropertyFormFromNode(activeLoadout?.nodes?.[socketId]));
    setSocketPropertyError('');
    setEdgeMutationError('');
    setSocketActionMode('edit');
  }

  function openEdgeConnector(socketId: string) {
    const firstOtherSocket = Object.keys(activeLoadout?.nodes ?? {}).find((id) => id !== socketId) ?? '';
    setEdgeTargetId(firstOtherSocket);
    setEdgeCondition('satisfied');
    setEdgeMutationError('');
    setSocketActionMode('connect');
  }

  function commitGraphMutation(description: string, mutator: (loadout: import('../../../types.js').MateriaPipelineConfig) => void, onSuccess: string, onError: (message: string) => string) {
    if (!activeLoadoutName || !activeLoadout) return false;
    const result = stageValidatedPipelineGraphChange(activeLoadout as import('../../../types.js').MateriaPipelineConfig, mutator, {
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
    updateDraft((config) => {
      const draftLoadouts = buildLoadouts(config);
      draftLoadouts[activeLoadoutName] = result.graph as PipelineConfig;
      config.loadouts = draftLoadouts;
    });
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
      (loadout) => {
        if (isSingleSocketLoop) {
          const socketId = selectedIds[0];
          const node = loadout.nodes?.[socketId] as PipelineNode | undefined;
          if (node && !(node.edges ?? []).some((edge) => edge.to === socketId)) {
            node.edges = [{ when: 'always', to: socketId }];
          }
        }
        loadout.loops = {
          ...(loadout.loops ?? {}),
          [loopId]: {
            label,
            nodes: selectedIds,
            consumes: { from: generator.from, output: generator.output },
            exit: { from: selectedIds[selectedIds.length - 1], when: exitCondition, to: 'end' },
          },
        };
      },
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
      (loadout) => {
        const draftLoop = loadout.loops?.[loopId];
        if (!draftLoop) return;
        draftLoop.exit = nextExit;
      },
      `Staged loop ${loopId} exit as ${nextExit.from}.${edgeConditionLabel(nextExit.when)} → ${nextExit.to}; it will compile into runtime parse/advance control flow.`,
      (message) => `Cannot update loop ${loopId} exit: ${message}`,
    );
  }

  function clearLoopExit(loopId: string) {
    commitGraphMutation(
      `Cleared loop ${loopId} exit.`,
      (loadout) => {
        const draftLoop = loadout.loops?.[loopId];
        if (draftLoop) delete draftLoop.exit;
      },
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
      (loadout) => {
        if (!loadout.loops?.[loopId]) return;
        delete loadout.loops[loopId];
        if (Object.keys(loadout.loops).length === 0) delete loadout.loops;
      },
      `Broke loop ${label}; sockets and edges were preserved.`,
      (message) => `Cannot break loop ${label}: ${message}`,
    );
  }

  function createEdge(from: string) {
    const to = edgeTargetId;
    if (!to) {
      const message = 'Choose a target socket.';
      setEdgeMutationError(message);
      setStatus(`Cannot create edge from ${from}: ${message}`);
      return;
    }
    const created = commitGraphMutation(
      `Staged edge ${from} → ${to}.`,
      (loadout) => {
        const node = loadout.nodes?.[from] as PipelineNode | undefined;
        if (!node || !loadout.nodes?.[to]) return;
        const edges = [...(node.edges ?? [])];
        edges.push({ to, when: edgeCondition });
        node.edges = edges;
      },
      `Staged edge ${socketLabel(from)} → ${socketLabel(to)} as ${edgeConditionLabel(edgeCondition)}.`,
      (message) => `Cannot create edge ${socketLabel(from)} → ${socketLabel(to)}: ${message}`,
    );
    if (created) {
      setSocketActionId(undefined);
      setSocketActionMode('actions');
    }
  }

  function removeEdge(from: string, edgeIndex: number) {
    const edge = activeLoadout?.nodes?.[from]?.edges?.[edgeIndex];
    if (!edge) return;
    const removed = commitGraphMutation(
      `Removed edge ${from} → ${edge.to}.`,
      (loadout) => {
        const node = loadout.nodes?.[from] as PipelineNode | undefined;
        if (!node?.edges) return;
        node.edges = node.edges.filter((_, index) => index !== edgeIndex);
        if (node.edges.length === 0) delete node.edges;
      },
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
      (loadout) => {
        const node = loadout.nodes?.[from] as LegacyPipelineNode | undefined;
        if (node) delete node.next;
      },
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

    updateDraft((config) => {
      const loadout = buildLoadouts(config)[activeLoadoutName];
      const node = loadout?.nodes?.[socketId];
      if (!node) return;
      const limits: PipelineNode['limits'] = {};
      if (maxVisits !== undefined) limits.maxVisits = maxVisits;
      if (maxEdgeTraversals !== undefined) limits.maxEdgeTraversals = maxEdgeTraversals;
      if (maxOutputBytes !== undefined) limits.maxOutputBytes = maxOutputBytes;
      if (Object.keys(limits).length > 0) node.limits = limits;
      else delete node.limits;
      const layout: PipelineNode['layout'] = {};
      if (layoutX !== undefined) layout.x = layoutX;
      if (layoutY !== undefined) layout.y = layoutY;
      if (Object.keys(layout).length > 0) node.layout = layout;
      else delete node.layout;
    });
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
    const result = stageValidatedPipelineGraphChange(activeLoadout as import('../../../types.js').MateriaPipelineConfig, (loadout) => {
      const node = loadout.nodes?.[edge.from] as PipelineNode | undefined;
      if (!node) return;
      if (edgeIndex === undefined) {
        node.edges = [...(node.edges ?? []), { to: edge.to, when: toggledEdgeCondition(edge.when) }];
        delete (node as LegacyPipelineNode).next;
        return;
      }
      const candidate = node.edges?.[edgeIndex];
      if (candidate) candidate.when = toggledEdgeCondition(candidate.when);
    });
    if (!result.ok) {
      setStatus(`Cannot toggle edge ${edge.from} → ${edge.to}: ${formatGraphValidationErrors(result.errors)}`);
      return;
    }
    updateDraft((config) => {
      const draftLoadouts = buildLoadouts(config);
      draftLoadouts[activeLoadoutName] = result.graph as PipelineConfig;
      config.loadouts = draftLoadouts;
    });
    const updatedEdge = edge.edgeIndex === undefined ? result.graph.nodes?.[edge.from]?.edges?.find((candidate) => candidate.to === edge.to) : result.graph.nodes?.[edge.from]?.edges?.[edge.edgeIndex];
    setStatus(`Staged edge ${socketLabel(edge.from)} → ${socketLabel(edge.to)} as ${edgeConditionLabel(updatedEdge?.when)}.`);
  }

  function editMateria(id: string) {
    const definition = materia[id];
    if (!definition) return;
    const isUtility = definition.type === 'utility';
    const generator = isGeneratorMateria(definition);
    const savedModel = isUtility ? '' : String(definition.model ?? '').trim();
    const savedThinking = isUtility ? '' : String(definition.thinking ?? '').trim();
    setOriginalMateriaModelSettings({ editingNodeId: id, model: savedModel, thinking: savedThinking });
    setMateriaForm({
      editingNodeId: id,
      name: id,
      behavior: isUtility ? 'tool' : 'prompt',
      prompt: isUtility ? '' : String(definition.prompt ?? ''),
      toolAccess: isUtility ? 'none' : (definition.tools ?? 'none'),
      model: savedModel,
      thinking: savedThinking,
      color: String(definition.color ?? ''),
      outputFormat: definition.parse === 'json' ? 'json' : 'text',
      multiTurn: isUtility ? false : Boolean(definition.multiTurn),
      generator: !isUtility && generator,
      utility: isUtility ? String(definition.utility ?? '') : '',
      command: isUtility ? (definition.command ?? []).join(' ') : '',
      params: isUtility ? JSON.stringify(definition.params ?? {}, null, 2) : '{}',
      timeoutMs: isUtility && definition.timeoutMs !== undefined ? String(definition.timeoutMs) : '',
      persistScope: 'user',
    });
    setStatus(`Editing reusable materia definition ${id}. Save the staged form to update definitions only.`);
  }

  async function generateRolePrompt() {
    const brief = roleBrief.trim();
    if (!brief) {
      setRoleGenerationError('Describe the desired role before generating a prompt.');
      return;
    }
    setRoleGenerating(true);
    setRoleGenerationError('');
    setStatus('Generating Materia role prompt preview…');
    try {
      const generates = materiaForm.generator ? canonicalWorkItemsGeneratorConfig() : null;
      const response = await fetch('/api/generate/materia-role', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ brief, generates }),
      });
      const body = await response.json() as RoleGenerationResponse;
      const errorMessage = typeof body.error === 'string' ? body.error : body.error?.message;
      if (!response.ok || body.ok === false || typeof body.prompt !== 'string') throw new Error(errorMessage ?? 'Materia role generation failed.');
      setGeneratedRolePrompt(body.prompt);
      setStatus('Generated role prompt preview. Review it before applying.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRoleGenerationError(message);
      setStatus(`Materia role generation failed: ${message}`);
    } finally {
      setRoleGenerating(false);
    }
  }

  function discardGeneratedRolePrompt() {
    setGeneratedRolePrompt('');
    setRoleGenerationError('');
    setStatus('Discarded generated role prompt preview.');
  }

  function applyGeneratedRolePrompt() {
    if (!generatedRolePrompt) return;
    setMateriaForm((current) => ({ ...current, prompt: generatedRolePrompt }));
    setGeneratedRolePrompt('');
    setRoleGenerationError('');
    setStatus('Applied generated role prompt to the form. Save when ready.');
  }

  async function saveMateriaForm() {
    try {
      const patch = buildMateriaPatch(materiaForm);
      const savedName = materiaForm.name.trim();
      const savedBehavior = materiaForm.behavior;
      const target = materiaForm.persistScope;
      setStatus(`Saving reusable ${savedBehavior} materia to ${target} scope…`);
      const response = await fetch('/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target, config: patch }),
      });
      const body = await response.json();
      if (!response.ok || body.ok === false) throw new Error(body.error ?? 'Materia save failed');
      const scope = body.target ?? target;
      dispatchMateriaSavedEvent({ id: savedName, name: savedName, behavior: savedBehavior, requestedScope: target, scope });
      resetMateriaEditorForm();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
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

  function selectTab(tabId: MateriaTabId) {
    setSelectedTab(tabId);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tabId);
    window.history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }

  async function saveDraft() {
    if (!draftConfig) return;
    setStatus('Saving staged loadout edits…');
    const normalizedDraft = normalizeMateriaConfigEdges(draftConfig);
    assertValidLoadoutSaveSemantics(normalizedDraft);
    const configToSave = cloneConfig(normalizedDraft) as Omit<MateriaConfig, 'loadouts'> & { loadouts?: Record<string, PipelineConfig | null> };
    if (deletedLoadoutNames.length > 0) {
      configToSave.loadouts = { ...(configToSave.loadouts ?? {}) };
      for (const name of deletedLoadoutNames) configToSave.loadouts[name] = null;
    }
    const response = await fetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: saveTarget, config: configToSave }),
    });
    const body = await response.json();
    if (!response.ok || body.ok === false) throw new Error(body.error ?? 'Save failed');
    setBaselineConfig(normalizedDraft);
    setDraftConfig(normalizedDraft);
    setDeletedLoadoutNames([]);
    setLoadoutSources((current) => {
      const next = { ...current };
      for (const name of deletedLoadoutNames) delete next[name];
      for (const name of Object.keys(normalizedDraft.loadouts ?? {})) if (!next[name]) next[name] = body.target ?? saveTarget;
      return next;
    });
    setStatus(`Saved staged loadout edits to ${body.target ?? saveTarget} scope.`);
  }

  return (
    <main className="min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_top,#14304a,#020617_58%)] text-slate-100">
      <section className="mx-auto flex min-h-screen w-full max-w-screen-2xl flex-col gap-6 px-6 py-8">
        <header className="rounded-3xl border border-cyan-200/30 bg-slate-950/75 p-7 shadow-[0_0_55px_rgba(34,211,238,0.16)] backdrop-blur">
          <p className="text-sm uppercase tracking-[0.45em] text-cyan-200">pi-materia loadout editor</p>
          <div className="mt-3 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="text-4xl font-black tracking-tight text-white md:text-6xl">Materia WebUI</h1>
              <p className="mt-3 max-w-3xl text-slate-300">Stage loadout changes visually. Sockets and graph node ids are preserved so inserted materia, layout, and node-shift semantics stay intact until an explicit save.</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-300">
              <div>Source: <span className="text-cyan-100">{source}</span></div>
              <div>Status: <span className={isDirty ? 'text-amber-200' : 'text-emerald-200'}>{isDirty ? 'staged edits' : 'clean'}</span></div>
            </div>
          </div>
        </header>

        <nav className="materia-tab-bar" aria-label="Materia WebUI sections">
          {materiaTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`materia-tab ${selectedTab === tab.id ? 'materia-tab-active' : ''}`}
              aria-current={selectedTab === tab.id ? 'page' : undefined}
              aria-selected={selectedTab === tab.id}
              title={tab.description}
              onClick={() => selectTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {selectedTab === 'loadout' && (
        <div className="loadout-workspace grid gap-6 xl:grid-cols-[16rem_minmax(0,1fr)_18rem]">
          <aside className="fantasy-panel loadout-side-panel p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-bold">Loadouts</h2>
              <button className="materia-button" onClick={createLoadout}>New</button>
            </div>
            <div className="space-y-2" role="list" aria-label="Available loadouts">
              {Object.keys(loadouts).map((name) => {
                const sourceScope = loadoutSources[name] ?? 'user';
                const defaultLoadout = sourceScope === 'default';
                const deleteDisabled = !canDeleteLoadout(name);
                return (
                  <div key={name} className={`loadout-card ${name === activeLoadoutName ? 'loadout-card-active' : ''}`}>
                    <button type="button" onClick={() => switchLoadout(name)} className="loadout-card-select">
                      <span>{name}</span>
                      <small>{Object.keys(loadouts[name].nodes ?? {}).length} sockets · {defaultLoadout ? 'shipped default' : `${sourceScope} loadout`}</small>
                    </button>
                    <button
                      type="button"
                      className="loadout-delete-button"
                      disabled={deleteDisabled}
                      onClick={() => deleteLoadout(name)}
                      title={defaultLoadout ? 'Shipped default loadouts cannot be deleted.' : deleteDisabled ? 'Create or keep another loadout before deleting this one.' : `Delete ${name}`}
                      aria-label={defaultLoadout ? 'Protected default loadout' : 'Delete loadout'}
                    >
                      Delete
                    </button>
                  </div>
                );
              })}
            </div>
          </aside>

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
                  <marker id="materia-edge-arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth">
                    <path d="M2,2 L10,6 L2,10 Z" className="loadout-edge-arrow" />
                  </marker>
                  <marker id="materia-generator-edge-arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth">
                    <path d="M2,2 L10,6 L2,10 Z" className="loadout-generator-edge-arrow" />
                  </marker>
                  <marker id="materia-loop-cycle-arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth">
                    <path d="M2,2 L10,6 L2,10 Z" className="loadout-loop-cycle-arrow" />
                  </marker>
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
                    <g
                      key={edge.id}
                      data-testid={`edge-${edge.from}-${edge.to}-${edge.edgeIndex ?? 'next'}`}
                      role="button"
                      tabIndex={0}
                      className={`loadout-edge loadout-edge-${edgeConditionClass(edge.when)} loadout-edge-route-${routeClass} ${isGeneratorInput ? 'loadout-edge-generator-input' : ''} loadout-edge-clickable`}
                      onClick={() => toggleEdgeCondition(edge)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          toggleEdgeCondition(edge);
                        }
                      }}
                    >
                      <path d={path} markerEnd={markerEnd} />
                      <text x={labelX} y={labelY} transform={`rotate(${labelRotate} ${labelX} ${labelY})`}>{edgeLabel}</text>
                    </g>
                  );
                })}
              </svg>
              {loopRegions.map((loop) => (
                <div
                  key={loop.id}
                  className="loadout-loop-region"
                  data-testid={`loop-region-${loop.id}`}
                  style={{ left: `${loop.x}px`, top: `${loop.y}px`, width: `${loop.width}px`, height: `${loop.height}px`, '--loop-accent': loop.accent, '--loop-accent-soft': loop.accentSoft } as CSSProperties}
                  title={loop.summary}
                  aria-label={`${loop.label} loop: ${loop.summary}`}
                >
                  <span className="loadout-loop-badge">Loop</span>
                  <span className="loadout-loop-title">{loop.label}</span>
                  <span className="loadout-loop-summary">{loop.summary}</span>
                </div>
              ))}
              {loopSelectionRectangle && (
                <div
                  className="loadout-loop-selection-rectangle"
                  data-testid="loop-selection-rectangle"
                  style={{ left: `${loopSelectionRectangle.x}px`, top: `${loopSelectionRectangle.y}px`, width: `${loopSelectionRectangle.width}px`, height: `${loopSelectionRectangle.height}px` }}
                />
              )}
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
                const socketStyle = loopMembership ? {
                  left: `${socketX}px`,
                  top: `${socketY}px`,
                  '--loop-accent': loopMembership.accent,
                  '--loop-accent-soft': loopMembership.accentSoft,
                } as CSSProperties : { left: `${socketX}px`, top: `${socketY}px` };
                return (
                <button
                  key={id}
                  data-testid={`socket-${id}`}
                  className={`materia-socket graph-materia-socket ${selectedMateriaId ? 'materia-socket-selectable' : ''} ${id === currentMonitorNode ? 'materia-socket-active' : ''} ${dragPreview ? 'graph-materia-socket-dragging' : ''} ${isIterator ? 'materia-socket-iterator' : ''} ${isGenerator ? 'materia-socket-generator' : ''} ${loopMembership ? 'materia-socket-loop-member' : ''} ${loopExitBadge ? 'materia-socket-loop-exit' : ''} ${isLoopSelected ? 'materia-socket-loop-selected' : ''}`}
                  style={socketStyle}
                  data-loop-ids={loopMembership?.loopIds.join(' ')}
                  data-loop-exit-ids={loopExitBadge?.loopIds.join(' ')}
                  aria-pressed={isLoopSelected}
                  onClick={(event) => handleSocketClick(id, event)}
                  onPointerDown={(event) => beginSocketLayoutDrag(socket, event)}
                  onPointerMove={moveSocketLayoutDrag}
                  onPointerUp={(event) => finishSocketLayoutDrag(id, event)}
                  onPointerCancel={cancelSocketLayoutDrag}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => handleDrop(id, event)}
                  title={socketHoverDetails}
                  aria-label={`${nodeLabel} socket details`}
                >
                  <div className="materia-socket-orb-stage">
                    <div draggable={!isEmptySocket(node)} onDragStart={(event) => dragMateria({ kind: 'socket', materiaId: id, fromLoadout: activeLoadoutName, fromSocket: id }, event)}>
                      <Orb color={nodeColor(id, index, materia, node)} label={socketHoverDetails} empty={isEmptySocket(node)} iterator={isIterator} />
                    </div>
                    {isIterator && <span className={`materia-iterator-badge graph-iterator-badge ${isGenerator ? 'materia-generator-badge' : ''}`} title={iteratorDetails}>{iteratorBadgeLabel(iteratorDetails)}</span>}
                  </div>
                  {isEntry && <span className="entry-rune">Entry</span>}
                  {loopExitBadge && <span className="loop-exit-rune" title={loopExitBadge.title} style={{ '--loop-accent': loopExitBadge.accent, '--loop-accent-soft': loopExitBadge.accentSoft } as CSSProperties}>Loop exit</span>}
                  <span className="materia-socket-label">{nodeLabel}</span>
                </button>
                );
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
                        <div className="min-w-48 flex-1">
                          <div className="font-semibold text-cyan-100">{formatLoopDisplayLabel(activeLoadout, loopId, loop.nodes, loop.label)}</div>
                          <div className="text-xs text-slate-400">Members: {loop.nodes.map(socketDisplayLabel).join(', ')}</div>
                        </div>
                        <label className="text-xs uppercase tracking-[0.16em] text-slate-400">Exit source
                          <select className="mt-1 block rounded-xl border border-cyan-200/20 bg-slate-950/80 px-3 py-2 text-cyan-100" data-testid={`loop-exit-source-${loopId}`} value={exit.from} onChange={(event) => updateLoopExit(loopId, { from: event.target.value })}>
                            {loop.nodes.map((nodeId) => <option key={nodeId} value={nodeId}>{socketDisplayLabel(nodeId)}</option>)}
                          </select>
                        </label>
                        <label className="text-xs uppercase tracking-[0.16em] text-slate-400">Exit condition
                          <select className="mt-1 block rounded-xl border border-cyan-200/20 bg-slate-950/80 px-3 py-2 text-cyan-100" data-testid={`loop-exit-condition-${loopId}`} value={exit.when} onChange={(event) => updateLoopExit(loopId, { when: event.target.value as MateriaEdgeCondition })}>
                            {Object.entries(edgeConditionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                          </select>
                        </label>
                        <label className="text-xs uppercase tracking-[0.16em] text-slate-400">Exit target
                          <select className="mt-1 block rounded-xl border border-cyan-200/20 bg-slate-950/80 px-3 py-2 text-cyan-100" data-testid={`loop-exit-target-${loopId}`} value={exit.to} onChange={(event) => updateLoopExit(loopId, { to: event.target.value })}>
                            <option value="end">end</option>
                            {Object.keys(activeLoadout?.nodes ?? {}).map((nodeId) => <option key={nodeId} value={nodeId}>{socketLabel(nodeId)}</option>)}
                          </select>
                        </label>
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
                <section
                  className="socket-action-modal"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="socket-action-title"
                  data-testid="socket-action-modal"
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs uppercase tracking-[0.3em] text-cyan-200">{socketActionMode === 'replace' ? 'replace materia' : socketActionMode === 'edit' ? 'edit socket properties' : socketActionMode === 'connect' ? 'connect edge' : 'socket actions'}</p>
                      <h3 id="socket-action-title" className="mt-1 text-2xl font-black text-white">{formatSocketLabel(socketActionId, activeLoadout.nodes[socketActionId])}</h3>
                      <p className="mt-1 text-sm text-slate-300">Socket id: {socketActionId}</p>
                    </div>
                    <button type="button" className="materia-button-secondary" onClick={closeSocketActionModal}>{socketActionMode === 'replace' || socketActionMode === 'edit' || socketActionMode === 'connect' ? 'Cancel' : 'Close'}</button>
                  </div>
                  {socketActionMode === 'replace' ? (
                    <div className="mt-5">
                      <p className="text-sm text-slate-300">Choose reusable materia to assign to this socket. Socket id, edges, traversal settings, and layout metadata will be preserved.</p>
                      <div className="materia-replacement-list mt-4" role="list" aria-label="Available replacement materia" data-testid="materia-replacement-list">
                        {palette.map(([id, node], index) => (
                          <button key={id} type="button" className="materia-replacement-row" data-testid={`replacement-materia-${id}`} onClick={() => replaceMateriaFromModal(socketActionId, id)}>
                            <Orb small color={nodeColor(id, index, materia, node)} label={id} />
                            <span className="flex min-w-0 flex-col text-left">
                              <span className="truncate font-black text-cyan-50">{id}</span>
                              <span className="truncate text-xs text-slate-300">{getNodeLabel(id, node)}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                      {palette.length === 0 && <p className="mt-4 text-sm text-amber-200">No available materia definitions found.</p>}
                    </div>
                  ) : socketActionMode === 'edit' ? (
                    <div className="mt-5 space-y-4" data-testid="socket-property-editor">
                      <p className="text-sm text-slate-300">Edit socket-level traversal limits and explicit layout coordinates. Empty fields clear that socket property.</p>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <label className="graph-field">Max visits
                          <input data-testid="socket-max-visits" inputMode="numeric" value={socketPropertyForm.maxVisits} onChange={(event) => setSocketPropertyForm({ ...socketPropertyForm, maxVisits: event.target.value })} placeholder="default" />
                        </label>
                        <label className="graph-field">Retries / edge traversals
                          <input data-testid="socket-max-edge-traversals" inputMode="numeric" value={socketPropertyForm.maxEdgeTraversals} onChange={(event) => setSocketPropertyForm({ ...socketPropertyForm, maxEdgeTraversals: event.target.value })} placeholder="default" />
                        </label>
                        <label className="graph-field">Max output bytes
                          <input data-testid="socket-max-output-bytes" inputMode="numeric" value={socketPropertyForm.maxOutputBytes} onChange={(event) => setSocketPropertyForm({ ...socketPropertyForm, maxOutputBytes: event.target.value })} placeholder="default" />
                        </label>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="graph-field">Layout X
                          <input data-testid="socket-layout-x" value={socketPropertyForm.layoutX} onChange={(event) => setSocketPropertyForm({ ...socketPropertyForm, layoutX: event.target.value })} placeholder="auto" />
                        </label>
                        <label className="graph-field">Layout Y
                          <input data-testid="socket-layout-y" value={socketPropertyForm.layoutY} onChange={(event) => setSocketPropertyForm({ ...socketPropertyForm, layoutY: event.target.value })} placeholder="auto" />
                        </label>
                      </div>
                      {socketPropertyError && <p className="socket-property-error" role="alert">{socketPropertyError}</p>}
                      <div className="flex flex-wrap gap-3">
                        <button type="button" className="materia-button" data-testid="save-socket-properties" onClick={() => saveSocketProperties(socketActionId)}>Save socket properties</button>
                        <button type="button" className="materia-button-secondary" onClick={closeSocketActionModal}>Cancel</button>
                      </div>
                    </div>
                  ) : socketActionMode === 'connect' ? (
                    <div className="mt-5 space-y-4" data-testid="edge-connector">
                      <p className="text-sm text-slate-300">Create a validated canonical edge from this socket to an existing socket.</p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="graph-field">Target socket
                          <select data-testid="edge-target" value={edgeTargetId} onChange={(event) => setEdgeTargetId(event.target.value)}>
                            <option value="">choose socket…</option>
                            {Object.keys(activeLoadout.nodes ?? {}).filter((id) => id !== socketActionId).map((id) => <option key={id} value={id}>{socketLabel(id)}</option>)}
                          </select>
                        </label>
                        <label className="graph-field">Condition
                          <select data-testid="edge-condition" value={edgeCondition} onChange={(event) => setEdgeCondition(event.target.value as MateriaEdgeCondition)}>
                            <option value="always">Always</option>
                            <option value="satisfied">Satisfied</option>
                            <option value="not_satisfied">Not Satisfied</option>
                          </select>
                        </label>
                      </div>
                      {edgeMutationError && <p className="socket-property-error" role="alert">{edgeMutationError}</p>}
                      <div className="flex flex-wrap gap-3">
                        <button type="button" className="materia-button" data-testid="create-edge" onClick={() => createEdge(socketActionId)}>Create edge</button>
                        <button type="button" className="materia-button-secondary" onClick={closeSocketActionModal}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-5 space-y-4">
                      <p className="text-sm text-slate-300">Tip: drag this socket's orb onto the graph background to clear it without opening this menu.</p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <button type="button" className="socket-action-button socket-action-button-muted" onClick={() => removeMateria(socketActionId)}>Clear socket</button>
                        <button type="button" className="socket-action-button" onClick={() => setSocketActionMode('replace')}>Replace</button>
                        <button type="button" className="socket-action-button" onClick={() => openSocketPropertyEditor(socketActionId)}>Edit</button>
                        <button type="button" className="socket-action-button" onClick={() => createConnectedSocket(socketActionId)}>New Socket</button>
                        <button type="button" className="socket-action-button" onClick={() => openEdgeConnector(socketActionId)}>Connect Edge</button>
                        <button
                          type="button"
                          className="socket-action-button socket-action-button-danger"
                          data-testid={`delete-socket-${socketActionId}`}
                          disabled={!canDeleteSocket(activeLoadout.nodes[socketActionId])}
                          title={canDeleteSocket(activeLoadout.nodes[socketActionId]) ? 'Delete this socket and clean graph references' : 'Entry sockets cannot be deleted'}
                          onClick={() => deleteSocket(socketActionId)}
                        >
                          Delete Socket
                        </button>
                      </div>
                      <div className="edge-removal-list" data-testid="edge-removal-list">
                        <p className="text-xs uppercase tracking-[0.24em] text-cyan-200">Outgoing edges</p>
                        {((activeLoadout.nodes[socketActionId] as LegacyPipelineNode).next) && (
                          <button type="button" className="edge-removal-row" data-testid={`remove-next-edge-${socketActionId}`} onClick={() => removeLegacyNextEdge(socketActionId)}>
                            Remove legacy flow to {socketLabel((activeLoadout.nodes[socketActionId] as LegacyPipelineNode).next as string)}
                          </button>
                        )}
                        {(activeLoadout.nodes[socketActionId].edges ?? []).map((edge, index) => (
                          <button key={`${edge.to}-${index}`} type="button" className="edge-removal-row" data-testid={`remove-edge-${socketActionId}-${index}`} onClick={() => removeEdge(socketActionId, index)}>
                            Remove {edgeConditionLabel(edge.when)} edge to {socketLabel(edge.to)}
                          </button>
                        ))}
                        {!(activeLoadout.nodes[socketActionId] as LegacyPipelineNode).next && (activeLoadout.nodes[socketActionId].edges ?? []).length === 0 && <p className="mt-2 text-sm text-slate-400">No outgoing edges from this socket.</p>}
                      </div>
                    </div>
                  )}
                </section>
              </div>
            )}
          </section>

          <aside className="loadout-side-panel flex flex-col gap-6">
            <section className="fantasy-panel p-5">
              <h2 className="text-xl font-bold">Materia palette</h2>
              <p className="mt-1 text-sm text-slate-400">Click once to select for swap/insert, or drag into a socket.</p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                {palette.map(([id, node], index) => {
                  const definition = materia[id];
                  const group = typeof definition?.group === 'string' ? definition.group : undefined;
                  const description = typeof definition?.description === 'string' ? definition.description : undefined;
                  const isIterator = hasIteratorBehavior(node, materia);
                  const isGenerator = isGeneratorSocket(node, materia);
                  const iteratorDetails = isIterator ? formatIteratorBehavior(node, materia) : undefined;
                  const title = [description, iteratorDetails].filter(Boolean).join('\n') || undefined;
                  return (
                    <button key={id} draggable title={title} data-testid={`palette-${id}`} onDragStart={(event) => dragMateria({ kind: 'palette', materiaId: id }, event)} onClick={() => setSelectedMateriaId(selectedMateriaId === id ? undefined : id)} className={`palette-orb ${selectedMateriaId === id ? 'palette-orb-selected' : ''} ${isIterator ? 'palette-orb-iterator' : ''} ${isGenerator ? 'palette-orb-generator' : ''}`}>
                      <Orb small color={nodeColor(id, index, materia, node)} label={id} iterator={isIterator} />
                      <span className="flex flex-col items-start leading-tight">
                        <span>{getNodeLabel(id, node)}</span>
                        {group && <span className="text-[0.62rem] uppercase tracking-[0.2em] text-cyan-200/80">{group}</span>}
                        {isIterator && <span className={`materia-iterator-badge palette-iterator-badge ${isGenerator ? 'materia-generator-badge' : ''}`} title={iteratorDetails}>{iteratorBadgeLabel(iteratorDetails)}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="fantasy-panel p-5">
              <h2 className="text-xl font-bold">Stage & apply</h2>
              <p className="mt-2 text-sm text-slate-400">Nothing is persisted until Save is pressed. User scope is the safe default.</p>
              <label className="mt-4 block text-sm text-slate-300">Save target
                <select className="mt-2 w-full rounded-xl border border-cyan-200/20 bg-slate-950 px-3 py-2" value={saveTarget} onChange={(event) => setSaveTarget(event.target.value as SaveTarget)}>
                  <option value="user">User profile</option>
                  <option value="project">Project</option>
                  <option value="explicit">Explicit config</option>
                </select>
              </label>
              <div
                data-testid="trash-socket"
                className={`trash-socket ${dragOverTrash ? 'trash-socket-hot' : ''}`}
                onDragOver={(event) => { event.preventDefault(); setDragOverTrash(true); }}
                onDragLeave={() => setDragOverTrash(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragOverTrash(false);
                  const raw = event.dataTransfer.getData('application/json');
                  if (!raw) return;
                  const payload = parseDragPayload(raw);
                  if (!payload) {
                    setStatus('Ignored drop: unsupported drag payload.');
                    return;
                  }
                  if (payload.kind === 'socket' && payload.fromSocket) removeMateria(payload.fromSocket);
                }}
              >
                Drag socket here or onto the graph background to unsocket materia
              </div>
              <div className="mt-4 flex gap-3">
                <button className="materia-button flex-1" disabled={!isDirty} onClick={() => saveDraft().catch((error) => setStatus(error.message))}>Save</button>
                <button className="materia-button-secondary" disabled={!isDirty || !baselineConfig} onClick={() => { setDraftConfig(cloneConfig(baselineConfig ?? {})); setStatus('Reverted staged edits.'); }}>Revert</button>
              </div>
              <p className="mt-3 min-h-10 text-sm text-cyan-100">{status}</p>
            </section>
          </aside>
        </div>
        )}

        {selectedTab === 'materia-editor' && (
        <section className="fantasy-panel p-4 sm:p-6" aria-label="Materia creation editor">
          <div className="mb-5">
            <p className="text-sm uppercase tracking-[0.35em] text-cyan-200">materia forge</p>
            <h2 className="mt-2 text-3xl font-black text-white">Create / edit materia</h2>
            <p className="mt-2 max-w-4xl text-sm text-slate-400">Forge reusable prompt materia or tool-invocation materia as staged definition edits. The form defaults to user profile persistence; choose Project only when you intentionally want repository-scoped materia.</p>
          </div>

          <section className="materia-form-section materia-settings-section" aria-label="Materia settings">
            <p className="materia-form-section-title">Settings</p>
            <div className="materia-compact-grid">
              <label className="graph-field">Edit existing
                <select data-testid="edit-materia-select" value={materiaForm.editingNodeId} onChange={(event) => event.target.value ? editMateria(event.target.value) : resetMateriaEditorForm()}>
                  <option value="">new materia…</option>
                  {editableDefinitionIds.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
              </label>
              <label className="graph-field">Name
                <input data-testid="materia-name" value={materiaForm.name} onChange={(event) => setMateriaForm({ ...materiaForm, name: event.target.value })} placeholder="Critique" />
              </label>
              <label className="graph-field">Behavior
                <select data-testid="materia-behavior" value={materiaForm.behavior} onChange={(event) => setMateriaForm({ ...materiaForm, behavior: event.target.value as MateriaFormState['behavior'] })}>
                  <option value="prompt">Prompt / agent</option>
                  <option value="tool">Tool invocation</option>
                </select>
              </label>
              <label className="graph-field">Output format
                <select data-testid="materia-output-format" value={materiaForm.outputFormat} onChange={(event) => setMateriaForm({ ...materiaForm, outputFormat: event.target.value as MateriaFormState['outputFormat'] })}>
                  <option value="text">Text</option>
                  <option value="json">JSON</option>
                </select>
              </label>
              <label className="graph-field">Save scope
                <select data-testid="materia-persist-scope" value={materiaForm.persistScope} onChange={(event) => setMateriaForm({ ...materiaForm, persistScope: event.target.value as SaveTarget })}>
                  <option value="user">User profile (~/.config/pi/pi-materia)</option>
                  <option value="project">Project (.pi/pi-materia.json)</option>
                  <option value="explicit">Explicit config</option>
                </select>
              </label>
              {materiaForm.behavior === 'prompt' ? (
                <fieldset className="materia-settings-group materia-agent-options" aria-label="Prompt agent options">
                  <legend>Prompt / agent options</legend>
                  <div className="materia-compact-grid materia-settings-subgrid">
                    <label className="graph-field">Model
                      <select data-testid="materia-model" value={materiaForm.model} onChange={(event) => handleMateriaModelChange(event.target.value)}>
                        {modelOptions.map((option) => <option key={option.value || 'active-pi-model'} value={option.value}>{option.label}</option>)}
                      </select>
                      <span className="materia-field-hint" data-testid="materia-model-catalog-status">
                        {modelCatalogStatus === 'loading'
                          ? 'Loading available Pi models…'
                          : modelCatalogStatus === 'error'
                            ? `Model list unavailable: ${modelCatalogError}`
                            : `${modelCatalog.models.length} available Pi model${modelCatalog.models.length === 1 ? '' : 's'}${activeModelDescription ? `; active ${activeModelDescription}` : ''}.`}
                      </span>
                    </label>
                    <label className="graph-field">Thinking
                      <select data-testid="materia-thinking" value={materiaForm.thinking} onChange={(event) => setMateriaForm({ ...materiaForm, thinking: event.target.value })}>
                        {thinkingOptions.map((option) => <option key={option.value || 'active-pi-thinking'} value={option.value}>{option.label}</option>)}
                      </select>
                      <span className="materia-field-hint" data-testid="materia-thinking-options-status">
                        {materiaForm.model ? `Uses thinking levels for ${selectedModel?.label ?? materiaForm.model}.` : 'Uses thinking levels for the active Pi model.'}
                        {thinkingLevelsForSelection.length > 0 ? ` Offered: ${thinkingLevelsForSelection.map(thinkingLabel).join(', ')}.` : ''}
                        {modelCatalog.activeThinking ? ` Active Pi thinking: ${modelCatalog.activeThinking}.` : ''}
                      </span>
                    </label>
                    <label className="graph-field">Tools
                      <select data-testid="materia-tools" value={materiaForm.toolAccess} onChange={(event) => setMateriaForm({ ...materiaForm, toolAccess: event.target.value as MateriaFormState['toolAccess'] })}>
                        <option value="none">none</option>
                        <option value="readOnly">read only</option>
                        <option value="coding">coding</option>
                      </select>
                    </label>
                    <fieldset ref={materiaColorDropdownRef} className="graph-field materia-color-picker" data-testid="materia-color" aria-label="Color">
                    <legend>Color</legend>
                    <div className="materia-color-dropdown">
                      <button
                        type="button"
                        className="materia-color-trigger"
                        aria-haspopup="listbox"
                        aria-expanded={materiaColorOpen}
                        aria-controls="materia-color-options"
                        aria-label="Select materia color"
                        data-testid="materia-color-trigger"
                        onClick={() => setMateriaColorOpen((open) => !open)}
                      >
                        <Orb small color={materiaForm.color} label="Selected materia color" />
                        <span aria-hidden className="materia-color-trigger-caret">▾</span>
                      </button>
                      {materiaColorOpen && (
                        <div id="materia-color-options" className="materia-color-options" role="listbox" aria-label="Materia color choices">
                          {materiaColorChoices.map((choice) => {
                            const selected = materiaForm.color === choice.value;
                            return (
                              <button
                                key={choice.id}
                                type="button"
                                role="option"
                                aria-selected={selected}
                                aria-label={`${choice.label} materia color`}
                                data-testid={`materia-color-${choice.id}`}
                                className={`materia-color-option ${selected ? 'materia-color-option-selected' : ''}`}
                                onClick={() => {
                                  setMateriaForm({ ...materiaForm, color: choice.value });
                                  setMateriaColorOpen(false);
                                }}
                                title={`${choice.label} materia color`}
                              >
                                <Orb small color={choice.value} label={`${choice.label} materia color`} />
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    {materiaForm.color && !materiaColorChoices.some((choice) => choice.value === materiaForm.color) && <p className="materia-color-legacy">Legacy custom color is selected; choose a palette color to replace it.</p>}
                    </fieldset>
                    <div className="materia-toggle-row materia-settings-toggle-row" aria-label="Boolean materia controls">
                    <label className="graph-field graph-field-inline text-sm">Multiturn
                      <input data-testid="materia-multiturn" type="checkbox" checked={materiaForm.multiTurn} onChange={(event) => setMateriaForm({ ...materiaForm, multiTurn: event.target.checked })} />
                    </label>
                    <label className="graph-field graph-field-inline text-sm" title="Generator materia parse JSON and produce the canonical workItems envelope for downstream loops or generator pipeline stages.">Generator
                      <input data-testid="materia-generator" type="checkbox" checked={materiaForm.generator} onChange={(event) => setMateriaForm({ ...materiaForm, generator: event.target.checked })} />
                    </label>
                    </div>
                  </div>
                </fieldset>
              ) : (
                <fieldset className="materia-settings-group materia-tool-options" aria-label="Tool invocation options">
                  <legend>Tool invocation options</legend>
                  <div className="materia-compact-grid materia-settings-subgrid">
                    <label className="graph-field">Utility
                      <input data-testid="materia-utility" value={materiaForm.utility} onChange={(event) => setMateriaForm({ ...materiaForm, utility: event.target.value })} placeholder="shell" />
                    </label>
                    <label className="graph-field">Command
                      <input data-testid="materia-command" value={materiaForm.command} onChange={(event) => setMateriaForm({ ...materiaForm, command: event.target.value })} placeholder="npm test" />
                    </label>
                    <label className="graph-field">Timeout ms
                      <input data-testid="materia-timeout" value={materiaForm.timeoutMs} onChange={(event) => setMateriaForm({ ...materiaForm, timeoutMs: event.target.value })} placeholder="60000" />
                    </label>
                  </div>
                </fieldset>
              )}
            </div>
          </section>


          {materiaForm.behavior === 'prompt' && (
            <section className="materia-form-section mt-5" aria-label="Generate role prompt instructions">
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                <label className="graph-field">Generate role prompt from brief
                  <textarea data-testid="role-generation-brief" className="min-h-16" value={roleBrief} onChange={(event) => setRoleBrief(event.target.value)} placeholder="Describe the persona, responsibilities, constraints, and style for this materia…" />
                </label>
                <button type="button" className="materia-button" data-testid="generate-role-prompt" disabled={roleGenerating || !roleBrief.trim()} onClick={() => { void generateRolePrompt(); }}>
                  {roleGenerating ? 'Generating…' : generatedRolePrompt ? 'Regenerate' : 'Generate'}
                </button>
              </div>
              {roleGenerationError && <p className="mt-3 text-sm text-rose-200" role="alert" data-testid="role-generation-error">{roleGenerationError}</p>}
              {generatedRolePrompt && (
                <div className="mt-4 rounded-xl border border-cyan-200/20 bg-black/30 p-4" data-testid="role-generation-preview">
                  <p className="text-xs uppercase tracking-[0.24em] text-cyan-200">Generated preview</p>
                  <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap text-sm text-cyan-50">{generatedRolePrompt}</pre>
                  <div className="mt-4 flex flex-wrap gap-3">
                    <button type="button" className="materia-button" data-testid="apply-generated-role-prompt" onClick={applyGeneratedRolePrompt}>Apply to prompt field</button>
                    <button type="button" className="materia-button-secondary" data-testid="discard-generated-role-prompt" onClick={discardGeneratedRolePrompt}>Discard</button>
                  </div>
                </div>
              )}
            </section>
          )}

          {materiaForm.behavior === 'prompt' ? (
            <label className="graph-field materia-prompt-field mt-5">Prompt
              <textarea data-testid="materia-prompt" className="min-h-72" value={materiaForm.prompt} onChange={(event) => setMateriaForm({ ...materiaForm, prompt: event.target.value })} placeholder="You are a focused review materia…" />
            </label>
          ) : (
            <label className="graph-field materia-prompt-field mt-5">Params JSON
              <textarea data-testid="materia-params" className="min-h-44" value={materiaForm.params} onChange={(event) => setMateriaForm({ ...materiaForm, params: event.target.value })} />
            </label>
          )}

          <div className="mt-5 flex flex-wrap gap-3">
            <button className="materia-button" data-testid="save-materia-form" onClick={() => { void saveMateriaForm(); }}>{materiaForm.editingNodeId ? 'Update materia' : 'Create materia'}</button>
            <button className="materia-button-secondary" onClick={() => { resetMateriaEditorForm(); discardGeneratedRolePrompt(); }}>Clear form</button>
          </div>
          <p className="mt-3 min-h-10 text-sm text-cyan-100" data-testid="materia-save-status">{status}</p>
        </section>
        )}

        {selectedTab === 'monitor' && (
        <section className="fantasy-panel p-6" aria-label="Live session monitor">
          <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.35em] text-cyan-200">session monitor</p>
              <h2 className="mt-2 text-3xl font-black text-white">Live cast telemetry</h2>
              <p className="mt-2 max-w-4xl text-sm text-slate-400">Scoped to the Pi session that launched <code>/materia ui</code>. Native materia session entries and run artifacts are streamed from this session only.</p>
            </div>
            <div className="monitor-stat-grid">
              <div><span>node</span><b>{currentMonitorNode ?? 'idle'}</b></div>
              <div><span>state</span><b>{monitor?.activeCast?.nodeState ?? 'no active cast'}</b></div>
              <div><span>elapsed</span><b>{elapsed}</b></div>
            </div>
          </div>
          <div className="grid gap-4 xl:grid-cols-3">
            <article className="monitor-card xl:col-span-1">
              <h3>Emitted outputs</h3>
              <div className="monitor-scroll">
                {(monitor?.emittedOutputs ?? []).length === 0 ? <p className="text-sm text-slate-500">Waiting for session output…</p> : monitor?.emittedOutputs?.slice(-10).reverse().map((output) => (
                  <div key={output.id} className="monitor-output">
                    <div><b>{output.type}</b><span>{formatTime(output.timestamp)}</span></div>
                    <p>{output.text}</p>
                  </div>
                ))}
              </div>
            </article>
            <article className="monitor-card xl:col-span-1">
              <h3>Artifact summary</h3>
              <pre className="monitor-summary">{monitor?.artifactSummary?.summary ?? 'No pi-materia artifacts found for this launched session yet.'}</pre>
              {monitor?.artifactSummary?.runDir && <p className="mt-3 break-all text-xs text-cyan-100/70">{monitor.artifactSummary.runDir}</p>}
            </article>
            <article className="monitor-card xl:col-span-1">
              <h3>Recent artifacts</h3>
              <div className="monitor-scroll">
                {(monitor?.artifactSummary?.outputs ?? []).length === 0 ? <p className="text-sm text-slate-500">Artifacts will appear as nodes emit context and output files.</p> : monitor?.artifactSummary?.outputs?.slice(-8).reverse().map((entry, index) => (
                  <details key={`${entry.artifact}-${index}`} className="monitor-artifact">
                    <summary>{entry.node ?? entry.phase ?? 'cast'} · {entry.kind ?? 'artifact'}</summary>
                    <p className="break-all text-xs text-cyan-100/70">{entry.artifact}</p>
                    {entry.content && <pre>{entry.content}</pre>}
                  </details>
                ))}
              </div>
            </article>
          </div>
        </section>
        )}
      </section>
    </main>
  );
}
