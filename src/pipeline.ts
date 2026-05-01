import { resolveArtifactRoot } from "./config.js";
import type { MateriaBudgetConfig, MateriaEdgeConfig, MateriaPipelineNodeConfig, PiMateriaConfig, ResolvedMateriaNode, ResolvedMateriaPipeline } from "./types.js";

export function resolvePipeline(config: PiMateriaConfig): ResolvedMateriaPipeline {
  const nodes = Object.fromEntries(
    Object.keys(config.pipeline.nodes).map((id) => [id, resolveNode(config, id, `pipeline.nodes.${id}`)]),
  );
  const entry = nodes[config.pipeline.entry];
  if (!entry) throw new Error(`Unknown pipeline entry slot "${config.pipeline.entry}"`);
  validateTargets(config);
  return { entry, nodes };
}

function resolveNode(config: PiMateriaConfig, id: string, source: string): ResolvedMateriaNode {
  const node = config.pipeline.nodes[id];
  if (!node) throw new Error(`Unknown pipeline slot "${id}" referenced by ${source}`);
  validateNode(id, node);

  if (node.type === "agent") {
    const role = config.roles[node.role];
    if (!role) throw new Error(`Pipeline slot "${id}" references unknown materia role "${node.role}"`);
    return { id, node, role };
  }

  return { id, node };
}

function validateNode(id: string, node: MateriaPipelineNodeConfig): void {
  if (node.type !== "agent" && node.type !== "utility") {
    throw new Error(`Pipeline slot "${id}" has unsupported type "${String((node as { type?: unknown }).type)}"`);
  }
  if (node.parse !== undefined && node.parse !== "text" && node.parse !== "json") {
    throw new Error(`Pipeline slot "${id}" has unsupported parse mode "${String(node.parse)}". Expected "text" or "json".`);
  }
  if (node.type === "utility") {
    if (!node.utility && !node.command) throw new Error(`Utility pipeline slot "${id}" must configure either "utility" or "command".`);
    if (node.command !== undefined) validateCommand(id, node.command);
    if (node.timeoutMs !== undefined && (!Number.isFinite(node.timeoutMs) || node.timeoutMs <= 0)) {
      throw new Error(`Utility pipeline slot "${id}" has invalid timeoutMs. Expected a positive number of milliseconds.`);
    }
  }
}

function validateCommand(id: string, command: unknown): void {
  if (!Array.isArray(command)) throw new Error(`Utility pipeline slot "${id}" has malformed command. Expected a non-empty string array.`);
  if (command.length === 0) throw new Error(`Utility pipeline slot "${id}" has malformed command. Expected at least one command element.`);
  for (const [index, part] of command.entries()) {
    if (typeof part !== "string" || part.length === 0) {
      throw new Error(`Utility pipeline slot "${id}" has malformed command element at index ${index}. Expected a non-empty string.`);
    }
  }
}

function validateTargets(config: PiMateriaConfig): void {
  for (const [id, node] of Object.entries(config.pipeline.nodes)) {
    validateTarget(config, node.next, `${id}.next`);
    validateTarget(config, node.foreach?.done, `${id}.foreach.done`);
    validateTarget(config, node.advance?.done, `${id}.advance.done`);
    for (const edge of node.edges ?? []) validateTarget(config, edge.to, `${id}.edges[].to`);
  }
}

function validateTarget(config: PiMateriaConfig, target: string | undefined, source: string): void {
  if (!target || target === "end") return;
  if (!config.pipeline.nodes[target]) throw new Error(`Unknown pipeline slot "${target}" referenced by ${source}`);
}

