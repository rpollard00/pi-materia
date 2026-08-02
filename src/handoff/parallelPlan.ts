import { createHash } from "node:crypto";
import type { HandoffWorkItem } from "../domain/handoff.js";
import type { DomainResult } from "../domain/result.js";
import {
  validateParallelSchedule,
  type ParallelSchedule,
} from "./parallelSchedule.js";

export const PARALLEL_PLAN_VERSION = 1 as const;

/** Immutable runtime plan produced from one validated generator handoff. */
export interface NormalizedParallelPlan {
  version: typeof PARALLEL_PLAN_VERSION;
  planId: string;
  workItemCount: number;
  streams: NormalizedParallelStream[];
}

export interface NormalizedParallelStream {
  laneId: string;
  name: string;
  streamIndex: number;
  workItemIndexes: number[];
}

/**
 * Normalize an agent-authored schedule without changing its stream or item
 * order. Validation and identity creation live here so every output path uses
 * the same deterministic plan contract.
 */
export function normalizeParallelPlan(
  workItems: readonly HandoffWorkItem[],
  schedule: unknown,
): DomainResult<NormalizedParallelPlan> {
  const validated = validateParallelSchedule(schedule, workItems.length);
  if (!validated.ok) return validated;

  const streams = assignStableLaneIds(validated.value);
  const identity = stableJson({
    version: PARALLEL_PLAN_VERSION,
    workItems,
    streams: streams.map(({ laneId, name, streamIndex, workItemIndexes }) => ({
      laneId,
      name,
      streamIndex,
      workItemIndexes,
    })),
  });

  return {
    ok: true,
    value: {
      version: PARALLEL_PLAN_VERSION,
      planId: `parallel-plan-v${PARALLEL_PLAN_VERSION}-${sha256(identity).slice(0, 16)}`,
      workItemCount: workItems.length,
      streams,
    },
  };
}

function assignStableLaneIds(schedule: ParallelSchedule): NormalizedParallelStream[] {
  const names = schedule.streams.map((stream) => stream.name.trim());
  const slugCounts = new Map<string, number>();
  for (const name of names) {
    const slug = laneSlug(name);
    slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
  }

  const usedLaneIds = new Set<string>();
  return schedule.streams.map((stream, streamIndex) => {
    const name = names[streamIndex]!;
    const slug = laneSlug(name);
    const candidate = slugCounts.get(slug) === 1 ? `lane-${slug}` : `lane-${slug}-${sha256(name).slice(0, 8)}`;
    let laneId = candidate;
    let suffix = streamIndex + 1;
    while (usedLaneIds.has(laneId)) laneId = `${candidate}-${suffix++}`;
    usedLaneIds.add(laneId);
    return {
      laneId,
      name,
      streamIndex,
      workItemIndexes: [...stream.workItemIndexes],
    };
  });
}

function laneSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "stream";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
