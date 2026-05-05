import { useEffect, useMemo, useState } from 'react';
import type { DragEvent } from 'react';

type SaveTarget = 'user' | 'project' | 'explicit';
type NodeType = 'agent' | 'utility';

interface PipelineNode {
  type?: NodeType;
  role?: string;
  utility?: string;
  command?: string[];
  next?: string;
  edges?: { to: string; when?: string; maxTraversals?: number }[];
  prompt?: string;
  empty?: boolean;
  layout?: { x?: number; y?: number };
  limits?: { maxVisits?: number; maxEdgeTraversals?: number; maxOutputBytes?: number };
  [key: string]: unknown;
}

interface PipelineConfig {
  entry?: string;
  nodes?: Record<string, PipelineNode>;
  [key: string]: unknown;
}

interface MateriaRoleConfig {
  tools?: 'none' | 'readOnly' | 'coding';
  systemPrompt?: string;
  model?: string;
  thinking?: string;
  multiTurn?: boolean;
  [key: string]: unknown;
}

interface MateriaConfig {
  activeLoadout?: string;
  loadouts?: Record<string, PipelineConfig>;
  pipeline?: PipelineConfig;
  roles?: Record<string, MateriaRoleConfig>;
  materiaDefinitions?: Record<string, PipelineNode>;
  [key: string]: unknown;
}

interface MateriaFormState {
  editingNodeId: string;
  name: string;
  behavior: 'prompt' | 'tool';
  prompt: string;
  toolAccess: 'none' | 'readOnly' | 'coding';
  model: string;
  thinking: string;
  outputFormat: 'text' | 'json';
  multiTurn: boolean;
  utility: string;
  command: string;
  params: string;
  timeoutMs: string;
  persistScope: SaveTarget;
}

interface ConfigResponse {
  ok?: boolean;
  config?: MateriaConfig;
  source?: string;
}

interface MateriaSavedEventDetail {
  id: string;
  name: string;
  behavior: MateriaFormState['behavior'];
  requestedScope: SaveTarget;
  scope: SaveTarget | string;
}

const materiaSavedEventName = 'materia:saved';

interface MonitorSnapshot {
  ok?: boolean;
  sessionKey?: string;
  uiStartedAt?: number;
  now?: number;
  emittedOutputs?: Array<{ id: string; type: string; text: string; timestamp?: number; node?: string }>;
  artifactSummary?: {
    runDir?: string;
    request?: string;
    summary?: string;
    events?: Array<{ ts?: number; type?: string; data?: unknown }>;
    outputs?: Array<{ node?: string; role?: string; phase?: string; kind?: string; artifact?: string; timestamp?: number; content?: string }>;
  };
  activeCast?: {
    castId: string;
    active: boolean;
    phase: string;
    currentNode?: string;
    currentRole?: string;
    nodeState?: string;
    awaitingResponse: boolean;
    runDir: string;
    artifactRoot: string;
    startedAt: number;
    updatedAt: number;
  };
}

interface DragPayload {
  kind: 'palette' | 'socket';
  materiaId: string;
  fromLoadout?: string;
  fromSocket?: string;
}

type MateriaTabId = 'loadout' | 'materia-editor' | 'monitor' | 'pipeline-graph';

const materiaTabs: Array<{ id: MateriaTabId; label: string; description: string }> = [
  { id: 'loadout', label: 'Loadout', description: 'Loadout selector, visual grid, palette, and apply controls' },
  { id: 'materia-editor', label: 'Materia Editor', description: 'Create and edit materia definitions' },
  { id: 'monitor', label: 'Monitoring', description: 'Live cast telemetry and artifacts' },
  { id: 'pipeline-graph', label: 'Pipeline Graph', description: 'Graph links, branches, layout, and retry limits' },
];

function parseTabId(value: string | null): MateriaTabId {
  return materiaTabs.some((tab) => tab.id === value) ? value as MateriaTabId : 'loadout';
}

function tabFromLocation(): MateriaTabId {
  if (typeof window === 'undefined') return 'loadout';
  return parseTabId(new URLSearchParams(window.location.search).get('tab'));
}

const emptyMateriaForm = (): MateriaFormState => ({
  editingNodeId: '',
  name: '',
  behavior: 'prompt',
  prompt: '',
  toolAccess: 'none',
  model: '',
  thinking: '',
  outputFormat: 'text',
  multiTurn: false,
  utility: '',
  command: '',
  params: '{}',
  timeoutMs: '',
  persistScope: 'user',
});

const paletteColors = [
  'from-sky-200 via-cyan-300 to-blue-600',
  'from-emerald-200 via-lime-300 to-green-700',
  'from-amber-100 via-yellow-300 to-orange-600',
  'from-fuchsia-200 via-pink-300 to-purple-700',
  'from-rose-200 via-red-300 to-red-700',
  'from-violet-200 via-indigo-300 to-slate-700',
];

const cloneConfig = <T,>(config: T): T => JSON.parse(JSON.stringify(config)) as T;