export function renderGrid(config: PiMateriaConfig, pipeline: ResolvedMateriaPipeline, source: string, cwd: string): string[] {
  const lines = [
    "pi-materia Materia Grid",
    `source: ${source}`,
    `artifactDir: ${resolveArtifactRoot(cwd, config.artifactDir)}`,
    `limits: ${formatLimits(config)}`,
    `budget: ${formatBudget(config.budget)}`,
    "",
    "Graph:",
    ...renderGraph(config),
    "",
    "Resolved entry:",
    pipeline.entry.id,
    "",
    "Roles:",
    ...renderRoles(config),
    "",
    "Slots:",
  ];

  for (const [id, node] of Object.entries(config.pipeline.nodes)) {
    lines.push(`- ${id}: ${formatNodeSlot(config, node)}`);
  }
  return lines;
}

function renderRoles(config: PiMateriaConfig): string[] {
  const entries = Object.entries(config.roles);
  if (entries.length === 0) return ["- none configured"];
  return entries.map(([name, role]) => `- ${name}: tools=${role.tools}, ${formatRoleModelSettings(role)}`);
}

function formatNodeSlot(config: PiMateriaConfig, node: MateriaPipelineNodeConfig): string {
  const details: string[] = [`type=${node.type}`];
  if (node.type === "agent") {
    const role = config.roles[node.role];
    details.push(`role=${node.role}`, `tools=${role?.tools ?? "unknown"}`);
    if (role) details.push(formatRoleModelSettings(role));
  } else {
    details.push(node.utility ? `utility=${node.utility}` : `command=${formatCommand(node.command)}`);
  }
  details.push(`parse=${node.parse ?? "text"}`);
  if (node.next) details.push(`next=${node.next}`);
  if (node.edges?.length) details.push(`edges=${node.edges.map((edge) => `${edgeLabel(edge)}->${edge.to}`).join(",")}`);
  if (node.foreach) details.push(`foreach=${node.foreach.items}${node.foreach.as ? ` as ${node.foreach.as}` : ""}${node.foreach.done ? ` done ${node.foreach.done}` : ""}`);
  if (node.advance) details.push(`advance=${node.advance.cursor}:${node.advance.items}${node.advance.when ? ` when ${node.advance.when}` : ""}${node.advance.done ? ` done ${node.advance.done}` : ""}`);
  if (node.limits) details.push(`limits=${formatNodeLimits(node.limits)}`);
  if (node.type === "utility" && node.timeoutMs !== undefined) details.push(`timeoutMs=${node.timeoutMs}`);
  return details.join(", ");
}

function formatCommand(command: string[] | undefined): string {
  return command?.length ? command.map((part) => JSON.stringify(part)).join(" ") : "<missing>";
}

function formatRoleModelSettings(role: { model?: string; thinking?: string }): string {
  return [
    `model=${role.model ?? "active Pi model"}`,
    `thinking=${role.thinking ?? "active Pi thinking"}`,
  ].join(", ");
}

function formatNodeLimits(limits: NonNullable<MateriaPipelineNodeConfig["limits"]>): string {
  return [
    limits.maxVisits === undefined ? undefined : `visits ${limits.maxVisits}`,
    limits.maxEdgeTraversals === undefined ? undefined : `edges ${limits.maxEdgeTraversals}`,
    limits.maxOutputBytes === undefined ? undefined : `output ${limits.maxOutputBytes}B`,
  ].filter(Boolean).join("/") || "default";
}

function renderGraph(config: PiMateriaConfig): string[] {
  const lines: string[] = [];
  for (const [id, node] of Object.entries(config.pipeline.nodes)) {
    if (node.next) lines.push(`${id} -> ${node.next}`);
    for (const edge of node.edges ?? []) lines.push(`${id} --${edgeLabel(edge)}--> ${edge.to}`);
    if (!node.next && !node.edges?.length) lines.push(`${id}`);
  }
  return lines.length > 0 ? lines : ["<empty>"];
}

function edgeLabel(edge: MateriaEdgeConfig): string {
  return edge.when ?? "always";
}

function formatLimits(config: PiMateriaConfig): string {
  return [
    `node visits ${config.limits?.maxNodeVisits ?? 25}`,
    `edge traversals ${config.limits?.maxEdgeTraversals ?? 25}`,
  ].join(", ");
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
