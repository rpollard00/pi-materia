import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { MateriaEdgeCondition } from '../../../types.js';
import { edgeConditionState, formatGraphValidationErrors, stageValidatedPipelineGraphChange } from '../../../graphValidation.js';
import {
  buildMateriaPalette,
  clearSocketMateria,
  getNodeLabel,
  isEmptySocket,
  makeEmptyEntryLoadout,
  makeEmptySocket,
  nodeColor,
  normalizeMateriaConfigEdges,
  placeMateriaInSocket,
  type MateriaConfig,
  type LegacyPipelineNode,
  type PipelineConfig,
  type PipelineNode,
} from './loadoutModel.js';

type SaveTarget = 'user' | 'project' | 'explicit';

interface MateriaFormState {
  editingNodeId: string;
  name: string;
  behavior: 'prompt' | 'tool';
  prompt: string;
  toolAccess: 'none' | 'readOnly' | 'coding';
  model: string;
  thinking: string;
  color: string;
  outputFormat: 'text' | 'json';
  multiTurn: boolean;
  utility: string;
  command: string;
  params: string;
  timeoutMs: string;
  persistScope: SaveTarget;
}

interface SocketPropertyFormState {
  maxVisits: string;
  maxEdgeTraversals: string;
  maxOutputBytes: string;
  layoutX: string;
  layoutY: string;
}

interface ConfigResponse {
  ok?: boolean;
  config?: MateriaConfig;
  source?: string;
}

interface RoleGenerationResponse {
  ok?: boolean;
  prompt?: string;
  error?: string;
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
    outputs?: Array<{ node?: string; materia?: string; phase?: string; kind?: string; artifact?: string; timestamp?: number; content?: string }>;
  };
  activeCast?: {
    castId: string;
    active: boolean;
    phase: string;
    currentNode?: string;
    currentMateria?: string;
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
  when: MateriaEdgeCondition;
  edgeIndex?: number;
}

interface PositionedSocket {
  id: string;
  node: PipelineNode;
  index: number;
  x: number;
  y: number;
}

interface RoutedLoadoutEdge {
  edge: LoadoutEdge;
  path: string;
  labelX: number;
  labelY: number;
  labelRotate: number;
  routeClass: 'forward' | 'backward' | 'loop';
}

interface LoopRegion {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  summary: string;
}

type SocketAnchorSide = 'top' | 'right' | 'bottom' | 'left';

interface SocketAnchorPoint {
  x: number;
  y: number;
  side: SocketAnchorSide;
}

const socketLayoutOffsetX = 32;
const socketLayoutOffsetY = 28;
const socketCardWidth = 92;
const socketStageHeight = 92;
const socketAnchorY = socketStageHeight / 2;
const socketLayoutUnitX = 208;
const socketLayoutUnitY = 168;
const socketLayoutRowGap = 240;
const socketGraphExtent = 190;

interface SocketLayoutDragState {
  socketId: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  originX: number;
  originY: number;
  currentX: number;
  currentY: number;
  moved: boolean;
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
  color: '',
  outputFormat: 'text',
  multiTurn: false,
  utility: '',
  command: '',
  params: '{}',
  timeoutMs: '',
  persistScope: 'user',
});

const emptySocketPropertyForm = (): SocketPropertyFormState => ({
  maxVisits: '',
  maxEdgeTraversals: '',
  maxOutputBytes: '',
  layoutX: '',
  layoutY: '',
});

const cloneConfig = <T,>(config: T): T => JSON.parse(JSON.stringify(config)) as T;

function buildLoadouts(config: MateriaConfig): Record<string, PipelineConfig> {
  if (config.loadouts && Object.keys(config.loadouts).length > 0) return config.loadouts;
  return {};
}

const edgeConditionLabels: Record<MateriaEdgeCondition, string> = {
  always: 'Always',
  satisfied: 'Satisfied',
  not_satisfied: 'Not Satisfied',
};

function edgeConditionLabel(when?: string) {
  const state = edgeConditionState({ when });
  if (state !== 'invalid') return edgeConditionLabels[state];
  return 'Invalid';
}

function edgeConditionClass(when?: string) {
  const state = edgeConditionState({ when });
  if (state === 'not_satisfied') return 'unsatisfied';
  if (state === 'satisfied') return 'satisfied';
  return 'default';
}

function toggledEdgeCondition(when?: string): MateriaEdgeCondition {
  const state = edgeConditionState({ when });
  if (state === 'always') return 'satisfied';
  if (state === 'satisfied') return 'not_satisfied';
  return 'always';
}

