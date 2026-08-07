import {
  formatParallelLaneNumber,
  parallelLaneNumber,
  type ParallelLaneMonitorSummary,
  type ParallelRunMonitorSummary,
} from '../../../../../application/parallelMonitoring.js';

/** Human-readable aggregate status for a symbolic loop header. */
export function formatParallelLoopStatus(summary: ParallelRunMonitorSummary): string {
  const { counts } = summary;
  const laneNumbers = summary.lanes
    .map((lane) => parallelLaneNumber(lane.queueIndex))
    .filter((number): number is number => number !== undefined);
  return [
    laneNumbers.length > 0 ? `Lanes ${laneNumbers.join(', ')}` : undefined,
    `Queued ${counts.queued}`,
    `Running ${counts.running}`,
    `Accepted ${counts.accepted}`,
    `Failed ${counts.failed}`,
    `Interrupted ${counts.interrupted}`,
    `Barrier ${summary.barrier.phase} ${counts.barrierReached}/${counts.total}`,
  ].filter((value): value is string => value !== undefined).join(' · ');
}

/**
 * Keep lane paths out of the compact header while making the disclosure's
 * accessible label useful even before its details are expanded.
 */
export function parallelLaneAccessibleLabel(lane: ParallelLaneMonitorSummary): string {
  const artifact = lane.childSession?.artifactRoot ?? lane.childSession?.runDirectory ?? 'artifact pending';
  const scope = lane.scope ? `${lane.scope.id} at ${lane.scope.cwd}` : 'scope pending';
  return `${formatParallelLaneNumber(lane.queueIndex)} (${lane.laneId}, ${lane.status}, attempt ${lane.attempt}), ${scope}, child artifacts ${artifact}`;
}

export function formatParallelLaneStatus(lane: ParallelLaneMonitorSummary): string {
  return `${formatParallelLaneNumber(lane.queueIndex)} · ${lane.name} · ${lane.status} · attempt ${lane.attempt} · items ${lane.workItemIndexes.join(', ') || 'none'}`;
}
