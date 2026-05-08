import { HANDOFF_EDGE_CONDITIONS } from "./handoffContract.js";
import { formatInvalidSocketIdMessage, isCanonicalSocketId } from "./socketIds.js";
import type { LegacyMateriaPipelineNodeConfig, MateriaEdgeCondition, MateriaEdgeConfig, MateriaLoopExitConfig, MateriaPipelineConfig, MateriaPipelineNodeConfig } from "./types.js";

export const CANONICAL_EDGE_CONDITIONS = HANDOFF_EDGE_CONDITIONS;
export type MateriaGraphEdgeCondition = MateriaEdgeCondition | "invalid";
export type MateriaGraphEdgeGuard = "unconditional" | "guarded";

export interface MateriaGraphValidationError {
  code: "missing-endpoint" | "unknown-endpoint" | "invalid-socket-id" | "invalid-edge-condition" | "unreachable-edge" | "invalid-loop";
  message: string;
  source?: string;
  from?: string;
  to?: string;
}

export interface MateriaGraphValidationResult {
  ok: boolean;
  errors: MateriaGraphValidationError[];
}

export interface MateriaGraphValidationOptions {
  isGeneratorNode?: (nodeId: string) => boolean;
}

export interface ValidatedGraphChangeResult<TGraph extends MateriaPipelineConfig = MateriaPipelineConfig> extends MateriaGraphValidationResult {
  graph: TGraph;
}

export function normalizePipelineGraph<TGraph extends MateriaPipelineConfig>(graph: TGraph): TGraph {
  const normalized = cloneGraph(graph);
  for (const node of Object.values(normalized.nodes ?? {}) as LegacyMateriaPipelineNodeConfig[]) {
    const edges = (node.edges ?? []).map((edge) => ({ ...edge, when: normalizeEdgeCondition(edge.when) }));
    if (node.next) edges.push({ when: "always", to: node.next });
    node.edges = edges.length > 0 ? edges : undefined;
    delete node.next;
  }
  return normalized;
}

export function normalizeEdgeCondition(value: unknown): MateriaEdgeCondition {
  if (value === undefined || value === "" || value === "flow" || value === "Flow") return "always";
  if (isCanonicalEdgeCondition(value)) return value;
  return value as MateriaEdgeCondition;
}

export function canonicalOutgoingEdges(node: MateriaPipelineNodeConfig): MateriaEdgeConfig[] {
  const legacyNode = node as LegacyMateriaPipelineNodeConfig;
  const edges = (legacyNode.edges ?? []).map((edge) => ({ ...edge, when: normalizeEdgeCondition(edge.when) }));
  if (legacyNode.next) edges.push({ when: "always", to: legacyNode.next });
  return edges;
}

export function validatePipelineGraph(graph: MateriaPipelineConfig, options: MateriaGraphValidationOptions = {}): MateriaGraphValidationResult {
  const normalized = normalizePipelineGraph(graph);
  const errors: MateriaGraphValidationError[] = [];
  const nodeIds = new Set(Object.keys(normalized.nodes ?? {}));

  for (const id of nodeIds) validateSocketId(errors, id, `nodes.${id}`);
  validateSocketReference(errors, nodeIds, graph.entry, "entry");

  for (const [id, node] of Object.entries(normalized.nodes ?? {})) {
    const errorCountBeforeNode = errors.length;
    validateNodeLinks(id, node, errors, nodeIds);
    if (errors.length === errorCountBeforeNode) validateOutgoingEdgeConditions(id, node.edges ?? [], errors);
  }
  validateLoops(normalized, errors, nodeIds, options);

  // Materia graphs are workflow state machines, not DAGs: transitions may
  // intentionally revisit earlier sockets (for example Build -> Eval -> Maintain
  // -> Build). Runtime node-visit and edge-traversal limits bound iterative
  // execution, so validation only checks structural graph integrity here.
  return { ok: errors.length === 0, errors };
}

export function assertValidPipelineGraph(graph: MateriaPipelineConfig, options: MateriaGraphValidationOptions = {}): void {
  const result = validatePipelineGraph(graph, options);
  if (!result.ok) throw new Error(formatGraphValidationErrors(result.errors));
}

export function stageValidatedPipelineGraphChange<TGraph extends MateriaPipelineConfig>(graph: TGraph, mutator: (draft: TGraph) => void, options: MateriaGraphValidationOptions = {}): ValidatedGraphChangeResult<TGraph> {
  const draft = cloneGraph(graph);
  mutator(draft);
  const normalized = normalizePipelineGraph(draft);
  const result = validatePipelineGraph(normalized, options);
  return { graph: result.ok ? normalized : graph, ok: result.ok, errors: result.errors };
}

export function formatGraphValidationErrors(errors: MateriaGraphValidationError[]): string {
  return errors.map((error) => error.message).join("\n");
}

