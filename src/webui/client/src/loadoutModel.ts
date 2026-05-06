type NodeType = 'agent' | 'utility';

export interface PipelineNode {
  type?: NodeType;
  materia?: string;
  utility?: string;
  command?: string[];
  next?: string;
  edges?: { to: string; when?: string; maxTraversals?: number }[];
  empty?: boolean;
  layout?: { x?: number; y?: number };
  limits?: { maxVisits?: number; maxEdgeTraversals?: number; maxOutputBytes?: number };
  [key: string]: unknown;
}

export interface PipelineConfig {
  entry?: string;
  nodes?: Record<string, PipelineNode>;
  [key: string]: unknown;
}

export interface MateriaBehaviorConfig {
  tools?: 'none' | 'readOnly' | 'coding';
  prompt?: string;
  model?: string;
  thinking?: string;
  multiTurn?: boolean;
  color?: string;
  [key: string]: unknown;
}

export interface MateriaConfig {
  activeLoadout?: string;
  loadouts?: Record<string, PipelineConfig>;
  materia?: Record<string, MateriaBehaviorConfig>;
  [key: string]: unknown;
}

export interface MateriaReference {
  type: 'agent';
  materia: string;
}

export const emptySocketLabel = 'Empty socket';

export const paletteColors = [
  'from-sky-200 via-cyan-300 to-blue-600',
  'from-emerald-200 via-lime-300 to-green-700',
  'from-amber-100 via-yellow-300 to-orange-600',
  'from-fuchsia-200 via-pink-300 to-purple-700',
  'from-rose-200 via-red-300 to-red-700',
  'from-violet-200 via-indigo-300 to-slate-700',
];

const materiaBehaviorKeys = new Set([
  'type',
  'materia',
  'utility',
  'command',
  'params',
  'timeoutMs',
  'model',
  'modelSettings',
  'outputFormat',
  'multiturn',
  'parse',
]);

const cloneValue = <T,>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;

export function isEmptySocket(node?: PipelineNode): boolean {
  return !node || node.empty === true || Object.keys(extractMateriaBehavior(node)).length === 0;
}

export function makeEmptySocket(structure: PipelineNode = {}): PipelineNode {
  return { ...extractSocketStructure(structure), empty: true };
}

export function makeEmptyEntryLoadout(entry = 'Entry'): PipelineConfig {
  return { entry, nodes: { [entry]: makeEmptySocket() } };
}

export function createMateriaReference(materiaId: string): MateriaReference {
  return { type: 'agent', materia: materiaId };
}

export function materiaPaletteNode(id: string): PipelineNode {
  return { ...createMateriaReference(id) };
}

export function extractMateriaReference(node?: PipelineNode): MateriaReference | undefined {
  if (!node || node.empty || node.type !== 'agent' || typeof node.materia !== 'string' || !node.materia) return undefined;
  return createMateriaReference(node.materia);
}

export function extractMateriaBehavior(node?: PipelineNode): PipelineNode {
  if (!node || node.empty) return {};
  const behavior: PipelineNode = {};
  for (const [key, value] of Object.entries(node)) {
    if (materiaBehaviorKeys.has(key)) behavior[key] = cloneValue(value);
  }
  return behavior;
}

export function extractSocketStructure(node?: PipelineNode): PipelineNode {
  const structure: PipelineNode = {};
  for (const [key, value] of Object.entries(node ?? {})) {
    if (!materiaBehaviorKeys.has(key) && key !== 'empty') structure[key] = cloneValue(value);
  }
  return structure;
}

export function placeMateriaInSocket(socket?: PipelineNode, materia?: PipelineNode): PipelineNode {
  const behavior = extractMateriaBehavior(materia);
  if (Object.keys(behavior).length === 0) return makeEmptySocket(socket);
  return { ...extractSocketStructure(socket), ...behavior, empty: false };
}

export function clearSocketMateria(socket?: PipelineNode): PipelineNode {
  return makeEmptySocket(socket);
}

export function getNodeLabel(id: string, node?: PipelineNode): string {
  if (isEmptySocket(node)) return emptySocketLabel;
  if (node?.type === 'agent') return node.materia ?? id;
  if (node?.type === 'utility') return node.utility ?? node.command?.join(' ') ?? id;
  return node?.materia ?? node?.utility ?? id;
}

export function nodeColor(id: string, index: number, definitions?: Record<string, MateriaBehaviorConfig>, node?: PipelineNode): string {
  const reference = extractMateriaReference(node)?.materia ?? id;
  const configured = definitions?.[reference]?.color;
  if (configured) return configured;
  const lowered = reference.toLowerCase();
  if (lowered.includes('plan')) return paletteColors[0];
  if (lowered.includes('build')) return paletteColors[1];
  if (lowered.includes('check') || lowered.includes('eval')) return paletteColors[2];
  if (lowered.includes('maintain')) return paletteColors[3];
  return paletteColors[index % paletteColors.length];
}