function summarizeHoverText(value?: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function buildSocketHoverDetails(id: string, node?: PipelineNode, definitions?: MateriaConfig['materia']): string {
  const lines = [`Socket: ${id}`];
  if (isEmptySocket(node)) return [...lines, 'Empty socket'].join('\n');

  const label = getNodeLabel(id, node);
  lines.push(`Label: ${label}`);
  if (node?.type) lines.push(`Type: ${node.type}`);
  if (node?.type === 'agent' && node.materia) {
    lines.push(`Materia: ${node.materia}`);
    const definition = definitions?.[node.materia];
    if (definition?.model) lines.push(`Model: ${definition.model}`);
    if (definition?.tools) lines.push(`Tools: ${definition.tools}`);
    if (definition?.thinking) lines.push(`Thinking: ${definition.thinking}`);
    if (definition?.multiTurn !== undefined) lines.push(`Multi-turn: ${definition.multiTurn ? 'yes' : 'no'}`);
    const prompt = summarizeHoverText(definition?.prompt);
    if (prompt) lines.push(`Prompt: ${prompt}`);
  }
  if (node?.type === 'utility') {
    if (node.utility) lines.push(`Utility: ${node.utility}`);
    if (node.command?.length) lines.push(`Command: ${node.command.join(' ')}`);
  }
  if (node?.edges?.length) {
    lines.push(`Edges: ${node.edges.map((edge) => `${edgeConditionLabel(edge.when)} → ${edge.to}`).join(', ')}`);
  }
  const legacyNext = (node as LegacyPipelineNode | undefined)?.next;
  if (legacyNext) lines.push(`Legacy flow: Always → ${legacyNext}`);
  if (node?.limits) {
    const limits = [
      node.limits.maxVisits !== undefined ? `max visits ${node.limits.maxVisits}` : undefined,
      node.limits.maxEdgeTraversals !== undefined ? `max edge traversals ${node.limits.maxEdgeTraversals}` : undefined,
      node.limits.maxOutputBytes !== undefined ? `max output bytes ${node.limits.maxOutputBytes}` : undefined,
    ].filter(Boolean);
    if (limits.length) lines.push(`Limits: ${limits.join(', ')}`);
  }
  if (node?.layout && (node.layout.x !== undefined || node.layout.y !== undefined)) {
    lines.push(`Layout: ${node.layout.x ?? 0}, ${node.layout.y ?? 0}`);
  }
  return lines.join('\n');
}

function getLoadoutEdges(nodes: Record<string, PipelineNode>): LoadoutEdge[] {
  const edges: LoadoutEdge[] = [];
  for (const [from, node] of Object.entries(nodes)) {
    for (const [index, edge] of (node.edges ?? []).entries()) {
      if (nodes[edge.to]) edges.push({ id: `${from}:edge:${index}:${edge.to}:${edge.when}`, from, to: edge.to, when: edge.when, edgeIndex: index });
    }
    const legacyNext = (node as LegacyPipelineNode).next;
    if (typeof legacyNext === 'string' && nodes[legacyNext]) {
      edges.push({ id: `${from}:legacy-next:${legacyNext}`, from, to: legacyNext, when: 'always' });
    }
  }
  return edges;
}

function layoutUnit(value: number, unit: number) {
  const position = Math.abs(value) <= 20 ? value * unit : value;
  return Math.round(position * 1000) / 1000;
}

function layoutValueForPosition(position: number, offset: number, unit: number) {
  const raw = position - offset;
  const asUnits = raw / unit;
  const value = Math.abs(asUnits) <= 20 ? asUnits : raw;
  return Math.round(value * 1000000000000) / 1000000000000;
}

function rounded(value: number) {
  return Math.round(value * 10) / 10;
}

function edgeOrderKey(edge: LoadoutEdge) {
  return `${edge.from}\u0000${edge.to}\u0000${edge.edgeIndex ?? -1}\u0000${edge.when ?? ''}`;
}

function orderedLane(edges: LoadoutEdge[], edge: LoadoutEdge, spacing: number) {
  const sorted = [...edges].sort((a, b) => edgeOrderKey(a).localeCompare(edgeOrderKey(b)));
  const index = sorted.findIndex((candidate) => candidate.id === edge.id);
  return (index - (sorted.length - 1) / 2) * spacing;
}

function lineIntersection(a: { startX: number; startY: number; endX: number; endY: number }, b: { startX: number; startY: number; endX: number; endY: number }) {
  const denominator = (a.startX - a.endX) * (b.startY - b.endY) - (a.startY - a.endY) * (b.startX - b.endX);
  if (Math.abs(denominator) < 0.001) return false;
  const t = ((a.startX - b.startX) * (b.startY - b.endY) - (a.startY - b.startY) * (b.startX - b.endX)) / denominator;
  const u = -((a.startX - a.endX) * (a.startY - b.startY) - (a.startY - a.endY) * (a.startX - b.startX)) / denominator;
  return t > 0.08 && t < 0.92 && u > 0.08 && u < 0.92;
}

function socketCenter(socket: PositionedSocket) {
  return { x: socket.x + socketCardWidth / 2, y: socket.y + socketStageHeight / 2 };
}

function socketAnchor(socket: PositionedSocket, side: SocketAnchorSide): SocketAnchorPoint {
  const center = socketCenter(socket);
  if (side === 'top') return { x: center.x, y: socket.y, side };
  if (side === 'bottom') return { x: center.x, y: socket.y + socketStageHeight, side };
  if (side === 'left') return { x: socket.x, y: center.y, side };
  return { x: socket.x + socketCardWidth, y: center.y, side };
}

function chooseSocketAnchors(edge: LoadoutEdge, from: PositionedSocket, to: PositionedSocket): { source: SocketAnchorPoint; target: SocketAnchorPoint } {
  if (edge.from === edge.to) {
    return { source: socketAnchor(from, 'right'), target: socketAnchor(to, 'bottom') };
  }

  const sourceCenter = socketCenter(from);
  const targetCenter = socketCenter(to);
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  const sameRow = Math.abs(dy) < socketStageHeight * 0.45;
  const verticalTransition = !sameRow && Math.abs(dy) > Math.abs(dx) * 0.65;

  if (sameRow) {
    return dx >= 0
      ? { source: socketAnchor(from, 'right'), target: socketAnchor(to, 'left') }
      : { source: socketAnchor(from, 'left'), target: socketAnchor(to, 'right') };
  }

  if (verticalTransition) {
    return dy >= 0
      ? { source: socketAnchor(from, 'bottom'), target: socketAnchor(to, 'top') }
      : { source: socketAnchor(from, 'top'), target: socketAnchor(to, 'bottom') };
  }

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { source: socketAnchor(from, 'right'), target: socketAnchor(to, 'left') }
      : { source: socketAnchor(from, 'left'), target: socketAnchor(to, 'right') };
  }

  return dy >= 0
    ? { source: socketAnchor(from, 'bottom'), target: socketAnchor(to, 'top') }
    : { source: socketAnchor(from, 'top'), target: socketAnchor(to, 'bottom') };
}

