import { resolveArtifactRoot } from "./config.js";
import type { MateriaBudgetConfig, PiMateriaConfig, ResolvedMateriaNode, ResolvedMateriaPipeline } from "./types.js";

export function resolvePipeline(config: PiMateriaConfig): ResolvedMateriaPipeline {
  const planner = resolveNode(config, config.pipeline.entry, "pipeline.entry");
  if (!planner.node.next) throw new Error(`Planner slot "${planner.id}" must define next`);

  const builder = resolveNode(config, planner.node.next, `${planner.id}.next`);
  if (!builder.node.next) throw new Error(`Builder slot "${builder.id}" must define next`);

  const evaluator = resolveNode(config, builder.node.next, `${builder.id}.next`);
  const passedTarget = evaluator.node.edges?.passed;
  const failedTarget = evaluator.node.edges?.failed;
  if (!passedTarget) throw new Error(`Evaluator slot "${evaluator.id}" must define edges.passed`);
  if (!failedTarget) throw new Error(`Evaluator slot "${evaluator.id}" must define edges.failed`);
  if (failedTarget !== builder.id) {
    throw new Error(`Evaluator slot "${evaluator.id}" edges.failed must link back to builder slot "${builder.id}" for this runtime`);
  }

  return {
    planner,
    builder,
    evaluator,
    maintainer: passedTarget === "end" ? undefined : resolveNode(config, passedTarget, `${evaluator.id}.edges.passed`),
  };
}

function resolveNode(config: PiMateriaConfig, id: string, source: string): ResolvedMateriaNode {
  const node = config.pipeline.nodes[id];
  if (!node) throw new Error(`Unknown pipeline slot "${id}" referenced by ${source}`);
  if (node.type !== "agent") throw new Error(`Pipeline slot "${id}" has unsupported type "${node.type}"`);

  const role = config.roles[node.role];
  if (!role) throw new Error(`Pipeline slot "${id}" references unknown materia role "${node.role}"`);

  return { id, node, role };
}

export function renderGrid(config: PiMateriaConfig, pipeline: ResolvedMateriaPipeline, source: string, cwd: string): string[] {
  const lines = [
    "pi-materia Materia Grid",
    `source: ${source}`,
    `artifactDir: ${resolveArtifactRoot(cwd, config.artifactDir)}`,
    `maxBuilderAttempts: ${config.maxBuilderAttempts}`,
    `autoCommit: ${config.autoCommit}`,
    `budget: ${formatBudget(config.budget)}`,
    "",
    "Graph:",
    ...renderGraph(config),
    "",
    "Supported runtime path:",
    `${pipeline.planner.id} -> ${pipeline.builder.id} -> ${pipeline.evaluator.id}`,
    `                         | passed -> ${pipeline.maintainer?.id ?? "end"}`,
    `                         | failed  -> ${pipeline.builder.id}`,
    "",
    "Slots:",
  ];

  for (const [id, node] of Object.entries(config.pipeline.nodes)) {
    const role = config.roles[node.role];
    lines.push(`- ${id}: role=${node.role}, tools=${role?.tools ?? "unknown"}`);
  }
  return lines;
}

function renderGraph(config: PiMateriaConfig): string[] {
  const lines: string[] = [];
  for (const [id, node] of Object.entries(config.pipeline.nodes)) {
    if (node.next) lines.push(`${id} -> ${node.next}`);
    for (const [label, target] of Object.entries(node.edges ?? {})) {
      lines.push(`${id} --${label}--> ${target}`);
    }
    if (!node.next && !node.edges) lines.push(`${id}`);
  }
  return lines.length > 0 ? lines : ["<empty>"];
}

function formatBudget(budget?: MateriaBudgetConfig): string {
  if (!budget) return "none";
  return [
    budget.maxTokens === undefined ? undefined : `${budget.maxTokens} tokens`,
    budget.maxCostUsd === undefined ? undefined : `$${budget.maxCostUsd}`,
    budget.warnAtPercent === undefined ? undefined : `warn ${budget.warnAtPercent}%`,
    budget.stopAtLimit === false ? "ask at limit" : "stop at limit",
  ].filter(Boolean).join(", ");
}
