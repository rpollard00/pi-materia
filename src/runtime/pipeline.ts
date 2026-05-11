import { resolveArtifactRoot } from "../config/config.js";
import { assertValidPipelineGraph } from "../graph/graphValidation.js";
import { canonicalGeneratorConfigFor, isGeneratorMateria } from "../graph/generator.js";
import { getLoadoutSocket, loadoutSocketEntries, loadoutSocketIds, loopSockets } from "../loadout/loadoutAccessors.js";
import { prepareLoadoutForRuntime } from "../loadout/loadoutNormalization.js";
import type { MateriaAgentConfig, MateriaBudgetConfig, MateriaEdgeConfig, MateriaForeachConfig, MateriaGeneratorConfig, MateriaLoopConfig, MateriaPipelineConfig, MateriaPipelineSocketConfig, MateriaConfig, PiMateriaConfig, ResolvedMateriaSocket, ResolvedMateriaPipeline } from "../types.js";

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
  return { pipeline: prepareLoadoutForRuntime(pipeline, config, { loadoutName: activeLoadout }).loadout, loadoutName: activeLoadout };
}

export function resolvePipeline(config: PiMateriaConfig): ResolvedMateriaPipeline {
  const rawConfig = config as unknown as Record<string, unknown>;
  if ("roles" in rawConfig) throw new Error(`Materia config configures obsolete roles. Use top-level materia instead.`);
  if ("materiaDefinitions" in rawConfig) throw new Error(`Materia config configures obsolete materiaDefinitions.`);
  validateMateriaEntries(config);
  const effective = getEffectivePipelineConfig(config);
  validateLoadout(effective.loadoutName, effective.pipeline);
  assertValidPipelineGraph(effective.pipeline, { isGeneratorSocket: (socketId) => isGeneratorPipelineSocket(config, effective.pipeline, socketId) });
  const sockets = Object.fromEntries(
    loadoutSocketIds(effective.pipeline).map((id) => [id, resolveSocket(config, effective, id, `${pipelineSource(effective)}.sockets.${id}`)]),
  );
  validateGeneratorSocketContracts(config, effective);
  const entry = sockets[effective.pipeline.entry];
  if (!entry) throw new Error(`Unknown pipeline entry socket "${effective.pipeline.entry}"`);
  return { entry, sockets, loops: resolveLoopIterators(config, effective) };
}

