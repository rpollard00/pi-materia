/** A bounded nominal progress checkpoint for one parallel lane. */
export interface ParallelLaneProgress {
  position: number;
  total: number;
}

/**
 * Immutable progress shape compiled into a sequential child loadout.
 *
 * Only loop sockets occur here. A branch prelude may be part of the child
 * loadout, but it is setup work and deliberately does not contribute steps.
 */
export interface NominalParallelLaneProgressDefinition {
  orderedLoopSocketIds: readonly string[];
  workItemCount: number;
}

export interface DeriveNominalParallelLaneProgressInput {
  definition: NominalParallelLaneProgressDefinition;
  /** Zero-based cursor into this child's ordered work-item stream. */
  workItemCursor: unknown;
  /** Current child socket. A prelude or unknown socket has ordinal zero. */
  activeSocketId?: unknown;
}

/**
 * Derive deterministic, graph-based lane progress without inspecting output.
 *
 * A loop socket contributes its one-based ordinal for the current item. Thus
 * the first socket of the first item is 1/N, while a branch prelude is 0/N.
 * Cursors at or beyond the end represent the terminal bound. Inputs are
 * normalized so this function can safely run against partially restored state.
 */
export function deriveNominalParallelLaneProgress(
  input: DeriveNominalParallelLaneProgressInput,
): ParallelLaneProgress {
  const socketIds = normalizedSocketIds(input.definition.orderedLoopSocketIds);
  const workItemCount = normalizedNonNegativeInteger(input.definition.workItemCount);
  const total = boundedProduct(socketIds.length, workItemCount);
  if (total === 0) return { position: 0, total: 0 };

  const cursor = normalizedCursor(input.workItemCursor, workItemCount);
  if (cursor >= workItemCount) return { position: total, total };

  const activeIndex = typeof input.activeSocketId === "string"
    ? socketIds.indexOf(input.activeSocketId)
    : -1;
  const ordinal = activeIndex < 0 ? 0 : activeIndex + 1;
  const position = Math.min(total, boundedProduct(cursor, socketIds.length) + ordinal);
  return { position, total };
}

function normalizedSocketIds(value: readonly string[]): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((socketId): socketId is string => typeof socketId === "string" && socketId.length > 0);
}

function normalizedNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
}

function normalizedCursor(value: unknown, workItemCount: number): number {
  if (value === Number.POSITIVE_INFINITY) return workItemCount;
  return Math.min(workItemCount, normalizedNonNegativeInteger(value));
}

function boundedProduct(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, left * right);
}
