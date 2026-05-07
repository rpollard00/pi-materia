import { resolveArtifactRoot } from "./config.js";
import { assertValidPipelineGraph, normalizePipelineGraph } from "./graphValidation.js";
import type { MateriaBudgetConfig, MateriaEdgeConfig, MateriaPipelineConfig, MateriaPipelineNodeConfig, MateriaConfig, PiMateriaConfig, ResolvedMateriaNode, ResolvedMateriaPipeline } from "./types.js";

export interface EffectiveMateriaPipelineConfig {
  pipeline: MateriaPipelineConfig;
  loadoutName: string;
}

export function getEffectivePipelineConfig(config: PiMateriaConfig): EffectiveMateriaPipelineConfig {
  const loadouts = config.loadouts ?? {};
  const loadoutNames = Object.keys(loadouts);
  if (loadoutNames.length === 0) {
    throw new Error(`Materia config must define named "loadouts" and set "activeLoadout" to one of them.`);
  }

  const activeLoadout = config.activeLoadout;
  if (!activeLoadout) {
    throw new Error(`No active Materia loadout configured. Set "activeLoadout" to one of: ${loadoutNames.join(", ")}.`);
  }
  const pipeline = loadouts[activeLoadout];
  if (!pipeline) {
    throw new Error(`Unknown active Materia loadout "${activeLoadout}". Available loadouts: ${loadoutNames.join(", ")}.`);
  }
  return { pipeline: normalizePipelineGraph(pipeline), loadoutName: activeLoadout };
}

export function resolvePipeline(config: PiMateriaConfig): ResolvedMateriaPipeline {
  const rawConfig = config as unknown as Record<string, unknown>;
  if ("roles" in rawConfig) throw new Error(`Materia config configures obsolete roles. Use top-level materia instead.`);
  if ("materiaDefinitions" in rawConfig) throw new Error(`Materia config configures obsolete materiaDefinitions.`);
  validateMateriaEntries(config);
  const effective = getEffectivePipelineConfig(config);
  validateLoadout(effective.loadoutName, effective.pipeline);
  assertValidPipelineGraph(effective.pipeline);
  const nodes = Object.fromEntries(
    Object.keys(effective.pipeline.nodes).map((id) => [id, resolveNode(config, effective, id, `${pipelineSource(effective)}.nodes.${id}`)]),
  );
  const entry = nodes[effective.pipeline.entry];
  if (!entry) throw new Error(`Unknown pipeline entry slot "${effective.pipeline.entry}"`);
  return { entry, nodes };
}

function resolveNode(config: PiMateriaConfig, effective: EffectiveMateriaPipelineConfig, id: string, source: string): ResolvedMateriaNode {
  const node = effective.pipeline.nodes[id];
  if (!node) throw new Error(`Unknown pipeline slot "${id}" referenced by ${source}`);
  validateNode(id, node);

  if (node.type === "agent") {
    const materia = config.materia[node.materia];
    if (!materia) throw new Error(`Pipeline slot "${id}" references unknown materia "${node.materia}"`);
    validateMateriaEntry(node.materia, materia);
    return { id, node, materia };
  }

  return { id, node };
}

function validateLoadout(name: string, pipeline: MateriaPipelineConfig): void {
  const rawLoadout = pipeline as unknown as Record<string, unknown>;
  if ("prompt" in rawLoadout) {
    throw new Error(`Materia loadout "${name}" configures obsolete prompt. Define prompt on referenced materia instead.`);
  }
  if ("systemPrompt" in rawLoadout) {
    throw new Error(`Materia loadout "${name}" configures obsolete systemPrompt. Define prompt on referenced materia instead.`);
  }
}

function validateNode(id: string, node: MateriaPipelineNodeConfig): void {
  if (node.type !== "agent" && node.type !== "utility") {
    throw new Error(`Pipeline slot "${id}" has unsupported type "${String((node as { type?: unknown }).type)}"`);
  }
  if (node.parse !== undefined && node.parse !== "text" && node.parse !== "json") {
    throw new Error(`Pipeline slot "${id}" has unsupported parse mode "${String(node.parse)}". Expected "text" or "json".`);
  }
  if ("role" in node) {
    throw new Error(`Pipeline slot "${id}" configures obsolete role. Use materia instead.`);
  }
  if ("prompt" in node || "systemPrompt" in node) {
    throw new Error(`Pipeline slot "${id}" configures obsolete prompt. Define prompt on the referenced materia instead.`);
  }
  if ("multiTurn" in node) {
    throw new Error(`Pipeline slot "${id}" configures obsolete multiTurn. Configure multiTurn on the referenced materia instead.`);
  }
  if (node.type === "utility") {
    if (!node.utility && !node.command) throw new Error(`Utility pipeline slot "${id}" must configure either "utility" or "command".`);
    if (node.command !== undefined) validateCommand(id, node.command);
    if (node.timeoutMs !== undefined && (!Number.isFinite(node.timeoutMs) || node.timeoutMs <= 0)) {
      throw new Error(`Utility pipeline slot "${id}" has invalid timeoutMs. Expected a positive number of milliseconds.`);
    }
  }
}