function routeLaneGroups(edges: LoadoutEdge[], positions: Map<string, PositionedSocket>) {
  const routeable = edges.flatMap((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) return [];
    const { source, target } = chooseSocketAnchors(edge, from, to);
    return [{
      edge,
      startX: source.x,
      startY: source.y,
      endX: target.x,
      endY: target.y,
    }];
  });
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const current = parent.get(id) ?? id;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };
  for (const route of routeable) parent.set(route.edge.id, route.edge.id);
  for (let i = 0; i < routeable.length; i += 1) {
    for (let j = i + 1; j < routeable.length; j += 1) {
      const a = routeable[i];
      const b = routeable[j];
      const exactParallel = (a.edge.from === b.edge.from && a.edge.to === b.edge.to) || (a.edge.from === b.edge.to && a.edge.to === b.edge.from);
      const nearbyParallel = Math.abs(a.startX - b.startX) < socketCardWidth * 0.7 && Math.abs(a.endX - b.endX) < socketCardWidth * 0.7 && Math.abs(a.startY - b.startY) < 90 && Math.abs(a.endY - b.endY) < 90;
      if (exactParallel || nearbyParallel || lineIntersection(a, b)) union(a.edge.id, b.edge.id);
    }
  }
  const groups = new Map<string, LoadoutEdge[]>();
  for (const { edge } of routeable) groups.set(find(edge.id), [...(groups.get(find(edge.id)) ?? []), edge]);
  const byEdge = new Map<string, LoadoutEdge[]>();
  for (const group of groups.values()) for (const edge of group) byEdge.set(edge.id, group);
  return byEdge;
}

function labelRotation(startX: number, startY: number, endX: number, endY: number) {
  const degrees = Math.atan2(endY - startY, endX - startX) * 180 / Math.PI;
  return degrees > 90 || degrees < -90 ? degrees + 180 : degrees;
}

function anchorOutwardVector(side: SocketAnchorSide) {
  if (side === 'left') return { x: -1, y: 0 };
  if (side === 'right') return { x: 1, y: 0 };
  if (side === 'top') return { x: 0, y: -1 };
  return { x: 0, y: 1 };
}

function offsetAnchor(anchor: SocketAnchorPoint, distance: number) {
  const vector = anchorOutwardVector(anchor.side);
  return { x: anchor.x + vector.x * distance, y: anchor.y + vector.y * distance };
}

function formatCurvedPath(points: Array<{ x: number; y: number }>) {
  return `M ${rounded(points[0].x)} ${rounded(points[0].y)} C ${rounded(points[1].x)} ${rounded(points[1].y)}, ${rounded(points[2].x)} ${rounded(points[2].y)}, ${rounded(points[3].x)} ${rounded(points[3].y)}`;
}

function perpendicularOffset(source: SocketAnchorPoint, target: SocketAnchorPoint, lane: number) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: -dy / length * lane, y: dx / length * lane };
}

function curvedRoute(source: SocketAnchorPoint, target: SocketAnchorPoint, lane: number) {
  const distance = Math.hypot(target.x - source.x, target.y - source.y);
  const lead = Math.max(32, Math.min(96, distance * 0.38));
  const sourceVector = anchorOutwardVector(source.side);
  const targetVector = anchorOutwardVector(target.side);
  const laneOffset = perpendicularOffset(source, target, lane);
  const sourceControl = {
    x: source.x + sourceVector.x * lead + laneOffset.x,
    y: source.y + sourceVector.y * lead + laneOffset.y,
  };
  const targetControl = {
    x: target.x + targetVector.x * lead + laneOffset.x,
    y: target.y + targetVector.y * lead + laneOffset.y,
  };
  const labelX = rounded((source.x + sourceControl.x + targetControl.x + target.x) / 4);
  const labelY = rounded((source.y + sourceControl.y + targetControl.y + target.y) / 4 - 10);

  return {
    path: formatCurvedPath([{ x: source.x, y: source.y }, sourceControl, targetControl, { x: target.x, y: target.y }]),
    labelX,
    labelY,
    labelRotate: rounded(labelRotation(source.x, source.y, target.x, target.y)),
  };
}