function buildLoadouts(config: MateriaConfig): Record<string, PipelineConfig> {
  if (config.loadouts && Object.keys(config.loadouts).length > 0) return config.loadouts;
  if (config.pipeline) return { Legacy: config.pipeline };
  return {};
}

function getNodeLabel(id: string, node?: PipelineNode) {
  if (!node || node.empty) return 'Empty socket';
  if (node.type === 'agent') return node.role ?? id;
  if (node.type === 'utility') return node.utility ?? node.command?.join(' ') ?? id;
  return node.role ?? node.utility ?? id;
}

function nodeColor(id: string, index: number) {
  const lowered = id.toLowerCase();
  if (lowered.includes('plan')) return paletteColors[0];
  if (lowered.includes('build')) return paletteColors[1];
  if (lowered.includes('check') || lowered.includes('eval')) return paletteColors[2];
  if (lowered.includes('maintain')) return paletteColors[3];
  return paletteColors[index % paletteColors.length];
}

function makeNewLoadoutName(loadouts: Record<string, PipelineConfig>) {
  let index = Object.keys(loadouts).length + 1;
  let name = `New Loadout ${index}`;
  while (loadouts[name]) name = `New Loadout ${++index}`;
  return name;
}

function makeUniqueNodeId(nodes: Record<string, PipelineNode>, base = 'NewNode') {
  const cleaned = base.trim().replace(/\s+/g, '-') || 'NewNode';
  if (!nodes[cleaned]) return cleaned;
  let index = 2;
  while (nodes[`${cleaned}-${index}`]) index += 1;
  return `${cleaned}-${index}`;
}

function getNodeLayout(id: string, index: number, node?: PipelineNode) {
  const rawX = node?.layout?.x;
  const rawY = node?.layout?.y;
  return {
    x: typeof rawX === 'number' ? rawX : 40 + (index % 4) * 210,
    y: typeof rawY === 'number' ? rawY : 40 + Math.floor(index / 4) * 150,
  };
}

function graphEdges(nodes: Record<string, PipelineNode>): { from: string; to: string; when: string; maxTraversals?: number }[] {
  return Object.entries(nodes).flatMap(([from, node]) => [
    ...(node.next ? [{ from, to: node.next, when: 'next' }] : []),
    ...(node.edges ?? []).map((edge) => ({ from, to: edge.to, when: edge.when ?? 'always', maxTraversals: edge.maxTraversals })),
  ]);
}

function graphPoint(id: string, index: number, node?: PipelineNode) {
  const layout = getNodeLayout(id, index, node);
  return {
    x: Math.abs(layout.x) <= 10 ? 54 + layout.x * 220 : layout.x,
    y: Math.abs(layout.y) <= 10 ? 46 + layout.y * 150 : layout.y,
  };
}

const materiaBehaviorKeys = new Set([
  'type',
  'role',
  'utility',
  'command',
  'params',
  'timeoutMs',
  'prompt',
  'model',
  'modelSettings',
  'outputFormat',
  'multiturn',
  'parse',
]);

function materiaBehavior(node?: PipelineNode): PipelineNode {
  if (!node || node.empty) return { empty: true };
  const behavior: PipelineNode = {};
  for (const [key, value] of Object.entries(node)) {
    if (materiaBehaviorKeys.has(key)) behavior[key] = cloneConfig(value);
  }
  return Object.keys(behavior).length > 0 ? behavior : { empty: true };
}

function socketStructure(node?: PipelineNode): PipelineNode {
  const structure: PipelineNode = {};
  for (const [key, value] of Object.entries(node ?? {})) {
    if (!materiaBehaviorKeys.has(key) && key !== 'empty') structure[key] = cloneConfig(value);
  }
  return structure;
}

function placeMateriaInSocket(socket?: PipelineNode, materia?: PipelineNode): PipelineNode {
  return { ...socketStructure(socket), ...materiaBehavior(materia), empty: false };
}

function clearSocketMateria(socket?: PipelineNode): PipelineNode {
  return { ...socketStructure(socket), empty: true };
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Tool params must be a JSON object.');
  return parsed as Record<string, unknown>;
}

function commandParts(raw: string): string[] | undefined {
  return raw.split(/\s+/).map((part) => part.trim()).filter(Boolean);
}

function buildMateriaPatch(form: MateriaFormState): MateriaConfig {
  const name = form.name.trim();
  if (!name) throw new Error('Materia name is required.');
  const timeoutMs = Number(form.timeoutMs);
  const patch: MateriaConfig = { materiaDefinitions: {} };
  if (form.behavior === 'prompt') {
    patch.roles = {
      [name]: {
        tools: form.toolAccess,
        systemPrompt: form.prompt,
        model: form.model.trim() || undefined,
        thinking: form.thinking.trim() || undefined,
        multiTurn: form.multiTurn || undefined,
      },
    };
    patch.materiaDefinitions = {
      [name]: { type: 'agent', role: name, prompt: form.prompt || undefined, parse: form.outputFormat === 'json' ? 'json' : 'text' },
    };
  } else {
    const parsedParams = parseJsonObject(form.params);
    const command = commandParts(form.command);
    patch.materiaDefinitions = {
      [name]: { type: 'utility', utility: form.utility || name, command: command?.length ? command : undefined, params: parsedParams, timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined, parse: form.outputFormat === 'json' ? 'json' : 'text' },
    };
  }
  return patch;
}

