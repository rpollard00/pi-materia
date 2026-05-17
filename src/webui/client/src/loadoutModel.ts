import { analyzeLoadoutGraph, reconcileLoadoutLoopConsumersFromGraph } from '../../../graph/loadoutGraphAnalysis.js';
import { normalizeLoadedLoadout } from '../../../loadout/loadoutNormalization.js';
import { materializeLoadoutLoopSemantics } from '../../../graph/loopSemantics.js';
import { assertCanonicalSocketId, parseCanonicalSocketId } from '../../../domain/socket.js';
import { fromWebUiLoadoutDto, toWebUiConfigDto, toWebUiLoadoutDto } from '../../loadoutDto.js';
import type { ToolScopeSpec } from '../../../domain/toolScope.js';
import type { MateriaEdgeCondition, MateriaPipelineConfig, PiMateriaConfig } from '../../../types.js';

type SocketType = 'agent' | 'utility';
export type SocketKind = 'entry' | 'normal';

export interface SocketLayout {
  x?: number;
  y?: number;
}

export interface PipelineSocket {
  type?: SocketType;
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
  /** @deprecated Use loadout.layout.sockets[socketId]. */
  layout?: SocketLayout;
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
  sockets: string[];
  consumes?: { from: string; output?: string; as?: string; cursor?: string; done?: string };
  iterator?: { items: string; as?: string; cursor?: string; done?: string };
  exit?: { from: string; when: MateriaEdgeCondition; to: string };
  exits?: PipelineLoopExitRoute[];
  [key: string]: unknown;
}

export interface PipelineLayout {
  sockets?: Record<string, SocketLayout>;
  [key: string]: unknown;
}

export interface PipelineConfig {
  id?: string;
  entry?: string;
  sockets?: Record<string, PipelineSocket>;
  loops?: Record<string, PipelineLoop>;
  layout?: PipelineLayout;
  [key: string]: unknown;
}

export type LegacyPipelineSocket = PipelineSocket & { next?: string };

function normalizeEdgeConditionForClient(when: unknown): MateriaEdgeCondition {
  if (when === undefined || when === '' || when === 'flow' || when === 'Flow') return 'always';
  if (when === 'always' || when === 'satisfied' || when === 'not_satisfied') return when;
  return when as MateriaEdgeCondition;
}

export interface NormalizeMateriaConfigOptions {
  semantic?: boolean;
}

export function normalizeMateriaConfigEdges(config: MateriaConfig, options: NormalizeMateriaConfigOptions = {}): MateriaConfig {
  const normalized = toWebUiConfigDto(cloneValue(config) as PiMateriaConfig) as MateriaConfig;
  const semantic = options.semantic ?? true;
  normalizeCanonicalParseSemantics(normalized);
  for (const loadout of Object.values(normalized.loadouts ?? {})) {
    normalizeLoadoutSocketKinds(loadout);
    normalizeLoadoutLayout(loadout);
    for (const socket of Object.values(loadout.sockets ?? {}) as LegacyPipelineSocket[]) {
      normalizeCanonicalParseSemantics(socket);
      const edges = (socket.edges ?? []).map((edge) => ({ ...edge, when: normalizeEdgeConditionForClient(edge.when) }));
      if (typeof socket.next === 'string' && socket.next) edges.push({ when: 'always', to: socket.next });
      if (edges.length > 0) socket.edges = edges;
      else delete socket.edges;
      delete socket.next;
    }
    if (semantic) {
      let semanticLoadout = fromWebUiLoadoutDto(loadout as never);
      Object.assign(semanticLoadout, reconcileLoadoutLoopConsumersFromGraph(semanticLoadout, normalized.materia ?? {}));
      Object.assign(loadout, toWebUiLoadoutDto(semanticLoadout));
      normalizeGeneratorPipelineSockets(loadout, normalized.materia ?? {});
      semanticLoadout = fromWebUiLoadoutDto(loadout as never);
      materializeLoadoutLoopSemantics(normalized as PiMateriaConfig, semanticLoadout);
      Object.assign(loadout, toWebUiLoadoutDto(semanticLoadout));
    }
  }
  return normalized;
}

