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
  edges?: { to: string; when?: string }[];
  prompt?: string;
  empty?: boolean;
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
      </section>
    </main>
  );
}
