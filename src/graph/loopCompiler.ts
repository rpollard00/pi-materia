import { parseHandoffWorkItem, type HandoffWorkItem } from "../domain/handoff.js";
import { ok, type DomainIssue, type DomainResult } from "../domain/result.js";
import { TERMINAL_ADVANCE_TARGET } from "../domain/socket.js";
import { loadoutSockets } from "../loadout/loadoutAccessors.js";
import { deriveParallelBranchRegions } from "./parallelRegions.js";
import type {
  MateriaLoopConfig,
  MateriaPipelineConfig,
  MateriaPipelineSocketConfig,
  MateriaEdgeConfig,
  MateriaForeachConfig,
  ResolvedMateriaPipeline,
  ResolvedMateriaSocket,
} from "../types.js";

/** The two graph representations which can be compiled without resolving or saving a loadout. */
export type LoopCompilerPipeline = MateriaPipelineConfig | ResolvedMateriaPipeline;

export interface LoopCompilerStream {
  /** Ordered indexes into the canonical workItems array. */
  workItemIndexes: readonly number[];
  /** Normalized lane identity, when the caller is compiling from state.parallelPlan. */
  laneId?: string;
  /** Planner stream name, retained only for stable diagnostics. */
  name?: string;
}

export interface CompileLoopRegionToChildLoadoutInput {
  /** Authored or already-resolved parent pipeline. The input is never mutated. */
  pipeline?: LoopCompilerPipeline;
  /** Compatibility alias for callers that refer to the parent graph as a loadout. */
  loadout?: LoopCompilerPipeline;
  /** Id of the loop region to extract. */
  loopId: string;
  /** Canonical workItems array, or the already selected ordered stream. */
  workItems?: readonly HandoffWorkItem[];
  /** Ordered stream of work items or normalized-plan stream indexes. */
  stream?: readonly HandoffWorkItem[] | LoopCompilerStream;
  /** Explicit stream indexes, equivalent to stream.workItemIndexes. */
  workItemIndexes?: readonly number[];
  /** Optional stable lane identity used only for diagnostics and ephemeral identity. */
  laneId?: string;
}

export interface CompiledLoopChildLoadout<TLoadout extends LoopCompilerPipeline = LoopCompilerPipeline> {
  /** The extracted ephemeral loadout in the same representation as the input. */
  loadout: TLoadout;
  /** Descriptive alias for callers that call the result a child loadout. */
  childLoadout: TLoadout;
  /** Authored graph form, available even when the input was resolved. */
  configLoadout: MateriaPipelineConfig;
  /** Resolved graph form, available when the input was resolved. */
  resolvedLoadout?: ResolvedMateriaPipeline;
  /** The only mutable state a child lane is seeded with. */
  initialData: { workItems: HandoffWorkItem[]; workItemIndexes: number[] };
  /** Stable source-to-child socket remapping, ordered by child socket identity. */
  socketIdMap: Readonly<Record<string, string>>;
  /** Stable remapping records useful for artifacts and event provenance. */
  socketIdRemapping: readonly LoopSocketIdRemapping[];
  /** The source loop remains identifiable while the child has no parallel metadata. */
  loopId: string;
  /** Stable, ephemeral identity for this compiled child. */
  childLoadoutId: string;
  /** The selected member that receives the child entry. */
  sourceEntrySocketId: string;
  /** The remapped child entry socket. */
  childEntrySocketId: string;
}

export interface LoopSocketIdRemapping {
  sourceSocketId: string;
  childSocketId: string;
}

/**
 * Compile one ordered stream of a loop into an isolated sequential loadout.
 *
 * This is deliberately a pure graph transformation. It does not resolve materia,
 * execute utilities, create a cast, or write a loadout. Resolved inputs retain
 * their resolved agent/utility objects (including model and tool settings), while
 * authored inputs retain the original materia references and socket behavior.
 */
