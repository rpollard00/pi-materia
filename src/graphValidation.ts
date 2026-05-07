import { HANDOFF_EDGE_CONDITIONS } from "./handoffContract.js";
import type { LegacyMateriaPipelineNodeConfig, MateriaEdgeCondition, MateriaEdgeConfig, MateriaPipelineConfig, MateriaPipelineNodeConfig } from "./types.js";

export const CANONICAL_EDGE_CONDITIONS = HANDOFF_EDGE_CONDITIONS;
export type MateriaGraphEdgeCondition = MateriaEdgeCondition | "invalid";
export type MateriaGraphEdgeGuard = "unconditional" | "guarded";

export interface MateriaGraphValidationError {
  code: "missing-endpoint" | "unknown-endpoint" | "invalid-edge-condition" | "unreachable-edge";
  message: string;
  source?: string;
  from?: string;
  to?: string;
}

export interface MateriaGraphValidationResult {
  ok: boolean;
  errors: MateriaGraphValidationError[];
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

export function validatePipelineGraph(graph: MateriaPipelineConfig): MateriaGraphValidationResult {
  const normalized = normalizePipelineGraph(graph);
  const errors: MateriaGraphValidationError[] = [];
  const nodeIds = new Set(Object.keys(normalized.nodes ?? {}));

  validateTarget(errors, nodeIds, graph.entry, "entry");

  for (const [id, node] of Object.entries(normalized.nodes ?? {})) {
    const errorCountBeforeNode = errors.length;
    validateNodeLinks(id, node, errors, nodeIds);
    if (errors.length === errorCountBeforeNode) validateOutgoingEdgeConditions(id, node.edges ?? [], errors);
  }

  // Materia graphs are workflow state machines, not DAGs: transitions may
  // intentionally revisit earlier sockets (for example Build -> Eval -> Maintain
  // -> Build). Runtime node-visit and edge-traversal limits bound iterative
  // execution, so validation only checks structural graph integrity here.
  return { ok: errors.length === 0, errors };
}

export function assertValidPipelineGraph(graph: MateriaPipelineConfig): void {
  const result = validatePipelineGraph(graph);
  if (!result.ok) throw new Error(formatGraphValidationErrors(result.errors));
}

export function stageValidatedPipelineGraphChange<TGraph extends MateriaPipelineConfig>(graph: TGraph, mutator: (draft: TGraph) => void): ValidatedGraphChangeResult<TGraph> {
  const draft = cloneGraph(graph);
  mutator(draft);
  const normalized = normalizePipelineGraph(draft);
  const result = validatePipelineGraph(normalized);
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

function validateOptionalTarget(errors: MateriaGraphValidationError[], nodeIds: Set<string>, from: string, to: string | undefined, source: string): void {
  if (!to) {
    if (source.includes(".edges[")) errors.push({ code: "missing-endpoint", source, from, message: `Missing graph endpoint referenced by ${source}.` });
    return;
  }
  if (to !== "end" && !nodeIds.has(to)) errors.push({ code: "unknown-endpoint", source, from, to, message: `Unknown graph endpoint "${to}" referenced by ${source}.` });
}

function validateTarget(errors: MateriaGraphValidationError[], nodeIds: Set<string>, to: string | undefined, source: string): void {
  if (!to) {
    errors.push({ code: "missing-endpoint", source, message: `Missing graph endpoint referenced by ${source}.` });
    return;
  }
  if (to !== "end" && !nodeIds.has(to)) errors.push({ code: "unknown-endpoint", source, to, message: `Unknown graph endpoint "${to}" referenced by ${source}.` });
}


function cloneGraph<TGraph extends MateriaPipelineConfig>(graph: TGraph): TGraph {
  return JSON.parse(JSON.stringify(graph)) as TGraph;
}
