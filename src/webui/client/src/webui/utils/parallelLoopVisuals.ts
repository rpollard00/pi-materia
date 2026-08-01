import type { MateriaEdgeCondition } from '../../../../../types.js';
import type { PipelineConfig } from '../../loadoutModel.js';
import {
  socketCardWidth,
  socketStageHeight,
  socketStageOffsetX,
  socketStageSize,
} from '../constants.js';
import type { ParallelLoopVisuals, PositionedSocket } from '../types.js';

/** Stable ids for derived parallel markers. These markers are visual-only and
 * intentionally do not become graph sockets or persisted edges. */
export function parallelForkVisualId(loopId: string): string {
  return `parallel-fork:${loopId}`;
}

export function parallelBarrierVisualId(loopId: string): string {
  return `parallel-barrier:${loopId}`;
}

export function parallelFanInVisualId(loopId: string, condition: MateriaEdgeCondition, routeId?: string): string {
  return `parallel-fan-in:${loopId}:${routeId ?? condition}`;
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function socketCenter(socket: PositionedSocket): { x: number; y: number } {
  return { x: socket.x + socketStageOffsetX + socketStageSize / 2, y: socket.y + socketStageHeight / 2 };
}

function inboundLoopEdge(loadout: PipelineConfig | undefined, loop: NonNullable<PipelineConfig['loops']>[string]): { from: string; to: string } | undefined {
  const sockets = loadout?.sockets ?? {};
  const source = loop.consumes?.from;
  if (!source || !sockets[source]) return undefined;
  for (const [from, socket] of Object.entries(sockets)) {
    if (from !== source) continue;
    const edge = (socket.edges ?? []).find((candidate) => loop.sockets.includes(candidate.to));
    if (edge) return { from, to: edge.to };
  }
  return undefined;
}

export function buildParallelLoopVisuals(
  loadout: PipelineConfig | undefined,
  loopId: string,
  loop: NonNullable<PipelineConfig['loops']>[string],
  positions: Map<string, PositionedSocket>,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): ParallelLoopVisuals {
  const centerFor = (socketId: string | undefined, fallback: { x: number; y: number }) => {
    const socket = socketId ? positions.get(socketId) : undefined;
    return socket ? socketCenter(socket) : fallback;
  };
  const memberCenters = loop.sockets.map((socketId) => positions.get(socketId)).filter(Boolean).map((socket) => socketCenter(socket as PositionedSocket));
  const firstCenter = memberCenters[0] ?? { x: minX + socketCardWidth / 2, y: minY + socketStageHeight / 2 };
  const inbound = inboundLoopEdge(loadout, loop);
  const sourceCenter = centerFor(inbound?.from, { x: minX - 116, y: firstCenter.y });
  const entryCenter = centerFor(inbound?.to, firstCenter);
  const forkX = rounded(sourceCenter.x + (entryCenter.x - sourceCenter.x) * 0.58);
  const forkY = rounded(sourceCenter.y + (entryCenter.y - sourceCenter.y) * 0.58);
  const forkPath = `M ${rounded(sourceCenter.x)} ${rounded(sourceCenter.y)} C ${rounded(sourceCenter.x + (forkX - sourceCenter.x) * 0.55)} ${rounded(sourceCenter.y)}, ${rounded(forkX - 22)} ${rounded(forkY)} ${forkX} ${forkY}`;
  const branches = [-1, 0, 1].map((offset) => `M ${forkX} ${forkY} C ${forkX + 10} ${forkY} ${forkX + 18} ${rounded(forkY + offset * 18)} ${forkX + 34} ${rounded(forkY + offset * 24)}`).join(' ');

  const barrierX = rounded(maxX + 30);
  const barrierY = rounded(memberCenters.reduce((sum, center) => sum + center.y, 0) / Math.max(memberCenters.length, 1));
  const barrierTop = rounded(Math.max(minY - 12, barrierY - Math.max(32, (maxY - minY) * 0.35)));
  const barrierBottom = rounded(Math.min(maxY + socketStageHeight + 12, barrierY + Math.max(32, (maxY - minY) * 0.35)));
  const barrierPath = `M ${barrierX} ${barrierTop} L ${barrierX} ${barrierBottom}`;
  const conditions: MateriaEdgeCondition[] = ['satisfied', 'not_satisfied'];
  const fanIn = conditions.map((condition, index) => {
    const route = (loop.exits ?? []).find((candidate) => candidate.from === loop.exit?.from && candidate.condition === condition);
    const targetSocketId = route?.targetSocketId;
    const target = centerFor(targetSocketId, { x: barrierX + 104, y: barrierY + (index === 0 ? -28 : 28) });
    const start = { x: barrierX, y: barrierY + (index === 0 ? -16 : 16) };
    const controlX = rounded(start.x + (target.x - start.x) * 0.52);
    const path = `M ${rounded(start.x)} ${rounded(start.y)} C ${controlX} ${rounded(start.y)}, ${controlX} ${rounded(target.y)} ${rounded(target.x)} ${rounded(target.y)}`;
    return {
      id: parallelFanInVisualId(loopId, condition, route?.id),
      condition,
      ...(targetSocketId ? { targetSocketId } : {}),
      path,
      labelX: rounded((start.x + target.x) / 2),
      labelY: rounded((start.y + target.y) / 2 - 8),
      label: condition === 'satisfied' ? 'Clean fan-in' : 'Conflict resolver',
    };
  });

  return {
    fork: { id: parallelForkVisualId(loopId), x: forkX, y: forkY, path: forkPath, branchesPath: branches, label: 'Parallel fork' },
    barrier: { id: parallelBarrierVisualId(loopId), x: barrierX, y: barrierY, path: barrierPath, label: 'Parallel barrier' },
    fanIn,
  };
}
