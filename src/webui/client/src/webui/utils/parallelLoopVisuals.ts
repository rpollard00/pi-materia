import type { ParallelBranchRegion } from '../../../../../graph/parallelRegions.js';
import type { PipelineConfig } from '../../loadoutModel.js';
import {
  socketCardWidth,
  socketStageHeight,
  socketStageOffsetX,
  socketStageSize,
} from '../constants.js';
import type { ParallelLoopVisuals, PositionedSocket } from '../types.js';

type Point = { x: number; y: number };
type SocketSide = 'top' | 'right' | 'bottom' | 'left';
type SocketBoundary = Point & { side: SocketSide };

const parallelLaneSpacing = 9;

/** Stable ids for derived parallel markers. These markers are visual-only and
 * intentionally do not become graph sockets or persisted edges. */
export function parallelForkVisualId(loopId: string): string {
  return `parallel-fork:${loopId}`;
}

/** The continuation id is retained for callers that identify this visual by its
 * former route-oriented name; it is now a direct loop-exit-to-continuation path. */
export function parallelFanInVisualId(loopId: string, _legacyCondition?: unknown, _legacyRouteId?: string): string {
  return `parallel-continuation:${loopId}`;
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function socketCenter(socket: PositionedSocket): Point {
  return { x: socket.x + socketStageOffsetX + socketStageSize / 2, y: socket.y + socketStageHeight / 2 };
}

function socketBoundary(socket: PositionedSocket, side: SocketSide): SocketBoundary {
  const center = socketCenter(socket);
  if (side === 'top') return { x: center.x, y: socket.y, side };
  if (side === 'bottom') return { x: center.x, y: socket.y + socketStageHeight, side };
  if (side === 'left') return { x: socket.x + socketStageOffsetX, y: center.y, side };
  return { x: socket.x + socketStageOffsetX + socketStageSize, y: center.y, side };
}

function chooseSocketBoundaries(from: PositionedSocket, to: PositionedSocket): { source: SocketBoundary; target: SocketBoundary } {
  const sourceCenter = socketCenter(from);
  const targetCenter = socketCenter(to);
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  const sameRow = Math.abs(dy) < socketStageHeight * 0.45;
  const verticalTransition = !sameRow && Math.abs(dy) > Math.abs(dx) * 0.65;

  if (sameRow || (!verticalTransition && Math.abs(dx) >= Math.abs(dy))) {
    return dx >= 0
      ? { source: socketBoundary(from, 'right'), target: socketBoundary(to, 'left') }
      : { source: socketBoundary(from, 'left'), target: socketBoundary(to, 'right') };
  }
  return dy >= 0
    ? { source: socketBoundary(from, 'bottom'), target: socketBoundary(to, 'top') }
    : { source: socketBoundary(from, 'top'), target: socketBoundary(to, 'bottom') };
}

function perpendicular(source: Point, target: Point, distance: number): Point {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: -dy / length * distance, y: dx / length * distance };
}

function cubicPath(source: Point, target: Point, lane: number): { path: string; midpoint: Point } {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.hypot(dx, dy) || 1;
  const direction = { x: dx / distance, y: dy / distance };
  const laneOffset = perpendicular(source, target, lane);
  const start = { x: source.x + laneOffset.x, y: source.y + laneOffset.y };
  const end = { x: target.x + laneOffset.x, y: target.y + laneOffset.y };
  const lead = Math.max(28, Math.min(96, distance * 0.38));
  const sourceControl = { x: start.x + direction.x * lead, y: start.y + direction.y * lead };
  const targetControl = { x: end.x - direction.x * lead, y: end.y - direction.y * lead };
  const midpoint = {
    x: (start.x + 3 * sourceControl.x + 3 * targetControl.x + end.x) / 8,
    y: (start.y + 3 * sourceControl.y + 3 * targetControl.y + end.y) / 8,
  };
  return {
    path: `M ${rounded(start.x)} ${rounded(start.y)} C ${rounded(sourceControl.x)} ${rounded(sourceControl.y)}, ${rounded(targetControl.x)} ${rounded(targetControl.y)} ${rounded(end.x)} ${rounded(end.y)}`,
    midpoint,
  };
}