async function fetchMateriaConfig(): Promise<{ config: MateriaConfig; source: string }> {
  const response = await fetch('/api/config');
  const body = await response.json() as ConfigResponse;
  return { config: body.config ?? (body as MateriaConfig), source: body.source ?? 'unknown' };
}

function mergeReloadedConfigIntoDraft(current: MateriaConfig | undefined, reloaded: MateriaConfig, preserveLoadoutEdits: boolean): MateriaConfig {
  if (!preserveLoadoutEdits || !current) return cloneConfig(reloaded);
  return {
    ...cloneConfig(current),
    roles: reloaded.roles ? cloneConfig(reloaded.roles) : undefined,
    materiaDefinitions: reloaded.materiaDefinitions ? cloneConfig(reloaded.materiaDefinitions) : undefined,
  };
}

function dispatchMateriaSavedEvent(detail: MateriaSavedEventDetail) {
  window.dispatchEvent(new CustomEvent<MateriaSavedEventDetail>(materiaSavedEventName, { detail }));
}

function Orb({ color, label, small = false, empty = false }: { color: string; label: string; small?: boolean; empty?: boolean }) {
  return <div aria-hidden className={`${small ? 'materia-orb-small' : 'materia-orb'} ${empty ? 'materia-orb-empty' : `bg-gradient-to-br ${color}`}`} title={label} />;
}