export function routeLoadoutEdges(edges: LoadoutEdge[], positions: Map<string, PositionedSocket>): RoutedLoadoutEdge[] {
  // Keep routing deterministic and local instead of adding a physics/layout dependency:
  // the WebUI preserves user-authored socket positions, so force solvers would move
  // nodes unpredictably and make saved layouts harder to reason about. Edges are
  // separated by stable lanes and attached to the nearest sensible side of each
  // socket so arrowheads follow the final segment into the target edge.
  const laneGroups = routeLaneGroups(edges, positions);

  return edges.map((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) return undefined;
    const lane = orderedLane(laneGroups.get(edge.id) ?? [edge], edge, 30);
    const anchors = chooseSocketAnchors(edge, from, to);
    const route = curvedRoute(anchors.source, anchors.target, lane);
    const backward = edge.from !== edge.to && anchors.source.side === 'left' && anchors.target.side === 'right';

    return {
      edge,
      routeClass: edge.from === edge.to ? 'loop' as const : backward ? 'backward' as const : 'forward' as const,
      ...route,
    };
  }).filter((route): route is RoutedLoadoutEdge => Boolean(route));
}

function getAutomaticSocketOrder(entries: Array<[string, PipelineNode]>, edges: LoadoutEdge[], entryId?: string) {
  const entryIds = entries.map(([id]) => id);
  const knownIds = new Set(entryIds);
  const visited = new Set<string>();
  const ordered: string[] = [];
  const queue = entryId ? [entryId] : [];

  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (visited.has(id) || !knownIds.has(id)) continue;
    visited.add(id);
    ordered.push(id);
    for (const edge of edges) {
      if (edge.from === id && !visited.has(edge.to)) queue.push(edge.to);
    }
  }

  for (const id of entryIds) {
    if (!visited.has(id)) ordered.push(id);
  }
  return ordered;
}

function serpentineAutoPosition(autoIndex: number, rowGap = socketLayoutRowGap) {
  const row = Math.floor(autoIndex / 2);
  const offsetInRow = autoIndex % 2;
  const column = row % 2 === 0 ? offsetInRow : 1 - offsetInRow;
  return {
    x: column * socketLayoutUnitX,
    y: row * rowGap,
  };
}

function getLoopRegions(loadout: PipelineConfig | undefined, positions: Map<string, PositionedSocket>): LoopRegion[] {
  return Object.entries(loadout?.loops ?? {}).flatMap(([id, loop]) => {
    const sockets = loop.nodes.map((nodeId) => positions.get(nodeId)).filter(Boolean) as PositionedSocket[];
    if (sockets.length === 0) return [];
    const minX = Math.min(...sockets.map((socket) => socket.x));
    const minY = Math.min(...sockets.map((socket) => socket.y));
    const maxX = Math.max(...sockets.map((socket) => socket.x + socketCardWidth));
    const maxY = Math.max(...sockets.map((socket) => socket.y + socketStageHeight));
    const iterator = loop.iterator ? `Iterator: ${loop.iterator.items}${loop.iterator.as ? ` as ${loop.iterator.as}` : ''}${loop.iterator.done ? ` until ${loop.iterator.done}` : ''}` : 'Loop region';
    const exit = loop.exit ? `Exit: ${edgeConditionLabel(loop.exit.when)} → ${loop.exit.to}` : undefined;
    return [{ id, label: loop.label ?? id, x: minX - 34, y: minY - 48, width: Math.max(180, maxX - minX + 68), height: Math.max(150, maxY - minY + 86), summary: [iterator, exit].filter(Boolean).join(' • ') }];
  });
}

function layoutSockets(loadout?: PipelineConfig): { sockets: PositionedSocket[]; edges: LoadoutEdge[]; width: number; height: number } {
  const nodes = loadout?.nodes ?? {};
  const entries = Object.entries(nodes);
  const edges = getLoadoutEdges(nodes);
  const entryId = loadout?.entry && nodes[loadout.entry] ? loadout.entry : entries[0]?.[0];
  const orderedAutoIds = getAutomaticSocketOrder(entries, edges, entryId).filter((id) => {
    const node = nodes[id];
    return typeof node.layout?.x !== 'number' || typeof node.layout?.y !== 'number';
  });
  const autoIndexById = new Map(orderedAutoIds.map((id, index) => [id, index]));

  const hasExplicitLayout = entries.some(([, node]) => typeof node.layout?.x === 'number' || typeof node.layout?.y === 'number');
  const autoRowGap = hasExplicitLayout ? socketLayoutUnitY + 8 : socketLayoutRowGap;
  const sockets = entries.map(([id, node], index) => {
    const autoPosition = serpentineAutoPosition(autoIndexById.get(id) ?? index, autoRowGap);
    const explicitX = typeof node.layout?.x === 'number' ? layoutUnit(node.layout.x, socketLayoutUnitX) : undefined;
    const explicitY = typeof node.layout?.y === 'number' ? layoutUnit(node.layout.y, socketLayoutUnitY) : undefined;
    return {
      id,
      node,
      index,
      x: socketLayoutOffsetX + (explicitX ?? autoPosition.x),
      y: socketLayoutOffsetY + (explicitY ?? autoPosition.y),
    };
  });
  const width = Math.max(448, ...sockets.map((socket) => socket.x + socketGraphExtent));
  const height = Math.max(256, ...sockets.map((socket) => socket.y + socketGraphExtent));
  return { sockets, edges, width, height };
}

