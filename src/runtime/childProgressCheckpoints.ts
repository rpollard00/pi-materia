import { CHILD_PROGRESS_CHECKPOINT_EVENT_TYPE } from "../application/childCastRunner.js";
import {
  deriveNominalParallelLaneProgress,
  type NominalParallelLaneProgressDefinition,
} from "../domain/parallelProgress.js";

export { CHILD_PROGRESS_CHECKPOINT_EVENT_TYPE };

type CheckpointWriter = (line: string) => void;

interface ActiveEmitter {
  definition: NominalParallelLaneProgressDefinition;
  cursorName: string;
  lastPosition?: number;
  write: CheckpointWriter;
}

let activeEmitter: ActiveEmitter | undefined;

/**
 * Enable content-free nominal progress records for one isolated child launch.
 * The returned disposer is ownership-aware so an older launch cannot disable a
 * newer emitter in tests or embedded runtimes.
 */
export function beginChildProgressCheckpointEmission(
  definition: NominalParallelLaneProgressDefinition,
  cursorName: string,
  write: CheckpointWriter = (line) => { process.stdout.write(line); },
): () => void {
  const emitter: ActiveEmitter = { definition, cursorName, write };
  activeEmitter = emitter;
  return () => {
    if (activeEmitter === emitter) activeEmitter = undefined;
  };
}

/**
 * Emit at a socket-start boundary, but only when the graph-derived position
 * changes. The protocol projection contains no cast, item, message, or tool
 * data; the parent process already owns the child identity and event sequence.
 */
export function emitChildNodeProgressCheckpoint(
  state: { cursors: Readonly<Record<string, number>> },
  activeSocketId: string,
): boolean {
  const emitter = activeEmitter;
  if (!emitter) return false;
  const progress = deriveNominalParallelLaneProgress({
    definition: emitter.definition,
    workItemCursor: state.cursors[emitter.cursorName],
    activeSocketId,
  });
  if (emitter.lastPosition === progress.position) return false;
  emitter.lastPosition = progress.position;
  emitter.write(`${JSON.stringify({
    type: CHILD_PROGRESS_CHECKPOINT_EVENT_TYPE,
    position: progress.position,
    total: progress.total,
  })}\n`);
  return true;
}