function normalizeCanonicalParseSemantics(container: { parse?: unknown; outputFormat?: unknown; materia?: unknown }): void {
  if (container.parse === undefined && (container.outputFormat === 'json' || container.outputFormat === 'text')) container.parse = container.outputFormat;
  delete container.outputFormat;
  const definitions = container.materia && typeof container.materia === 'object' && !Array.isArray(container.materia) ? container.materia as Record<string, MateriaBehaviorConfig> : {};
  for (const definition of Object.values(definitions)) normalizeCanonicalParseSemantics(definition);
}

function normalizeGeneratorPipelineSockets(loadout: PipelineConfig, definitions: Record<string, MateriaBehaviorConfig>): void {
  for (const id of generatorPipelineSocketIds(loadout, definitions)) {
    const socket = loadout.sockets?.[id];
    if ((socket?.type !== 'agent' && socket?.type !== 'utility') || typeof socket.materia !== 'string') continue;
    if (!canonicalMateriaGeneratorOutput(definitions[socket.materia])) continue;
    socket.parse = 'json';
    socket.assign = { ...(socket.assign as Record<string, string> | undefined ?? {}), workItems: '$.workItems' };
  }
}

function generatorPipelineSocketIds(loadout: PipelineConfig, definitions: Record<string, MateriaBehaviorConfig>): Set<string> {
  return analyzeLoadoutGraph(fromWebUiLoadoutDto(loadout as never), definitions).workItemProducingSocketIds;
}

function canonicalMateriaGeneratorOutput(definition?: MateriaBehaviorConfig): string | undefined {
  return definition?.generator === true ? 'workItems' : undefined;
}

export interface MateriaBehaviorConfig {
  type?: SocketType;
  tools?: ToolScopeSpec;
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
  activeLoadoutId?: string;
  activeLoadout?: string;
  loadouts?: Record<string, PipelineConfig>;
  materia?: Record<string, MateriaBehaviorConfig>;
  [key: string]: unknown;
}