function centeredLabel(source: Point, target: Point, midpoint: Point): Point {
  const offset = perpendicular(source, target, -16);
  return { x: rounded(midpoint.x + offset.x), y: rounded(midpoint.y + offset.y) };
}

function fallbackCenterFor(
  socketId: string | undefined,
  positions: Map<string, PositionedSocket>,
  fallback: Point,
): Point {
  const socket = socketId ? positions.get(socketId) : undefined;
  return socket ? socketCenter(socket) : fallback;
}

function boundaryPair(
  sourceSocketId: string,
  targetSocketId: string,
  positions: Map<string, PositionedSocket>,
  sourceFallback: Point,
  targetFallback: Point,
): { source: Point; target: Point } {
  const sourceSocket = positions.get(sourceSocketId);
  const targetSocket = positions.get(targetSocketId);
  if (!sourceSocket || !targetSocket) {
    return {
      source: fallbackCenterFor(sourceSocketId, positions, sourceFallback),
      target: fallbackCenterFor(targetSocketId, positions, targetFallback),
    };
  }
  const boundaries = chooseSocketBoundaries(sourceSocket, targetSocket);
  return { source: boundaries.source, target: boundaries.target };
}

export function buildParallelLoopVisuals(
  _loadout: PipelineConfig | undefined,
  loopId: string,
  loop: NonNullable<PipelineConfig['loops']>[string],
  region: ParallelBranchRegion,
  positions: Map<string, PositionedSocket>,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): ParallelLoopVisuals {
  const memberCenters = loop.sockets
    .map((socketId) => positions.get(socketId))
    .filter((socket): socket is PositionedSocket => Boolean(socket))
    .map(socketCenter);
  const firstCenter = memberCenters[0] ?? { x: minX + socketCardWidth / 2, y: minY + socketStageHeight / 2 };
  const forkBoundaries = boundaryPair(
    region.generatorSocketId,
    region.entrySocketId,
    positions,
    { x: minX - socketCardWidth, y: firstCenter.y },
    firstCenter,
  );
  const forkRoutes = [-1, 0, 1].map((lane) => cubicPath(forkBoundaries.source, forkBoundaries.target, lane * parallelLaneSpacing));
  const forkLabel = centeredLabel(forkBoundaries.source, forkBoundaries.target, forkRoutes[1]!.midpoint);

  const loopExitSocketId = loop.exit?.from
    ?? loop.exits?.[0]?.from
    ?? region.loopSocketIds[region.loopSocketIds.length - 1]
    ?? region.entrySocketId;
  const exitFallback = {
    x: maxX + socketCardWidth / 2,
    y: memberCenters.reduce((sum, center) => sum + center.y, 0) / Math.max(memberCenters.length, 1),
  };
  const continuationFallback = { x: exitFallback.x + 104, y: exitFallback.y };
  const fanInBoundaries = boundaryPair(
    loopExitSocketId,
    region.continuationSocketId,
    positions,
    exitFallback,
    continuationFallback,
  );
  const fanInRoute = cubicPath(fanInBoundaries.source, fanInBoundaries.target, 0);
  const fanInLabel = centeredLabel(fanInBoundaries.source, fanInBoundaries.target, fanInRoute.midpoint);

  return {
    fork: {
      id: parallelForkVisualId(loopId),
      sourceSocketId: region.generatorSocketId,
      targetSocketId: region.entrySocketId,
      paths: forkRoutes.map((route) => route.path),
      arrowPathIndex: 1,
      labelX: forkLabel.x,
      labelY: forkLabel.y,
      label: 'Fan-Out',
    },
    fanIn: [{
      id: parallelFanInVisualId(loopId),
      sourceSocketId: loopExitSocketId,
      targetSocketId: region.continuationSocketId,
      path: fanInRoute.path,
      labelX: fanInLabel.x,
      labelY: fanInLabel.y,
      label: 'Fan-In',
    }],
    preludeSocketIds: [...region.preludeSocketIds],
    loopSocketIds: [...region.loopSocketIds],
  };
}
