import { canonicalGeneratorConfigFor } from '../../../../../generator.js';
import { edgeConditionState } from '../../../../../graphValidation.js';
import type { MateriaEdgeCondition } from '../../../../../types.js';
import {
  extractMateriaReference,
  formatSocketLabel,
  getNodeLabel,
  isEmptySocket,
  resolveSocketDisplayLabel,
  type LegacyPipelineNode,
  type MateriaConfig,
  type PipelineConfig,
  type PipelineNode,
} from '../../loadoutModel.js';
import {
  edgeConditionLabels,
  loopAccentPalette,
  loopCanvasPadding,
  loopCyclePadding,
  loopHeaderHeight,
  loopHeaderMaxWidth,
  loopHeaderMinWidth,
  loopHeaderOffset,
  socketCardWidth,
  socketGraphExtent,
  socketLayoutOffsetX,
  socketLayoutOffsetY,
  socketLayoutRowGap,
  socketLayoutUnitX,
  socketLayoutUnitY,
  socketStageHeight,
  socketStageOffsetX,
  socketStageSize,
} from '../constants.js';
import type {
  LayoutSocketsResult,
  LoadoutEdge,
  LoopExitBadge,
  LoopMembership,
  LoopRegion,
  PositionedSocket,
  RoutedLoadoutEdge,
  SocketAnchorPoint,
  SocketAnchorSide,
} from '../types.js';

export function buildLoadouts(config: MateriaConfig): Record<string, PipelineConfig> {
  if (config.loadouts && Object.keys(config.loadouts).length > 0) return config.loadouts;
  return {};
}

function loopAccent(index: number) {
  return loopAccentPalette[index % loopAccentPalette.length];
}

export function edgeConditionLabel(when?: string) {
  const state = edgeConditionState({ when });
  if (state !== 'invalid') return edgeConditionLabels[state];
  return 'Invalid';
}

export function edgeConditionClass(when?: string) {
  const state = edgeConditionState({ when });
  if (state === 'not_satisfied') return 'unsatisfied';
  if (state === 'satisfied') return 'satisfied';
  return 'default';
}

export function toggledEdgeCondition(when?: string): MateriaEdgeCondition {
  const state = edgeConditionState({ when });
  if (state === 'always') return 'satisfied';
  if (state === 'satisfied') return 'not_satisfied';
  return 'always';
}

export function materiaGeneratorOutput(definition?: NonNullable<MateriaConfig['materia']>[string]): string | undefined {
  return canonicalGeneratorConfigFor(definition)?.output;
}

export function isGeneratorSocket(node?: PipelineNode, definitions?: MateriaConfig['materia']): boolean {
  const referenced = extractMateriaReference(node);
  return Boolean(referenced && materiaGeneratorOutput(definitions?.[referenced.materia]));
}

export function hasIteratorBehavior(node?: PipelineNode, definitions?: MateriaConfig['materia']): boolean {
  if (node?.foreach) return true;
  const referenced = extractMateriaReference(node);
  return Boolean(referenced && (definitions?.[referenced.materia]?.foreach || materiaGeneratorOutput(definitions?.[referenced.materia])));
}

export function formatIteratorBehavior(node?: PipelineNode, definitions?: MateriaConfig['materia']): string {
  const referenced = extractMateriaReference(node);
  const definition = referenced ? definitions?.[referenced.materia] : undefined;
  const generatorOutput = materiaGeneratorOutput(definition);
  if (generatorOutput) {
    const generatorConfig = canonicalGeneratorConfigFor(definition);
    return definition?.generator === true
      ? 'Generator: canonical workItems output'
      : `Generator: migration-only ${generatorOutput}${generatorConfig?.itemType ? ` (${generatorConfig.itemType} list)` : ''}`;
  }
  const foreach = node?.foreach ?? (referenced ? definitions?.[referenced.materia]?.foreach : undefined);
  if (foreach) return `Iterator: ${foreach.items}${foreach.as ? ` as ${foreach.as}` : ''}${foreach.done ? ` until ${foreach.done}` : ''}`;
  return 'Iterator materia';
}

function loopConsumerSummary(loop: NonNullable<PipelineConfig['loops']>[string]): string {
  if (loop.consumes) return `Loop consumes: ${loop.consumes.from}.${loop.consumes.output ?? 'workItems'}`;
  if (loop.iterator) return `Loop consumes: ${loop.iterator.items}${loop.iterator.as ? ` as ${loop.iterator.as}` : ''}${loop.iterator.done ? ` until ${loop.iterator.done}` : ''}`;
  return 'Loop region';
}