export interface MateriaReference {
  type: SocketType;
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

export function isEntrySocket(socket?: PipelineSocket): boolean {
  return socket?.socketKind === 'entry';
}

export function canDeleteSocket(socket?: PipelineSocket): boolean {
  return socket?.socketKind === 'normal';
}

function deleteOptionalTarget(container: { done?: string } | undefined, deletedSocketId: string): void {
  if (container?.done === deletedSocketId) delete container.done;
}

function removeLoopOwnedRuntimeControls(loadout: PipelineConfig, loop: PipelineLoop): void {
  const exitSource = loop.exit?.from;
  const sourceSocket = exitSource ? loadout.sockets?.[exitSource] : undefined;
  if (!sourceSocket) return;

  const loopExitTargets = new Set((loop.exits ?? []).map((route) => route.targetSocketId));
  const advanceDoneTarget = loop.exit?.to;
  if (advanceDoneTarget && advanceDoneTarget !== 'end') loopExitTargets.add(advanceDoneTarget);

  if (sourceSocket.advance && sourceSocket.advance.done === advanceDoneTarget) delete sourceSocket.advance;
  if (sourceSocket.edges && loopExitTargets.size > 0) {
    sourceSocket.edges = sourceSocket.edges.filter((edge) => !loopExitTargets.has(edge.to));
    if (sourceSocket.edges.length === 0) delete sourceSocket.edges;
  }
}

export function deleteSocketFromLoadout(loadout: PipelineConfig, socketId: string): boolean {
  const socket = loadout.sockets?.[socketId];
  if (!loadout.sockets || !canDeleteSocket(socket)) return false;

  delete loadout.sockets[socketId];
  for (const current of Object.values(loadout.sockets) as LegacyPipelineSocket[]) {
    if (current.edges) {
      current.edges = current.edges.filter((edge) => edge.to !== socketId);
      if (current.edges.length === 0) delete current.edges;
    }
    if (current.next === socketId) delete current.next;
    deleteOptionalTarget(current.foreach, socketId);
    deleteOptionalTarget(current.advance as { done?: string } | undefined, socketId);
  }

  for (const [loopId, loop] of Object.entries(loadout.loops ?? {})) {
    if (loop.sockets.includes(socketId) || loop.consumes?.from === socketId || loop.exit?.from === socketId || loop.exits?.some((route) => route.from === socketId)) {
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
  const sockets = loadout.sockets ?? {};
  const entryId = loadout.entry && sockets[loadout.entry] ? loadout.entry : Object.keys(sockets)[0];
  if (entryId && !loadout.entry) loadout.entry = entryId;
  for (const [id, socket] of Object.entries(sockets)) {
    socket.socketKind = id === entryId ? 'entry' : 'normal';
  }
  return loadout;
}

function isSocketLayout(value: unknown): value is SocketLayout {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const layout = value as SocketLayout;
  return typeof layout.x === 'number' || typeof layout.y === 'number';
}

export function getSocketLayout(loadout: PipelineConfig | undefined, socketId: string): SocketLayout | undefined {
  const explicit = loadout?.layout?.sockets?.[socketId];
  if (isSocketLayout(explicit)) return explicit;
  const legacy = loadout?.sockets?.[socketId]?.layout;
  return isSocketLayout(legacy) ? legacy : undefined;
}

export function setLoadoutSocketLayout(loadout: PipelineConfig, socketId: string, layout: SocketLayout | undefined): PipelineConfig {
  if (!layout || (layout.x === undefined && layout.y === undefined)) {
    const sockets: Record<string, SocketLayout> = { ...(loadout.layout?.sockets ?? {}) };
    if (!(socketId in sockets)) return loadout;
    delete sockets[socketId];
    const nextLayout: PipelineLayout = { ...(loadout.layout ?? {}), sockets };
    if (Object.keys(sockets).length === 0) delete nextLayout.sockets;
    const next: PipelineConfig = { ...loadout, layout: nextLayout };
    if (Object.keys(nextLayout).length === 0) delete next.layout;
    return next;
  }
  return { ...loadout, layout: { ...(loadout.layout ?? {}), sockets: { ...(loadout.layout?.sockets ?? {}), [socketId]: { ...layout } } } };
}

export function normalizeLoadoutLayout(loadout: PipelineConfig): PipelineConfig {
  const sockets = loadout.sockets ?? {};
  const existing = loadout.layout && typeof loadout.layout === 'object' && !Array.isArray(loadout.layout) ? loadout.layout : {};
  const existingSockets = existing.sockets && typeof existing.sockets === 'object' && !Array.isArray(existing.sockets) ? existing.sockets : {};
  const socketLayouts: Record<string, SocketLayout> = {};

  for (const id of Object.keys(sockets).sort((a, b) => a.localeCompare(b))) {
    const authoritative = existingSockets[id];
    const fallback = sockets[id]?.layout;
    const source = isSocketLayout(authoritative) ? authoritative : isSocketLayout(fallback) ? fallback : undefined;
    if (source) socketLayouts[id] = { ...(typeof source.x === 'number' ? { x: source.x } : {}), ...(typeof source.y === 'number' ? { y: source.y } : {}) };
    if (sockets[id] && 'layout' in sockets[id]) delete sockets[id].layout;
  }

  const nextLayout: PipelineLayout = { ...existing };
  if (Object.keys(socketLayouts).length > 0) nextLayout.sockets = socketLayouts;
  else delete nextLayout.sockets;
  if (Object.keys(nextLayout).length > 0) loadout.layout = nextLayout;
  else delete loadout.layout;
  return loadout;
}

export function isEmptySocket(socket?: PipelineSocket): boolean {
  return !socket || socket.empty === true || Object.keys(extractMateriaBehavior(socket)).length === 0;
}

export function makeEmptySocket(structure: PipelineSocket = {}): PipelineSocket {
  return { socketKind: 'normal', ...extractSocketStructure(structure), empty: true };
}

export function makeEmptyEntryLoadout(entry = 'Socket-1'): PipelineConfig {
  assertCanonicalSocketId(entry, 'new loadout entry');
  return { entry, sockets: { [entry]: makeEmptySocket({ socketKind: 'entry' }) } };
}

export function makeNewSocketId(sockets: Record<string, PipelineSocket>): string {
  const usedNumbers = new Set<number>();
  for (const id of Object.keys(sockets)) {
    const parsed = parseCanonicalSocketId(id);
    if (parsed) usedNumbers.add(parsed.ordinal);
  }
  let index = 1;
  while (usedNumbers.has(index) || sockets[`Socket-${index}`]) index += 1;
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
  if (!loop || loop.exit?.from !== from || !loadout.sockets?.[targetSocketId]) return undefined;
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

export function createMateriaReference(materiaId: string, type: SocketType = 'agent'): MateriaReference {
  return { type, materia: materiaId };
}

export function materiaPaletteSocket(id: string, definition?: MateriaBehaviorConfig): PipelineSocket {
  if (definition?.type === 'utility') return { ...createMateriaReference(id, 'utility') };
  return {
    ...createMateriaReference(id, 'agent'),
    parse: definition?.parse,
    assign: cloneValue(definition?.assign),
    foreach: cloneValue(definition?.foreach),
  };
}

export function buildMateriaPalette(definitions: Record<string, MateriaBehaviorConfig> = {}): Array<[string, PipelineSocket]> {
  return Object.keys(definitions).map((id) => [id, materiaPaletteSocket(id, definitions[id])]);
}

export function extractMateriaReference(socket?: PipelineSocket): MateriaReference | undefined {
  if (!socket || socket.empty || (socket.type !== 'agent' && socket.type !== 'utility') || typeof socket.materia !== 'string' || !socket.materia) return undefined;
  return createMateriaReference(socket.materia, socket.type);
}

export function extractMateriaBehavior(socket?: PipelineSocket): PipelineSocket {
  if (!socket || socket.empty) return {};
  const behavior: PipelineSocket = {};
  for (const [key, value] of Object.entries(socket)) {
    if (materiaBehaviorKeys.has(key)) behavior[key] = cloneValue(value);
  }
  return behavior;
}

export function extractSocketStructure(socket?: PipelineSocket): PipelineSocket {
  const structure: PipelineSocket = {};
  for (const [key, value] of Object.entries(socket ?? {})) {
    if (key === 'socketKind') {
      if (isSocketKind(value)) structure.socketKind = value;
      continue;
    }
    if (!materiaBehaviorKeys.has(key) && key !== 'empty' && key !== 'next' && key !== 'layout') structure[key] = cloneValue(value);
  }
  return structure;
}

export function placeMateriaInSocket(socket?: PipelineSocket, materia?: PipelineSocket): PipelineSocket {
  const behavior = extractMateriaBehavior(materia);
  if (Object.keys(behavior).length === 0) return makeEmptySocket(socket);
  return { ...extractSocketStructure(socket), ...behavior, empty: false };
}

export function clearSocketMateria(socket?: PipelineSocket): PipelineSocket {
  return makeEmptySocket(socket);
}

export function getSocketLabel(id: string, socket?: PipelineSocket, definitions?: Record<string, MateriaBehaviorConfig>): string {
  if (isEmptySocket(socket)) return emptySocketLabel;
  const referenced = extractMateriaReference(socket);
  const definition = referenced ? definitions?.[referenced.materia] : undefined;
  if (definition?.label) return definition.label;
  if (referenced) return referenced.materia;
  if (socket?.type === 'utility') return socket.label ?? socket.utility ?? socket.command?.join(' ') ?? id;
  return socket?.materia ?? socket?.utility ?? id;
}

export function formatSocketLabel(id: string, socket?: PipelineSocket, definitions?: Record<string, MateriaBehaviorConfig>): string {
  return `${id} (${getSocketLabel(id, socket, definitions)})`;
}

const jsonControlConditions = new Set<MateriaEdgeCondition>(['satisfied', 'not_satisfied']);

function isJsonControlCondition(when: unknown): when is MateriaEdgeCondition {
  return when === 'satisfied' || when === 'not_satisfied';
}

function controlParseError(loadoutName: string, socketId: string, socket: PipelineSocket, source: string, condition: MateriaEdgeCondition): string {
  const label = formatSocketLabel(socketId, socket);
  const parseMode = socket.parse ?? 'text';
  return `Loadout "${loadoutName}" socket ${label} uses ${condition} control routing at ${source}, but its output format is ${JSON.stringify(parseMode)}. Set the socket Output format to JSON (parse: "json") or change the route to always; satisfied/not_satisfied routing requires JSON output parsing.`;
}

function effectiveSocketParse(socket: PipelineSocket | undefined, definitions: Record<string, MateriaBehaviorConfig>): PipelineSocket['parse'] {
  if (!socket) return undefined;
  const referenced = extractMateriaReference(socket);
  if (referenced && definitions[referenced.materia]?.generator === true) return 'json';
  return socket.parse ?? (referenced ? definitions[referenced.materia]?.parse : undefined);
}

function validateCanonicalSocketReferences(loadoutName: string, loadout: PipelineConfig, definitions: Record<string, MateriaBehaviorConfig>, errors: string[]): void {
  for (const [socketId, socket] of Object.entries(loadout.sockets ?? {})) {
    if ((socket.type !== 'agent' && socket.type !== 'utility') || typeof socket.materia !== 'string' || !socket.materia) continue;
    const definition = definitions[socket.materia];
    if (!definition) {
      if (socket.type === 'utility') errors.push(`loadouts.${loadoutName}.sockets.${socketId}.materia: utility socket references unknown materia ${JSON.stringify(socket.materia)}`);
      continue;
    }
    if (definition.type === undefined) continue;
    if (socket.type === 'agent' && definition.type !== 'agent') errors.push(`loadouts.${loadoutName}.sockets.${socketId}.materia: agent socket must reference agent materia`);
    if (socket.type === 'utility' && definition.type !== 'utility') errors.push(`loadouts.${loadoutName}.sockets.${socketId}.materia: utility socket must reference utility materia`);
  }
}

export function validateLoadoutSaveSemantics(config: MateriaConfig): string[] {
  const errors: string[] = [];
  for (const [loadoutName, rawLoadout] of Object.entries(config.loadouts ?? {})) {
    // Route WebUI validation through the shared normalization boundary so save
    // checks use the same migrated layout, normalized edges, and graph-derived
    // loop semantics as config load/save and runtime preparation. Clone first so
    // validation remains a non-mutating read from editor state.
    const { loadout: sharedLoadout, analysis } = normalizeLoadedLoadout(fromWebUiLoadoutDto(cloneValue(rawLoadout) as never), config.materia ?? {});
    validateCanonicalSocketReferences(loadoutName, sharedLoadout as never, config.materia ?? {}, errors);
    const loadout = toWebUiLoadoutDto(sharedLoadout) as PipelineConfig;
    for (const [socketId, socket] of Object.entries(loadout.sockets ?? {})) {
      const parse = effectiveSocketParse(socket, config.materia ?? {});
      for (const [index, edge] of (socket.edges ?? []).entries()) {
        if (!jsonControlConditions.has(edge.when)) continue;
        if (parse !== 'json') errors.push(controlParseError(loadoutName, socketId, { ...socket, parse }, `${socketId}.edges[${index}]`, edge.when));
      }
      const advanceWhen = socket.advance?.when;
      if (isJsonControlCondition(advanceWhen) && parse !== 'json') {
        errors.push(controlParseError(loadoutName, socketId, { ...socket, parse }, `${socketId}.advance.when`, advanceWhen));
      }
    }
    for (const diagnostic of analysis.diagnostics) {
      if (diagnostic.code === 'loop-consumer-missing' || diagnostic.code === 'loop-consumer-ambiguous') errors.push(`Loadout "${loadoutName}" ${diagnostic.message}`);
    }
    for (const [loopId, loop] of Object.entries(loadout.loops ?? {})) {
      for (const [index, route] of (loop.exits ?? []).entries()) {
        const source = loadout.sockets?.[route.from];
        const parse = effectiveSocketParse(source, config.materia ?? {});
        if (source && isJsonControlCondition(route.condition) && parse !== 'json') {
          errors.push(controlParseError(loadoutName, route.from, { ...source, parse }, `loops.${loopId}.exits[${index}].condition`, route.condition));
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

export function resolveSocketDisplayLabel(loadout: PipelineConfig | undefined, socketId: string, definitions?: Record<string, MateriaBehaviorConfig>): string {
  if (loadout?.sockets && !loadout.sockets[socketId]) return socketId;
  return getSocketLabel(socketId, loadout?.sockets?.[socketId], definitions);
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

export function socketColor(id: string, _index: number, definitions?: Record<string, MateriaBehaviorConfig>, socket?: PipelineSocket): string {
  return resolveMateriaColor(extractMateriaReference(socket)?.materia ?? id, definitions);
}

export function canonicalizeUtilitySocketReferences(config: MateriaConfig): MateriaConfig {
  const next = cloneValue(config);
  for (const loadout of Object.values(next.loadouts ?? {})) {
    for (const socket of Object.values(loadout.sockets ?? {})) {
      if (socket.type !== 'utility' || typeof socket.materia !== 'string' || !socket.materia) continue;
      delete socket.utility;
      delete socket.command;
      delete socket.params;
      delete socket.timeoutMs;
      delete socket.parse;
      delete socket.assign;
    }
  }
  return next;
}