function makeNewLoadoutName(loadouts: Record<string, PipelineConfig>) {
  let index = Object.keys(loadouts).length + 1;
  let name = `New Loadout ${index}`;
  while (loadouts[name]) name = `New Loadout ${++index}`;
  return name;
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

function socketPropertyFormFromNode(node?: PipelineNode): SocketPropertyFormState {
  return {
    maxVisits: node?.limits?.maxVisits === undefined ? '' : String(node.limits.maxVisits),
    maxEdgeTraversals: node?.limits?.maxEdgeTraversals === undefined ? '' : String(node.limits.maxEdgeTraversals),
    maxOutputBytes: node?.limits?.maxOutputBytes === undefined ? '' : String(node.limits.maxOutputBytes),
    layoutX: node?.layout?.x === undefined ? '' : String(node.layout.x),
    layoutY: node?.layout?.y === undefined ? '' : String(node.layout.y),
  };
}

function parseOptionalPositiveInteger(label: string, raw: string, errors: string[]): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1) {
    errors.push(`${label} must be a positive whole number.`);
    return undefined;
  }
  return value;
}

function parseOptionalFiniteNumber(label: string, raw: string, errors: string[]): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    errors.push(`${label} must be a finite number.`);
    return undefined;
  }
  return value;
}

function buildMateriaPatch(form: MateriaFormState): MateriaConfig {
  const name = form.name.trim();
  if (!name) throw new Error('Materia name is required.');
  if (form.behavior !== 'prompt') throw new Error('Reusable tool definitions are no longer saved outside loadout graphs.');
  return {
    materia: {
      [name]: {
        tools: form.toolAccess,
        prompt: form.prompt,
        model: form.model.trim() || undefined,
        thinking: form.thinking.trim() || undefined,
        color: form.color.trim() || undefined,
        multiTurn: form.multiTurn || undefined,
      },
    },
  };
}