export function compileLoopRegionToChildLoadout(
  input: CompileLoopRegionToChildLoadoutInput,
): DomainResult<CompiledLoopChildLoadout>;
export function compileLoopRegionToChildLoadout(
  pipeline: LoopCompilerPipeline,
  loopId: string,
  workItems: readonly HandoffWorkItem[],
  laneId?: string,
): DomainResult<CompiledLoopChildLoadout>;
export function compileLoopRegionToChildLoadout(
  inputOrPipeline: CompileLoopRegionToChildLoadoutInput | LoopCompilerPipeline,
  positionalLoopId?: string,
  positionalWorkItems?: readonly HandoffWorkItem[],
  positionalLaneId?: string,
): DomainResult<CompiledLoopChildLoadout> {
  const input = normalizeCompilerInput(inputOrPipeline, positionalLoopId, positionalWorkItems, positionalLaneId);
  const issues: DomainIssue[] = [];
  const source = input.pipeline ?? input.loadout;
  if (!source || typeof source !== "object") {
    return { ok: false, issues: [{ path: "pipeline", message: "pipeline or loadout is required" }] };
  }
  if (typeof input.loopId !== "string" || input.loopId.trim().length === 0) {
    issues.push({ path: "loopId", message: "loopId is required" });
  }

  const resolvedStream = resolveOrderedStream(input, issues);
  if (!resolvedStream) return { ok: false, issues };
  const parsedStream = resolvedStream.workItems;

  const sourceLoops = source.loops ?? {};
  const loop = sourceLoops[input.loopId];
  if (!loop) {
    issues.push({ path: `loops.${input.loopId}`, message: `unknown loop ${JSON.stringify(input.loopId)}` });
    return { ok: false, issues };
  }

  const sourceSocketMap = sourceSocketConfigs(source);
  const memberIds = validateMembers(loop, sourceSocketMap, input.loopId, issues);
  if (memberIds.length === 0) return { ok: false, issues };
  const memberSet = new Set(memberIds);

  // A capability-derived region includes the acyclic branch prelude. Legacy
  // callers which compile an ordinary loop still receive the loop-only child.
  const regionResult = deriveParallelBranchRegions(source);
  if (!regionResult.ok) return { ok: false, issues: [...issues, ...regionResult.issues] };
  const region = regionResult.value.find((candidate) => candidate.loopId === input.loopId);
  const preludeIds = region ? [...region.preludeSocketIds] : [];
  const selectedIds = [...preludeIds, ...memberIds];
  const selectedSet = new Set(selectedIds);
  const sourceEntrySocketId = region?.entrySocketId
    ?? findChildEntry(loop, memberSet, sourceSocketMap, input.loopId, issues);
  if (!sourceEntrySocketId) return { ok: false, issues };
  validateReachability(sourceSocketMap, sourceEntrySocketId, selectedSet, input.loopId, issues);
  validateLoopReferences(loop, memberSet, sourceSocketMap, input.loopId, issues);
  if (issues.length > 0) return { ok: false, issues };

  // Numeric canonical socket order is used rather than object insertion order or
  // completion order. The resulting identities are stable across processes.
  const orderedSockets = [...selectedIds].sort(compareSocketIds);
  const socketIdMap = Object.fromEntries(orderedSockets.map((id, index) => [id, `Socket-${index + 1}`]));
  const socketIdRemapping = orderedSockets.map((sourceSocketId) => ({ sourceSocketId, childSocketId: socketIdMap[sourceSocketId]! }));

  const configSockets: Record<string, MateriaPipelineSocketConfig> = {};
  for (const sourceSocketId of orderedSockets) {
    const socket = sourceSocketMap[sourceSocketId]!;
    configSockets[socketIdMap[sourceSocketId]!] = remapSocketConfig(
      socket,
      socketIdMap,
      selectedSet,
      memberSet.has(sourceSocketId),
    );
  }

  const childLoop = remapChildLoop(loop, socketIdMap, memberSet);
  const childEntrySocketId = socketIdMap[sourceEntrySocketId]!;
  const configLoadout = buildConfigLoadout(source, configSockets, childEntrySocketId, input.loopId, childLoop, socketIdMap);
  const initialData = {
    workItems: parsedStream.map(cloneWorkItem),
    workItemIndexes: [...resolvedStream.workItemIndexes],
  };
  const childLoadoutId = childLoadoutIdentity(source, input.loopId, input.laneId ?? resolvedStream.laneId);

  if (isResolvedPipeline(source)) {
    const resolvedSockets: Record<string, ResolvedMateriaSocket> = {};
    for (const sourceSocketId of orderedSockets) {
      const resolvedSocket = source.sockets[sourceSocketId];
      if (!resolvedSocket) {
        issues.push({ path: `sockets.${sourceSocketId}`, message: "resolved pipeline socket is missing" });
        continue;
      }
      const childId = socketIdMap[sourceSocketId]!;
      resolvedSockets[childId] = {
        ...cloneValue(resolvedSocket),
        id: childId,
        socket: remapSocketConfig(
          resolvedSocket.socket,
          socketIdMap,
          selectedSet,
          memberSet.has(sourceSocketId),
        ),
        materia: withoutRecursiveParallelGeneration(resolvedSocket.materia),
      } as ResolvedMateriaSocket;
    }
    if (issues.length > 0) return { ok: false, issues };
    const resolvedLoadout: ResolvedMateriaPipeline = {
      entry: resolvedSockets[childEntrySocketId]!,
      sockets: resolvedSockets,
      loops: { [input.loopId]: childLoop },
    };
    return ok({
      loadout: resolvedLoadout as LoopCompilerPipeline,
      childLoadout: resolvedLoadout as LoopCompilerPipeline,
      configLoadout,
      resolvedLoadout,
      initialData,
      socketIdMap,
      socketIdRemapping,
      loopId: input.loopId,
      childLoadoutId,
      sourceEntrySocketId,
      childEntrySocketId,
    });
  }

  return ok({
    loadout: configLoadout as LoopCompilerPipeline,
    childLoadout: configLoadout as LoopCompilerPipeline,
    configLoadout,
    initialData,
    socketIdMap,
    socketIdRemapping,
    loopId: input.loopId,
    childLoadoutId,
    sourceEntrySocketId,
    childEntrySocketId,
  });
}