export function isCanonicalEdgeCondition(value: unknown): value is MateriaEdgeCondition {
  return typeof value === "string" && (CANONICAL_EDGE_CONDITIONS as readonly string[]).includes(value);
}

export function edgeConditionState(edge: { when?: unknown }): MateriaGraphEdgeCondition {
  return isCanonicalEdgeCondition(edge.when) ? edge.when : "invalid";
}

export function edgeGuard(edge: { when?: unknown }): MateriaGraphEdgeGuard {
  return edgeConditionState(edge) === "always" ? "unconditional" : "guarded";
}

function validateNodeLinks(id: string, node: MateriaPipelineNodeConfig, errors: MateriaGraphValidationError[], nodeIds: Set<string>): void {
  const legacyNode = node as LegacyMateriaPipelineNodeConfig;
  validateOptionalTarget(errors, nodeIds, id, legacyNode.next, `${id}.next`);
  validateOptionalTarget(errors, nodeIds, id, node.foreach?.done, `${id}.foreach.done`);
  validateOptionalTarget(errors, nodeIds, id, node.advance?.done, `${id}.advance.done`);
  for (const [index, edge] of (node.edges ?? []).entries()) {
    validateOptionalTarget(errors, nodeIds, id, edge.to, `${id}.edges[${index}].to`);
  }
}

function validateOutgoingEdgeConditions(id: string, edges: MateriaEdgeConfig[], errors: MateriaGraphValidationError[]): void {
  // Runtime treats outgoing edges as an ordered guard list: the first edge with
  // `when: "always"`, or whose canonical condition evaluates truthy, wins.
  // Only the closed canonical set is valid, and edges after an `always` edge are
  // structurally unreachable and rejected.
  let firstUnconditional: number | undefined;
  for (const [index, edge] of edges.entries()) {
    const validCondition = isCanonicalEdgeCondition(edge.when);
    if (!validCondition) {
      errors.push({
        code: "invalid-edge-condition",
        source: `${id}.edges[${index}].when`,
        from: id,
        to: edge.to,
        message: `Socket "${id}" has invalid edge condition at ${id}.edges[${index}].when. Expected one of: ${CANONICAL_EDGE_CONDITIONS.join(", ")}.`,
      });
    }
    if (firstUnconditional !== undefined) {
      errors.push({
        code: "unreachable-edge",
        source: `${id}.edges[${index}]`,
        from: id,
        message: `Socket "${id}" has an unreachable outgoing edge at ${id}.edges[${index}] because ${id}.edges[${firstUnconditional}] is unconditional and runtime selects the first satisfied edge in order.`,
      });
      continue;
    }
    if (validCondition && edgeGuard(edge) === "unconditional") firstUnconditional = index;
  }
}

function validateLoops(graph: MateriaPipelineConfig, errors: MateriaGraphValidationError[], nodeIds: Set<string>, options: MateriaGraphValidationOptions): void {
  for (const [loopId, loop] of Object.entries(graph.loops ?? {})) {
    if (!Array.isArray(loop.nodes) || loop.nodes.length === 0) {
      errors.push({ code: "invalid-loop", source: `loops.${loopId}.nodes`, message: `Loop "${loopId}" must include at least one socket id in loops.${loopId}.nodes.` });
      continue;
    }
    let loopNodesAreValid = true;
    for (const [index, nodeId] of loop.nodes.entries()) {
      if (!validateSocketReference(errors, nodeIds, nodeId, `loops.${loopId}.nodes[${index}]`)) loopNodesAreValid = false;
    }
    const consumesFromIsValid = !loop.consumes || validateSocketReference(errors, nodeIds, loop.consumes.from, `loops.${loopId}.consumes.from`, { from: loop.consumes.from });
    validateOptionalTarget(errors, nodeIds, loopId, loop.consumes?.done, `loops.${loopId}.consumes.done`);
    validateOptionalTarget(errors, nodeIds, loopId, loop.iterator?.done, `loops.${loopId}.iterator.done`);
    validateLoopExit(errors, nodeIds, loopId, loop.nodes, loop.exit);
    if (loop.consumes && consumesFromIsValid && loopNodesAreValid) validateLoopTopology(graph, errors, loopId, loop.nodes, loop.consumes.from, options);
  }
}

