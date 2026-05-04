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

interface MateriaConfig {
  activeLoadout?: string;
  loadouts?: Record<string, PipelineConfig>;
  pipeline?: PipelineConfig;
  [key: string]: unknown;
}

interface ConfigResponse {
  ok?: boolean;
  config?: MateriaConfig;
  source?: string;
}

interface DragPayload {
  kind: 'palette' | 'socket';
  materiaId: string;
  fromLoadout?: string;
  fromSocket?: string;
}

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

function Orb({ color, label, small = false, empty = false }: { color: string; label: string; small?: boolean; empty?: boolean }) {
  return <div aria-hidden className={`${small ? 'materia-orb-small' : 'materia-orb'} ${empty ? 'materia-orb-empty' : `bg-gradient-to-br ${color}`}`} title={label} />;
}

export function App() {
  const [baselineConfig, setBaselineConfig] = useState<MateriaConfig | undefined>();
  const [draftConfig, setDraftConfig] = useState<MateriaConfig | undefined>();
  const [source, setSource] = useState<string>('loading');
  const [status, setStatus] = useState('Loading materia configuration…');
  const [selectedMateriaId, setSelectedMateriaId] = useState<string | undefined>();
  const [saveTarget, setSaveTarget] = useState<SaveTarget>('user');
  const [dragOverTrash, setDragOverTrash] = useState(false);
  const [newGraphNodeId, setNewGraphNodeId] = useState('Review');
  const [insertFrom, setInsertFrom] = useState('');
  const [insertTo, setInsertTo] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/config')
      .then((response) => response.json() as Promise<ConfigResponse>)
      .then((body) => {
        if (cancelled) return;
        const config = body.config ?? (body as MateriaConfig);
        setBaselineConfig(cloneConfig(config));
        setDraftConfig(cloneConfig(config));
        setSource(body.source ?? 'unknown');
        setStatus('Draft ready. Changes are staged until you save.');
      })
      .catch((error) => {
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

  const loadouts = useMemo(() => buildLoadouts(draftConfig ?? {}), [draftConfig]);
  const activeLoadoutName = draftConfig?.activeLoadout && loadouts[draftConfig.activeLoadout] ? draftConfig.activeLoadout : Object.keys(loadouts)[0];
  const activeLoadout = activeLoadoutName ? loadouts[activeLoadoutName] : undefined;
  const activeNodes = activeLoadout?.nodes ?? {};
  const activeNodeIds = Object.keys(activeNodes);
  const activeGraphEdges = useMemo(() => graphEdges(activeNodes), [activeNodes]);
  const palette = useMemo(() => {
    const allNodes = Object.values(loadouts).flatMap((loadout) => Object.entries(loadout.nodes ?? {}));
    const byId = new Map<string, PipelineNode>();
    for (const [id, node] of allNodes) {
      if (!node.empty) byId.set(id, node);
    }
    return [...byId.entries()];
  }, [loadouts]);
  const isDirty = JSON.stringify(baselineConfig) !== JSON.stringify(draftConfig);

  function updateDraft(updater: (config: MateriaConfig) => void) {
    setDraftConfig((current) => {
      const next = cloneConfig(current ?? {});
      if (!next.loadouts) next.loadouts = buildLoadouts(next);
      updater(next);
      return next;
    });
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
                  className={`materia-socket ${selectedMateriaId ? 'materia-socket-selectable' : ''}`}
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
                <article key={id} data-testid={`graph-node-${id}`} className="graph-node-card" style={{ left: point.x, top: point.y }}>
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
      </section>
    </main>
  );
}
