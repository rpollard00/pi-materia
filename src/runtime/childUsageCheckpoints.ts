import { CHILD_USAGE_CHECKPOINT_EVENT_TYPE } from "../application/childCastRunner.js";
import type { UsageTotals } from "../types.js";

export { CHILD_USAGE_CHECKPOINT_EVENT_TYPE };

type CheckpointWriter = (line: string) => void;

interface ActiveEmitter {
  last?: UsageTotals;
  write: CheckpointWriter;
}

let activeEmitter: ActiveEmitter | undefined;

/**
 * Enable canonical usage checkpoint writes for the lifetime of a child launch.
 * Pi print mode may redirect direct stdout writes to stderr; the parent protocol
 * intentionally accepts this record on either channel.
 */
export function beginChildUsageCheckpointEmission(
  write: CheckpointWriter = (line) => { process.stdout.write(line); },
): () => void {
  const emitter: ActiveEmitter = { write };
  activeEmitter = emitter;
  return () => {
    if (activeEmitter === emitter) activeEmitter = undefined;
  };
}

/** Emit the cumulative, post-agent_end usage aggregate when it has changed. */
export function emitChildUsageCheckpoint(usage: unknown): boolean {
  if (!activeEmitter) return false;
  const projected = projectFiniteUsage(usage);
  if (!projected || sameUsage(activeEmitter.last, projected)) return false;
  activeEmitter.last = projected;
  activeEmitter.write(`${JSON.stringify({ type: CHILD_USAGE_CHECKPOINT_EVENT_TYPE, usage: projected })}\n`);
  return true;
}

/** Copy only the ten finite protocol scalars from a cumulative usage report. */
export function projectFiniteUsage(value: unknown): UsageTotals | undefined {
  if (!isRecord(value)) return undefined;
  const tokens = projectScalars(value.tokens);
  const cost = projectScalars(value.cost);
  return tokens && cost ? { tokens, cost } : undefined;
}

function projectScalars(value: unknown): UsageTotals["tokens"] | undefined {
  if (!isRecord(value)) return undefined;
  const scalars = [value.input, value.output, value.cacheRead, value.cacheWrite, value.total];
  if (!scalars.every((scalar) => typeof scalar === "number" && Number.isFinite(scalar))) return undefined;
  const [input, output, cacheRead, cacheWrite, total] = scalars as number[];
  return { input: input!, output: output!, cacheRead: cacheRead!, cacheWrite: cacheWrite!, total: total! };
}

function sameUsage(left: UsageTotals | undefined, right: UsageTotals): boolean {
  return left !== undefined
    && left.tokens.input === right.tokens.input
    && left.tokens.output === right.tokens.output
    && left.tokens.cacheRead === right.tokens.cacheRead
    && left.tokens.cacheWrite === right.tokens.cacheWrite
    && left.tokens.total === right.tokens.total
    && left.cost.input === right.cost.input
    && left.cost.output === right.cost.output
    && left.cost.cacheRead === right.cost.cacheRead
    && left.cost.cacheWrite === right.cost.cacheWrite
    && left.cost.total === right.cost.total;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
