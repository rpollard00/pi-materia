import { canonicalGeneratorConfigFor, type GeneratorMateriaLike } from "./generator.js";
import { getLoadoutSocket, loadoutSocketEntries, loadoutSockets, loopSocketSet } from "../loadout/loadoutAccessors.js";
import type { MateriaEdgeConfig, MateriaLoopConfig, MateriaLoopConsumerConfig, MateriaPipelineConfig } from "../types.js";

export type LoadoutGraphDiagnosticCode =
  | "loop-consumer-missing"
  | "loop-consumer-ambiguous"
  | "loop-consumer-stale";

export interface LoadoutGraphDiagnostic {
  code: LoadoutGraphDiagnosticCode;
  message: string;
  loopId?: string;
  source?: string;
  from?: string;
}

export interface DerivedLoopConsumerSource {
  from: string;
  output: string;
}

export interface LoadoutGraphAnalysis {
  workItemProducingSocketIds: Set<string>;
  loopConsumerSources: Map<string, DerivedLoopConsumerSource>;
  diagnostics: LoadoutGraphDiagnostic[];
}

interface AnalyzeableSocket {
  type?: string;
  materia?: string;
  edges?: MateriaEdgeConfig[];
}

interface AnalyzeableLoop {
  sockets?: string[];
  consumes?: Partial<MateriaLoopConsumerConfig> & { from?: string };
  iterator?: unknown;
}

interface AnalyzeableLoadout {
  sockets?: Record<string, AnalyzeableSocket | undefined>;
  loops?: Record<string, AnalyzeableLoop | undefined>;
}

export function analyzeLoadoutGraph(loadout: AnalyzeableLoadout, materia: Record<string, GeneratorMateriaLike> = {}): LoadoutGraphAnalysis {
  // Keep this analysis tied to semantic graph inputs: build loop membership
  // indexes once, walk socket edges once, then finalize each loop. Complexity is
  // O(sockets + edges + loop memberships + edge-loop hits) instead of scanning
  // every socket/edge once per loop; nested loops only add proportional hits for
  // edges that actually target sockets belonging to multiple loops.
  const sockets = loadoutSockets(loadout as MateriaPipelineConfig) as Record<string, AnalyzeableSocket | undefined>;
  const diagnostics: LoadoutGraphDiagnostic[] = [];
  const loopConsumerSources = new Map<string, DerivedLoopConsumerSource>();
  const workItemProducingSocketIds = new Set<string>();
  const loopSocketSets = new Map<string, Set<string>>();
  const loopConsumerFlags = new Map<string, boolean>();
  const socketLoopIds = new Map<string, Set<string>>();
  const inboundGeneratorSourcesByLoop = new Map<string, Set<string>>();

  for (const [loopId, loop] of Object.entries(loadout.loops ?? {})) {
    if (!loop) continue;
    const loopSet = loopSocketSet(loop as MateriaLoopConfig);
    loopSocketSets.set(loopId, loopSet);
    loopConsumerFlags.set(loopId, Boolean(loop.consumes || loop.iterator));
    inboundGeneratorSourcesByLoop.set(loopId, new Set());
    for (const socketId of loopSet) {
      const loopIds = socketLoopIds.get(socketId) ?? new Set<string>();
      loopIds.add(loopId);
      socketLoopIds.set(socketId, loopIds);
    }
  }

  for (const [from, socket] of loadoutSocketEntries(loadout as MateriaPipelineConfig) as [string, AnalyzeableSocket | undefined][]) {
    if (!socket || !isWorkItemsGeneratorSocket(socket, materia)) continue;
    for (const edge of socket.edges ?? []) {
      const targetLoopIds = socketLoopIds.get(edge.to);
      if (!targetLoopIds) continue;
      for (const loopId of targetLoopIds) {
        const loopSet = loopSocketSets.get(loopId);
        if (!loopSet || loopSet.has(from)) continue;
        inboundGeneratorSourcesByLoop.get(loopId)?.add(from);
      }
    }
  }

  for (const [loopId, sources] of inboundGeneratorSourcesByLoop) {
    const loop = loadout.loops?.[loopId];
    if (!loop) continue;
    const uniqueSources = Array.from(sources).sort();
    const isConsumerLoop = loopConsumerFlags.get(loopId) === true;

    if (uniqueSources.length === 1) {
      const from = uniqueSources[0]!;
      const output = loop.consumes?.output ?? generatorOutputForSocket(sockets[from], materia) ?? "workItems";
      loopConsumerSources.set(loopId, { from, output });
      workItemProducingSocketIds.add(from);
      if (loop.consumes?.from && loop.consumes.from !== from) {
        diagnostics.push({
          code: "loop-consumer-stale",
          loopId,
          source: `loops.${loopId}.consumes.from`,
          from: loop.consumes.from,
          message: `Loop "${loopId}" consumes "${loop.consumes.from}" but its current inbound generator edge comes from "${from}". Reconcile loops.${loopId}.consumes.from from graph topology.`,
        });
      }
    } else if (isConsumerLoop && uniqueSources.length === 0) {
      diagnostics.push({
        code: "loop-consumer-missing",
        loopId,
        source: `loops.${loopId}.consumes`,
        message: `Loop "${loopId}" must have exactly one inbound edge from a generator socket into the selected cycle; found none.`,
      });
    } else if (isConsumerLoop && uniqueSources.length > 1) {
      diagnostics.push({
        code: "loop-consumer-ambiguous",
        loopId,
        source: `loops.${loopId}.consumes`,
        message: `Loop "${loopId}" must have exactly one inbound edge from a generator socket into the selected cycle; found ${uniqueSources.length}: ${uniqueSources.join(", ")}.`,
      });
    }
  }

  for (const [from, socket] of loadoutSocketEntries(loadout as MateriaPipelineConfig) as [string, AnalyzeableSocket | undefined][]) {
    if (!socket || !isWorkItemsGeneratorSocket(socket, materia)) continue;
    for (const edge of socket.edges ?? []) {
      if (!isWorkItemsGeneratorSocket(getLoadoutSocket(loadout as MateriaPipelineConfig, edge.to) as AnalyzeableSocket | undefined, materia)) continue;
      workItemProducingSocketIds.add(from);
      workItemProducingSocketIds.add(edge.to);
    }
  }

  return { workItemProducingSocketIds, loopConsumerSources, diagnostics };
}

