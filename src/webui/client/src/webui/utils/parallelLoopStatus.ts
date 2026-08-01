import type { ParallelLaneMonitorSummary, ParallelRunMonitorSummary } from '../../../../../application/parallelMonitoring.js';

/** Human-readable aggregate status for a symbolic loop header. */
export function formatParallelLoopStatus(summary: ParallelRunMonitorSummary): string {
  const { counts } = summary;
  return [
    `Queued ${counts.queued}`,
    `Running ${counts.running}`,
    `Accepted ${counts.accepted}`,
    `Failed ${counts.failed}`,
    `Interrupted ${counts.interrupted}`,
    `Fan-in ${counts.fanIn}`,
    `Conflict ${counts.conflict}`,
    `Complete ${counts.completed}/${counts.total}`,
  ].join(' · ');
}

/**
 * Keep lane paths out of the compact header while making the disclosure's
 * accessible label useful even before its details are expanded.
 */
export function parallelLaneAccessibleLabel(lane: ParallelLaneMonitorSummary): string {
  const artifact = lane.childSession?.artifactRoot ?? lane.childSession?.runDirectory ?? 'artifact pending';
  const workspace = lane.workspace?.workspacePath ?? 'workspace pending';
  return `${lane.laneId} (${lane.status}), child artifacts ${artifact}, jj workspace ${workspace}`;
}

export function formatParallelLaneStatus(lane: ParallelLaneMonitorSummary): string {
  return `${lane.name} · ${lane.status} · items ${lane.workItemIndexes.join(', ') || 'none'}`;
}