function validateMateriaEntries(config: PiMateriaConfig): void {
  const rawMateriaConfig = (config as unknown as Record<string, unknown>).materia;
  if (rawMateriaConfig === undefined) return;
  if (!isPlainObject(rawMateriaConfig)) throw new Error(`Materia config has invalid materia. Expected a materia object.`);
  for (const [name, materia] of Object.entries(rawMateriaConfig)) {
    validateMateriaEntry(name, materia as MateriaConfig);
  }
}

function validateMateriaEntry(name: string, materia: MateriaConfig): void {
  const rawMateria = materia as unknown as Record<string, unknown>;
  if (!isPlainObject(rawMateria)) throw new Error(`Materia "${name}" is invalid. Expected a materia object.`);
  if ("systemPrompt" in rawMateria) throw new Error(`Materia "${name}" configures obsolete systemPrompt. Use prompt instead.`);
  if (rawMateria.prompt === undefined || typeof rawMateria.prompt !== "string") {
    throw new Error(`Materia "${name}" has invalid prompt. Expected a string.`);
  }
  if (materia.multiTurn !== undefined && typeof materia.multiTurn !== "boolean") {
    throw new Error(`Materia "${name}" has invalid multiTurn. Expected a boolean when configured.`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function pipelineSource(effective: EffectiveMateriaPipelineConfig): string {
  return `loadouts.${effective.loadoutName}`;
}

export function renderGrid(config: PiMateriaConfig, pipeline: ResolvedMateriaPipeline, source: string, cwd: string): string[] {
  const effective = getEffectivePipelineConfig(config);
  const lines = [
    "pi-materia Materia Grid",
    `source: ${source}`,
    `artifactDir: ${resolveArtifactRoot(cwd, config.artifactDir)}`,
    `limits: ${formatLimits(config)}`,
    `budget: ${formatBudget(config.budget)}`,
    `loadout: ${effective.loadoutName}`,
    "",
    "Graph:",
    ...renderGraph(effective.pipeline),
    "",
    "Resolved entry:",
    pipeline.entry.id,
    "",
    "Materia:",
    ...renderMateria(config),
    "",
    "Slots:",
  ];

  for (const [id, node] of Object.entries(effective.pipeline.nodes)) {
    lines.push(`- ${id}: ${formatNodeSlot(config, node)}`);
  }
  return lines;
}

function renderMateria(config: PiMateriaConfig): string[] {
  const entries = Object.entries(config.materia);
  if (entries.length === 0) return ["- none configured"];
  return entries.map(([name, materia]) => `- ${name}: ${formatMateriaDetails(materia)}`);
}

function formatNodeSlot(config: PiMateriaConfig, node: MateriaPipelineNodeConfig): string {
  const details: string[] = [`type=${node.type}`];
  if (node.type === "agent") {
    const materia = config.materia[node.materia];
    details.push(`materia=${node.materia}`, `tools=${materia?.tools ?? "unknown"}`);
    if (materia?.multiTurn) details.push("materia.multiTurn=true");
    if (materia) details.push(formatMateriaModelSettings(materia));
  } else {
    details.push(node.utility ? `utility=${node.utility}` : `command=${formatCommand(node.command)}`);
  }
  details.push(`parse=${node.parse ?? "text"}`);
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

function formatMateriaDetails(materia: { tools?: string; model?: string; thinking?: string; multiTurn?: boolean }): string {
  return [
    `tools=${materia.tools}`,
    materia.multiTurn ? "multiTurn=true" : undefined,
    formatMateriaModelSettings(materia),
  ].filter(Boolean).join(", ");
}

function formatMateriaModelSettings(materia: { model?: string; thinking?: string }): string {
  return [
    `model=${materia.model ?? "active Pi model"}`,
    `thinking=${materia.thinking ?? "active Pi thinking"}`,
  ].join(", ");
}

function formatNodeLimits(limits: NonNullable<MateriaPipelineNodeConfig["limits"]>): string {
  return [
    limits.maxVisits === undefined ? undefined : `visits ${limits.maxVisits}`,
    limits.maxEdgeTraversals === undefined ? undefined : `edges ${limits.maxEdgeTraversals}`,
    limits.maxOutputBytes === undefined ? undefined : `output ${limits.maxOutputBytes}B`,
  ].filter(Boolean).join("/") || "default";
}

function renderGraph(pipeline: MateriaPipelineConfig): string[] {
  const lines: string[] = [];
  for (const [id, node] of Object.entries(pipeline.nodes)) {
    for (const edge of node.edges ?? []) lines.push(`${id} --${edgeLabel(edge)}--> ${edge.to}`);
    if (!node.edges?.length) lines.push(`${id}`);
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
