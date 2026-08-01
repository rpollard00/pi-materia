import type { DomainIssue, DomainResult } from "../domain/result.js";

/** Top-level handoff field reserved for an explicitly enabled parallel planner. */
export const PARALLEL_SCHEDULE_FIELD = "parallelSchedule" as const;
/** The only planner schedule contract understood by this experimental mode. */
export const PARALLEL_SCHEDULE_VERSION = 1 as const;
/** Descriptive alias for callers that prefer the contract terminology. */
export const PARALLEL_SCHEDULE_CONTRACT_VERSION = PARALLEL_SCHEDULE_VERSION;

export interface ParallelScheduleStream {
  /** Stable human-readable lane name. Stream array order is authoritative. */
  name: string;
  /** Ordered indexes into the sibling canonical workItems array. */
  workItemIndexes: number[];
}

export interface ParallelSchedule {
  version: typeof PARALLEL_SCHEDULE_VERSION;
  streams: ParallelScheduleStream[];
}

/**
 * Validate the planner sidecar against the canonical work-item list.
 *
 * This intentionally does not normalize names or indexes. The planner's stream
 * order and item order are execution inputs, so accepting a corrected or
 * resorted value here would make retries/recovery ambiguous.
 */
export function validateParallelSchedule(
  value: unknown,
  workItemCount: number,
  path = `$.${PARALLEL_SCHEDULE_FIELD}`,
): DomainResult<ParallelSchedule> {
  const issues: DomainIssue[] = [];
  if (!isPlainObject(value)) {
    return { ok: false, issues: [{ path, message: "parallelSchedule must be an object" }] };
  }
  if (!Number.isSafeInteger(workItemCount) || workItemCount < 0) {
    return { ok: false, issues: [{ path: "$.workItems", message: "work item count must be a non-negative safe integer before validating parallelSchedule" }] };
  }

  if (value.version !== PARALLEL_SCHEDULE_VERSION) {
    issues.push({
      path: `${path}.version`,
      message: `parallelSchedule.version must be the supported version ${PARALLEL_SCHEDULE_VERSION}`,
    });
  }

  if (!Array.isArray(value.streams)) {
    issues.push({ path: `${path}.streams`, message: "parallelSchedule.streams must be an array" });
    return { ok: false, issues };
  }

  const names = new Map<string, number>();
  const assigned = new Map<number, string>();
  for (const [streamIndex, stream] of value.streams.entries()) {
    const streamPath = `${path}.streams.${streamIndex}`;
    if (!isPlainObject(stream)) {
      issues.push({ path: streamPath, message: "parallel schedule stream must be an object" });
      continue;
    }

    const name = stream.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      issues.push({ path: `${streamPath}.name`, message: "stream name must be a non-empty string" });
    } else {
      const normalizedName = name.trim();
      const previous = names.get(normalizedName);
      if (previous !== undefined) {
        issues.push({
          path: `${streamPath}.name`,
          message: `stream name ${JSON.stringify(name)} duplicates ${path}.streams.${previous}.name`,
        });
      } else {
        names.set(normalizedName, streamIndex);
      }
    }

    if (!Array.isArray(stream.workItemIndexes)) {
      issues.push({ path: `${streamPath}.workItemIndexes`, message: "stream workItemIndexes must be an array" });
      continue;
    }
    if (stream.workItemIndexes.length === 0) {
      issues.push({ path: `${streamPath}.workItemIndexes`, message: "stream must contain at least one work-item index" });
    }

    for (const [indexPosition, rawIndex] of stream.workItemIndexes.entries()) {
      const indexPath = `${streamPath}.workItemIndexes.${indexPosition}`;
      if (!Number.isSafeInteger(rawIndex) || rawIndex < 0) {
        issues.push({ path: indexPath, message: "work-item index must be a non-negative safe integer" });
        continue;
      }
      if (rawIndex >= workItemCount) {
        issues.push({ path: indexPath, message: `work-item index ${rawIndex} is outside workItems (length ${workItemCount})` });
        continue;
      }
      const previousStream = assigned.get(rawIndex);
      if (previousStream !== undefined) {
        issues.push({
          path: indexPath,
          message: `work-item index ${rawIndex} is assigned more than once (already assigned to stream ${JSON.stringify(previousStream)})`,
        });
      } else {
        assigned.set(rawIndex, typeof name === "string" ? name : `stream-${streamIndex}`);
      }
    }
  }

  if (workItemCount === 0) {
    if (value.streams.length !== 0) {
      issues.push({ path: `${path}.streams`, message: "an empty workItems list must have an empty parallelSchedule.streams array" });
    }
  } else {
    for (let index = 0; index < workItemCount; index += 1) {
      if (!assigned.has(index)) {
        issues.push({ path: `${path}.streams`, message: `work-item index ${index} is not assigned to any stream` });
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      version: PARALLEL_SCHEDULE_VERSION,
      streams: value.streams.map((stream) => ({
        name: stream.name as string,
        workItemIndexes: [...(stream.workItemIndexes as number[])],
      })),
    },
  };
}

export function isParallelSchedule(value: unknown): value is ParallelSchedule {
  if (!isPlainObject(value) || value.version !== PARALLEL_SCHEDULE_VERSION || !Array.isArray(value.streams)) return false;
  return value.streams.every((stream) => isPlainObject(stream) && typeof stream.name === "string" && Array.isArray(stream.workItemIndexes));
}

export function cloneParallelSchedule(value: ParallelSchedule): ParallelSchedule {
  return {
    version: PARALLEL_SCHEDULE_VERSION,
    streams: value.streams.map((stream) => ({ name: stream.name, workItemIndexes: [...stream.workItemIndexes] })),
  };
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
