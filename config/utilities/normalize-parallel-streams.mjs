#!/usr/bin/env node
/**
 * Normalize a planner's parallelSchedule sidecar into the runtime-owned
 * state.parallelPlan contract.
 *
 * The planner owns the canonical workItems array and the sidecar owns only
 * ordered indexes into that array. This utility deliberately never rewrites
 * work items or silently repairs a schedule: a repaired schedule would be a
 * different execution plan and would make recovery ambiguous.
 */
import { createHash } from "node:crypto";

const PARALLEL_PLAN_VERSION = 1;
const PARALLEL_SCHEDULE_VERSION = 1;

try {
  const input = await readStdinJson();
  const state = isPlainObject(input.state) ? input.state : {};
  const hasStateWorkItems = hasOwn(state, "workItems");
  const hasTopLevelWorkItems = hasOwn(input, "workItems");
  const rawWorkItems = Array.isArray(state.workItems)
    ? state.workItems
    : Array.isArray(input.workItems)
      ? input.workItems
      : undefined;
  const workItems = rawWorkItems === undefined ? [] : structuredClone(rawWorkItems);
  const issues = [];

  if ((hasStateWorkItems || hasTopLevelWorkItems) && rawWorkItems === undefined) {
    issues.push("$.workItems must be an array");
  }

  const hasStateSchedule = hasOwn(state, "parallelSchedule");
  const hasTopLevelSchedule = hasOwn(input, "parallelSchedule");
  const rawSchedule = hasStateSchedule ? state.parallelSchedule : input.parallelSchedule;

  // An absent schedule is a useful deterministic no-op only when there are no
  // work items. An explicit null or malformed value is still a planner error.
  const schedule = rawSchedule === undefined && workItems.length === 0
    ? { version: PARALLEL_SCHEDULE_VERSION, streams: [] }
    : rawSchedule;
  let normalizedStreams;
  if (rawSchedule === undefined && workItems.length > 0) {
    issues.push("$.parallelSchedule is required when workItems are present");
  } else {
    normalizedStreams = validateSchedule(schedule, workItems.length, issues);
  }

  if (issues.length > 0 || normalizedStreams === undefined) {
    writeStdoutJson({
      workItems,
      satisfied: false,
      context: formatFailure(issues.length > 0 ? issues : ["parallelSchedule could not be normalized"]),
    });
    process.exit(0);
  }

  const streams = assignLaneIds(normalizedStreams);
  const planId = createPlanId(workItems, streams);
  const parallelPlan = {
    version: PARALLEL_PLAN_VERSION,
    planId,
    workItemCount: workItems.length,
    streams,
  };

  writeStdoutJson({
    workItems,
    satisfied: true,
    context: workItems.length === 0
      ? `Parallel stream plan normalized as a deterministic no-op: no work items and no lanes. Plan ${planId}.`
      : `Parallel stream plan normalized: ${workItems.length} work item(s) assigned to ${streams.length} ordered stream(s). Plan ${planId}.`,
    state: { parallelPlan },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeStdoutJson({
    workItems: [],
    satisfied: false,
    context: `Parallel stream normalization failed unexpectedly: ${message}`,
  });
}

function validateSchedule(value, workItemCount, issues) {
  if (!isPlainObject(value)) {
    issues.push("$.parallelSchedule must be an object");
    return undefined;
  }
  if (value.version !== PARALLEL_SCHEDULE_VERSION) {
    issues.push(`$.parallelSchedule.version must be ${PARALLEL_SCHEDULE_VERSION}`);
  }
  if (!Array.isArray(value.streams)) {
    issues.push("$.parallelSchedule.streams must be an array");
    return undefined;
  }

  const names = new Map();
  const assigned = new Map();
  const streams = [];

  for (const [streamIndex, stream] of value.streams.entries()) {
    const streamPath = `$.parallelSchedule.streams.${streamIndex}`;
    if (!isPlainObject(stream)) {
      issues.push(`${streamPath} must be an object`);
      continue;
    }

    const name = stream.name;
    let normalizedName;
    if (typeof name !== "string" || name.trim().length === 0) {
      issues.push(`${streamPath}.name must be a non-empty string`);
      normalizedName = `stream-${streamIndex + 1}`;
    } else {
      normalizedName = name.trim();
      const previous = names.get(normalizedName);
      if (previous !== undefined) {
        issues.push(`${streamPath}.name duplicates stream name at $.parallelSchedule.streams.${previous}.name; stream names must be unique`);
      } else {
        names.set(normalizedName, streamIndex);
      }
    }

    if (!Array.isArray(stream.workItemIndexes)) {
      issues.push(`${streamPath}.workItemIndexes must be an array`);
      continue;
    }
    if (stream.workItemIndexes.length === 0) {
      issues.push(`${streamPath}.workItemIndexes must contain at least one work-item index; streams cannot be empty`);
    }

    const indexes = [];
    for (const [indexPosition, rawIndex] of stream.workItemIndexes.entries()) {
      const indexPath = `${streamPath}.workItemIndexes.${indexPosition}`;
      if (!Number.isSafeInteger(rawIndex) || rawIndex < 0) {
        issues.push(`${indexPath} must be a non-negative safe integer`);
        continue;
      }
      if (rawIndex >= workItemCount) {
        issues.push(`${indexPath} index ${rawIndex} is outside workItems (length ${workItemCount})`);
        continue;
      }
      const previousStream = assigned.get(rawIndex);
      if (previousStream !== undefined) {
        issues.push(`${indexPath} index ${rawIndex} is assigned more than once (already assigned to stream ${JSON.stringify(previousStream)})`);
        continue;
      }
      assigned.set(rawIndex, normalizedName);
      indexes.push(rawIndex);
    }

    streams.push({ name: normalizedName, workItemIndexes: indexes, streamIndex });
  }

  if (workItemCount === 0) {
    if (value.streams.length !== 0) {
      issues.push("$.parallelSchedule.streams must be empty when workItems is empty");
    }
  } else {
    for (let index = 0; index < workItemCount; index += 1) {
      if (!assigned.has(index)) {
        issues.push(`$.parallelSchedule.streams is missing work-item index ${index}; every work item must be assigned exactly once`);
      }
    }
  }

  if (issues.length > 0) return undefined;
  return streams;
}

function assignLaneIds(streams) {
  const slugCounts = new Map();
  for (const stream of streams) {
    const slug = laneSlug(stream.name);
    slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
  }

  return streams.map((stream) => {
    const slug = laneSlug(stream.name);
    const laneId = slugCounts.get(slug) === 1
      ? `lane-${slug}`
      : `lane-${slug}-${shortHash(stream.name)}`;
    return {
      laneId,
      name: stream.name,
      streamIndex: stream.streamIndex,
      workItemIndexes: [...stream.workItemIndexes],
    };
  });
}

function laneSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "stream";
}

function createPlanId(workItems, streams) {
  const identity = stableJson({
    version: PARALLEL_PLAN_VERSION,
    workItems,
    streams: streams.map(({ laneId, name, streamIndex, workItemIndexes }) => ({ laneId, name, streamIndex, workItemIndexes })),
  });
  return `parallel-plan-v${PARALLEL_PLAN_VERSION}-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function formatFailure(issues) {
  return [
    "Parallel stream normalization failed. Correct the planner's parallelSchedule before starting parallel execution:",
    ...issues.map((issue) => `- ${issue}`),
    "Required: version 1, uniquely named non-empty streams, and every workItems index assigned exactly once in the intended stream order.",
  ].join("\n");
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

function writeStdoutJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
