import { isParallelGeneratorMateria } from "./generator.js";
import { getLoadoutSocket, loopSockets } from "../loadout/loadoutAccessors.js";
import type { DomainIssue, DomainResult } from "../domain/result.js";
import type { MateriaLoopParallelConfig, MateriaPipelineConfig, ResolvedMateriaPipeline } from "../types.js";

export type ParallelRegionPipeline = MateriaPipelineConfig | ResolvedMateriaPipeline;

/** A parallel generator's derived fork-to-barrier graph boundary. */
export interface ParallelBranchRegion {
  generatorSocketId: string;
  /** First socket executed by every branch. */
  entrySocketId: string;
  /** Acyclic sockets between the generator and consuming loop, in execution order. */
  preludeSocketIds: readonly string[];
  loopId: string;
  loopSocketIds: readonly string[];
  /** The sole parent target reached after the intrinsic branch barrier. */
  continuationSocketId: string;
  /** Optional consuming-loop concurrency override; this does not enable parallelism. */
  concurrency?: MateriaLoopParallelConfig;
}

export interface DeriveParallelBranchRegionsOptions {
  isParallelGeneratorSocket?: (socketId: string) => boolean;
}

/**
 * Derive parallel regions from generator capability and loop consumption.
 *
 * No authored loop flag enables a region. A parallel generator must own exactly
 * one consuming loop and reach it through one unconditional, acyclic path.
 */
export function deriveParallelBranchRegions(
  pipeline: ParallelRegionPipeline,
  options: DeriveParallelBranchRegionsOptions = {},
): DomainResult<readonly ParallelBranchRegion[]> {
  const issues: DomainIssue[] = [];
  const regions: ParallelBranchRegion[] = [];
  const isParallelGenerator = options.isParallelGeneratorSocket ?? ((socketId: string) => {
    const socket = resolvedSocket(pipeline, socketId);
    return Boolean(socket && isParallelGeneratorMateria(socket.materia));
  });
  const socketIds = Object.keys(socketConfigs(pipeline)).sort(compareSocketIds);

  for (const generatorSocketId of socketIds.filter(isParallelGenerator)) {
    const consumers = Object.entries(pipeline.loops ?? {})
      .filter(([, loop]) => loop.consumes?.from === generatorSocketId)
      .sort(([left], [right]) => left.localeCompare(right));
    // A capability may be catalogued or placed without a consuming loop. It
    // becomes an executable parallel region only when a loop explicitly
    // consumes it; authored loop concurrency metadata is never an opt-in.
    if (consumers.length === 0) continue;
    if (consumers.length > 1) {
      issues.push({
        path: `sockets.${generatorSocketId}`,
        message: `parallel generator ${JSON.stringify(generatorSocketId)} must have exactly one consuming loop; found ${consumers.length}`,
      });
      continue;
    }

    const [loopId, loop] = consumers[0]!;
    const members = loopSockets(loop);
    const memberSet = new Set(members);
    const path = deterministicPathToLoop(pipeline, generatorSocketId, memberSet, loopId, issues);
    if (!path) continue;

    const continuationTargets = new Set<string>();
    if (loop.exit?.to) continuationTargets.add(loop.exit.to);
    for (const route of loop.exits ?? []) if (route?.targetSocketId) continuationTargets.add(route.targetSocketId);
    if (continuationTargets.size !== 1) {
      issues.push({
        path: `loops.${loopId}.exit`,
        message: `parallel region for generator ${JSON.stringify(generatorSocketId)} requires exactly one post-barrier continuation; found ${continuationTargets.size}`,
      });
      continue;
    }

    regions.push({
      generatorSocketId,
      entrySocketId: path[0]!,
      preludeSocketIds: path.slice(0, -1),
      loopId,
      loopSocketIds: [...members],
      continuationSocketId: [...continuationTargets][0]!,
      ...(loop.parallel ? { concurrency: { ...loop.parallel } } : {}),
    });
  }

  validateRegionInteractions(regions, issues);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: regions };
}