function loopConsumerForSocket(loadout: PipelineConfig | undefined, socketId: string): string | undefined {
  const loop = Object.values(loadout?.loops ?? {}).find((candidate) => candidate.nodes.includes(socketId));
  return loop ? loopConsumerSummary(loop) : undefined;
}

function formatLoopExitSummary(loadout: PipelineConfig | undefined, loopId: string, loop: NonNullable<PipelineConfig['loops']>[string]): string | undefined {
  if (!loop.exit) return undefined;
  const label = formatLoopDisplayLabel(loadout, loopId, loop.nodes, loop.label);
  const target = loop.exit.to === 'end' ? 'end' : formatSocketLabel(loop.exit.to, loadout?.nodes?.[loop.exit.to]);
  return `Loop exit for ${label}: ${edgeConditionLabel(loop.exit.when)} → ${target}`;
}

function loopExitSummariesForSocket(loadout: PipelineConfig | undefined, socketId: string): string[] {
  return Object.entries(loadout?.loops ?? {}).flatMap(([loopId, loop]) => {
    if (loop.exit?.from !== socketId) return [];
    const summary = formatLoopExitSummary(loadout, loopId, loop);
    return summary ? [summary] : [];
  });
}

function generatorLoopOutput(edge: Pick<LoadoutEdge, 'from' | 'to'>, loadout: PipelineConfig | undefined): string | undefined {
  const loop = Object.values(loadout?.loops ?? {}).find((candidate) => candidate.consumes?.from === edge.from && candidate.nodes.includes(edge.to));
  return loop?.consumes ? loop.consumes.output ?? 'workItems' : undefined;
}

function generatorToGeneratorOutput(edge: Pick<LoadoutEdge, 'from' | 'to'>, loadout: PipelineConfig | undefined, definitions?: MateriaConfig['materia']): string | undefined {
  const fromNode = loadout?.nodes?.[edge.from];
  const toNode = loadout?.nodes?.[edge.to];
  return isGeneratorSocket(fromNode, definitions) && isGeneratorSocket(toNode, definitions) ? 'workItems' : undefined;
}

function generatorEdgeOutput(edge: Pick<LoadoutEdge, 'from' | 'to'>, loadout: PipelineConfig | undefined, definitions?: MateriaConfig['materia']): string | undefined {
  return generatorLoopOutput(edge, loadout) ?? generatorToGeneratorOutput(edge, loadout, definitions);
}

export function isGeneratorOutputEdge(edge: Pick<LoadoutEdge, 'from' | 'to'>, loadout: PipelineConfig | undefined, definitions?: MateriaConfig['materia']): boolean {
  return Boolean(generatorEdgeOutput(edge, loadout, definitions));
}

export function generatorEdgeLabel(edge: Pick<LoadoutEdge, 'from' | 'to' | 'when'>, loadout: PipelineConfig | undefined, definitions?: MateriaConfig['materia']): string {
  const output = generatorEdgeOutput(edge, loadout, definitions);
  return output ? `Generator output: ${output}` : edgeConditionLabel(edge.when);
}

