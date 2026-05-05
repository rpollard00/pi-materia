import { useEffect, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import { edgeConditionState, formatGraphValidationErrors, stageValidatedPipelineGraphChange } from '../../../graphValidation.js';

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

interface LoadoutEdge {
  id: string;
  from: string;
  to: string;
  when?: string;
  kind: 'next' | 'edge';
  edgeIndex?: number;
}

interface PositionedSocket {
  id: string;
  node: PipelineNode;
  index: number;
  x: number;
  y: number;
}

type MateriaTabId = 'loadout' | 'materia-editor' | 'monitor';

const materiaTabs: Array<{ id: MateriaTabId; label: string; description: string }> = [
  { id: 'loadout', label: 'Loadout', description: 'Loadout selector, visual grid, palette, and apply controls' },
  { id: 'materia-editor', label: 'Materia Editor', description: 'Create and edit materia definitions' },
  { id: 'monitor', label: 'Monitoring', description: 'Live cast telemetry and artifacts' },
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

function edgeConditionLabel(when?: string) {
  if (!when) return 'flow';
  return when.replace(/_/g, ' ');
}

function edgeConditionClass(when?: string) {
  const state = edgeConditionState({ when });
  if (state === 'unsatisfied') return 'unsatisfied';
  if (state === 'satisfied' && when) return 'satisfied';
  return 'default';
}

function toggledEdgeCondition(when?: string) {
  return edgeConditionState({ when }) === 'unsatisfied' ? 'satisfied' : 'not_satisfied';
}

function getLoadoutEdges(nodes: Record<string, PipelineNode>): LoadoutEdge[] {
  const edges: LoadoutEdge[] = [];
  for (const [from, node] of Object.entries(nodes)) {
    if (typeof node.next === 'string' && nodes[node.next]) {
      edges.push({ id: `${from}:next:${node.next}`, from, to: node.next, kind: 'next' });
    }
    for (const [index, edge] of (node.edges ?? []).entries()) {
      if (nodes[edge.to]) edges.push({ id: `${from}:edge:${index}:${edge.to}:${edge.when ?? 'flow'}`, from, to: edge.to, when: edge.when, kind: 'edge', edgeIndex: index });
    }
  }
  return edges;
}

function layoutUnit(value: number, unit: number) {
  return Math.abs(value) <= 20 ? value * unit : value;
}

function layoutSockets(loadout?: PipelineConfig): { sockets: PositionedSocket[]; edges: LoadoutEdge[]; width: number; height: number } {
  const nodes = loadout?.nodes ?? {};
  const entries = Object.entries(nodes);
  const edges = getLoadoutEdges(nodes);
  const entryId = loadout?.entry && nodes[loadout.entry] ? loadout.entry : entries[0]?.[0];
  const depth = new Map<string, number>();
  if (entryId) depth.set(entryId, 0);
  const queue = entryId ? [entryId] : [];
  while (queue.length > 0) {
    const from = queue.shift() as string;
    const nextDepth = (depth.get(from) ?? 0) + 1;
    for (const edge of edges.filter((candidate) => candidate.from === from)) {
      if (!depth.has(edge.to) || nextDepth < (depth.get(edge.to) ?? Infinity)) {
        depth.set(edge.to, nextDepth);
        queue.push(edge.to);
      }
    }
  }

  const rowsByDepth = new Map<number, number>();
  const sockets = entries.map(([id, node], index) => {
    const automaticDepth = depth.get(id) ?? Math.max(0, ...depth.values(), 0) + 1;
    const row = rowsByDepth.get(automaticDepth) ?? 0;
    rowsByDepth.set(automaticDepth, row + 1);
    const explicitX = typeof node.layout?.x === 'number' ? layoutUnit(node.layout.x, 260) : undefined;
    const explicitY = typeof node.layout?.y === 'number' ? layoutUnit(node.layout.y, 210) : undefined;
    return {
      id,
      node,
      index,
      x: 32 + (explicitX ?? automaticDepth * 260),
      y: 28 + (explicitY ?? row * 220),
    };
  });
  const width = Math.max(560, ...sockets.map((socket) => socket.x + 230));
  const height = Math.max(320, ...sockets.map((socket) => socket.y + 190));
  return { sockets, edges, width, height };
}

function makeNewLoadoutName(loadouts: Record<string, PipelineConfig>) {
  let index = Object.keys(loadouts).length + 1;
  let name = `New Loadout ${index}`;
  while (loadouts[name]) name = `New Loadout ${++index}`;
  return name;
}

function makeEmptyEntryLoadout(): PipelineConfig {
  const entry = 'Entry';
  return { entry, nodes: { [entry]: { empty: true } } };
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

function parseDragPayload(raw: string): DragPayload | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<DragPayload> | null;
    if (!parsed || (parsed.kind !== 'palette' && parsed.kind !== 'socket') || typeof parsed.materiaId !== 'string' || !parsed.materiaId) return undefined;
    if (parsed.kind === 'socket' && parsed.fromSocket !== undefined && typeof parsed.fromSocket !== 'string') return undefined;
    return parsed as DragPayload;
  } catch {
    return undefined;
  }
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

function rolePaletteNode(id: string, role: MateriaRoleConfig): PipelineNode {
  return {
    type: 'agent',
    role: id,
    prompt: role.systemPrompt,
    model: role.model,
    thinking: role.thinking,
    multiturn: role.multiTurn,
  };
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
  const [monitor, setMonitor] = useState<MonitorSnapshot>();
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
  const loadoutGraph = useMemo(() => layoutSockets(activeLoadout), [activeLoadout]);
  const socketPositions = useMemo(() => new Map(loadoutGraph.sockets.map((socket) => [socket.id, socket])), [loadoutGraph.sockets]);
  const roles = draftConfig?.roles ?? {};
  const materiaDefinitions = draftConfig?.materiaDefinitions ?? {};
  const editableDefinitionIds = useMemo(() => {
    const ids = new Set<string>([...Object.keys(roles), ...Object.keys(materiaDefinitions)]);
    return [...ids].sort((a, b) => a.localeCompare(b));
  }, [roles, materiaDefinitions]);
  const palette = useMemo(() => {
    const byId = new Map<string, PipelineNode>();
    for (const [id, node] of Object.entries(materiaDefinitions)) {
      if (!node.empty) byId.set(id, cloneConfig(node));
    }
    for (const [id, role] of Object.entries(roles)) {
      if (!byId.has(id)) byId.set(id, rolePaletteNode(id, role));
    }
    const allNodes = Object.values(loadouts).flatMap((loadout) => Object.entries(loadout.nodes ?? {}));
    for (const [id, node] of allNodes) {
      if (!node.empty && !byId.has(id)) byId.set(id, node);
    }
    return [...byId.entries()];
  }, [loadouts, materiaDefinitions, roles]);
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
      draftLoadouts[name] = makeEmptyEntryLoadout();
      config.loadouts = draftLoadouts;
      config.activeLoadout = name;
    });
    setStatus('Created a new draft loadout with one empty entry socket. Rename and save when ready.');
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
      if (!currentSource || currentSource.empty) {
        setStatus('Ignored drop: dragged socket materia is no longer available.');
        return false;
      }
    } else {
      const currentSource = palette.find(([id]) => id === materiaId)?.[1] ?? currentLoadout.nodes[materiaId];
      if (!currentSource || currentSource.empty) {
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
        if (!source || source.empty || !target) return;
        loadout.nodes[socketId] = placeMateriaInSocket(target, source);
        loadout.nodes[fromSocket] = placeMateriaInSocket(source, target);
      } else {
        const sourceNode = palette.find(([id]) => id === materiaId)?.[1] ?? loadout.nodes[materiaId];
        const target = loadout.nodes[socketId];
        if (sourceNode && !sourceNode.empty && target) loadout.nodes[socketId] = placeMateriaInSocket(target, sourceNode);
      }
    });
    setSelectedMateriaId(undefined);
    setStatus(`Staged ${materiaId} in socket ${socketId}; socket graph links and layout were preserved.`);
    return true;
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

  function toggleEdgeCondition(edge: LoadoutEdge) {
    if (!activeLoadoutName || edge.kind !== 'edge' || edge.edgeIndex === undefined || !activeLoadout) return;
    const edgeIndex = edge.edgeIndex;
    const result = stageValidatedPipelineGraphChange(activeLoadout as import('../../../types.js').MateriaPipelineConfig, (loadout) => {
      const candidate = loadout.nodes?.[edge.from]?.edges?.[edgeIndex];
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
    setStatus(`Staged edge ${edge.from} → ${edge.to} as ${edgeConditionLabel(result.graph.nodes?.[edge.from]?.edges?.[edge.edgeIndex]?.when)}.`);
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
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  function handleDrop(socketId: string, event: DragEvent) {
    event.preventDefault();
    const raw = event.dataTransfer.getData('application/json');
    if (!raw) return;
    const payload = parseDragPayload(raw);
    if (!payload) {
      setStatus('Ignored drop: unsupported drag payload.');
      return;
    }
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

            <div className="loadout-graph-canvas" data-testid="socket-grid" style={{ minWidth: `${loadoutGraph.width}px`, minHeight: `${loadoutGraph.height}px` }}>
              <svg className="loadout-edge-layer" width={loadoutGraph.width} height={loadoutGraph.height} aria-label="Loadout edges">
                <defs>
                  <marker id="materia-edge-arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth">
                    <path d="M2,2 L10,6 L2,10 Z" className="loadout-edge-arrow" />
                  </marker>
                </defs>
                {loadoutGraph.edges.map((edge) => {
                  const from = socketPositions.get(edge.from);
                  const to = socketPositions.get(edge.to);
                  if (!from || !to) return null;
                  const startX = from.x + 184;
                  const startY = from.y + 92;
                  const endX = to.x + 12;
                  const endY = to.y + 92;
                  const midX = (startX + endX) / 2;
                  const midY = (startY + endY) / 2;
                  const curve = Math.max(44, Math.abs(endX - startX) * 0.35);
                  const path = `M ${startX} ${startY} C ${startX + curve} ${startY}, ${endX - curve} ${endY}, ${endX} ${endY}`;
                  return (
                    <g
                      key={edge.id}
                      data-testid={`edge-${edge.from}-${edge.to}-${edge.edgeIndex ?? 'next'}`}
                      role={edge.kind === 'edge' ? 'button' : undefined}
                      tabIndex={edge.kind === 'edge' ? 0 : undefined}
                      className={`loadout-edge loadout-edge-${edgeConditionClass(edge.when)} ${edge.kind === 'edge' ? 'loadout-edge-clickable' : ''}`}
                      onClick={() => toggleEdgeCondition(edge)}
                      onKeyDown={(event) => {
                        if (edge.kind === 'edge' && (event.key === 'Enter' || event.key === ' ')) {
                          event.preventDefault();
                          toggleEdgeCondition(edge);
                        }
                      }}
                    >
                      <path d={path} markerEnd="url(#materia-edge-arrow)" />
                      <text x={midX} y={midY - 10}>{edgeConditionLabel(edge.when)}</text>
                    </g>
                  );
                })}
              </svg>
              {loadoutGraph.sockets.map(({ id, node, index, x, y }) => (
                <button
                  key={id}
                  data-testid={`socket-${id}`}
                  className={`materia-socket graph-materia-socket ${selectedMateriaId ? 'materia-socket-selectable' : ''} ${id === currentMonitorNode ? 'materia-socket-active' : ''}`}
                  style={{ left: `${x}px`, top: `${y}px` }}
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
                  const payload = parseDragPayload(raw);
                  if (!payload) {
                    setStatus('Ignored drop: unsupported drag payload.');
                    return;
                  }
                  if (payload.kind === 'socket' && payload.fromSocket) removeMateria(payload.fromSocket);
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
      </section>
    </main>
  );
}