export function parallelBranchRegionForEntry(
  pipeline: ResolvedMateriaPipeline,
  socketId: string,
): ParallelBranchRegion | undefined {
  const result = deriveParallelBranchRegions(pipeline);
  return result.ok ? result.value.find((region) => region.entrySocketId === socketId) : undefined;
}

function deterministicPathToLoop(
  pipeline: ParallelRegionPipeline,
  generatorSocketId: string,
  loopMembers: Set<string>,
  loopId: string,
  issues: DomainIssue[],
): string[] | undefined {
  const path: string[] = [];
  const visited = new Set([generatorSocketId]);
  let current = generatorSocketId;
  while (true) {
    // Terminal edges are executable routes too: ignoring them would allow a
    // conditional bypass to `end` alongside an otherwise deterministic path.
    const outgoing = socketConfig(pipeline, current)?.edges ?? [];
    if (outgoing.length !== 1 || outgoing[0]?.when !== "always") {
      issues.push({
        path: `sockets.${current}.edges`,
        message: `parallel generator path to loop ${JSON.stringify(loopId)} must have exactly one unconditional successor at every prelude socket; ${JSON.stringify(current)} has ${outgoing.length}`,
      });
      return undefined;
    }
    const target = outgoing[0].to;
    if (target === "end") {
      issues.push({
        path: `sockets.${current}.edges`,
        message: `parallel generator path to loop ${JSON.stringify(loopId)} terminates before reaching its consuming loop`,
      });
      return undefined;
    }
    if (visited.has(target)) {
      issues.push({ path: `sockets.${current}.edges`, message: `parallel generator path to loop ${JSON.stringify(loopId)} contains a cycle before its consuming loop` });
      return undefined;
    }
    if (!socketConfig(pipeline, target)) {
      issues.push({ path: `sockets.${current}.edges`, message: `parallel generator path references unknown socket ${JSON.stringify(target)}` });
      return undefined;
    }
    visited.add(target);
    path.push(target);
    if (loopMembers.has(target)) return path;
    current = target;
  }
}

function validateRegionInteractions(regions: readonly ParallelBranchRegion[], issues: DomainIssue[]): void {
  for (let leftIndex = 0; leftIndex < regions.length; leftIndex += 1) {
    const left = regions[leftIndex]!;
    const leftInitial = new Set([...left.preludeSocketIds, ...left.loopSocketIds]);
    for (let rightIndex = leftIndex + 1; rightIndex < regions.length; rightIndex += 1) {
      const right = regions[rightIndex]!;
      const overlap = [...right.preludeSocketIds, ...right.loopSocketIds].filter((id) => leftInitial.has(id));
      const nested = leftInitial.has(right.generatorSocketId)
        || new Set([...right.preludeSocketIds, ...right.loopSocketIds]).has(left.generatorSocketId);
      if (overlap.length === 0 && !nested) continue;
      issues.push({
        path: `loops.${left.loopId}`,
        message: `parallel regions ${JSON.stringify(left.loopId)} and ${JSON.stringify(right.loopId)} overlap or nest${overlap.length > 0 ? ` through ${[...new Set(overlap)].join(", ")}` : ""}; initial parallel regions must be disjoint`,
      });
    }
  }
}

function socketConfigs(pipeline: ParallelRegionPipeline): Record<string, unknown> {
  return pipeline.sockets ?? {};
}

function socketConfig(pipeline: ParallelRegionPipeline, socketId: string) {
  if (isResolved(pipeline)) return pipeline.sockets[socketId]?.socket;
  return getLoadoutSocket(pipeline, socketId);
}

function resolvedSocket(pipeline: ParallelRegionPipeline, socketId: string) {
  return isResolved(pipeline) ? pipeline.sockets[socketId] : undefined;
}

function isResolved(pipeline: ParallelRegionPipeline): pipeline is ResolvedMateriaPipeline {
  return typeof pipeline.entry === "object" && pipeline.entry !== null;
}

function compareSocketIds(left: string, right: string): number {
  const leftOrdinal = /^Socket-(\d+)$/.exec(left);
  const rightOrdinal = /^Socket-(\d+)$/.exec(right);
  if (leftOrdinal && rightOrdinal) return Number(leftOrdinal[1]) - Number(rightOrdinal[1]);
  return left.localeCompare(right);
}