export function reconcileLoadoutLoopConsumersFromGraph<TLoadout extends AnalyzeableLoadout>(loadout: TLoadout, materia: Record<string, GeneratorMateriaLike> = {}): TLoadout {
  const analysis = analyzeLoadoutGraph(loadout, materia);
  if (!loadout.loops || analysis.loopConsumerSources.size === 0) return cloneValue(loadout);

  const next = cloneValue(loadout);
  for (const [loopId, source] of analysis.loopConsumerSources) {
    const loop = next.loops?.[loopId];
    if (!loop || (!loop.consumes && !loop.iterator)) continue;
    loop.consumes = { ...(loop.consumes ?? {}), from: source.from, output: loop.consumes?.output ?? source.output };
  }
  return next;
}

export function reconcileLoadoutLoopConsumersFromGraphInPlace(loadout: MateriaPipelineConfig, materia: Record<string, GeneratorMateriaLike> = {}): LoadoutGraphAnalysis {
  const analysis = analyzeLoadoutGraph(loadout, materia);
  for (const [loopId, source] of analysis.loopConsumerSources) {
    const loop = loadout.loops?.[loopId];
    if (!loop || (!loop.consumes && !loop.iterator)) continue;
    loop.consumes = { ...(loop.consumes ?? {}), from: source.from, output: loop.consumes?.output ?? source.output };
  }
  return analysis;
}

function isWorkItemsGeneratorSocket(socket: AnalyzeableSocket | undefined, materia: Record<string, GeneratorMateriaLike>): boolean {
  return socket?.type === "agent" && typeof socket.materia === "string" && Boolean(canonicalGeneratorConfigFor(materia[socket.materia]));
}

function generatorOutputForSocket(socket: AnalyzeableSocket | undefined, materia: Record<string, GeneratorMateriaLike>): string | undefined {
  return socket?.type === "agent" && typeof socket.materia === "string" ? canonicalGeneratorConfigFor(materia[socket.materia])?.output : undefined;
}

function cloneValue<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}
