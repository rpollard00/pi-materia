import type { MateriaEdgeConfig, MateriaPipelineConfig, MateriaPipelineNodeConfig } from "./types.js";

export type MateriaGraphEdgeCondition = "satisfied" | "unsatisfied" | "other";

export interface MateriaGraphValidationError {
  code: "missing-endpoint" | "unknown-endpoint" | "duplicate-condition";
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

export function validatePipelineGraph(graph: MateriaPipelineConfig): MateriaGraphValidationResult {
  const errors: MateriaGraphValidationError[] = [];
  const nodeIds = new Set(Object.keys(graph.nodes ?? {}));

  validateTarget(errors, nodeIds, graph.entry, "entry");

  for (const [id, node] of Object.entries(graph.nodes ?? {})) {
    validateNodeLinks(id, node, errors, nodeIds);
    validateOutgoingEdgeConditions(id, node.edges ?? [], errors);
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
  const result = validatePipelineGraph(draft);
  return { graph: result.ok ? draft : graph, ok: result.ok, errors: result.errors };
}

export function formatGraphValidationErrors(errors: MateriaGraphValidationError[]): string {
  return errors.map((error) => error.message).join("\n");
}

export function edgeConditionState(edge: Pick<MateriaEdgeConfig, "when">): MateriaGraphEdgeCondition {
  const condition = edge.when?.trim();
  if (!condition) return "satisfied";
  const normalized = condition.replace(/\s+/g, " ").toLowerCase();
  if (normalized === "satisfied" || normalized === "not unsatisfied") return "satisfied";
  if (normalized === "unsatisfied" || normalized === "not_satisfied" || normalized === "not satisfied") return "unsatisfied";
  if (/==\s*true$/.test(normalized) || /!=\s*false$/.test(normalized)) return "satisfied";
  if (/==\s*false$/.test(normalized) || /!=\s*true$/.test(normalized)) return "unsatisfied";
  return "other";
}

function validateNodeLinks(id: string, node: MateriaPipelineNodeConfig, errors: MateriaGraphValidationError[], nodeIds: Set<string>): void {
  validateOptionalTarget(errors, nodeIds, id, node.next, `${id}.next`);
  validateOptionalTarget(errors, nodeIds, id, node.foreach?.done, `${id}.foreach.done`);
  validateOptionalTarget(errors, nodeIds, id, node.advance?.done, `${id}.advance.done`);
  for (const [index, edge] of (node.edges ?? []).entries()) {
    validateOptionalTarget(errors, nodeIds, id, edge.to, `${id}.edges[${index}].to`);
  }
}

function validateOutgoingEdgeConditions(id: string, edges: MateriaEdgeConfig[], errors: MateriaGraphValidationError[]): void {
  const seen = new Map<MateriaGraphEdgeCondition, number>();
  for (const [index, edge] of edges.entries()) {
    const condition = edgeConditionState(edge);
    if (condition === "other") continue;
    const prior = seen.get(condition);
    if (prior !== undefined) {
      errors.push({
        code: "duplicate-condition",
        source: `${id}.edges[${index}]`,
        from: id,
        message: `Socket "${id}" has more than one outgoing ${condition} edge (${id}.edges[${prior}] and ${id}.edges[${index}]).`,
      });
    } else {
      seen.set(condition, index);
    }
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
