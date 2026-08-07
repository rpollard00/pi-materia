import { describe, expect, it } from 'vitest';
import { summarizeParallelRun } from '../../../../../application/parallelMonitoring.js';
import { createParallelRunState } from '../../../../../domain/parallelRun.js';
import {
  formatParallelLaneStatus,
  formatParallelLoopStatus,
  parallelLaneAccessibleLabel,
} from './parallelLoopStatus.js';

function summary() {
  const run = createParallelRunState({
    parentCastId: 'cast-1',
    loopId: 'build',
    runId: 'run-1',
    planIdentity: { version: 1, planId: 'plan-1', workItemCount: 2 },
    graphIdentity: { graphHash: 'graph-1' },
    configIdentity: { configHash: 'config-1', loopId: 'build', maxConcurrency: 2 },
    queue: [
      { laneId: 'lane-api', name: 'API', streamIndex: 0, workItemIndexes: [0] },
      { laneId: 'lane-ui', name: 'UI', streamIndex: 1, workItemIndexes: [1] },
    ],
    now: 1,
  });
  run.lanes['lane-api']!.status = 'accepted';
  run.lanes['lane-ui']!.status = 'failed';
  run.lanes['lane-ui']!.attempt = 4;
  return summarizeParallelRun(run);
}

describe('parallel lane status presentation', () => {
  it('keeps immutable lane numbers visible across ordering, acceptance, and repeated attempts', () => {
    const value = summary();

    expect(formatParallelLoopStatus(value)).toContain('Lanes 1, 2');
    expect(formatParallelLaneStatus(value.lanes[0]!)).toContain('Lane 1 · API · accepted · attempt 1');
    expect(formatParallelLaneStatus(value.lanes[1]!)).toContain('Lane 2 · UI · failed · attempt 4');
    expect(parallelLaneAccessibleLabel(value.lanes[1]!)).toContain('Lane 2');
    expect(parallelLaneAccessibleLabel(value.lanes[1]!)).toContain('lane-ui');
  });
});
