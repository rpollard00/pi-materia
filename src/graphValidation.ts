import type { MateriaEdgeConfig, MateriaPipelineConfig, MateriaPipelineNodeConfig } from "./types.js";

export type MateriaGraphEdgeCondition = "satisfied" | "unsatisfied" | "other";

export interface MateriaGraphValidationError {
  code: "missing-endpoint" | "unknown-endpoint" | "duplicate-condition" | "cycle";
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

interface GraphLink {
  from: string;
  to: string;
  source: string;
  condition?: MateriaGraphEdgeCondition;
}

export function validatePipelineGraph(graph: MateriaPipelineConfig): MateriaGraphValidationResult {
  const errors: MateriaGraphValidationError[] = [];
  const nodeIds = new Set(Object.keys(graph.nodes ?? {}));

  validateTarget(errors, nodeIds, graph.entry, "entry");

  const links: GraphLink[] = [];
  for (const [id, node] of Object.entries(graph.nodes ?? {})) {
    collectNodeLinks(id, node, links, errors, nodeIds);
    validateOutgoingEdgeConditions(id, node.edges ?? [], errors);
  }

  validateAcyclic(links.filter((link) => nodeIds.has(link.from) && nodeIds.has(link.to)), errors);
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
  if (/==\s*true$/.test(normalized) || /!=\s*false$/.test(normalized)) return "satisfied";
  if (/==\s*false$/.test(normalized) || /!=\s*true$/.test(normalized)) return "unsatisfied";
  return "other";
}

function collectNodeLinks(id: string, node: MateriaPipelineNodeConfig, links: GraphLink[], errors: MateriaGraphValidationError[], nodeIds: Set<string>): void {
  addLink(links, errors, nodeIds, id, node.next, `${id}.next`);
  addLink(links, errors, nodeIds, id, node.foreach?.done, `${id}.foreach.done`);
  addLink(links, errors, nodeIds, id, node.advance?.done, `${id}.advance.done`);
  for (const [index, edge] of (node.edges ?? []).entries()) {
    addLink(links, errors, nodeIds, id, edge.to, `${id}.edges[${index}].to`, edgeConditionState(edge));
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

function addLink(links: GraphLink[], errors: MateriaGraphValidationError[], nodeIds: Set<string>, from: string, to: string | undefined, source: string, condition?: MateriaGraphEdgeCondition): void {
  if (!to) {
    if (source.includes(".edges[")) errors.push({ code: "missing-endpoint", source, from, message: `Missing graph endpoint referenced by ${source}.` });
    return;
  }
  if (to === "end") return;
  if (!nodeIds.has(to)) {
    errors.push({ code: "unknown-endpoint", source, from, to, message: `Unknown graph endpoint "${to}" referenced by ${source}.` });
    return;
  }
  links.push({ from, to, source, condition });
}

function validateTarget(errors: MateriaGraphValidationError[], nodeIds: Set<string>, to: string | undefined, source: string): void {
  if (!to) {
    errors.push({ code: "missing-endpoint", source, message: `Missing graph endpoint referenced by ${source}.` });
    return;
  }
  if (to !== "end" && !nodeIds.has(to)) errors.push({ code: "unknown-endpoint", source, to, message: `Unknown graph endpoint "${to}" referenced by ${source}.` });
}

function validateAcyclic(links: GraphLink[], errors: MateriaGraphValidationError[]): void {
  const outgoing = new Map<string, GraphLink[]>();
  for (const link of links) outgoing.set(link.from, [...(outgoing.get(link.from) ?? []), link]);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: GraphLink[] = [];

  const visit = (id: string): boolean => {
    if (visiting.has(id)) {
      const start = stack.findIndex((link) => link.from === id);
      const cycle = stack.slice(Math.max(0, start)).map((link) => `${link.from}->${link.to}`).join(" -> ");
      errors.push({ code: "cycle", source: stack.at(-1)?.source, from: id, message: `Graph cycle detected: ${cycle}.` });
      return true;
    }
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const link of outgoing.get(id) ?? []) {
      stack.push(link);
      if (visit(link.to)) return true;
      stack.pop();
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  for (const id of outgoing.keys()) {
    if (visit(id)) break;
  }
}

function cloneGraph<TGraph extends MateriaPipelineConfig>(graph: TGraph): TGraph {
  return JSON.parse(JSON.stringify(graph)) as TGraph;
}
