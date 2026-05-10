import { materializeLoadoutLoopSemantics } from '../../../loopSemantics.js';
import { assertCanonicalSocketId, parseCanonicalSocketId } from '../../../socketIds.js';
import type { MateriaEdgeCondition, MateriaPipelineConfig, PiMateriaConfig } from '../../../types.js';

type NodeType = 'agent' | 'utility';
export type SocketKind = 'entry' | 'normal';

export interface PipelineNode {
  type?: NodeType;
  socketKind?: SocketKind;
  materia?: string;
  utility?: string;
  command?: string[];
  label?: string;
  parse?: 'text' | 'json';
  assign?: Record<string, string>;
  edges?: { to: string; when: MateriaEdgeCondition; maxTraversals?: number }[];
  foreach?: { items: string; as?: string; cursor?: string; done?: string };
  advance?: { items?: string; cursor?: string; done?: string; when?: MateriaEdgeCondition };
  empty?: boolean;
  layout?: { x?: number; y?: number };
  limits?: { maxVisits?: number; maxEdgeTraversals?: number; maxOutputBytes?: number };
  [key: string]: unknown;
}

export interface PipelineLoopExitRoute {
  id: string;
  from: string;
  condition: MateriaEdgeCondition;
  targetSocketId: string;
}

export interface PipelineLoop {
  label?: string;
  nodes: string[];
  consumes?: { from: string; output?: string; as?: string; cursor?: string; done?: string };
  iterator?: { items: string; as?: string; cursor?: string; done?: string };
  exit?: { from: string; when: MateriaEdgeCondition; to: string };
  exits?: PipelineLoopExitRoute[];
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
  normalizeCanonicalParseSemantics(normalized);
  for (const loadout of Object.values(normalized.loadouts ?? {})) {
    normalizeLoadoutSocketKinds(loadout);
    for (const node of Object.values(loadout.nodes ?? {}) as LegacyPipelineNode[]) {
      normalizeCanonicalParseSemantics(node);
      const edges = (node.edges ?? []).map((edge) => ({ ...edge, when: normalizeEdgeConditionForClient(edge.when) }));
      if (typeof node.next === 'string' && node.next) edges.push({ when: 'always', to: node.next });
      if (edges.length > 0) node.edges = edges;
      else delete node.edges;
      delete node.next;
    }
    reconcileLoopConsumersFromTopology(loadout, normalized.materia ?? {});
    normalizeGeneratorPipelineSockets(loadout, normalized.materia ?? {});
    materializeLoadoutLoopSemantics(normalized as PiMateriaConfig, loadout as MateriaPipelineConfig);
  }
  return normalized;
}

function normalizeCanonicalParseSemantics(container: { parse?: unknown; outputFormat?: unknown; materia?: unknown }): void {
  if (container.parse === undefined && (container.outputFormat === 'json' || container.outputFormat === 'text')) container.parse = container.outputFormat;
  delete container.outputFormat;
  const definitions = container.materia && typeof container.materia === 'object' && !Array.isArray(container.materia) ? container.materia as Record<string, MateriaBehaviorConfig> : {};
  for (const definition of Object.values(definitions)) normalizeCanonicalParseSemantics(definition);
}

function reconcileLoopConsumersFromTopology(loadout: PipelineConfig, definitions: Record<string, MateriaBehaviorConfig>): void {
  const nodes = loadout.nodes ?? {};
  for (const loop of Object.values(loadout.loops ?? {})) {
    if (!loop.consumes) continue;
    const loopNodes = new Set(loop.nodes);
    const inboundGeneratorSources = Object.entries(nodes).flatMap(([from, node]) => {
      if (loopNodes.has(from) || !isGeneratorSocket(node, definitions)) return [];
      return (node.edges ?? []).some((edge) => loopNodes.has(edge.to)) ? [from] : [];
    });
    const uniqueSources = Array.from(new Set(inboundGeneratorSources));
    if (uniqueSources.length === 1 && loop.consumes.from !== uniqueSources[0]) loop.consumes = { ...loop.consumes, from: uniqueSources[0] };
  }
}

