import type { MateriaEdgeCondition } from '../../../types.js';

type NodeType = 'agent' | 'utility';

export interface PipelineNode {
  type?: NodeType;
  materia?: string;
  utility?: string;
  command?: string[];
  label?: string;
  edges?: { to: string; when: MateriaEdgeCondition; maxTraversals?: number }[];
  foreach?: { items: string; as?: string; cursor?: string; done?: string };
  empty?: boolean;
  layout?: { x?: number; y?: number };
  limits?: { maxVisits?: number; maxEdgeTraversals?: number; maxOutputBytes?: number };
  [key: string]: unknown;
}

export interface PipelineLoop {
  label?: string;
  nodes: string[];
  consumes?: { from: string; output?: string; as?: string; cursor?: string; done?: string };
  iterator?: { items: string; as?: string; cursor?: string; done?: string };
  exit?: { from: string; when: MateriaEdgeCondition; to: string };
  [key: string]: unknown;
}

export interface PipelineConfig {
  entry?: string;
  nodes?: Record<string, PipelineNode>;
  loops?: Record<string, PipelineLoop>;
  [key: string]: unknown;
}

export type LegacyPipelineNode = PipelineNode & { next?: string };

function normalizeEdgeConditionForClient(when: unknown): MateriaEdgeCondition {
  if (when === undefined || when === '' || when === 'flow' || when === 'Flow') return 'always';
  if (when === 'always' || when === 'satisfied' || when === 'not_satisfied') return when;
  return when as MateriaEdgeCondition;
}

export function normalizeMateriaConfigEdges(config: MateriaConfig): MateriaConfig {
  const normalized = cloneValue(config);
  for (const loadout of Object.values(normalized.loadouts ?? {})) {
    for (const node of Object.values(loadout.nodes ?? {}) as LegacyPipelineNode[]) {
      const edges = (node.edges ?? []).map((edge) => ({ ...edge, when: normalizeEdgeConditionForClient(edge.when) }));
      if (typeof node.next === 'string' && node.next) edges.push({ when: 'always', to: node.next });
      if (edges.length > 0) node.edges = edges;
      else delete node.edges;
      delete node.next;
    }
  }
  return normalized;
}

export interface MateriaBehaviorConfig {
  type?: NodeType;
  tools?: 'none' | 'readOnly' | 'coding';
  prompt?: string;
  model?: string;
  thinking?: string;
  multiTurn?: boolean;
  color?: string;
  label?: string;
  description?: string;
  group?: string;
  utility?: string;
  command?: string[];
  params?: Record<string, unknown>;
  timeoutMs?: number;
  parse?: 'text' | 'json';
  assign?: Record<string, string>;
  foreach?: { items: string; as?: string; cursor?: string; done?: string };
  generates?: { output: string; items?: string; listType: 'array'; itemType: string; as?: string; cursor?: string; done?: string };
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

export const emptySocketLabel = 'Empty';

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
  'assign',
  'foreach',
  'generates',
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

export function makeEmptyEntryLoadout(entry = 'Socket-1'): PipelineConfig {
  return { entry, nodes: { [entry]: makeEmptySocket() } };
}

export function makeNewSocketId(nodes: Record<string, PipelineNode>): string {
  const usedNumbers = new Set<number>();
  for (const id of Object.keys(nodes)) {
    const match = /^Socket-([1-9]\d*)$/.exec(id);
    if (match) usedNumbers.add(Number(match[1]));
  }
  let index = 1;
  while (usedNumbers.has(index) || nodes[`Socket-${index}`]) index += 1;
  return `Socket-${index}`;
}

export function createMateriaReference(materiaId: string): MateriaReference {
  return { type: 'agent', materia: materiaId };
}

export function materiaPaletteNode(id: string, definition?: MateriaBehaviorConfig): PipelineNode {
  if (definition?.type === 'utility') {
    return {
      type: 'utility',
      utility: definition.utility,
      command: cloneValue(definition.command),
      params: cloneValue(definition.params),
      timeoutMs: definition.timeoutMs,
      parse: definition.parse,
      assign: cloneValue(definition.assign),
      foreach: cloneValue(definition.foreach),
      label: definition.label,
    };
  }
  return { ...createMateriaReference(id), foreach: cloneValue(definition?.foreach) };
}

export function buildMateriaPalette(definitions: Record<string, MateriaBehaviorConfig> = {}): Array<[string, PipelineNode]> {
  return Object.keys(definitions).map((id) => [id, materiaPaletteNode(id, definitions[id])]);
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
    if (!materiaBehaviorKeys.has(key) && key !== 'empty' && key !== 'next') structure[key] = cloneValue(value);
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
  if (node?.type === 'utility') return node.label ?? node.utility ?? node.command?.join(' ') ?? id;
  return node?.materia ?? node?.utility ?? id;
}

function fallbackColorIndex(materiaId: string): number {
  let hash = 0;
  for (const char of materiaId) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % paletteColors.length;
}

export function resolveMateriaColor(materiaId: string, definitions?: Record<string, MateriaBehaviorConfig>): string {
  const configured = definitions?.[materiaId]?.color;
  if (configured) return configured;
  return paletteColors[fallbackColorIndex(materiaId)];
}

export function nodeColor(id: string, _index: number, definitions?: Record<string, MateriaBehaviorConfig>, node?: PipelineNode): string {
  return resolveMateriaColor(extractMateriaReference(node)?.materia ?? id, definitions);
}