/** Descriptive alias matching the parallel-loop feature name. */
export const compileParallelLoopChildLoadout = compileLoopRegionToChildLoadout;
/** Short alias for application callers that already selected a loop region. */
export const compileLoopChildLoadout = compileLoopRegionToChildLoadout;
/** Alias used by callers that omit the word `Region`. */
export const compileLoopToChildLoadout = compileLoopRegionToChildLoadout;
/** Alias used by graph-oriented callers. */
export const compileParallelLoopRegion = compileLoopRegionToChildLoadout;
/** Alias used by orchestration callers. */
export const compileParallelLoopLoadout = compileLoopRegionToChildLoadout;

function normalizeCompilerInput(
  inputOrPipeline: CompileLoopRegionToChildLoadoutInput | LoopCompilerPipeline,
  positionalLoopId?: string,
  positionalWorkItems?: readonly HandoffWorkItem[],
  positionalLaneId?: string,
): CompileLoopRegionToChildLoadoutInput {
  if (isCompilerInput(inputOrPipeline)) {
    return {
      ...inputOrPipeline,
      pipeline: inputOrPipeline.pipeline ?? inputOrPipeline.loadout,
    };
  }
  return {
    pipeline: inputOrPipeline,
    loopId: positionalLoopId ?? "",
    workItems: positionalWorkItems,
    ...(positionalLaneId !== undefined ? { laneId: positionalLaneId } : {}),
  };
}

interface ResolvedCompilerStream {
  workItems: HandoffWorkItem[];
  /** Original positions in the parent generator's canonical workItems array. */
  workItemIndexes: number[];
  laneId?: string;
}

