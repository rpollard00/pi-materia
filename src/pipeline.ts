import { resolveArtifactRoot } from "./config.js";
import { assertValidPipelineGraph, normalizePipelineGraph } from "./graphValidation.js";
import type { MateriaAgentConfig, MateriaBudgetConfig, MateriaEdgeConfig, MateriaForeachConfig, MateriaGeneratorConfig, MateriaLoopConfig, MateriaPipelineConfig, MateriaPipelineNodeConfig, MateriaConfig, PiMateriaConfig, ResolvedMateriaNode, ResolvedMateriaPipeline } from "./types.js";

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
  migrateLegacyLoopConsumers(config, effective.pipeline);
  validateLoadout(effective.loadoutName, effective.pipeline);
  assertValidPipelineGraph(effective.pipeline, { isGeneratorNode: (nodeId) => isGeneratorPipelineNode(config, effective.pipeline, nodeId) });
  const nodes = Object.fromEntries(
    Object.keys(effective.pipeline.nodes).map((id) => [id, resolveNode(config, effective, id, `${pipelineSource(effective)}.nodes.${id}`)]),
  );
  validateGeneratorNodeContracts(config, effective);
  const entry = nodes[effective.pipeline.entry];
  if (!entry) throw new Error(`Unknown pipeline entry slot "${effective.pipeline.entry}"`);
  return { entry, nodes, loops: resolveLoopIterators(config, effective) };
}