async function fetchMateriaConfig(): Promise<{ config: MateriaConfig; source: string }> {
  const response = await fetch('/api/config');
  const body = await response.json() as ConfigResponse;
  return { config: normalizeMateriaConfigEdges(body.config ?? (body as MateriaConfig)), source: body.source ?? 'unknown' };
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
  const [socketActionId, setSocketActionId] = useState<string | undefined>();
  const [socketActionMode, setSocketActionMode] = useState<'actions' | 'replace' | 'edit' | 'connect'>('actions');
  const [socketPropertyForm, setSocketPropertyForm] = useState<SocketPropertyFormState>(() => emptySocketPropertyForm());
  const [socketPropertyError, setSocketPropertyError] = useState('');
  const [edgeTargetId, setEdgeTargetId] = useState('');
  const [edgeCondition, setEdgeCondition] = useState<MateriaEdgeCondition>('satisfied');
  const [edgeMutationError, setEdgeMutationError] = useState('');
  const [socketLayoutDrag, setSocketLayoutDrag] = useState<SocketLayoutDragState | undefined>();
  const suppressSocketClickRef = useRef(false);
  const [monitor, setMonitor] = useState<MonitorSnapshot>();
  const [materiaForm, setMateriaForm] = useState<MateriaFormState>(() => emptyMateriaForm());
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
              planner: { type: 'agent', materia: 'planner', edges: [{ when: 'always', to: 'Build' }] },
              Build: { type: 'agent', materia: 'Build', edges: [{ when: 'always', to: 'Auto-Eval' }] },
              'Auto-Eval': { type: 'agent', materia: 'Auto-Eval', edges: [{ when: 'always', to: 'Maintain' }] },
              Maintain: { type: 'agent', materia: 'Maintain' },
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
  const loopRegions = useMemo(() => getLoopRegions(activeLoadout, socketPositions), [activeLoadout, socketPositions]);
  const routedEdges = useMemo(() => routeLoadoutEdges(loadoutGraph.edges, socketPositions), [loadoutGraph.edges, socketPositions]);
  const materia = draftConfig?.materia ?? {};
  const editableDefinitionIds = useMemo(() => Object.keys(materia).sort((a, b) => a.localeCompare(b)), [materia]);
  const palette = useMemo(() => buildMateriaPalette(materia), [materia]);
  const isDirty = JSON.stringify(baselineConfig) !== JSON.stringify(draftConfig);
  const currentMonitorNode = monitor?.activeCast?.currentNode;
  const elapsed = formatElapsed(monitor?.activeCast?.startedAt ?? monitor?.uiStartedAt, monitor?.now);

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
    setBaselineConfig(normalizeMateriaConfigEdges(loaded.config));
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
    setSocketActionId(undefined);
    setSocketActionMode('actions');
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

  function makeNewSocketId(nodes: Record<string, PipelineNode>, afterSocketId: string) {
    const base = `${afterSocketId}-Socket`;
    if (!nodes[base]) return base;
    let index = 2;
    while (nodes[`${base}-${index}`]) index += 1;
    return `${base}-${index}`;
  }

  function createConnectedSocket(afterSocketId: string) {
    if (!activeLoadoutName || !activeLoadout) return;
    const result = stageValidatedPipelineGraphChange(activeLoadout as import('../../../types.js').MateriaPipelineConfig, (loadout) => {
      if (!loadout.nodes?.[afterSocketId]) return;
      const source = loadout.nodes[afterSocketId] as PipelineNode;
      const newId = makeNewSocketId(loadout.nodes as Record<string, PipelineNode>, afterSocketId);
      const priorAlways = source.edges?.find((edge) => edge.when === 'always')?.to;
      const sourceLayout = source.layout;
      loadout.nodes[newId] = makeEmptySocket({
        edges: priorAlways ? [{ when: 'always', to: priorAlways }] : undefined,
        layout: sourceLayout ? { x: (sourceLayout.x ?? 0) + 1, y: sourceLayout.y ?? 0 } : undefined,
      }) as unknown as import('../../../types.js').MateriaPipelineNodeConfig;
      source.edges = [...(source.edges ?? []).filter((edge) => edge.when !== 'always'), { when: 'always', to: newId }];
    });
    if (!result.ok) {
      setStatus(`Cannot create socket after ${afterSocketId}: ${formatGraphValidationErrors(result.errors)}`);
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

  function handleSocketClick(socketId: string) {
    if (suppressSocketClickRef.current) {
      suppressSocketClickRef.current = false;
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
    if (event.button !== 0 || selectedMateriaId) return;
    const target = event.target as HTMLElement;
    if (target.closest('[draggable="true"]')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
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
    event.currentTarget.releasePointerCapture(event.pointerId);
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
    const result = stageValidatedPipelineGraphChange(activeLoadout as import('../../../types.js').MateriaPipelineConfig, mutator);
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
    const required = ['Build', 'Auto-Eval', 'Maintain'];
    const missing = required.filter((id) => !activeLoadout?.nodes?.[id]);
    if (missing.length > 0) {
      setStatus(`Cannot create task loop; missing sockets: ${missing.join(', ')}.`);
      return;
    }
    const created = commitGraphMutation(
      'Staged Build → Eval → Maintain task loop.',
      (loadout) => {
        loadout.loops = {
          ...(loadout.loops ?? {}),
          taskIteration: {
            label: 'Build → Eval → Maintain until all tasks complete',
            nodes: required,
            iterator: { items: 'state.tasks', as: 'task', cursor: 'taskIndex', done: 'end' },
            exit: { when: 'satisfied', to: 'end' },
          },
        };
      },
      'Staged explicit task iterator loop around Build, Auto-Eval, and Maintain.',
      (message) => `Cannot create task loop: ${message}`,
    );
    if (created) setSocketActionId(undefined);
  }

  function updateLoopExit(loopId: string, patch: Partial<{ when: MateriaEdgeCondition; to: string }>) {
    const loop = activeLoadout?.loops?.[loopId];
    if (!loop) return;
    const currentExit = loop.exit ?? { when: 'satisfied' as MateriaEdgeCondition, to: 'end' };
    const nextExit = { ...currentExit, ...patch };
    commitGraphMutation(
      `Updated loop ${loopId} exit.`,
      (loadout) => {
        const draftLoop = loadout.loops?.[loopId];
        if (!draftLoop) return;
        draftLoop.exit = nextExit;
      },
      `Staged loop ${loopId} exit as ${edgeConditionLabel(nextExit.when)} → ${nextExit.to}.`,
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
      `Staged edge ${from} → ${to} as ${edgeConditionLabel(edgeCondition)}.`,
      (message) => `Cannot create edge ${from} → ${to}: ${message}`,
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
    setStatus(`Staged edge ${edge.from} → ${edge.to} as ${edgeConditionLabel(updatedEdge?.when)}.`);
  }

  function editMateria(id: string) {
    const definition = materia[id];
    if (!definition) return;
    setMateriaForm({
      editingNodeId: id,
      name: id,
      behavior: 'prompt',
      prompt: String(definition.prompt ?? ''),
      toolAccess: definition.tools ?? 'none',
      model: String(definition.model ?? ''),
      thinking: String(definition.thinking ?? ''),
      color: String(definition.color ?? ''),
      outputFormat: 'text',
      multiTurn: Boolean(definition.multiTurn),
      utility: '',
      command: '',
      params: '{}',
      timeoutMs: '',
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
      const response = await fetch('/api/generate/materia-role', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ brief }),
      });
      const body = await response.json() as RoleGenerationResponse;
      if (!response.ok || body.ok === false || typeof body.prompt !== 'string') throw new Error(body.error ?? 'Materia role generation failed.');
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
      setMateriaForm(emptyMateriaForm());
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
    const response = await fetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: saveTarget, config: normalizeMateriaConfigEdges(draftConfig) }),
    });
    const body = await response.json();
    if (!response.ok || body.ok === false) throw new Error(body.error ?? 'Save failed');
    setBaselineConfig(normalizeMateriaConfigEdges(draftConfig));
    setDraftConfig(normalizeMateriaConfigEdges(draftConfig));
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
              {Object.keys(loadouts).map((name) => (
                <button key={name} onClick={() => switchLoadout(name)} className={`loadout-card ${name === activeLoadoutName ? 'loadout-card-active' : ''}`}>
                  <span>{name}</span>
                  <small>{Object.keys(loadouts[name].nodes ?? {}).length} sockets</small>
                </button>
              ))}
            </div>
          </aside>

          <section className="fantasy-panel loadout-graph-panel p-6">
            <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="text-2xl font-bold">Visual materia grid</h2>
                <p className="text-sm text-slate-400">Drag orbs into sockets, drag socketed orbs onto the graph background to unsocket, drag socket cards to arrange them, or click a palette orb then click a socket.</p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" className="materia-button-secondary" data-testid="create-task-loop" onClick={createTaskIteratorLoop}>Create Task Loop</button>
              <label className="text-sm text-slate-300">Edit name
                <input className="ml-3 rounded-xl border border-cyan-200/20 bg-slate-950/80 px-3 py-2 text-cyan-100" value={activeLoadoutName ?? ''} onChange={(event) => renameActiveLoadout(event.target.value)} />
              </label>
              </div>
            </div>

            <div className="loadout-graph-viewport" data-testid="socket-grid-viewport" onDragOver={(event) => event.preventDefault()} onDrop={handleGraphDrop}>
              <div className="loadout-graph-canvas" data-testid="socket-grid" style={{ width: `${loadoutGraph.width}px`, height: `${loadoutGraph.height}px` }}>
              <svg className="loadout-edge-layer" width={loadoutGraph.width} height={loadoutGraph.height} aria-label="Loadout edges">
                <defs>
                  <marker id="materia-edge-arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth">
                    <path d="M2,2 L10,6 L2,10 Z" className="loadout-edge-arrow" />
                  </marker>
                </defs>
                {routedEdges.map(({ edge, path, labelX, labelY, labelRotate, routeClass }) => {
                  return (
                    <g
                      key={edge.id}
                      data-testid={`edge-${edge.from}-${edge.to}-${edge.edgeIndex ?? 'next'}`}
                      role="button"
                      tabIndex={0}
                      className={`loadout-edge loadout-edge-${edgeConditionClass(edge.when)} loadout-edge-route-${routeClass} loadout-edge-clickable`}
                      onClick={() => toggleEdgeCondition(edge)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          toggleEdgeCondition(edge);
                        }
                      }}
                    >
                      <path d={path} markerEnd="url(#materia-edge-arrow)" />
                      <text x={labelX} y={labelY} transform={`rotate(${labelRotate} ${labelX} ${labelY})`}>{edgeConditionLabel(edge.when)}</text>
                    </g>
                  );
                })}
              </svg>
              {loopRegions.map((loop) => (
                <div
                  key={loop.id}
                  className="loadout-loop-region"
                  data-testid={`loop-region-${loop.id}`}
                  style={{ left: `${loop.x}px`, top: `${loop.y}px`, width: `${loop.width}px`, height: `${loop.height}px` }}
                  title={loop.summary}
                  aria-label={`${loop.label} loop: ${loop.summary}`}
                >
                  <span className="loadout-loop-badge">Loop</span>
                  <span className="loadout-loop-title">{loop.label}</span>
                  <span className="loadout-loop-summary">{loop.summary}</span>
                </div>
              ))}
              {loadoutGraph.sockets.map((socket) => {
                const { id, node, index, x, y } = socket;
                const dragPreview = socketLayoutDrag?.socketId === id ? socketLayoutDrag : undefined;
                const socketX = dragPreview?.currentX ?? x;
                const socketY = dragPreview?.currentY ?? y;
                const nodeLabel = getNodeLabel(id, node);
                const socketHoverDetails = buildSocketHoverDetails(id, node, materia);
                return (
                <button
                  key={id}
                  data-testid={`socket-${id}`}
                  className={`materia-socket graph-materia-socket ${selectedMateriaId ? 'materia-socket-selectable' : ''} ${id === currentMonitorNode ? 'materia-socket-active' : ''} ${dragPreview ? 'graph-materia-socket-dragging' : ''}`}
                  style={{ left: `${socketX}px`, top: `${socketY}px` }}
                  onClick={() => handleSocketClick(id)}
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
                      <Orb color={nodeColor(id, index, materia, node)} label={socketHoverDetails} empty={isEmptySocket(node)} />
                    </div>
                  </div>
                  <span className="materia-socket-label">{nodeLabel}</span>
                </button>
                );
              })}
              </div>
            </div>

            {Object.keys(activeLoadout?.loops ?? {}).length > 0 && (
              <div className="mt-4 rounded-2xl border border-cyan-200/15 bg-slate-950/55 p-4" data-testid="loop-editor-panel">
                <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-200">Loop exits</h3>
                <p className="mt-1 text-xs text-slate-400">Loop exit conditions use the same canonical edge model as graph edges.</p>
                <div className="mt-3 grid gap-3">
                  {Object.entries(activeLoadout?.loops ?? {}).map(([loopId, loop]) => {
                    const exit = loop.exit ?? { when: 'satisfied' as MateriaEdgeCondition, to: 'end' };
                    return (
                      <div key={loopId} className="flex flex-wrap items-end gap-3 rounded-xl border border-cyan-200/10 bg-slate-900/60 p-3" data-testid={`loop-editor-${loopId}`}>
                        <div className="min-w-48 flex-1">
                          <div className="font-semibold text-cyan-100">{loop.label ?? loopId}</div>
                          <div className="text-xs text-slate-400">Members: {loop.nodes.join(', ')}</div>
                        </div>
                        <label className="text-xs uppercase tracking-[0.16em] text-slate-400">Exit condition
                          <select className="mt-1 block rounded-xl border border-cyan-200/20 bg-slate-950/80 px-3 py-2 text-cyan-100" data-testid={`loop-exit-condition-${loopId}`} value={exit.when} onChange={(event) => updateLoopExit(loopId, { when: event.target.value as MateriaEdgeCondition })}>
                            {Object.entries(edgeConditionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                          </select>
                        </label>
                        <label className="text-xs uppercase tracking-[0.16em] text-slate-400">Exit target
                          <select className="mt-1 block rounded-xl border border-cyan-200/20 bg-slate-950/80 px-3 py-2 text-cyan-100" data-testid={`loop-exit-target-${loopId}`} value={exit.to} onChange={(event) => updateLoopExit(loopId, { to: event.target.value })}>
                            <option value="end">end</option>
                            {Object.keys(activeLoadout?.nodes ?? {}).map((nodeId) => <option key={nodeId} value={nodeId}>{nodeId}</option>)}
                          </select>
                        </label>
                        {loop.exit && <button type="button" className="materia-button-secondary" data-testid={`loop-exit-clear-${loopId}`} onClick={() => clearLoopExit(loopId)}>Clear exit</button>}
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
                      <h3 id="socket-action-title" className="mt-1 text-2xl font-black text-white">{socketActionId}</h3>
                      <p className="mt-1 text-sm text-slate-300">{getNodeLabel(socketActionId, activeLoadout.nodes[socketActionId])}</p>
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
                            {Object.keys(activeLoadout.nodes ?? {}).filter((id) => id !== socketActionId).map((id) => <option key={id} value={id}>{id}</option>)}
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
                      </div>
                      <div className="edge-removal-list" data-testid="edge-removal-list">
                        <p className="text-xs uppercase tracking-[0.24em] text-cyan-200">Outgoing edges</p>
                        {((activeLoadout.nodes[socketActionId] as LegacyPipelineNode).next) && (
                          <button type="button" className="edge-removal-row" data-testid={`remove-next-edge-${socketActionId}`} onClick={() => removeLegacyNextEdge(socketActionId)}>
                            Remove legacy flow to {(activeLoadout.nodes[socketActionId] as LegacyPipelineNode).next}
                          </button>
                        )}
                        {(activeLoadout.nodes[socketActionId].edges ?? []).map((edge, index) => (
                          <button key={`${edge.to}-${index}`} type="button" className="edge-removal-row" data-testid={`remove-edge-${socketActionId}-${index}`} onClick={() => removeEdge(socketActionId, index)}>
                            Remove {edgeConditionLabel(edge.when)} edge to {edge.to}
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
                {palette.map(([id, node], index) => (
                  <button key={id} draggable data-testid={`palette-${id}`} onDragStart={(event) => dragMateria({ kind: 'palette', materiaId: id }, event)} onClick={() => setSelectedMateriaId(selectedMateriaId === id ? undefined : id)} className={`palette-orb ${selectedMateriaId === id ? 'palette-orb-selected' : ''}`}>
                    <Orb small color={nodeColor(id, index, materia, node)} label={id} />
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
            <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_14rem_14rem_14rem_10rem]">
              <label className="graph-field">Prompt
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
              <label className="graph-field">Color
                <input data-testid="materia-color" value={materiaForm.color} onChange={(event) => setMateriaForm({ ...materiaForm, color: event.target.value })} placeholder="from-sky-200 via-cyan-300 to-blue-600" />
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

          {materiaForm.behavior === 'prompt' && (
            <section className="mt-5 rounded-2xl border border-cyan-200/20 bg-slate-950/50 p-4" aria-label="Generate role prompt instructions">
              <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
                <label className="graph-field">Generate role prompt from brief
                  <textarea data-testid="role-generation-brief" className="min-h-24" value={roleBrief} onChange={(event) => setRoleBrief(event.target.value)} placeholder="Describe the persona, responsibilities, constraints, and style for this materia…" />
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

          <div className="mt-5 flex flex-wrap gap-3">
            <button className="materia-button" data-testid="save-materia-form" onClick={() => { void saveMateriaForm(); }}>{materiaForm.editingNodeId ? 'Update materia' : 'Create materia'}</button>
            <button className="materia-button-secondary" onClick={() => { setMateriaForm(emptyMateriaForm()); discardGeneratedRolePrompt(); }}>Clear form</button>
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