function normalizeGeneratorPipelineSockets(loadout: PipelineConfig, definitions: Record<string, MateriaBehaviorConfig>): void {
  for (const id of generatorPipelineSocketIds(loadout, definitions)) {
    const node = loadout.nodes?.[id];
    if (node?.type !== 'agent' || typeof node.materia !== 'string') continue;
    if (!canonicalMateriaGeneratorOutput(definitions[node.materia])) continue;
    node.parse = 'json';
    node.assign = { ...(node.assign as Record<string, string> | undefined ?? {}), workItems: '$.workItems' };
  }
}

function generatorPipelineSocketIds(loadout: PipelineConfig, definitions: Record<string, MateriaBehaviorConfig>): Set<string> {
  const ids = new Set(Object.values(loadout.loops ?? {}).map((loop) => loop.consumes?.from).filter((id): id is string => typeof id === 'string'));
  for (const [from, node] of Object.entries(loadout.nodes ?? {})) {
    if (!isGeneratorSocket(node, definitions)) continue;
    for (const edge of node.edges ?? []) {
      if (!isGeneratorSocket(loadout.nodes?.[edge.to], definitions)) continue;
      ids.add(from);
      ids.add(edge.to);
    }
  }
  return ids;
}

function isGeneratorSocket(node: PipelineNode | undefined, definitions: Record<string, MateriaBehaviorConfig>): boolean {
  return node?.type === 'agent' && typeof node.materia === 'string' && Boolean(canonicalMateriaGeneratorOutput(definitions[node.materia]));
}