function resolveNode(config: PiMateriaConfig, effective: EffectiveMateriaPipelineConfig, id: string, source: string): ResolvedMateriaNode {
  const node = effective.pipeline.nodes[id];
  if (!node) throw new Error(`Unknown pipeline slot "${id}" referenced by ${source}`);
  validateNode(id, node);

  if (node.type === "agent") {
    const materia = config.materia[node.materia];
    if (!materia) throw new Error(`Pipeline slot "${id}" references unknown materia "${node.materia}"`);
    validateAgentMateriaEntry(node.materia, materia);
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
  if (rawMateria.type === "utility") {
    validateUtilityMateriaEntry(name, rawMateria);
    return;
  }
  validateAgentMateriaEntry(name, materia);
}

function validateAgentMateriaEntry(name: string, materia: MateriaConfig): asserts materia is MateriaAgentConfig {
  const rawMateria = materia as unknown as Record<string, unknown>;
  if (!isPlainObject(rawMateria)) throw new Error(`Materia "${name}" is invalid. Expected a materia object.`);
  if ("systemPrompt" in rawMateria) throw new Error(`Materia "${name}" configures obsolete systemPrompt. Use prompt instead.`);
  if (rawMateria.type !== undefined && rawMateria.type !== "agent") throw new Error(`Materia "${name}" has unsupported type "${String(rawMateria.type)}".`);
  if (rawMateria.prompt === undefined || typeof rawMateria.prompt !== "string") {
    throw new Error(`Materia "${name}" has invalid prompt. Expected a string.`);
  }
  if (rawMateria.multiTurn !== undefined && typeof rawMateria.multiTurn !== "boolean") {
    throw new Error(`Materia "${name}" has invalid multiTurn. Expected a boolean when configured.`);
  }
  validateGeneratorDeclaration(name, rawMateria.generates);
}

function validateUtilityMateriaEntry(name: string, rawMateria: Record<string, unknown>): void {
  if ("systemPrompt" in rawMateria || "prompt" in rawMateria) throw new Error(`Utility materia "${name}" must not configure prompt/systemPrompt.`);
  if (!rawMateria.utility && !rawMateria.command) throw new Error(`Utility materia "${name}" must configure either "utility" or "command".`);
  if (rawMateria.command !== undefined) validateCommand(name, rawMateria.command);
  if (rawMateria.timeoutMs !== undefined && (!Number.isFinite(rawMateria.timeoutMs) || Number(rawMateria.timeoutMs) <= 0)) {
    throw new Error(`Utility materia "${name}" has invalid timeoutMs. Expected a positive number of milliseconds.`);
  }
  validateGeneratorDeclaration(name, rawMateria.generates);
}

function validateGeneratorDeclaration(name: string, generates: unknown): void {
  if (generates === undefined) return;
  if (!isPlainObject(generates)) throw new Error(`Materia "${name}" has invalid generates. Expected an object.`);
  if (typeof generates.output !== "string" || generates.output.length === 0) throw new Error(`Materia "${name}" has invalid generates.output. Expected a non-empty string.`);
  if (generates.listType !== "array") throw new Error(`Materia "${name}" has invalid generates.listType. Expected "array" for loop-consumable list outputs.`);
  if (typeof generates.itemType !== "string" || generates.itemType.length === 0) throw new Error(`Materia "${name}" has invalid generates.itemType. Expected a non-empty string.`);
  for (const field of ["items", "as", "cursor", "done"] as const) {
    if (generates[field] !== undefined && (typeof generates[field] !== "string" || generates[field].length === 0)) throw new Error(`Materia "${name}" has invalid generates.${field}. Expected a non-empty string when configured.`);
  }
}

function isGeneratorPipelineNode(config: PiMateriaConfig, pipeline: MateriaPipelineConfig, nodeId: string): boolean {
  const node = pipeline.nodes[nodeId];
  return Boolean(node?.type === "agent" && config.materia[node.materia]?.generates);
}

function migrateLegacyLoopConsumers(config: PiMateriaConfig, pipeline: MateriaPipelineConfig): void {
  for (const [loopId, loop] of Object.entries(pipeline.loops ?? {})) {
    if (loop.consumes || !loop.iterator) continue;
    const loopSet = new Set(loop.nodes);
    const inboundGeneratorEdges = Object.entries(pipeline.nodes ?? {}).flatMap(([from, node]) => {
      if (loopSet.has(from) || !isGeneratorPipelineNode(config, pipeline, from)) return [];
      return (node.edges ?? []).filter((edge) => loopSet.has(edge.to)).map(() => from);
    });
    const uniqueGeneratorIds = Array.from(new Set(inboundGeneratorEdges));
    if (uniqueGeneratorIds.length === 1) {
      const from = uniqueGeneratorIds[0];
      const source = pipeline.nodes[from];
      if (source?.type !== "agent") continue;
      const output = config.materia[source.materia]?.generates?.output;
      if (output) loop.consumes = { from, output };
    } else if (uniqueGeneratorIds.length > 1) {
      throw new Error(`Legacy loop "${loopId}" declares iterator metadata but no consumes generator. Add loops.${loopId}.consumes with exactly one generator source; found inbound generator sockets: ${uniqueGeneratorIds.join(", ")}.`);
    }
  }
}

function validateGeneratorNodeContracts(config: PiMateriaConfig, effective: EffectiveMateriaPipelineConfig): void {
  const consumedGeneratorIds = new Set(Object.values(effective.pipeline.loops ?? {}).map((loop) => loop.consumes?.from).filter((id): id is string => typeof id === "string"));
  for (const id of consumedGeneratorIds) {
    const node = effective.pipeline.nodes[id];
    if (!node || node.type !== "agent") continue;
    const generator = config.materia[node.materia]?.generates;
    if (!generator) continue;
    if (generator.listType !== "array") throw new Error(`Generator materia "${node.materia}" must declare generates.listType="array" for loop-consumable output "${generator.output}".`);
    if (!generator.itemType) throw new Error(`Generator materia "${node.materia}" must declare generates.itemType for loop-consumable output "${generator.output}".`);
    if (node.parse !== "json") throw new Error(`Generator pipeline slot "${id}" must parse JSON to expose generated output "${generator.output}".`);
    const assignedPath = node.assign?.[generator.output];
    if (assignedPath !== `$.${generator.output}`) {
      throw new Error(`Generator pipeline slot "${id}" must assign generated output "${generator.output}" from the handoff JSON.`);
    }
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
    ...renderGraph(config, effective.pipeline),
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
    const agentMateria = materia && materia.type !== "utility" ? materia : undefined;
    details.push(`materia=${node.materia}`, `tools=${agentMateria?.tools ?? "unknown"}`);
    if (agentMateria?.multiTurn) details.push("materia.multiTurn=true");
    if (agentMateria) details.push(formatMateriaModelSettings(agentMateria));
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

function formatMateriaDetails(materia: MateriaConfig): string {
  const generator = materia.generates ? `generates=${materia.generates.output}:${materia.generates.listType}<${materia.generates.itemType}>` : undefined;
  if (materia.type === "utility") {
    return [`type=utility`, materia.utility ? `utility=${materia.utility}` : `command=${formatCommand(materia.command)}`, `parse=${materia.parse ?? "text"}`, generator].filter(Boolean).join(", ");
  }
  return [
    `tools=${materia.tools}`,
    materia.multiTurn ? "multiTurn=true" : undefined,
    formatMateriaModelSettings(materia),
    generator,
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

function renderGraph(config: PiMateriaConfig, pipeline: MateriaPipelineConfig): string[] {
  const lines: string[] = [];
  for (const [id, node] of Object.entries(pipeline.nodes)) {
    for (const edge of node.edges ?? []) lines.push(`${id} --${edgeLabel(edge)}--> ${edge.to}`);
    if (!node.edges?.length) lines.push(`${id}`);
  }
  const loops = resolveLoopIterators(config, { pipeline, loadoutName: "<render>" });
  for (const [id, loop] of Object.entries(loops ?? {})) {
    const label = loop.label ? `${id} (${loop.label})` : id;
    const consumer = loop.consumes ? ` consumes=${loop.consumes.from}.${loop.consumes.output ?? generatorForLoop(config, pipeline, id)?.output ?? "<generated>"}` : "";
    const iterator = loop.iterator ? ` iterator=${formatForeach(loop.iterator)}` : "";
    const exit = loop.exit ? ` exit=${loop.exit.when}->${loop.exit.to}` : "";
    lines.push(`loop ${label}: [${loop.nodes.join(", ")}]${consumer}${iterator}${exit}`);
  }
  return lines.length > 0 ? lines : ["<empty>"];
}

function resolveLoopIterators(config: PiMateriaConfig, effective: EffectiveMateriaPipelineConfig): Record<string, MateriaLoopConfig> | undefined {
  if (!effective.pipeline.loops) return undefined;
  return Object.fromEntries(Object.entries(effective.pipeline.loops).map(([id, loop]) => [id, { ...loop, iterator: loop.iterator ?? generatedIteratorForLoop(config, effective.pipeline, id, loop) }]));
}

function generatedIteratorForLoop(config: PiMateriaConfig, pipeline: MateriaPipelineConfig, loopId: string, loop: MateriaLoopConfig): MateriaForeachConfig | undefined {
  if (!loop.consumes) return undefined;
  const generator = generatorForLoop(config, pipeline, loopId);
  const output = loop.consumes.output ?? generator.output;
  if (output !== generator.output) throw new Error(`Loop "${loopId}" consumes output "${output}" but generator "${loop.consumes.from}" declares output "${generator.output}".`);
  return {
    items: generator.items ?? `state.${generator.output}`,
    as: loop.consumes.as ?? generator.as,
    cursor: loop.consumes.cursor ?? generator.cursor,
    done: loop.consumes.done ?? generator.done,
  };
}

function generatorForLoop(config: PiMateriaConfig, pipeline: MateriaPipelineConfig, loopId: string): MateriaGeneratorConfig {
  const consumer = pipeline.loops?.[loopId]?.consumes;
  if (!consumer) throw new Error(`Loop "${loopId}" does not declare a generator consumer.`);
  const source = pipeline.nodes[consumer.from];
  if (!source) throw new Error(`Loop "${loopId}" consumes unknown generator socket "${consumer.from}".`);
  if (source.type !== "agent") throw new Error(`Loop "${loopId}" consumes "${consumer.from}", but only agent materia can declare generated outputs.`);
  const generator = config.materia[source.materia]?.generates;
  if (!generator) throw new Error(`Loop "${loopId}" consumes "${consumer.from}", but materia "${source.materia}" does not declare generates metadata.`);
  return generator;
}

export function loopIteratorForNode(pipeline: Pick<MateriaPipelineConfig, "nodes" | "loops"> | Pick<ResolvedMateriaPipeline, "nodes" | "loops">, nodeId: string): MateriaForeachConfig | undefined {
  const entry = pipeline.nodes[nodeId] as (MateriaPipelineNodeConfig | ResolvedMateriaNode | undefined);
  const node = entry && "node" in entry ? entry.node : entry;
  const direct = node?.foreach;
  if (direct) return direct;
  for (const loop of Object.values(pipeline.loops ?? {})) {
    if (loop.iterator && loop.nodes.includes(nodeId)) return loop.iterator;
  }
  return undefined;
}

function formatForeach(loop: MateriaForeachConfig): string {
  return `${loop.items}${loop.as ? ` as ${loop.as}` : ""}${loop.done ? ` done ${loop.done}` : ""}`;
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