function validateLoopExit(errors: MateriaGraphValidationError[], nodeIds: Set<string>, loopId: string, loopNodes: string[], exit: MateriaLoopExitConfig | undefined): void {
  if (!exit) return;
  validateOptionalTarget(errors, nodeIds, loopId, exit.to, `loops.${loopId}.exit.to`);
  if (!exit.from) {
    errors.push({ code: "missing-endpoint", source: `loops.${loopId}.exit.from`, message: `Missing graph endpoint referenced by loops.${loopId}.exit.from.` });
  } else if (!validateSocketId(errors, exit.from, `loops.${loopId}.exit.from`, { from: exit.from })) {
    return;
  } else if (!nodeIds.has(exit.from)) {
    errors.push({ code: "unknown-endpoint", source: `loops.${loopId}.exit.from`, from: exit.from, message: `Unknown graph endpoint "${exit.from}" referenced by loops.${loopId}.exit.from.` });
  } else if (!loopNodes.includes(exit.from)) {
    errors.push({ code: "invalid-loop", source: `loops.${loopId}.exit.from`, from: exit.from, message: `Loop "${loopId}" exit source "${exit.from}" must be one of its member sockets: ${loopNodes.join(", ")}.` });
  }
  if (!isCanonicalEdgeCondition(exit.when)) {
    errors.push({ code: "invalid-edge-condition", source: `loops.${loopId}.exit.when`, from: exit.from, to: exit.to, message: `Loop "${loopId}" has invalid exit condition at loops.${loopId}.exit.when. Expected one of: ${CANONICAL_EDGE_CONDITIONS.join(", ")}.` });
  }
}

function validateLoopTopology(graph: MateriaPipelineConfig, errors: MateriaGraphValidationError[], loopId: string, loopNodes: string[], consumesFrom: string, options: MateriaGraphValidationOptions): void {
  const loopSet = new Set(loopNodes);
  if (!containsDirectedCycle(graph, loopSet)) {
    errors.push({ code: "invalid-loop", source: `loops.${loopId}.nodes`, message: `Loop "${loopId}" must contain a directed cycle among its selected sockets before it can be created.` });
  }
  if (!options.isGeneratorNode) return;

  const inboundGeneratorEdges = Object.entries(graph.nodes ?? {}).flatMap(([from, node]) => {
    if (loopSet.has(from) || !options.isGeneratorNode?.(from)) return [];
    return (node.edges ?? []).filter((edge) => loopSet.has(edge.to)).map((edge) => ({ from, to: edge.to }));
  });

  if (inboundGeneratorEdges.length === 0) {
    errors.push({ code: "invalid-loop", source: `loops.${loopId}.consumes`, message: `Loop "${loopId}" must have exactly one inbound edge from a generator socket into the selected cycle; found none.` });
  } else if (inboundGeneratorEdges.length > 1) {
    const details = inboundGeneratorEdges.map((edge) => `${edge.from}->${edge.to}`).join(", ");
    errors.push({ code: "invalid-loop", source: `loops.${loopId}.consumes`, message: `Loop "${loopId}" must have exactly one inbound edge from a generator socket into the selected cycle; found ${inboundGeneratorEdges.length}: ${details}.` });
  } else if (inboundGeneratorEdges[0]?.from !== consumesFrom) {
    errors.push({ code: "invalid-loop", source: `loops.${loopId}.consumes.from`, from: consumesFrom, message: `Loop "${loopId}" consumes "${consumesFrom}" but its only inbound generator edge comes from "${inboundGeneratorEdges[0]?.from}".` });
  }
}

function containsDirectedCycle(graph: MateriaPipelineConfig, loopSet: Set<string>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const edge of graph.nodes[nodeId]?.edges ?? []) {
      if (loopSet.has(edge.to) && visit(edge.to)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  return Array.from(loopSet).some((nodeId) => visit(nodeId));
}

function validateOptionalTarget(errors: MateriaGraphValidationError[], nodeIds: Set<string>, from: string, to: string | undefined, source: string): void {
  if (!to) {
    if (source.includes(".edges[")) errors.push({ code: "missing-endpoint", source, from, message: `Missing graph endpoint referenced by ${source}.` });
    return;
  }
  if (to === "end") return;
  if (!validateSocketId(errors, to, source, { from, to })) return;
  if (!nodeIds.has(to)) errors.push({ code: "unknown-endpoint", source, from, to, message: `Unknown graph endpoint "${to}" referenced by ${source}.` });
}

function validateSocketReference(errors: MateriaGraphValidationError[], nodeIds: Set<string>, to: string | undefined, source: string, endpoint: Pick<MateriaGraphValidationError, "from" | "to"> = { to }): boolean {
  if (!to) {
    errors.push({ code: "missing-endpoint", source, message: `Missing graph endpoint referenced by ${source}.` });
    return false;
  }
  if (!validateSocketId(errors, to, source, endpoint)) return false;
  if (!nodeIds.has(to)) {
    errors.push({ code: "unknown-endpoint", source, to, message: `Unknown graph endpoint "${to}" referenced by ${source}.` });
    return false;
  }
  return true;
}

function validateSocketId(errors: MateriaGraphValidationError[], value: string, source: string, endpoint: Pick<MateriaGraphValidationError, "from" | "to"> = {}): boolean {
  if (isCanonicalSocketId(value)) return true;
  errors.push({ code: "invalid-socket-id", source, ...endpoint, message: formatInvalidSocketIdMessage(value, source) });
  return false;
}


function cloneGraph<TGraph extends MateriaPipelineConfig>(graph: TGraph): TGraph {
  return JSON.parse(JSON.stringify(graph)) as TGraph;
}