function resolveSocket(config: PiMateriaConfig, effective: EffectiveMateriaPipelineConfig, id: string, source: string): ResolvedMateriaSocket {
  const socket = getLoadoutSocket(effective.pipeline, id);
  if (!socket) throw new Error(`Unknown pipeline slot "${id}" referenced by ${source}`);
  validateSocket(id, socket);

  if (socket.type === "agent") {
    const materia = config.materia[socket.materia];
    if (!materia) throw new Error(`Pipeline slot "${id}" references unknown materia "${socket.materia}"`);
    validateAgentMateriaEntry(socket.materia, materia);
    return { id, socket, materia };
  }

  return { id, socket };
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

function validateSocket(id: string, socket: MateriaPipelineSocketConfig): void {
  if (socket.type !== "agent" && socket.type !== "utility") {
    throw new Error(`Pipeline slot "${id}" has unsupported type "${String((socket as { type?: unknown }).type)}"`);
  }
  if (socket.parse !== undefined && socket.parse !== "text" && socket.parse !== "json") {
    throw new Error(`Pipeline slot "${id}" has unsupported parse mode "${String(socket.parse)}". Expected "text" or "json".`);
  }
  if ("role" in socket) {
    throw new Error(`Pipeline slot "${id}" configures obsolete role. Use materia instead.`);
  }
  if ("prompt" in socket || "systemPrompt" in socket) {
    throw new Error(`Pipeline slot "${id}" configures obsolete prompt. Define prompt on the referenced materia instead.`);
  }
  if ("multiTurn" in socket) {
    throw new Error(`Pipeline slot "${id}" configures obsolete multiTurn. Configure multiTurn on the referenced materia instead.`);
  }
  if (socket.type === "utility") {
    if (!socket.utility && !socket.command) throw new Error(`Utility pipeline slot "${id}" must configure either "utility" or "command".`);
    if (socket.command !== undefined) validateCommand(id, socket.command);
    if (socket.timeoutMs !== undefined && (!Number.isFinite(socket.timeoutMs) || socket.timeoutMs <= 0)) {
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
  validateMateriaParseMode(name, rawMateria.parse);
  validateGeneratorMarker(name, rawMateria.generator);
  validateLegacyGeneratorDeclaration(name, rawMateria.generates);
}

function validateUtilityMateriaEntry(name: string, rawMateria: Record<string, unknown>): void {
  if ("systemPrompt" in rawMateria || "prompt" in rawMateria) throw new Error(`Utility materia "${name}" must not configure prompt/systemPrompt.`);
  if (!rawMateria.utility && !rawMateria.command) throw new Error(`Utility materia "${name}" must configure either "utility" or "command".`);
  if (rawMateria.command !== undefined) validateCommand(name, rawMateria.command);
  if (rawMateria.timeoutMs !== undefined && (!Number.isFinite(rawMateria.timeoutMs) || Number(rawMateria.timeoutMs) <= 0)) {
    throw new Error(`Utility materia "${name}" has invalid timeoutMs. Expected a positive number of milliseconds.`);
  }
  validateMateriaParseMode(name, rawMateria.parse);
  validateGeneratorMarker(name, rawMateria.generator);
  validateLegacyGeneratorDeclaration(name, rawMateria.generates);
}

function validateGeneratorMarker(name: string, generator: unknown): void {
  if (generator !== undefined && typeof generator !== "boolean") {
    throw new Error(`Materia "${name}" has invalid generator. Expected a boolean when configured.`);
  }
}

function validateMateriaParseMode(name: string, parse: unknown): void {
  if (parse === undefined) return;
  if (parse !== "text" && parse !== "json") throw new Error(`Materia "${name}" has unsupported parse mode "${String(parse)}". Expected "text" or "json".`);
}

// Migration-only cleanup marker: saved editors may write `generates: null` to
// remove the obsolete declaration, but authored `generates` metadata must not
// activate or describe runtime generator output.
function validateLegacyGeneratorDeclaration(name: string, generates: unknown): void {
  if (generates === undefined || generates === null) return;
  throw new Error(`Materia "${name}" configures obsolete generates metadata. Use generator: true and emit canonical JSON with workItems; custom generates.output aliases are not active runtime generator outputs.`);
}

function isGeneratorPipelineSocket(config: PiMateriaConfig, pipeline: MateriaPipelineConfig, socketId: string): boolean {
  const socket = getLoadoutSocket(pipeline, socketId);
  return Boolean(socket?.type === "agent" && isGeneratorMateria(config.materia[socket.materia]));
}

function migrateLegacyLoopConsumers(config: PiMateriaConfig, pipeline: MateriaPipelineConfig): void {
  for (const [loopId, loop] of Object.entries(pipeline.loops ?? {})) {
    if (loop.consumes || !loop.iterator) continue;
    const loopSet = new Set(loopSockets(loop));
    const inboundGeneratorEdges = loadoutSocketEntries(pipeline).flatMap(([from, socket]) => {
      if (loopSet.has(from) || !isGeneratorPipelineSocket(config, pipeline, from)) return [];
      return (socket.edges ?? []).filter((edge) => loopSet.has(edge.to)).map(() => from);
    });
    const uniqueGeneratorIds = Array.from(new Set(inboundGeneratorEdges));
    if (uniqueGeneratorIds.length === 1) {
      const from = uniqueGeneratorIds[0];
      const source = getLoadoutSocket(pipeline, from);
      if (source?.type !== "agent") continue;
      const output = canonicalGeneratorConfigFor(config.materia[source.materia])?.output;
      if (output) loop.consumes = { from, output };
    } else if (uniqueGeneratorIds.length > 1) {
      throw new Error(`Legacy loop "${loopId}" declares iterator metadata but no consumes generator. Add loops.${loopId}.consumes with exactly one generator source; found inbound generator sockets: ${uniqueGeneratorIds.join(", ")}.`);
    }
  }
}

function normalizeGeneratorPipelineSlots(config: PiMateriaConfig, pipeline: MateriaPipelineConfig): void {
  for (const id of generatorPipelineSocketIds(config, pipeline)) {
    const socket = getLoadoutSocket(pipeline, id);
    if (!socket || socket.type !== "agent") continue;
    const generator = canonicalGeneratorConfigFor(config.materia[socket.materia]);
    if (!generator) continue;
    socket.parse = "json";
    socket.assign = { ...(socket.assign ?? {}), [generator.output]: `$.${generator.output}` };
  }
}

function validateGeneratorSocketContracts(config: PiMateriaConfig, effective: EffectiveMateriaPipelineConfig): void {
  const generatorPipelineIds = generatorPipelineSocketIds(config, effective.pipeline);
  for (const id of generatorPipelineIds) {
    const socket = getLoadoutSocket(effective.pipeline, id);
    if (!socket || socket.type !== "agent") continue;
    const generator = canonicalGeneratorConfigFor(config.materia[socket.materia]);
    if (!generator) continue;
    if (generator.listType !== "array") throw new Error(`Generator materia "${socket.materia}" must resolve listType="array" for generator pipeline output "${generator.output}".`);
    if (!generator.itemType) throw new Error(`Generator materia "${socket.materia}" must resolve an itemType for generator pipeline output "${generator.output}".`);
    if (socket.parse !== "json") throw new Error(`Generator pipeline slot "${id}" must parse JSON and expose generated output "${generator.output}" from the canonical handoff envelope. Set parse: "json" and assign ${generator.output} from $.${generator.output}.`);
    const assignedPath = socket.assign?.[generator.output];
    if (assignedPath !== `$.${generator.output}`) {
      throw new Error(`Generator pipeline slot "${id}" must parse JSON and expose generated output "${generator.output}" from the canonical handoff envelope. Set parse: "json" and assign ${generator.output} from $.${generator.output}.`);
    }
  }
}

function generatorPipelineSocketIds(config: PiMateriaConfig, pipeline: MateriaPipelineConfig): Set<string> {
  const ids = new Set(Object.values(pipeline.loops ?? {}).map((loop) => loop.consumes?.from).filter((id): id is string => typeof id === "string"));
  for (const [from, socket] of loadoutSocketEntries(pipeline)) {
    if (!isGeneratorPipelineSocket(config, pipeline, from)) continue;
    for (const edge of socket.edges ?? []) {
      if (!isGeneratorPipelineSocket(config, pipeline, edge.to)) continue;
      ids.add(from);
      ids.add(edge.to);
    }
  }
  return ids;
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

  for (const [id, socket] of loadoutSocketEntries(effective.pipeline)) {
    lines.push(`- ${id}: ${formatSocketSlot(config, socket)}`);
  }
  return lines;
}

function renderMateria(config: PiMateriaConfig): string[] {
  const entries = Object.entries(config.materia);
  if (entries.length === 0) return ["- none configured"];
  return entries.map(([name, materia]) => `- ${name}: ${formatMateriaDetails(materia)}`);
}

function formatSocketSlot(config: PiMateriaConfig, socket: MateriaPipelineSocketConfig): string {
  const details: string[] = [`type=${socket.type}`];
  if (socket.type === "agent") {
    const materia = config.materia[socket.materia];
    const agentMateria = materia && materia.type !== "utility" ? materia : undefined;
    details.push(`materia=${socket.materia}`, `tools=${agentMateria?.tools ?? "unknown"}`);
    if (agentMateria?.multiTurn) details.push("materia.multiTurn=true");
    if (agentMateria) details.push(formatMateriaModelSettings(agentMateria));
  } else {
    details.push(socket.utility ? `utility=${socket.utility}` : `command=${formatCommand(socket.command)}`);
  }
  details.push(`parse=${socket.parse ?? "text"}`);
  if (socket.edges?.length) details.push(`edges=${socket.edges.map((edge) => `${edgeLabel(edge)}->${edge.to}`).join(",")}`);
  if (socket.foreach) details.push(`foreach=${socket.foreach.items}${socket.foreach.as ? ` as ${socket.foreach.as}` : ""}${socket.foreach.done ? ` done ${socket.foreach.done}` : ""}`);
  if (socket.advance) details.push(`advance=${socket.advance.cursor}:${socket.advance.items}${socket.advance.when ? ` when ${socket.advance.when}` : ""}${socket.advance.done ? ` done ${socket.advance.done}` : ""}`);
  if (socket.limits) details.push(`limits=${formatSocketLimits(socket.limits)}`);
  if (socket.type === "utility" && socket.timeoutMs !== undefined) details.push(`timeoutMs=${socket.timeoutMs}`);
  return details.join(", ");
}

function formatCommand(command: string[] | undefined): string {
  return command?.length ? command.map((part) => JSON.stringify(part)).join(" ") : "<missing>";
}

function formatMateriaDetails(materia: MateriaConfig): string {
  const generatorConfig = canonicalGeneratorConfigFor(materia);
  const generator = generatorConfig ? `generator=${generatorConfig.output}:${generatorConfig.listType}<${generatorConfig.itemType}>` : undefined;
  if (materia.type === "utility") {
    return [`type=utility`, materia.utility ? `utility=${materia.utility}` : `command=${formatCommand(materia.command)}`, `parse=${materia.parse ?? "text"}`, generator].filter(Boolean).join(", ");
  }
  return [
    `tools=${materia.tools}`,
    materia.parse ? `parse=${materia.parse}` : undefined,
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

function formatSocketLimits(limits: NonNullable<MateriaPipelineSocketConfig["limits"]>): string {
  return [
    limits.maxVisits === undefined ? undefined : `visits ${limits.maxVisits}`,
    limits.maxEdgeTraversals === undefined ? undefined : `edges ${limits.maxEdgeTraversals}`,
    limits.maxOutputBytes === undefined ? undefined : `output ${limits.maxOutputBytes}B`,
  ].filter(Boolean).join("/") || "default";
}

function renderGraph(config: PiMateriaConfig, pipeline: MateriaPipelineConfig): string[] {
  const lines: string[] = [];
  for (const [id, socket] of loadoutSocketEntries(pipeline)) {
    for (const edge of socket.edges ?? []) lines.push(`${id} --${edgeLabel(edge)}--> ${edge.to}`);
    if (!socket.edges?.length) lines.push(`${id}`);
  }
  const loops = resolveLoopIterators(config, { pipeline, loadoutName: "<render>" });
  for (const [id, loop] of Object.entries(loops ?? {})) {
    const label = loop.label ? `${id} (${loop.label})` : id;
    const consumer = loop.consumes ? ` consumes=${loop.consumes.from}.${loop.consumes.output ?? generatorForLoop(config, pipeline, id)?.output ?? "<generated>"}` : "";
    const iterator = loop.iterator ? ` iterator=${formatForeach(loop.iterator)}` : "";
    const exit = loop.exit ? ` exit=${loop.exit.from}.${loop.exit.when}->${loop.exit.to}` : "";
    lines.push(`loop ${label}: [${loopSockets(loop).join(", ")}]${consumer}${iterator}${exit}`);
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
  const source = getLoadoutSocket(pipeline, consumer.from);
  if (!source) throw new Error(`Loop "${loopId}" consumes unknown generator socket "${consumer.from}".`);
  if (source.type !== "agent") throw new Error(`Loop "${loopId}" consumes "${consumer.from}", but only agent materia can declare generated outputs.`);
  const generator = canonicalGeneratorConfigFor(config.materia[source.materia]);
  if (!generator) throw new Error(`Loop "${loopId}" consumes "${consumer.from}", but materia "${source.materia}" is not marked as a Generator.`);
  return generator;
}

export { loopIteratorForSocket } from "../loadout/loadoutAccessors.js";

function formatForeach(loop: MateriaForeachConfig): string {
  return `${loop.items}${loop.as ? ` as ${loop.as}` : ""}${loop.done ? ` done ${loop.done}` : ""}`;
}

function edgeLabel(edge: MateriaEdgeConfig): string {
  return edge.when ?? "always";
}

function formatLimits(config: PiMateriaConfig): string {
  return [
    `socket visits ${config.limits?.maxSocketVisits ?? 25}`,
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