function resolveOrderedStream(input: CompileLoopRegionToChildLoadoutInput, issues: DomainIssue[]): ResolvedCompilerStream | undefined {
  const canonical = input.workItems;
  const stream = input.stream;
  const indexedStream = isPlainObject(stream) && Array.isArray((stream as unknown as Record<string, unknown>).workItemIndexes)
    ? stream as LoopCompilerStream
    : undefined;
  const indexes = input.workItemIndexes ?? indexedStream?.workItemIndexes;
  const laneId = input.laneId ?? indexedStream?.laneId;

  if (indexes !== undefined) {
    if (!Array.isArray(canonical)) {
      issues.push({ path: "workItems", message: "canonical workItems are required when compiling a stream by index" });
      return undefined;
    }
    if (indexes.length === 0) {
      issues.push({ path: "workItemIndexes", message: "a child lane stream must contain at least one work-item index" });
      return undefined;
    }
    const selected: HandoffWorkItem[] = [];
    const seen = new Set<number>();
    for (const [position, rawIndex] of indexes.entries()) {
      if (!Number.isSafeInteger(rawIndex) || rawIndex < 0 || rawIndex >= canonical.length) {
        issues.push({ path: `workItemIndexes.${position}`, message: `work-item index ${String(rawIndex)} is outside workItems (length ${canonical.length})` });
        continue;
      }
      if (seen.has(rawIndex)) {
        issues.push({ path: `workItemIndexes.${position}`, message: `work-item index ${rawIndex} occurs more than once in the child stream` });
        continue;
      }
      seen.add(rawIndex);
      selected.push(canonical[rawIndex]!);
    }
    const parsed = validateStreamItems(selected, issues, "workItems");
    return parsed ? { workItems: parsed, workItemIndexes: [...indexes], ...(laneId !== undefined ? { laneId } : {}) } : undefined;
  }

  // A normalized stream may carry its selected items directly for callers that
  // already performed plan expansion.
  if (stream !== undefined && !Array.isArray(stream)) {
    issues.push({ path: "stream", message: "stream must be an item array or an object containing workItemIndexes" });
    return undefined;
  }
  const directStream = Array.isArray(stream) ? stream : undefined;
  const items = directStream ?? canonical;
  const parsed = validateStreamItems(items, issues, directStream ? "stream" : "workItems");
  return parsed ? {
    workItems: parsed,
    workItemIndexes: parsed.map((_, index) => index),
    ...(laneId !== undefined ? { laneId } : {}),
  } : undefined;
}

function validateStreamItems(stream: readonly HandoffWorkItem[] | undefined, issues: DomainIssue[], path: string): HandoffWorkItem[] | undefined {
  if (!Array.isArray(stream)) {
    issues.push({ path, message: "one ordered work-item stream is required" });
    return undefined;
  }
  if (stream.length === 0) {
    issues.push({ path, message: "a child lane stream must contain at least one work item" });
    return undefined;
  }
  const result: HandoffWorkItem[] = [];
  for (const [index, item] of stream.entries()) {
    const parsed = parseHandoffWorkItem(item, `${path}.${index}`);
    if (!parsed.ok) issues.push(...parsed.issues);
    else result.push(parsed.value);
  }
  return issues.length > 0 ? undefined : result;
}

function validateMembers(
  loop: MateriaLoopConfig,
  sockets: Record<string, MateriaPipelineSocketConfig>,
  loopId: string,
  issues: DomainIssue[],
): string[] {
  if (!Array.isArray(loop.sockets) || loop.sockets.length === 0) {
    issues.push({ path: `loops.${loopId}.sockets`, message: "selected loop must contain at least one socket" });
    return [];
  }
  const seen = new Set<string>();
  const members: string[] = [];
  for (const [index, socketId] of loop.sockets.entries()) {
    if (typeof socketId !== "string" || socketId.trim().length === 0) {
      issues.push({ path: `loops.${loopId}.sockets.${index}`, message: "loop member must be a non-empty socket id" });
      continue;
    }
    if (seen.has(socketId)) {
      issues.push({ path: `loops.${loopId}.sockets.${index}`, message: `loop member ${JSON.stringify(socketId)} is duplicated` });
      continue;
    }
    seen.add(socketId);
    if (!sockets[socketId]) {
      issues.push({ path: `loops.${loopId}.sockets.${index}`, message: `loop member references unknown socket ${JSON.stringify(socketId)}` });
      continue;
    }
    members.push(socketId);
  }
  return members;
}

function findChildEntry(
  loop: MateriaLoopConfig,
  memberSet: Set<string>,
  sockets: Record<string, MateriaPipelineSocketConfig>,
  loopId: string,
  issues: DomainIssue[],
): string | undefined {
  const inbound: Array<{ from: string; to: string }> = [];
  for (const [from, socket] of Object.entries(sockets)) {
    if (memberSet.has(from) || !socket) continue;
    const edges = Array.isArray((socket as unknown as Record<string, unknown>).edges) ? socket.edges : [];
    for (const edge of edges ?? []) {
      if (edge && typeof edge.to === "string" && memberSet.has(edge.to)) inbound.push({ from, to: edge.to });
    }
  }

  if (loop.consumes) {
    if (memberSet.has(loop.consumes.from)) {
      issues.push({ path: `loops.${loopId}.consumes.from`, message: "loop consumer source must be outside the child loop subgraph" });
    }
    const matching = inbound.filter((edge) => edge.from === loop.consumes?.from);
    if (inbound.length !== 1 || matching.length !== 1) {
      const details = inbound.map((edge) => `${edge.from}->${edge.to}`).join(", ") || "none";
      issues.push({ path: `loops.${loopId}.consumes`, message: `child compilation requires one deterministic inbound loop entry from ${JSON.stringify(loop.consumes.from)}; found ${details}` });
      return undefined;
    }
    return matching[0]!.to;
  }

  if (inbound.length > 1) {
    issues.push({ path: `loops.${loopId}.sockets`, message: `child compilation found ambiguous inbound loop entries: ${inbound.map((edge) => `${edge.from}->${edge.to}`).join(", ")}` });
    return undefined;
  }
  if (inbound.length === 1) return inbound[0]!.to;

  // A loop without a consumer is still useful as a pure extracted subgraph.
  // Its persisted member order is the only available deterministic entry.
  const first = [...memberSet].sort(compareSocketIds)[0];
  if (!first) issues.push({ path: `loops.${loopId}.sockets`, message: "child loop has no deterministic entry socket" });
  return first;
}

