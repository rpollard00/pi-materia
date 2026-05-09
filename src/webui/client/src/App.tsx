import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
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
import { AppHeader, TabNav } from './webui/components/AppChrome.js';
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
        <AppHeader source={source} isDirty={isDirty} />

        <TabNav selectedTab={selectedTab} onSelectTab={selectTab} />

        {selectedTab === 'loadout' && (
        <div className="loadout-workspace grid gap-6 xl:grid-cols-[16rem_minmax(0,1fr)_18rem]">
          <LoadoutListPanel
            loadouts={loadouts}
            activeLoadoutName={activeLoadoutName}
            loadoutSources={loadoutSources}
            canDeleteLoadout={canDeleteLoadout}
            onCreateLoadout={createLoadout}
            onSwitchLoadout={switchLoadout}
            onDeleteLoadout={deleteLoadout}
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
              dragOverTrash={dragOverTrash}
              isDirty={isDirty}
              canRevert={Boolean(baselineConfig)}
              status={status}
              onSaveTargetChange={setSaveTarget}
              onTrashDragOver={(event) => { event.preventDefault(); setDragOverTrash(true); }}
              onTrashDragLeave={() => setDragOverTrash(false)}
              onTrashDrop={(event) => {
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
              onSave={() => saveDraft().catch((error) => setStatus(error.message))}
              onRevert={() => { setDraftConfig(cloneConfig(baselineConfig ?? {})); setStatus('Reverted staged edits.'); }}
            />
          </aside>
        </div>
        )}

        {selectedTab === 'materia-editor' && (
        <MateriaEditorPanel
          activeModelDescription={activeModelDescription}
          editableDefinitionIds={editableDefinitionIds}
          generatedRolePrompt={generatedRolePrompt}
          materiaColorDropdownRef={materiaColorDropdownRef}
          materiaColorOpen={materiaColorOpen}
          materiaForm={materiaForm}
          modelCatalog={modelCatalog}
          modelCatalogError={modelCatalogError}
          modelCatalogStatus={modelCatalogStatus}
          modelOptions={modelOptions}
          roleBrief={roleBrief}
          roleGenerating={roleGenerating}
          roleGenerationError={roleGenerationError}
          selectedModel={selectedModel}
          status={status}
          thinkingLevelsForSelection={thinkingLevelsForSelection}
          thinkingOptions={thinkingOptions}
          applyGeneratedRolePrompt={applyGeneratedRolePrompt}
          discardGeneratedRolePrompt={discardGeneratedRolePrompt}
          editMateria={editMateria}
          generateRolePrompt={generateRolePrompt}
          handleMateriaModelChange={handleMateriaModelChange}
          resetMateriaEditorForm={resetMateriaEditorForm}
          saveMateriaForm={saveMateriaForm}
          setMateriaColorOpen={setMateriaColorOpen}
          setMateriaForm={setMateriaForm}
          setRoleBrief={setRoleBrief}
        />
        )}

        {selectedTab === 'monitor' && <MonitorPanel monitor={monitor} currentMonitorNode={currentMonitorNode} elapsed={elapsed} />}
      </section>
    </main>
  );
}
