import { canonicalGeneratorConfigFor, type GeneratorMateriaLike } from "./generator.js";
import type { MateriaEdgeConfig, MateriaLoopConsumerConfig, MateriaPipelineConfig, MateriaPipelineNodeConfig } from "./types.js";

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
  workItemProducingNodeIds: Set<string>;
  loopConsumerSources: Map<string, DerivedLoopConsumerSource>;
  diagnostics: LoadoutGraphDiagnostic[];
}

interface AnalyzeableNode {
  type?: string;
  materia?: string;
  edges?: MateriaEdgeConfig[];
}

interface AnalyzeableLoop {
  nodes: string[];
  consumes?: Partial<MateriaLoopConsumerConfig> & { from?: string };
  iterator?: unknown;
}

interface AnalyzeableLoadout {
  nodes?: Record<string, AnalyzeableNode | undefined>;
  loops?: Record<string, AnalyzeableLoop | undefined>;
}

export function analyzeLoadoutGraph(loadout: AnalyzeableLoadout, materia: Record<string, GeneratorMateriaLike> = {}): LoadoutGraphAnalysis {
  // Keep this analysis tied to semantic graph inputs: build loop membership
  // indexes once, walk node edges once, then finalize each loop. Complexity is
  // O(nodes + edges + loop memberships + edge-loop hits) instead of scanning
  // every node/edge once per loop; nested loops only add proportional hits for
  // edges that actually target sockets belonging to multiple loops.
  const nodes = loadout.nodes ?? {};
  const diagnostics: LoadoutGraphDiagnostic[] = [];
  const loopConsumerSources = new Map<string, DerivedLoopConsumerSource>();
  const workItemProducingSocketIds = new Set<string>();
  const workItemProducingNodeIds = new Set<string>();
  const loopNodeSets = new Map<string, Set<string>>();
  const loopConsumerFlags = new Map<string, boolean>();
  const socketLoopIds = new Map<string, Set<string>>();
  const inboundGeneratorSourcesByLoop = new Map<string, Set<string>>();

  for (const [loopId, loop] of Object.entries(loadout.loops ?? {})) {
    if (!loop) continue;
    const loopSet = new Set(loop.nodes ?? []);
    loopNodeSets.set(loopId, loopSet);
    loopConsumerFlags.set(loopId, Boolean(loop.consumes || loop.iterator));
    inboundGeneratorSourcesByLoop.set(loopId, new Set());
    for (const socketId of loopSet) {
      const loopIds = socketLoopIds.get(socketId) ?? new Set<string>();
      loopIds.add(loopId);
      socketLoopIds.set(socketId, loopIds);
    }
  }

  for (const [from, node] of Object.entries(nodes)) {
    if (!node || !isWorkItemsGeneratorNode(node, materia)) continue;
    for (const edge of node.edges ?? []) {
      const targetLoopIds = socketLoopIds.get(edge.to);
      if (!targetLoopIds) continue;
      for (const loopId of targetLoopIds) {
        const loopSet = loopNodeSets.get(loopId);
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
      const output = loop.consumes?.output ?? generatorOutputForNode(nodes[from], materia) ?? "workItems";
      loopConsumerSources.set(loopId, { from, output });
      workItemProducingSocketIds.add(from);
      workItemProducingNodeIds.add(from);
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

  for (const [from, node] of Object.entries(nodes)) {
    if (!node || !isWorkItemsGeneratorNode(node, materia)) continue;
    for (const edge of node.edges ?? []) {
      if (!isWorkItemsGeneratorNode(nodes[edge.to], materia)) continue;
      workItemProducingSocketIds.add(from);
      workItemProducingSocketIds.add(edge.to);
      workItemProducingNodeIds.add(from);
      workItemProducingNodeIds.add(edge.to);
    }
  }

  return { workItemProducingSocketIds, workItemProducingNodeIds, loopConsumerSources, diagnostics };
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

function isWorkItemsGeneratorNode(node: AnalyzeableNode | undefined, materia: Record<string, GeneratorMateriaLike>): boolean {
  return node?.type === "agent" && typeof node.materia === "string" && Boolean(canonicalGeneratorConfigFor(materia[node.materia]));
}

function generatorOutputForNode(node: AnalyzeableNode | undefined, materia: Record<string, GeneratorMateriaLike>): string | undefined {
  return node?.type === "agent" && typeof node.materia === "string" ? canonicalGeneratorConfigFor(materia[node.materia])?.output : undefined;
}

function cloneValue<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}