function validateReachability(
  sockets: Record<string, MateriaPipelineSocketConfig>,
  entry: string,
  members: Set<string>,
  loopId: string,
  issues: DomainIssue[],
): void {
  const visited = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const edges = sockets[current] && Array.isArray((sockets[current] as unknown as Record<string, unknown>).edges) ? sockets[current]!.edges : [];
    for (const edge of edges ?? []) {
      if (edge && typeof edge.to === "string" && members.has(edge.to) && !visited.has(edge.to)) queue.push(edge.to);
    }
  }
  const unreachable = [...members].filter((socketId) => !visited.has(socketId)).sort(compareSocketIds);
  if (unreachable.length > 0) {
    issues.push({ path: `loops.${loopId}.sockets`, message: `child loop sockets are unreachable from deterministic entry ${JSON.stringify(entry)}: ${unreachable.join(", ")}` });
  }
}

function validateLoopReferences(
  loop: MateriaLoopConfig,
  members: Set<string>,
  sockets: Record<string, MateriaPipelineSocketConfig>,
  loopId: string,
  issues: DomainIssue[],
): void {
  if (loop.exit && !members.has(loop.exit.from)) {
    issues.push({ path: `loops.${loopId}.exit.from`, message: "loop exit source must be inside the selected child subgraph" });
  }
  if (loop.exit && !isKnownTarget(loop.exit.to, sockets)) {
    issues.push({ path: `loops.${loopId}.exit.to`, message: `loop exit target references unknown graph target ${JSON.stringify(loop.exit.to)}` });
  }
  if (loop.exits !== undefined && !Array.isArray(loop.exits)) {
    issues.push({ path: `loops.${loopId}.exits`, message: "loop exits must be an array" });
  }
  for (const [index, route] of (Array.isArray(loop.exits) ? loop.exits : []).entries()) {
    if (!route || typeof route !== "object") {
      issues.push({ path: `loops.${loopId}.exits.${index}`, message: "loop-exit route must be an object" });
      continue;
    }
    if (!members.has(route.from)) issues.push({ path: `loops.${loopId}.exits.${index}.from`, message: "loop-exit route source must be inside the selected child subgraph" });
    if (!isKnownTarget(route.targetSocketId, sockets)) issues.push({ path: `loops.${loopId}.exits.${index}.targetSocketId`, message: `loop-exit target references unknown graph target ${JSON.stringify(route.targetSocketId)}` });
  }
  if (loop.consumes?.done !== undefined && !isKnownTarget(loop.consumes.done, sockets)) {
    issues.push({ path: `loops.${loopId}.consumes.done`, message: `loop consumer done target references unknown graph target ${JSON.stringify(loop.consumes.done)}` });
  }
  if (loop.iterator !== undefined) {
    if (!isPlainObject(loop.iterator) || typeof loop.iterator.items !== "string") {
      issues.push({ path: `loops.${loopId}.iterator`, message: "loop iterator must define an items path" });
    } else if (loop.iterator.done !== undefined && !isKnownTarget(loop.iterator.done, sockets)) {
      issues.push({ path: `loops.${loopId}.iterator.done`, message: `loop iterator done target references unknown graph target ${JSON.stringify(loop.iterator.done)}` });
    }
  }
  for (const member of members) {
    const socket = sockets[member];
    if (!socket) continue;
    const rawSocket = socket as unknown as Record<string, unknown>;
    const edges = rawSocket.edges;
    if (edges !== undefined && !Array.isArray(edges)) {
      issues.push({ path: `sockets.${member}.edges`, message: "socket edges must be an array" });
    }
    for (const [index, edge] of (Array.isArray(edges) ? edges : []).entries()) {
      if (!edge || typeof edge !== "object" || typeof (edge as MateriaEdgeConfig).to !== "string" || (edge as MateriaEdgeConfig).to.trim().length === 0) {
        issues.push({ path: `sockets.${member}.edges.${index}.to`, message: "child socket edge target must be a non-empty graph target" });
      } else if (!isKnownTarget((edge as MateriaEdgeConfig).to, sockets)) {
        issues.push({ path: `sockets.${member}.edges.${index}.to`, message: `child socket edge references unknown graph target ${JSON.stringify((edge as MateriaEdgeConfig).to)}` });
      }
    }
    const foreach = rawSocket.foreach;
    if (foreach !== undefined && (!isPlainObject(foreach) || typeof foreach.items !== "string")) {
      issues.push({ path: `sockets.${member}.foreach`, message: "socket foreach must define an items path" });
    } else if (isPlainObject(foreach) && foreach.done !== undefined && !isKnownTarget(foreach.done, sockets)) {
      issues.push({ path: `sockets.${member}.foreach.done`, message: `foreach done target references unknown graph target ${JSON.stringify(foreach.done)}` });
    }
    const advance = rawSocket.advance;
    if (advance !== undefined && (!isPlainObject(advance) || typeof advance.items !== "string")) {
      issues.push({ path: `sockets.${member}.advance`, message: "socket advance must define an items path" });
    } else if (isPlainObject(advance) && advance.done !== undefined && !isKnownTarget(advance.done, sockets)) {
      issues.push({ path: `sockets.${member}.advance.done`, message: `advance done target references unknown graph target ${JSON.stringify(advance.done)}` });
    }
  }
}