function canonicalMateriaGeneratorOutput(definition?: MateriaBehaviorConfig): string | undefined {
  return definition?.generator === true ? 'workItems' : undefined;
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
  generator?: boolean;
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

export interface MateriaColorChoice {
  id: string;
  label: string;
  value: string;
}

export const materiaColorChoices: MateriaColorChoice[] = [
  { id: 'green', label: 'Green', value: 'materia-color-green' },
  { id: 'red', label: 'Red', value: 'materia-color-red' },
  { id: 'yellow', label: 'Yellow', value: 'materia-color-yellow' },
  { id: 'purple', label: 'Purple', value: 'materia-color-purple' },
  { id: 'blue', label: 'Blue', value: 'materia-color-blue' },
  { id: 'cyan', label: 'Cyan', value: 'materia-color-cyan' },
  { id: 'white', label: 'White', value: 'materia-color-white' },
  { id: 'black-gray', label: 'Black / Gray', value: 'materia-color-black-gray' },
];

export const paletteColors = materiaColorChoices.map((choice) => choice.value);

const materiaBehaviorKeys = new Set([
  'type',
  'materia',
  'utility',
  'command',
  'params',
  'timeoutMs',
  'assign',
  'foreach',
  'generator',
  'generates',
  'model',
  'modelSettings',
  'outputFormat',
  'multiturn',
  'parse',
]);

const cloneValue = <T,>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;

export function isSocketKind(value: unknown): value is SocketKind {
  return value === 'entry' || value === 'normal';
}

export function isEntrySocket(node?: PipelineNode): boolean {
  return node?.socketKind === 'entry';
}

export function canDeleteSocket(node?: PipelineNode): boolean {
  return node?.socketKind === 'normal';
}

function deleteOptionalTarget(container: { done?: string } | undefined, deletedSocketId: string): void {
  if (container?.done === deletedSocketId) delete container.done;
}

function removeLoopOwnedRuntimeControls(loadout: PipelineConfig, loop: PipelineLoop): void {
  const exitSource = loop.exit?.from;
  const sourceNode = exitSource ? loadout.nodes?.[exitSource] : undefined;
  if (!sourceNode) return;

  const loopExitTargets = new Set((loop.exits ?? []).map((route) => route.targetSocketId));
  const advanceDoneTarget = loop.exit?.to;
  if (advanceDoneTarget && advanceDoneTarget !== 'end') loopExitTargets.add(advanceDoneTarget);

  if (sourceNode.advance && sourceNode.advance.done === advanceDoneTarget) delete sourceNode.advance;
  if (sourceNode.edges && loopExitTargets.size > 0) {
    sourceNode.edges = sourceNode.edges.filter((edge) => !loopExitTargets.has(edge.to));
    if (sourceNode.edges.length === 0) delete sourceNode.edges;
  }
}

export function deleteSocketFromLoadout(loadout: PipelineConfig, socketId: string): boolean {
  const node = loadout.nodes?.[socketId];
  if (!loadout.nodes || !canDeleteSocket(node)) return false;

  delete loadout.nodes[socketId];
  for (const current of Object.values(loadout.nodes) as LegacyPipelineNode[]) {
    if (current.edges) {
      current.edges = current.edges.filter((edge) => edge.to !== socketId);
      if (current.edges.length === 0) delete current.edges;
    }
    if (current.next === socketId) delete current.next;
    deleteOptionalTarget(current.foreach, socketId);
    deleteOptionalTarget(current.advance as { done?: string } | undefined, socketId);
  }

  for (const [loopId, loop] of Object.entries(loadout.loops ?? {})) {
    if (loop.nodes.includes(socketId) || loop.consumes?.from === socketId || loop.exit?.from === socketId || loop.exits?.some((route) => route.from === socketId)) {
      removeLoopOwnedRuntimeControls(loadout, loop);
      delete loadout.loops?.[loopId];
      continue;
    }
    deleteOptionalTarget(loop.consumes, socketId);
    deleteOptionalTarget(loop.iterator, socketId);
    if (loop.exit?.to === socketId) loop.exit.to = 'end';
    if (loop.exits) {
      loop.exits = loop.exits.filter((route) => route.targetSocketId !== socketId);
      if (loop.exits.length === 0) delete loop.exits;
    }
  }
  if (loadout.loops && Object.keys(loadout.loops).length === 0) delete loadout.loops;
  return true;
}

export function normalizeLoadoutSocketKinds(loadout: PipelineConfig): PipelineConfig {
  const nodes = loadout.nodes ?? {};
  const entryId = loadout.entry && nodes[loadout.entry] ? loadout.entry : Object.keys(nodes)[0];
  if (entryId && !loadout.entry) loadout.entry = entryId;
  for (const [id, node] of Object.entries(nodes)) {
    node.socketKind = id === entryId ? 'entry' : 'normal';
  }
  return loadout;
}

export function isEmptySocket(node?: PipelineNode): boolean {
  return !node || node.empty === true || Object.keys(extractMateriaBehavior(node)).length === 0;
}

export function makeEmptySocket(structure: PipelineNode = {}): PipelineNode {
  return { socketKind: 'normal', ...extractSocketStructure(structure), empty: true };
}

export function makeEmptyEntryLoadout(entry = 'Socket-1'): PipelineConfig {
  assertCanonicalSocketId(entry, 'new loadout entry');
  return { entry, nodes: { [entry]: makeEmptySocket({ socketKind: 'entry' }) } };
}

export function makeNewSocketId(nodes: Record<string, PipelineNode>): string {
  const usedNumbers = new Set<number>();
  for (const id of Object.keys(nodes)) {
    const parsed = parseCanonicalSocketId(id);
    if (parsed) usedNumbers.add(parsed.ordinal);
  }
  let index = 1;
  while (usedNumbers.has(index) || nodes[`Socket-${index}`]) index += 1;
  return `Socket-${index}`;
}

export interface LoopExitConnectionContext {
  loopId: string;
  loop: PipelineLoop;
}

export function findLoopExitConnectionContext(loadout: PipelineConfig | undefined, socketId: string): LoopExitConnectionContext | undefined {
  const matches = Object.entries(loadout?.loops ?? {}).filter(([, loop]) => loop.exit?.from === socketId);
  if (matches.length !== 1) return undefined;
  const [loopId, loop] = matches[0];
  return { loopId, loop };
}

export function loopExitRouteId(from: string, condition: MateriaEdgeCondition): string {
  return `exit:${from}:${condition}`;
}

export function upsertLoopExitRoute(loadout: PipelineConfig, loopId: string, from: string, condition: MateriaEdgeCondition, targetSocketId: string): PipelineLoopExitRoute | undefined {
  const loop = loadout.loops?.[loopId];
  if (!loop || loop.exit?.from !== from || !loadout.nodes?.[targetSocketId]) return undefined;
  const route = { id: loopExitRouteId(from, condition), from, condition, targetSocketId };
  const routes = (loop.exits ?? []).filter((candidate) => !(candidate.from === from && candidate.condition === condition));
  loop.exits = [...routes, route];
  return route;
}

export function removeLoopExitRoute(loadout: PipelineConfig, loopId: string, routeId: string): boolean {
  const loop = loadout.loops?.[loopId];
  if (!loop?.exits) return false;
  const next = loop.exits.filter((route) => route.id !== routeId);
  if (next.length === loop.exits.length) return false;
  if (next.length > 0) loop.exits = next;
  else delete loop.exits;
  return true;
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
  return {
    ...createMateriaReference(id),
    parse: definition?.parse,
    assign: cloneValue(definition?.assign),
    foreach: cloneValue(definition?.foreach),
  };
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
    if (key === 'socketKind') {
      if (isSocketKind(value)) structure.socketKind = value;
      continue;
    }
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

export function formatSocketLabel(id: string, node?: PipelineNode): string {
  return `${id} (${getNodeLabel(id, node)})`;
}

const jsonControlConditions = new Set<MateriaEdgeCondition>(['satisfied', 'not_satisfied']);

function isJsonControlCondition(when: unknown): when is MateriaEdgeCondition {
  return when === 'satisfied' || when === 'not_satisfied';
}

function controlParseError(loadoutName: string, socketId: string, node: PipelineNode, source: string, condition: MateriaEdgeCondition): string {
  const label = formatSocketLabel(socketId, node);
  const parseMode = node.parse ?? 'text';
  return `Loadout "${loadoutName}" socket ${label} uses ${condition} control routing at ${source}, but its output format is ${JSON.stringify(parseMode)}. Set the socket Output format to JSON (parse: "json") or change the route to always; satisfied/not_satisfied routing requires JSON output parsing.`;
}

export function validateLoadoutSaveSemantics(config: MateriaConfig): string[] {
  const errors: string[] = [];
  for (const [loadoutName, loadout] of Object.entries(config.loadouts ?? {})) {
    for (const [socketId, node] of Object.entries(loadout.nodes ?? {})) {
      for (const [index, edge] of (node.edges ?? []).entries()) {
        if (!jsonControlConditions.has(edge.when)) continue;
        if (node.parse !== 'json') errors.push(controlParseError(loadoutName, socketId, node, `${socketId}.edges[${index}]`, edge.when));
      }
      const advanceWhen = node.advance?.when;
      if (isJsonControlCondition(advanceWhen) && node.parse !== 'json') {
        errors.push(controlParseError(loadoutName, socketId, node, `${socketId}.advance.when`, advanceWhen));
      }
    }
    for (const [loopId, loop] of Object.entries(loadout.loops ?? {})) {
      for (const [index, route] of (loop.exits ?? []).entries()) {
        const source = loadout.nodes?.[route.from];
        if (source && isJsonControlCondition(route.condition) && source.parse !== 'json') {
          errors.push(controlParseError(loadoutName, route.from, source, `loops.${loopId}.exits[${index}].condition`, route.condition));
        }
      }
    }
  }
  return errors;
}

export function assertValidLoadoutSaveSemantics(config: MateriaConfig): void {
  const errors = validateLoadoutSaveSemantics(config);
  if (errors.length > 0) throw new Error(errors.join('\n'));
}

export function resolveSocketDisplayLabel(loadout: PipelineConfig | undefined, socketId: string): string {
  if (loadout?.nodes && !loadout.nodes[socketId]) return socketId;
  return getNodeLabel(socketId, loadout?.nodes?.[socketId]);
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