export function iteratorBadgeLabel(details?: string): string {
  if (details?.startsWith('Generator: canonical')) return 'Generator';
  if (details?.startsWith('Generator: migration-only')) {
    const output = details.slice('Generator: migration-only'.length).trim().split(/\s|\(/)[0];
    return output ? `Legacy: ${output}` : 'Legacy generator';
  }
  return 'Iterator';
}

function summarizeHoverText(value?: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

export function buildSocketHoverDetails(id: string, node?: PipelineNode, definitions?: MateriaConfig['materia'], loadout?: PipelineConfig): string {
  const lines = [`Socket: ${id}`, `Display: ${formatSocketLabel(id, node)}`];
  if (isEmptySocket(node)) return [...lines, 'Empty socket'].join('\n');

  const label = getNodeLabel(id, node);
  lines.push(`Label: ${label}`);
  if (hasIteratorBehavior(node, definitions)) lines.push(formatIteratorBehavior(node, definitions));
  const loopConsumer = loopConsumerForSocket(loadout, id);
  if (loopConsumer) lines.push(loopConsumer);
  lines.push(...loopExitSummariesForSocket(loadout, id));
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
    lines.push(`Edges: ${node.edges.map((edge) => `${generatorEdgeLabel({ from: id, to: edge.to, when: edge.when }, loadout, definitions)} → ${formatSocketLabel(edge.to, loadout?.nodes?.[edge.to])}`).join(', ')}`);
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

export function layoutValueForPosition(position: number, offset: number, unit: number) {
  const raw = position - offset;
  const asUnits = raw / unit;
  const value = Math.abs(asUnits) <= 20 ? asUnits : raw;
  return Math.round(value * 1000000000000) / 1000000000000;
}

function rounded(value: number) {
  return Math.round(value * 10) / 10;
}

export function rectanglesIntersect(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
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
  return { x: socket.x + socketStageOffsetX + socketStageSize / 2, y: socket.y + socketStageHeight / 2 };
}

function socketAnchor(socket: PositionedSocket, side: SocketAnchorSide): SocketAnchorPoint {
  const center = socketCenter(socket);
  if (side === 'top') return { x: center.x, y: socket.y, side };
  if (side === 'bottom') return { x: center.x, y: socket.y + socketStageHeight, side };
  if (side === 'left') return { x: socket.x + socketStageOffsetX, y: center.y, side };
  return { x: socket.x + socketStageOffsetX + socketStageSize, y: center.y, side };
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

function selfLoopRoute(socket: PositionedSocket, lane: number) {
  const source = socketAnchor(socket, 'right');
  const target = socketAnchor(socket, 'bottom');
  // Self/retry routes need much more clearance than normal edge lanes: keep the
  // curve outside the socket body so labels such as "not satisfied" are readable.
  const outward = Math.max(108, 124 + lane);
  const drop = 96 + Math.abs(lane) * 0.55;
  const sourceControl = { x: source.x + outward, y: source.y };
  const targetControl = { x: source.x + outward, y: target.y + drop };
  const labelX = rounded(source.x + outward * 0.72);
  const labelY = rounded(target.y + drop * 0.36);

  return {
    path: formatCurvedPath([source, sourceControl, targetControl, target]),
    labelX,
    labelY,
    labelRotate: 0,
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
    const isSelfLoop = edge.from === edge.to;
    const anchors = chooseSocketAnchors(edge, from, to);
    const route = isSelfLoop ? selfLoopRoute(from, lane) : curvedRoute(anchors.source, anchors.target, lane);
    const backward = !isSelfLoop && anchors.source.side === 'left' && anchors.target.side === 'right';

    return {
      edge,
      routeClass: isSelfLoop ? 'loop' as const : backward ? 'backward' as const : 'forward' as const,
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

type Point = { x: number; y: number };

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function loopCyclePath(sockets: PositionedSocket[]): string {
  const centers = sockets.map(socketCenter);
  if (centers.length === 1) {
    const center = centers[0];
    const rx = socketStageSize / 2 + loopCyclePadding;
    const ry = socketStageHeight / 2 + loopCyclePadding;
    return [
      `M ${rounded(center.x - rx)} ${rounded(center.y)}`,
      `C ${rounded(center.x - rx)} ${rounded(center.y - ry)}, ${rounded(center.x + rx)} ${rounded(center.y - ry)}, ${rounded(center.x + rx)} ${rounded(center.y)}`,
      `C ${rounded(center.x + rx)} ${rounded(center.y + ry)}, ${rounded(center.x - rx)} ${rounded(center.y + ry)}, ${rounded(center.x - rx)} ${rounded(center.y)}`,
    ].join(' ');
  }

  const start = midpoint(centers[centers.length - 1], centers[0]);
  const segments = [`M ${rounded(start.x)} ${rounded(start.y)}`];
  centers.forEach((center, index) => {
    const next = centers[(index + 1) % centers.length];
    const through = midpoint(center, next);
    segments.push(`Q ${rounded(center.x)} ${rounded(center.y)} ${rounded(through.x)} ${rounded(through.y)}`);
  });
  return segments.join(' ');
}

function estimateLoopHeaderWidth(label: string, summary: string) {
  const titleWidth = label.length * 8.2 + 132;
  const summaryWidth = summary.length * 5.4 + 52;
  return Math.max(loopHeaderMinWidth, Math.min(loopHeaderMaxWidth, Math.max(titleWidth, summaryWidth)));
}

function loopMemberLabels(loadout: PipelineConfig | undefined, socketIds: string[]): string[] {
  return socketIds.map((socketId) => resolveSocketDisplayLabel(loadout, socketId));
}

export function formatLoopDisplayLabel(loadout: PipelineConfig | undefined, loopId: string, socketIds: string[], label?: string): string {
  const memberSequence = loopMemberLabels(loadout, socketIds).join(' → ');
  if (!label) return memberSequence || loopId;
  return label.replace(/Socket-\d+(?=\b)/g, (socketId) => resolveSocketDisplayLabel(loadout, socketId));
}

export function getLoopRegions(loadout: PipelineConfig | undefined, positions: Map<string, PositionedSocket>): LoopRegion[] {
  return Object.entries(loadout?.loops ?? {}).flatMap(([id, loop], index) => {
    const sockets = loop.nodes.map((nodeId) => positions.get(nodeId)).filter(Boolean) as PositionedSocket[];
    if (sockets.length === 0) return [];
    const minX = Math.min(...sockets.map((socket) => socket.x));
    const minY = Math.min(...sockets.map((socket) => socket.y));
    const maxX = Math.max(...sockets.map((socket) => socket.x + socketCardWidth));
    const consumer = loopConsumerSummary(loop);
    const exit = loop.exit ? `Exit: ${formatSocketLabel(loop.exit.from, loadout?.nodes?.[loop.exit.from])}.${edgeConditionLabel(loop.exit.when)} → ${loop.exit.to === 'end' ? 'end' : formatSocketLabel(loop.exit.to, loadout?.nodes?.[loop.exit.to])}` : undefined;
    const summary = [consumer, exit].filter(Boolean).join(' • ');
    const label = formatLoopDisplayLabel(loadout, id, loop.nodes, loop.label);
    const socketSpanWidth = maxX - minX;
    const headerWidth = Math.min(loopHeaderMaxWidth, Math.max(estimateLoopHeaderWidth(label, summary), socketSpanWidth + 48));
    const headerX = rounded(minX + socketSpanWidth / 2 - headerWidth / 2);
    const headerY = minY - loopHeaderOffset;
    return [{ id, label, x: headerX, y: headerY, width: headerWidth, height: loopHeaderHeight, summary, cyclePath: loopCyclePath(sockets), ...loopAccent(index) }];
  });
}

export function getLoopMemberships(loadout: PipelineConfig | undefined): Map<string, LoopMembership> {
  const memberships = new Map<string, LoopMembership>();
  Object.entries(loadout?.loops ?? {}).forEach(([loopId, loop], index) => {
    const accent = loopAccent(index);
    for (const socketId of loop.nodes) {
      const existing = memberships.get(socketId);
      memberships.set(socketId, existing
        ? { ...existing, loopIds: [...existing.loopIds, loopId] }
        : { loopIds: [loopId], ...accent });
    }
  });
  return memberships;
}

export function getLoopExitBadges(loadout: PipelineConfig | undefined): Map<string, LoopExitBadge> {
  const badges = new Map<string, LoopExitBadge>();
  Object.entries(loadout?.loops ?? {}).forEach(([loopId, loop], index) => {
    if (!loop.exit?.from) return;
    const socketId = loop.exit.from;
    const accent = loopAccent(index);
    const summary = formatLoopExitSummary(loadout, loopId, loop) ?? `Loop exit for ${loopId}`;
    const existing = badges.get(socketId);
    badges.set(socketId, existing
      ? { ...existing, loopIds: [...existing.loopIds, loopId], title: `${existing.title}\n${summary}` }
      : { loopIds: [loopId], title: summary, ...accent });
  });
  return badges;
}

export function layoutSockets(loadout?: PipelineConfig): LayoutSocketsResult {
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
  let sockets = entries.map(([id, node], index) => {
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

  const positionMap = () => new Map(sockets.map((socket) => [socket.id, socket]));
  let loopRegions = getLoopRegions(loadout, positionMap());
  const minRenderedX = Math.min(...sockets.map((socket) => socket.x), ...loopRegions.map((loop) => loop.x), loopCanvasPadding);
  const minRenderedY = Math.min(...sockets.map((socket) => socket.y), ...loopRegions.map((loop) => loop.y), loopCanvasPadding);
  const shiftX = Math.max(0, loopCanvasPadding - minRenderedX);
  const shiftY = Math.max(0, loopCanvasPadding - minRenderedY);
  if (shiftX > 0 || shiftY > 0) {
    sockets = sockets.map((socket) => ({ ...socket, x: socket.x + shiftX, y: socket.y + shiftY }));
    loopRegions = getLoopRegions(loadout, positionMap());
  }

  const width = Math.max(448, ...sockets.map((socket) => socket.x + socketGraphExtent), ...loopRegions.map((loop) => loop.x + loop.width + loopCanvasPadding));
  const height = Math.max(256, ...sockets.map((socket) => socket.y + socketGraphExtent), ...loopRegions.map((loop) => loop.y + loop.height + loopCanvasPadding));
  return { sockets, edges, width, height };
}