function isKnownTarget(target: unknown, sockets: Record<string, MateriaPipelineSocketConfig>): target is string {
  return target === TERMINAL_ADVANCE_TARGET || (typeof target === "string" && Object.prototype.hasOwnProperty.call(sockets, target));
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function remapSocketConfig(
  socket: MateriaPipelineSocketConfig,
  socketIdMap: Record<string, string>,
  selectedSockets: Set<string>,
  consumesLaneItems: boolean,
): MateriaPipelineSocketConfig {
  const next = cloneValue(socket);
  if (socket.edges) next.edges = socket.edges.map((edge) => ({ ...edge, to: remapInternalTarget(edge.to, socketIdMap, selectedSockets) }));
  if (socket.foreach) next.foreach = remapForeach(socket.foreach, socketIdMap, selectedSockets, consumesLaneItems);
  if (socket.advance) next.advance = {
    ...socket.advance,
    items: consumesLaneItems ? childItemsPath(socket.advance.items) : socket.advance.items,
    ...(socket.advance.done !== undefined ? { done: remapInternalTarget(socket.advance.done, socketIdMap, selectedSockets) } : {}),
  };
  return next;
}

function remapForeach(
  foreach: MateriaForeachConfig,
  socketIdMap: Record<string, string>,
  selectedSockets: Set<string>,
  consumesLaneItems: boolean,
): MateriaForeachConfig {
  return {
    ...cloneValue(foreach),
    items: consumesLaneItems ? childItemsPath(foreach.items) : foreach.items,
    ...(foreach.done !== undefined ? { done: remapInternalTarget(foreach.done, socketIdMap, selectedSockets) } : {}),
  };
}

function remapChildLoop(
  loop: MateriaLoopConfig,
  socketIdMap: Record<string, string>,
  members: Set<string>,
): MateriaLoopConfig {
  const originalIterator = loop.iterator;
  const iterator: MateriaForeachConfig = originalIterator
    ? {
        ...cloneValue(originalIterator),
        items: childItemsPath(originalIterator.items),
        ...(originalIterator.done !== undefined ? { done: remapInternalTarget(originalIterator.done, socketIdMap, members) } : { done: TERMINAL_ADVANCE_TARGET }),
      }
    : {
        items: "state.workItems",
        as: loop.consumes?.as ?? "workItem",
        cursor: loop.consumes?.cursor ?? "workItemIndex",
        done: TERMINAL_ADVANCE_TARGET,
      };

  const next: MateriaLoopConfig = {
    ...cloneValue(loop),
    sockets: loop.sockets?.map((socketId) => socketIdMap[socketId]!),
    iterator,
  };
  // The generator socket is deliberately not copied into a child. The child
  // receives initialData.workItems instead, so retaining consumes would point
  // at a socket outside the extracted graph and could re-enter parallel mode.
  delete next.consumes;
  delete next.parallel;

  if (loop.exit) {
    next.exit = {
      ...cloneValue(loop.exit),
      from: socketIdMap[loop.exit.from]!,
      to: TERMINAL_ADVANCE_TARGET,
    };
  }
  if (loop.exits) {
    next.exits = loop.exits.map((route) => ({
      ...cloneValue(route),
      from: socketIdMap[route.from]!,
      // Every parent fan-in/resolver route becomes a local child terminal.
      targetSocketId: TERMINAL_ADVANCE_TARGET,
    }));
  }
  return next;
}

function buildConfigLoadout(
  source: LoopCompilerPipeline,
  sockets: Record<string, MateriaPipelineSocketConfig>,
  entry: string,
  loopId: string,
  loop: MateriaLoopConfig,
  socketIdMap: Record<string, string>,
): MateriaPipelineConfig {
  const sourceConfig = isResolvedPipeline(source) ? undefined : source;
  const layout = sourceConfig?.layout?.sockets
    ? { sockets: Object.fromEntries(Object.entries(sourceConfig.layout.sockets).flatMap(([sourceId, value]) => socketIdMap[sourceId] ? [[socketIdMap[sourceId]!, cloneValue(value)]] : [])) }
    : undefined;
  return {
    entry,
    sockets,
    ...(layout && Object.keys(layout.sockets ?? {}).length > 0 ? { layout } : {}),
    loops: { [loopId]: loop },
  };
}

function sourceSocketConfigs(source: LoopCompilerPipeline): Record<string, MateriaPipelineSocketConfig> {
  if (isResolvedPipeline(source)) {
    return Object.fromEntries(Object.entries(source.sockets ?? {}).flatMap(([id, socket]) => socket && socket.socket ? [[id, socket.socket]] : []));
  }
  return loadoutSockets(source);
}

function isResolvedPipeline(value: LoopCompilerPipeline): value is ResolvedMateriaPipeline {
  return typeof value.entry === "object" && value.entry !== null;
}

function isCompilerInput(value: CompileLoopRegionToChildLoadoutInput | LoopCompilerPipeline): value is CompileLoopRegionToChildLoadoutInput {
  return typeof value === "object" && value !== null && "loopId" in value && ("pipeline" in value || "loadout" in value);
}

function remapInternalTarget(target: string, socketIdMap: Record<string, string>, members: Set<string>): string {
  if (target === TERMINAL_ADVANCE_TARGET) return TERMINAL_ADVANCE_TARGET;
  return members.has(target) ? socketIdMap[target]! : TERMINAL_ADVANCE_TARGET;
}

function withoutRecursiveParallelGeneration<T>(materia: T): T {
  const cloned = cloneValue(materia);
  if (isPlainObject(cloned)) delete cloned.parallel;
  return cloned;
}

function childItemsPath(_items: string): string {
  // Planner streams always seed the canonical lane list. Rewriting the control
  // path avoids accidentally carrying a parent planner alias into the child.
  return "state.workItems";
}

function childLoadoutIdentity(source: LoopCompilerPipeline, loopId: string, laneId?: string): string {
  const sourceId = !isResolvedPipeline(source) && typeof source.id === "string" ? source.id : "pipeline";
  const parts = [sourceId, loopId, laneId].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return `parallel-child-${parts.map(safeIdentityPart).join("-")}`;
}

function safeIdentityPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "anonymous";
}

function compareSocketIds(left: string, right: string): number {
  const leftMatch = /^Socket-(\d+)$/.exec(left);
  const rightMatch = /^Socket-(\d+)$/.exec(right);
  if (leftMatch && rightMatch) return Number(leftMatch[1]) - Number(rightMatch[1]);
  if (leftMatch) return -1;
  if (rightMatch) return 1;
  return left.localeCompare(right);
}

function cloneWorkItem(item: HandoffWorkItem): HandoffWorkItem {
  return { title: item.title, context: item.context };
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, cloneValue(child)])) as T;
}
