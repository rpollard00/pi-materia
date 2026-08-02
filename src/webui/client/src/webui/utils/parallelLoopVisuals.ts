import type { ParallelBranchRegion } from '../../../../../graph/parallelRegions.js';
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

export function parallelFanInVisualId(loopId: string, _legacyCondition?: unknown, _legacyRouteId?: string): string {
  return `parallel-continuation:${loopId}`;
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function socketCenter(socket: PositionedSocket): { x: number; y: number } {
  return { x: socket.x + socketStageOffsetX + socketStageSize / 2, y: socket.y + socketStageHeight / 2 };
}

export function buildParallelLoopVisuals(
  loadout: PipelineConfig | undefined,
  loopId: string,
  loop: NonNullable<PipelineConfig['loops']>[string],
  region: ParallelBranchRegion,
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
  const sourceCenter = centerFor(region.generatorSocketId, { x: minX - 116, y: firstCenter.y });
  const entryCenter = centerFor(region.entrySocketId, firstCenter);
  const forkX = rounded(sourceCenter.x + (entryCenter.x - sourceCenter.x) * 0.58);
  const forkY = rounded(sourceCenter.y + (entryCenter.y - sourceCenter.y) * 0.58);
  const forkPath = `M ${rounded(sourceCenter.x)} ${rounded(sourceCenter.y)} C ${rounded(sourceCenter.x + (forkX - sourceCenter.x) * 0.55)} ${rounded(sourceCenter.y)}, ${rounded(forkX - 22)} ${rounded(forkY)} ${forkX} ${forkY}`;
  const branches = [-1, 0, 1].map((offset) => `M ${forkX} ${forkY} C ${forkX + 10} ${forkY} ${forkX + 18} ${rounded(forkY + offset * 18)} ${forkX + 34} ${rounded(forkY + offset * 24)}`).join(' ');

  const barrierX = rounded(maxX + 30);
  const barrierY = rounded(memberCenters.reduce((sum, center) => sum + center.y, 0) / Math.max(memberCenters.length, 1));
  const barrierTop = rounded(Math.max(minY - 12, barrierY - Math.max(32, (maxY - minY) * 0.35)));
  const barrierBottom = rounded(Math.min(maxY + socketStageHeight + 12, barrierY + Math.max(32, (maxY - minY) * 0.35)));
  const barrierPath = `M ${barrierX} ${barrierTop} L ${barrierX} ${barrierBottom}`;
  const target = centerFor(region.continuationSocketId, { x: barrierX + 104, y: barrierY });
  const controlX = rounded(barrierX + (target.x - barrierX) * 0.52);
  const path = `M ${barrierX} ${barrierY} C ${controlX} ${barrierY}, ${controlX} ${rounded(target.y)} ${rounded(target.x)} ${rounded(target.y)}`;

  return {
    fork: { id: parallelForkVisualId(loopId), x: forkX, y: forkY, path: forkPath, branchesPath: branches, label: `Parallel fork; prelude ${region.preludeSocketIds.join(' → ') || 'none'}` },
    barrier: { id: parallelBarrierVisualId(loopId), x: barrierX, y: barrierY, path: barrierPath, label: 'Ordered branch barrier' },
    fanIn: [{ id: parallelFanInVisualId(loopId), targetSocketId: region.continuationSocketId, path, labelX: rounded((barrierX + target.x) / 2), labelY: rounded((barrierY + target.y) / 2 - 8), label: 'Continue after barrier' }],
    preludeSocketIds: [...region.preludeSocketIds],
    loopSocketIds: [...region.loopSocketIds],
  };
}