function formatElapsed(startedAt?: number, now = Date.now()) {
  if (!startedAt) return '—';
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatTime(timestamp?: number) {
  return timestamp ? new Date(timestamp).toLocaleTimeString() : 'live';
}

export function App() {
  const [selectedTab, setSelectedTab] = useState<MateriaTabId>(() => tabFromLocation());
  const [baselineConfig, setBaselineConfig] = useState<MateriaConfig | undefined>();
  const [draftConfig, setDraftConfig] = useState<MateriaConfig | undefined>();
  const [source, setSource] = useState<string>('loading');
  const [status, setStatus] = useState('Loading materia configuration…');
  const [selectedMateriaId, setSelectedMateriaId] = useState<string | undefined>();
  const [saveTarget, setSaveTarget] = useState<SaveTarget>('user');
  const [dragOverTrash, setDragOverTrash] = useState(false);
  const [newGraphNodeId, setNewGraphNodeId] = useState('Review');
  const [insertFrom, setInsertFrom] = useState('');
  const [monitor, setMonitor] = useState<MonitorSnapshot>();
  const [insertTo, setInsertTo] = useState('');
  const [materiaForm, setMateriaForm] = useState<MateriaFormState>(() => emptyMateriaForm());

  useEffect(() => {
    const handlePopState = () => setSelectedTab(tabFromLocation());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    reloadConfig({ cancelled: () => cancelled }).catch((error) => {
      if (cancelled) return;
      setStatus(`Using demo loadout data: ${error instanceof Error ? error.message : String(error)}`);
      const fallback: MateriaConfig = {
        activeLoadout: 'Demo Loadout',
        loadouts: {
          'Demo Loadout': {
            entry: 'planner',
            nodes: {
              planner: { type: 'agent', role: 'planner', next: 'Build' },
              Build: { type: 'agent', role: 'Build', next: 'Auto-Eval' },
              'Auto-Eval': { type: 'agent', role: 'Auto-Eval', next: 'Maintain' },
              Maintain: { type: 'agent', role: 'Maintain' },
            },
          },
        },
      };
      setBaselineConfig(cloneConfig(fallback));
      setDraftConfig(fallback);
      setSource('demo');
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

  const loadouts = useMemo(() => buildLoadouts(draftConfig ?? {}), [draftConfig]);
  const activeLoadoutName = draftConfig?.activeLoadout && loadouts[draftConfig.activeLoadout] ? draftConfig.activeLoadout : Object.keys(loadouts)[0];
  const activeLoadout = activeLoadoutName ? loadouts[activeLoadoutName] : undefined;
  const activeNodes = activeLoadout?.nodes ?? {};
  const activeNodeIds = Object.keys(activeNodes);
  const activeGraphEdges = useMemo(() => graphEdges(activeNodes), [activeNodes]);
  const roles = draftConfig?.roles ?? {};
  const materiaDefinitions = draftConfig?.materiaDefinitions ?? {};
  const editableDefinitionIds = useMemo(() => {
    const ids = new Set<string>([...Object.keys(roles), ...Object.keys(materiaDefinitions)]);
    return [...ids].sort((a, b) => a.localeCompare(b));
  }, [roles, materiaDefinitions]);
  const palette = useMemo(() => {
    const allNodes = Object.values(loadouts).flatMap((loadout) => Object.entries(loadout.nodes ?? {}));
    const byId = new Map<string, PipelineNode>();
    for (const [id, node] of allNodes) {
      if (!node.empty) byId.set(id, node);
    }
    return [...byId.entries()];
  }, [loadouts]);
  const isDirty = JSON.stringify(baselineConfig) !== JSON.stringify(draftConfig);
  const currentMonitorNode = monitor?.activeCast?.currentNode;
  const elapsed = formatElapsed(monitor?.activeCast?.startedAt ?? monitor?.uiStartedAt, monitor?.now);

  function updateDraft(updater: (config: MateriaConfig) => void) {
    setDraftConfig((current) => {
      const next = cloneConfig(current ?? {});
      if (!next.loadouts) next.loadouts = buildLoadouts(next);
      updater(next);
      return next;
    });
  }

  async function reloadConfig({ preserveLoadoutEdits = false, readyStatus = 'Draft ready. Changes are staged until you save.', cancelled = () => false }: { preserveLoadoutEdits?: boolean; readyStatus?: string; cancelled?: () => boolean } = {}) {
    const loaded = await fetchMateriaConfig();
    if (cancelled()) return;
    setBaselineConfig(cloneConfig(loaded.config));
    setDraftConfig((current) => mergeReloadedConfigIntoDraft(current, loaded.config, preserveLoadoutEdits));
    setSource(loaded.source);
    setStatus(readyStatus);
  }

  function switchLoadout(name: string) {
    updateDraft((config) => {
      config.activeLoadout = name;
    });
    setSelectedMateriaId(undefined);
    setStatus(`Active loadout staged: ${name}`);
  }

  function renameActiveLoadout(name: string) {
    if (!activeLoadoutName || !name.trim() || name === activeLoadoutName) return;
    updateDraft((config) => {
      const draftLoadouts = buildLoadouts(config);
      if (draftLoadouts[name]) return;
      draftLoadouts[name] = draftLoadouts[activeLoadoutName];
      delete draftLoadouts[activeLoadoutName];
      config.loadouts = draftLoadouts;
      config.activeLoadout = name;
    });
    setStatus(`Renamed loadout to ${name}. Save to persist.`);
  }

  function createLoadout() {
    updateDraft((config) => {
      const draftLoadouts = buildLoadouts(config);
      const name = makeNewLoadoutName(draftLoadouts);
      draftLoadouts[name] = activeLoadout ? cloneConfig(activeLoadout) as PipelineConfig : { entry: '', nodes: {} };
      config.loadouts = draftLoadouts;
      config.activeLoadout = name;
    });
    setStatus('Created a cloned draft loadout. Rename and save when ready.');
  }

  function putMateria(socketId: string, materiaId: string, fromSocket?: string) {
    if (!activeLoadoutName || !draftConfig) return;
    updateDraft((config) => {
      const loadout = buildLoadouts(config)[activeLoadoutName];
      if (!loadout?.nodes) return;
      if (fromSocket && fromSocket !== socketId) {
        const target = loadout.nodes[socketId];
        const source = loadout.nodes[fromSocket];
        if (!source || !target) return;
        loadout.nodes[socketId] = placeMateriaInSocket(target, source);
        loadout.nodes[fromSocket] = placeMateriaInSocket(source, target);
      } else {
        const sourceNode = palette.find(([id]) => id === materiaId)?.[1] ?? loadout.nodes[materiaId];
        if (sourceNode) loadout.nodes[socketId] = placeMateriaInSocket(loadout.nodes[socketId], sourceNode);
      }
    });
    setSelectedMateriaId(undefined);
    setStatus(`Staged ${materiaId} in socket ${socketId}; socket graph links and layout were preserved.`);
  }

  function removeMateria(socketId: string) {
    if (!activeLoadoutName) return;
    updateDraft((config) => {
      const loadout = buildLoadouts(config)[activeLoadoutName];
      if (!loadout?.nodes || !loadout.nodes[socketId]) return;
      loadout.nodes[socketId] = clearSocketMateria(loadout.nodes[socketId]);
    });
    setStatus(`Cleared materia from ${socketId}; socket graph links and layout were preserved.`);
  }

  function mutateActiveGraph(mutator: (loadout: PipelineConfig, nodes: Record<string, PipelineNode>) => void) {
    if (!activeLoadoutName) return;
    updateDraft((config) => {
      const loadout = buildLoadouts(config)[activeLoadoutName];
      if (!loadout) return;
      loadout.nodes ??= {};
      mutator(loadout, loadout.nodes);
    });
  }

  function addGraphNode() {
    mutateActiveGraph((loadout, nodes) => {
      const id = makeUniqueNodeId(nodes, newGraphNodeId);
      nodes[id] = { type: 'agent', role: id, layout: { x: 40 + Object.keys(nodes).length * 35, y: 420 }, limits: { maxVisits: 3 } };
      if (!loadout.entry) loadout.entry = id;
      setNewGraphNodeId(id);
      setStatus(`Added pipeline node ${id}. Save to persist.`);
    });
  }

  function insertGraphNodeBetween() {
    if (!insertFrom || !insertTo || insertFrom === insertTo) return;
    mutateActiveGraph((_loadout, nodes) => {
      const fromNode = nodes[insertFrom];
      const toNode = nodes[insertTo];
      if (!fromNode || !toNode) return;
      const id = makeUniqueNodeId(nodes, `${insertFrom}-insert`);
      const fromIndex = activeNodeIds.indexOf(insertFrom);
      const toIndex = activeNodeIds.indexOf(insertTo);
      const fromLayout = getNodeLayout(insertFrom, fromIndex < 0 ? 0 : fromIndex, fromNode);
      const toLayout = getNodeLayout(insertTo, toIndex < 0 ? 1 : toIndex, toNode);
      nodes[id] = { type: 'agent', role: id, next: insertTo, layout: { x: Math.round((fromLayout.x + toLayout.x) / 2), y: Math.round((fromLayout.y + toLayout.y) / 2) }, inserted: { between: [insertFrom, insertTo], via: 'webui-graph-editor' } };
      if (fromNode.next === insertTo) fromNode.next = id;
      fromNode.edges = fromNode.edges?.map((edge) => edge.to === insertTo ? { ...edge, to: id } : edge);
      setStatus(`Inserted ${id} between ${insertFrom} and ${insertTo}; surrounding graph references were shifted safely.`);
    });
  }

  function setNodeNext(id: string, next: string) {
    mutateActiveGraph((_loadout, nodes) => {
      if (!nodes[id]) return;
      if (next) nodes[id].next = next;
      else delete nodes[id].next;
    });
    setStatus(`Updated next edge for ${id}.`);
  }

  function setBranch(id: string, when: 'satisfied' | 'not_satisfied', to: string) {
    mutateActiveGraph((_loadout, nodes) => {
      const node = nodes[id];
      if (!node) return;
      const existing = node.edges?.find((edge) => edge.when === when);
      const remaining = (node.edges ?? []).filter((edge) => edge.when !== when);
      node.edges = to ? [...remaining, { ...existing, when, to }] : remaining;
    });
    setStatus(`Updated ${when.replace('_', ' ')} branch for ${id}.`);
  }

  function updateBranchMaxTraversals(id: string, when: 'satisfied' | 'not_satisfied', value: string) {
    const parsed = Number(value);
    mutateActiveGraph((_loadout, nodes) => {
      const node = nodes[id];
      const edge = node?.edges?.find((candidate) => candidate.when === when);
      if (!edge) return;
      if (!Number.isFinite(parsed) || parsed <= 0) delete edge.maxTraversals;
      else edge.maxTraversals = parsed;
    });
    setStatus(`Tweaked ${when.replace('_', ' ')} branch retry traversal limit for ${id}.`);
  }

  function updateNodeLayout(id: string, axis: 'x' | 'y', value: string) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    mutateActiveGraph((_loadout, nodes) => {
      const node = nodes[id];
      if (!node) return;
      node.layout = { ...(node.layout ?? {}), [axis]: parsed };
    });
    setStatus(`Moved graph node ${id}. Layout change is staged.`);
  }

  function updateRetryLimit(id: string, key: 'maxVisits' | 'maxEdgeTraversals' | 'maxOutputBytes', value: string) {
    const parsed = Number(value);
    mutateActiveGraph((_loadout, nodes) => {
      const node = nodes[id];
      if (!node) return;
      node.limits = { ...(node.limits ?? {}) };
      if (!Number.isFinite(parsed) || parsed <= 0) delete node.limits[key];
      else node.limits[key] = parsed;
    });
    setStatus(`Tweaked retry/limit setting ${key} for ${id}.`);
  }

  function setEntry(id: string) {
    mutateActiveGraph((loadout) => {
      loadout.entry = id;
    });
    setStatus(`Entry node staged: ${id}.`);
  }

  function editMateria(id: string) {
    const definition = materiaDefinitions[id];
    const roleName = definition?.role ?? id;
    const role = roles[roleName] ?? roles[id];
    if (!definition && !role) return;
    setMateriaForm({
      editingNodeId: id,
      name: id,
      behavior: definition?.type === 'utility' ? 'tool' : 'prompt',
      prompt: String(role?.systemPrompt ?? definition?.prompt ?? ''),
      toolAccess: role?.tools ?? 'none',
      model: String(role?.model ?? definition?.model ?? ''),
      thinking: String(role?.thinking ?? ''),
      outputFormat: (definition?.parse === 'json' || definition?.outputFormat === 'json') ? 'json' : 'text',
      multiTurn: Boolean(role?.multiTurn ?? definition?.multiturn),
      utility: String(definition?.utility ?? ''),
      command: Array.isArray(definition?.command) ? definition.command.join(' ') : '',
      params: definition?.params ? JSON.stringify(definition.params, null, 2) : '{}',
      timeoutMs: definition?.timeoutMs ? String(definition.timeoutMs) : '',
      persistScope: 'user',
    });
    setStatus(`Editing reusable materia definition ${id}. Save the staged form to update definitions only.`);
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
      setMateriaForm(emptyMateriaForm());
      await reloadConfig({
        preserveLoadoutEdits: true,
        readyStatus: `Saved reusable ${savedBehavior} materia ${savedName} to ${scope} scope. Loadout draft edits were left unchanged.`,
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  function handleDrop(socketId: string, event: DragEvent) {
    event.preventDefault();
    const raw = event.dataTransfer.getData('application/json');
    if (!raw) return;
    const payload = JSON.parse(raw) as DragPayload;
    putMateria(socketId, payload.materiaId, payload.kind === 'socket' ? payload.fromSocket : undefined);
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
    const response = await fetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: saveTarget, config: draftConfig }),
    });
    const body = await response.json();
    if (!response.ok || body.ok === false) throw new Error(body.error ?? 'Save failed');
    setBaselineConfig(cloneConfig(draftConfig));
    setStatus(`Saved staged loadout edits to ${body.target ?? saveTarget} scope.`);
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,#14304a,#020617_58%)] text-slate-100">
      <section className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-6 py-8">
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
        <div className="grid gap-6 xl:grid-cols-[18rem_1fr_20rem]">
          <aside className="fantasy-panel p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-bold">Loadouts</h2>
              <button className="materia-button" onClick={createLoadout}>New</button>
            </div>
            <div className="space-y-2" role="list" aria-label="Available loadouts">
              {Object.keys(loadouts).map((name) => (
                <button key={name} onClick={() => switchLoadout(name)} className={`loadout-card ${name === activeLoadoutName ? 'loadout-card-active' : ''}`}>
                  <span>{name}</span>
                  <small>{Object.keys(loadouts[name].nodes ?? {}).length} sockets</small>
                </button>
              ))}
            </div>
          </aside>

          <section className="fantasy-panel p-6">
            <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="text-2xl font-bold">Visual materia grid</h2>
                <p className="text-sm text-slate-400">Drag orbs into sockets, drag sockets onto each other to swap, or click a palette orb then click a socket.</p>
              </div>
              <label className="text-sm text-slate-300">Edit name
                <input className="ml-3 rounded-xl border border-cyan-200/20 bg-slate-950/80 px-3 py-2 text-cyan-100" value={activeLoadoutName ?? ''} onChange={(event) => renameActiveLoadout(event.target.value)} />
              </label>
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3" data-testid="socket-grid">
              {Object.entries(activeNodes).map(([id, node], index) => (
                <button
                  key={id}
                  data-testid={`socket-${id}`}
                  className={`materia-socket ${selectedMateriaId ? 'materia-socket-selectable' : ''} ${id === currentMonitorNode ? 'materia-socket-active' : ''}`}
                  onClick={() => selectedMateriaId && putMateria(id, selectedMateriaId)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => handleDrop(id, event)}
                >
                  <div draggable={!node.empty} onDragStart={(event) => dragMateria({ kind: 'socket', materiaId: id, fromLoadout: activeLoadoutName, fromSocket: id }, event)}>
                    <Orb color={nodeColor(id, index)} label={getNodeLabel(id, node)} empty={node.empty} />
                  </div>
                  <span className="relative z-10 mt-4 text-sm font-semibold uppercase tracking-widest text-slate-100">{id}</span>
                  <span className="relative z-10 mt-1 text-xs text-cyan-100/80">{getNodeLabel(id, node)}</span>
                  {id === activeLoadout?.entry && <span className="entry-rune">entry</span>}
                </button>
              ))}
            </div>
          </section>

          <aside className="flex flex-col gap-6">
            <section className="fantasy-panel p-5">
              <h2 className="text-xl font-bold">Materia palette</h2>
              <p className="mt-1 text-sm text-slate-400">Click once to select for swap/insert, or drag into a socket.</p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                {palette.map(([id, node], index) => (
                  <button key={id} draggable data-testid={`palette-${id}`} onDragStart={(event) => dragMateria({ kind: 'palette', materiaId: id }, event)} onClick={() => setSelectedMateriaId(selectedMateriaId === id ? undefined : id)} className={`palette-orb ${selectedMateriaId === id ? 'palette-orb-selected' : ''}`}>
                    <Orb small color={nodeColor(id, index)} label={id} />
                    <span>{getNodeLabel(id, node)}</span>
                  </button>
                ))}
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
                  const payload = JSON.parse(raw) as DragPayload;
                  if (payload.fromSocket) removeMateria(payload.fromSocket);
                }}
              >
                Drag socket here to remove non-entry materia
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
        <section className="fantasy-panel p-6" aria-label="Materia creation editor">
          <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.35em] text-cyan-200">materia forge</p>
              <h2 className="mt-2 text-3xl font-black text-white">Create / edit materia</h2>
              <p className="mt-2 max-w-4xl text-sm text-slate-400">Forge reusable prompt materia or tool-invocation materia as staged definition edits. The form defaults to user profile persistence; choose Project only when you intentionally want repository-scoped materia.</p>
            </div>
            <label className="graph-field w-full max-w-xs">Edit existing
              <select data-testid="edit-materia-select" value={materiaForm.editingNodeId} onChange={(event) => event.target.value ? editMateria(event.target.value) : setMateriaForm(emptyMateriaForm())}>
                <option value="">new materia…</option>
                {editableDefinitionIds.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </label>
          </div>

          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
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
          </div>

          {materiaForm.behavior === 'prompt' ? (
            <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_14rem_14rem_10rem]">
              <label className="graph-field">Prompt / system prompt
                <textarea data-testid="materia-prompt" className="min-h-32" value={materiaForm.prompt} onChange={(event) => setMateriaForm({ ...materiaForm, prompt: event.target.value })} placeholder="You are a focused review materia…" />
              </label>
              <label className="graph-field">Model
                <input data-testid="materia-model" value={materiaForm.model} onChange={(event) => setMateriaForm({ ...materiaForm, model: event.target.value })} placeholder="provider/model" />
              </label>
              <label className="graph-field">Tools
                <select data-testid="materia-tools" value={materiaForm.toolAccess} onChange={(event) => setMateriaForm({ ...materiaForm, toolAccess: event.target.value as MateriaFormState['toolAccess'] })}>
                  <option value="none">none</option>
                  <option value="readOnly">read only</option>
                  <option value="coding">coding</option>
                </select>
              </label>
              <label className="graph-field">Multiturn
                <input data-testid="materia-multiturn" type="checkbox" checked={materiaForm.multiTurn} onChange={(event) => setMateriaForm({ ...materiaForm, multiTurn: event.target.checked })} />
              </label>
            </div>
          ) : (
            <div className="mt-4 grid gap-4 lg:grid-cols-[14rem_1fr_1fr_10rem]">
              <label className="graph-field">Utility
                <input data-testid="materia-utility" value={materiaForm.utility} onChange={(event) => setMateriaForm({ ...materiaForm, utility: event.target.value })} placeholder="shell" />
              </label>
              <label className="graph-field">Command
                <input data-testid="materia-command" value={materiaForm.command} onChange={(event) => setMateriaForm({ ...materiaForm, command: event.target.value })} placeholder="npm test" />
              </label>
              <label className="graph-field">Params JSON
                <textarea data-testid="materia-params" value={materiaForm.params} onChange={(event) => setMateriaForm({ ...materiaForm, params: event.target.value })} />
              </label>
              <label className="graph-field">Timeout ms
                <input data-testid="materia-timeout" value={materiaForm.timeoutMs} onChange={(event) => setMateriaForm({ ...materiaForm, timeoutMs: event.target.value })} placeholder="60000" />
              </label>
            </div>
          )}

          <div className="mt-5 flex flex-wrap gap-3">
            <button className="materia-button" data-testid="save-materia-form" onClick={() => { void saveMateriaForm(); }}>{materiaForm.editingNodeId ? 'Update materia' : 'Create materia'}</button>
            <button className="materia-button-secondary" onClick={() => setMateriaForm(emptyMateriaForm())}>Clear form</button>
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

        {selectedTab === 'pipeline-graph' && (
        <section className="fantasy-panel p-6" aria-label="Pipeline graph editor">
          <div className="mb-5 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.35em] text-cyan-200">pipeline graph</p>
              <h2 className="mt-2 text-3xl font-black text-white">Graph editor</h2>
              <p className="mt-2 max-w-4xl text-sm text-slate-400">Edit graph links, branches, layout, and retry limits as staged loadout changes. Insertions shift only the selected references and preserve existing inserted metadata, socket ids, and layout fields.</p>
            </div>
            <div className="grid gap-3 md:grid-cols-[12rem_8rem_8rem_auto]">
              <label className="graph-field">New node id
                <input data-testid="new-node-id" value={newGraphNodeId} onChange={(event) => setNewGraphNodeId(event.target.value)} />
              </label>
              <label className="graph-field">Insert from
                <select data-testid="insert-from" value={insertFrom} onChange={(event) => setInsertFrom(event.target.value)}>
                  <option value="">from…</option>
                  {activeNodeIds.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
              </label>
              <label className="graph-field">Insert to
                <select data-testid="insert-to" value={insertTo} onChange={(event) => setInsertTo(event.target.value)}>
                  <option value="">to…</option>
                  {activeNodeIds.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
              </label>
              <div className="flex items-end gap-2">
                <button className="materia-button" onClick={addGraphNode}>Add node</button>
                <button className="materia-button-secondary" disabled={!insertFrom || !insertTo || insertFrom === insertTo} onClick={insertGraphNodeBetween}>Insert</button>
              </div>
            </div>
          </div>

          <div className="graph-canvas" data-testid="pipeline-graph">
            <svg className="graph-svg" viewBox="0 0 980 620" role="img" aria-label="Pipeline graph edges">
              <defs>
                <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="rgb(103 232 249 / 0.82)" />
                </marker>
              </defs>
              {activeGraphEdges.map((edge, index) => {
                const fromIndex = activeNodeIds.indexOf(edge.from);
                const toIndex = activeNodeIds.indexOf(edge.to);
                const fromPoint = graphPoint(edge.from, fromIndex < 0 ? 0 : fromIndex, activeNodes[edge.from]);
                const toPoint = graphPoint(edge.to, toIndex < 0 ? 0 : toIndex, activeNodes[edge.to]);
                return (
                  <g key={`${edge.from}-${edge.when}-${edge.to}-${index}`}>
                    <line x1={fromPoint.x + 80} y1={fromPoint.y + 42} x2={toPoint.x + 8} y2={toPoint.y + 42} className={`graph-edge ${edge.when === 'satisfied' ? 'graph-edge-satisfied' : edge.when === 'not_satisfied' ? 'graph-edge-unsatisfied' : ''}`} markerEnd="url(#arrow)" />
                    <text x={(fromPoint.x + toPoint.x) / 2 + 44} y={(fromPoint.y + toPoint.y) / 2 + 30} className="graph-edge-label">{edge.when}{edge.maxTraversals ? ` · ${edge.maxTraversals}x` : ''}</text>
                  </g>
                );
              })}
            </svg>
            {Object.entries(activeNodes).map(([id, node], index) => {
              const point = graphPoint(id, index, node);
              return (
                <article key={id} data-testid={`graph-node-${id}`} className={`graph-node-card ${id === currentMonitorNode ? 'graph-node-card-active' : ''}`} style={{ left: point.x, top: point.y }}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-bold text-white">{id}</h3>
                      <p className="text-xs text-cyan-100/80">{getNodeLabel(id, node)}</p>
                    </div>
                    <button className="graph-entry-button" onClick={() => setEntry(id)}>{id === activeLoadout?.entry ? 'entry' : 'make entry'}</button>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <label className="graph-field">x<input aria-label={`${id} layout x`} value={node.layout?.x ?? getNodeLayout(id, index, node).x} onChange={(event) => updateNodeLayout(id, 'x', event.target.value)} /></label>
                    <label className="graph-field">y<input aria-label={`${id} layout y`} value={node.layout?.y ?? getNodeLayout(id, index, node).y} onChange={(event) => updateNodeLayout(id, 'y', event.target.value)} /></label>
                  </div>
                  <label className="graph-field mt-2">next
                    <select aria-label={`${id} next`} value={node.next ?? ''} onChange={(event) => setNodeNext(id, event.target.value)}>
                      <option value="">end</option>
                      {activeNodeIds.filter((target) => target !== id).map((target) => <option key={target} value={target}>{target}</option>)}
                    </select>
                  </label>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <label className="graph-field">satisfied
                      <select aria-label={`${id} satisfied branch`} value={node.edges?.find((edge) => edge.when === 'satisfied')?.to ?? ''} onChange={(event) => setBranch(id, 'satisfied', event.target.value)}>
                        <option value="">none</option>
                        {activeNodeIds.filter((target) => target !== id).map((target) => <option key={target} value={target}>{target}</option>)}
                      </select>
                    </label>
                    <label className="graph-field">not satisfied
                      <select aria-label={`${id} not satisfied branch`} value={node.edges?.find((edge) => edge.when === 'not_satisfied')?.to ?? ''} onChange={(event) => setBranch(id, 'not_satisfied', event.target.value)}>
                        <option value="">none</option>
                        {activeNodeIds.filter((target) => target !== id).map((target) => <option key={target} value={target}>{target}</option>)}
                      </select>
                    </label>
                    <label className="graph-field">sat retry
                      <input aria-label={`${id} satisfied max traversals`} value={node.edges?.find((edge) => edge.when === 'satisfied')?.maxTraversals ?? ''} placeholder="global" onChange={(event) => updateBranchMaxTraversals(id, 'satisfied', event.target.value)} />
                    </label>
                    <label className="graph-field">not sat retry
                      <input aria-label={`${id} not satisfied max traversals`} value={node.edges?.find((edge) => edge.when === 'not_satisfied')?.maxTraversals ?? ''} placeholder="global" onChange={(event) => updateBranchMaxTraversals(id, 'not_satisfied', event.target.value)} />
                    </label>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <label className="graph-field">visits<input aria-label={`${id} max visits`} value={node.limits?.maxVisits ?? ''} placeholder="default" onChange={(event) => updateRetryLimit(id, 'maxVisits', event.target.value)} /></label>
                    <label className="graph-field">edges<input aria-label={`${id} max edge traversals`} value={node.limits?.maxEdgeTraversals ?? ''} placeholder="default" onChange={(event) => updateRetryLimit(id, 'maxEdgeTraversals', event.target.value)} /></label>
                    <label className="graph-field">bytes<input aria-label={`${id} max output bytes`} value={node.limits?.maxOutputBytes ?? ''} placeholder="default" onChange={(event) => updateRetryLimit(id, 'maxOutputBytes', event.target.value)} /></label>
                  </div>
                </article>
              );
            })}
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4" aria-label="Graph edge list">
            {activeGraphEdges.length === 0 ? <p className="text-sm text-slate-400">No edges yet. Add next or branch links on a node card.</p> : activeGraphEdges.map((edge, index) => (
              <div key={`${edge.from}-${edge.when}-${edge.to}-list-${index}`} className="graph-edge-pill"><span>{edge.from}</span><b>{edge.when}</b><span>{edge.to}</span></div>
            ))}
          </div>
        </section>
        )}
      </section>
    </main>
  );
}
