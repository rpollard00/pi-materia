import { resolveArtifactRoot } from "../config/config.js";
import { isShippedUtilityScriptRef } from "../config/shippedUtilities.js";
import { assertValidPipelineGraph } from "../graph/graphValidation.js";
import { canonicalGeneratorConfigFor, isGeneratorMateria } from "../graph/generator.js";
import { getLoadoutSocket, loadoutSocketEntries, loadoutSocketIds, loopSockets } from "../loadout/loadoutAccessors.js";
import { prepareLoadoutForRuntime } from "../loadout/loadoutNormalization.js";
import { formatToolScopeSpec, validateToolScopeSpecShape, validToolScopeShapeDescription } from "../domain/toolScope.js";
import type { MateriaAgentConfig, MateriaBudgetConfig, MateriaEdgeConfig, MateriaForeachConfig, MateriaGeneratorConfig, MateriaLoopConfig, MateriaPipelineConfig, MateriaPipelineSocketConfig, MateriaConfig, MateriaUtilityConfig, PiMateriaConfig, ResolvedMateriaSocket, ResolvedMateriaPipeline } from "../types.js";

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
  validateAuthoredUtilityRuntimeSockets(config, effective.loadoutName);
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

  const materia = config.materia[socket.materia];
  if (!materia) throw new Error(`Pipeline slot "${id}" references unknown materia "${socket.materia}"`);
  const rawMateria = materia as unknown as Record<string, unknown>;
  const isUtility = rawMateria.type === "utility" || rawMateria.utility !== undefined || rawMateria.command !== undefined || rawMateria.script !== undefined;
  if (!isUtility) {
    validateAgentMateriaEntry(socket.materia, materia);
    return { id, socket, materia };
  }

  validateUtilityMateriaEntry(socket.materia, rawMateria);
  validateCanonicalUtilityRuntimeSocket(id, socket, materia as MateriaUtilityConfig);
  return { id, socket, materiaId: socket.materia, materia: materia as MateriaUtilityConfig };
}

// Runtime accepts only canonical utility sockets authored as graph placement
// references. Executable socket fields belong on referenced utility materia; parse
// may be materialized later for generator/loop control-flow semantics.
function validateAuthoredUtilityRuntimeSockets(config: PiMateriaConfig, loadoutName: string): void {
  const loadout = config.loadouts?.[loadoutName];
  if (!loadout) return;
  for (const [id, socket] of loadoutSocketEntries(loadout)) {
    const materia = typeof socket.materia === "string" ? config.materia?.[socket.materia] : undefined;
    const rawMateria = materia as unknown as Record<string, unknown> | undefined;
    const isUtility = rawMateria?.type === "utility" || rawMateria?.utility !== undefined || rawMateria?.command !== undefined || rawMateria?.script !== undefined;
    if (!isUtility) continue;
    const rawSocket = socket as unknown as Record<string, unknown>;
    for (const field of ["utility", "command", "script", "params", "timeoutMs"] as const) {
      if (rawSocket[field] !== undefined) throw new Error(`Utility pipeline slot "${id}" configures obsolete socket field "${field}". Configure executable utility behavior on materia "${socket.materia}" instead.`);
    }
    const generator = canonicalGeneratorConfigFor(rawMateria as unknown as MateriaUtilityConfig);
    // parse: "json" is allowed on utility sockets when it is a loop JSON exit source
    // (runtime-materialized by loop semantics) or when the materia is a generator
    // (legacy canonical derived value; will be pruned on save).
    const allowsRuntimeMaterializedParse = socket.parse === "json" && (isLoopJsonExitSource(loadout, id) || Boolean(generator));
    // Assign is allowed on utility sockets when it exactly matches the canonical
    // generator workItems assignment (legacy derived value; pruned on save).
    const allowsDerivedGeneratorAssign = generator && socket.assign?.[generator.output] === `$.${generator.output}` && Object.keys(socket.assign).length === 1;
    if (socket.parse !== undefined && !allowsRuntimeMaterializedParse) throw new Error(`Utility pipeline slot "${id}" configures obsolete socket field "parse". Configure parse on utility materia "${socket.materia}" instead.`);
    if (socket.assign !== undefined && !allowsDerivedGeneratorAssign) throw new Error(`Utility pipeline slot "${id}" configures obsolete socket field "assign". Configure assign on utility materia "${socket.materia}" instead.`);
  }
}

function isLoopJsonExitSource(loadout: MateriaPipelineConfig, socketId: string): boolean {
  return Object.values(loadout.loops ?? {}).some((loop) => loop.exit?.from === socketId && (loop.exit.when === "satisfied" || loop.exit.when === "not_satisfied"));
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
  if ("type" in (socket as unknown as Record<string, unknown>)) {
    throw new Error(`Pipeline slot "${id}" configures obsolete socket field "type". Socket behavior is determined by referenced materia.`);
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
  if (typeof socket.materia !== "string" || socket.materia.trim().length === 0) {
    throw new Error(`Pipeline slot "${id}" must reference materia via "materia".`);
  }
}

function validateCanonicalUtilityRuntimeSocket(id: string, socket: MateriaPipelineSocketConfig, materia: MateriaUtilityConfig): void {
  const rawSocket = socket as unknown as Record<string, unknown>;
  for (const field of ["utility", "command", "script", "params", "timeoutMs"] as const) {
    if (rawSocket[field] !== undefined) throw new Error(`Utility pipeline slot "${id}" configures obsolete socket field "${field}". Configure executable utility behavior on materia "${socket.materia}" instead.`);
  }

  const generator = canonicalGeneratorConfigFor(materia);
  // parse: "json" is always allowed on utility sockets in the per-socket validation
  // because runtime-materialized loop exit sources may carry parse: "json" without
  // being generators themselves. The pre-validation (validateAuthoredUtilityRuntimeSockets)
  // handles the stricter obsolete-field rejection.
  const allowsRuntimeMaterializedParse = socket.parse === "json";
  // Assign is allowed on utility sockets when it exactly matches the canonical
  // generator workItems assignment (legacy derived value; pruned on save).
  const allowsDerivedGeneratorAssign = generator && socket.assign?.[generator.output] === `$.${generator.output}` && Object.keys(socket.assign).length === 1;
  if (socket.parse !== undefined && !allowsRuntimeMaterializedParse) {
    throw new Error(`Utility pipeline slot "${id}" configures obsolete socket field "parse". Configure parse on utility materia "${socket.materia}" instead.`);
  }
  if (socket.assign !== undefined && !allowsDerivedGeneratorAssign) {
    throw new Error(`Utility pipeline slot "${id}" configures obsolete socket field "assign". Configure assign on utility materia "${socket.materia}" instead.`);
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
  if (rawMateria.type === "utility" || rawMateria.utility !== undefined || rawMateria.command !== undefined || rawMateria.script !== undefined) {
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
  if (rawMateria.tools === undefined) {
    throw new Error(`Materia "${name}" has invalid tools. Expected ${validToolScopeShapeDescription()}.`);
  }
  const toolScope = validateToolScopeSpecShape(rawMateria.tools, `materia.${name}.tools`);
  if (!toolScope.ok) {
    throw new Error(`Materia "${name}" has invalid tools. ${toolScope.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
  }
  if (rawMateria.multiTurn !== undefined && typeof rawMateria.multiTurn !== "boolean") {
    throw new Error(`Materia "${name}" has invalid multiTurn. Expected a boolean when configured.`);
  }
  validateMateriaParseMode(name, rawMateria.parse);
  validateGeneratorMarker(name, rawMateria.generator);
  validateObsoleteGeneratorDeclaration(name, rawMateria.generates);
}

function validateUtilityMateriaEntry(name: string, rawMateria: Record<string, unknown>): void {
  if ("systemPrompt" in rawMateria || "prompt" in rawMateria) throw new Error(`Utility materia "${name}" must not configure prompt/systemPrompt.`);
  if (!rawMateria.utility && !rawMateria.command && !rawMateria.script) throw new Error(`Utility materia "${name}" must configure either "utility", "command", or "script".`);
  if (rawMateria.command !== undefined) validateCommand(name, rawMateria.command);
  if (rawMateria.script !== undefined) validateScript(name, rawMateria.script);
  if (rawMateria.timeoutMs !== undefined && (!Number.isFinite(rawMateria.timeoutMs) || Number(rawMateria.timeoutMs) <= 0)) {
    throw new Error(`Utility materia "${name}" has invalid timeoutMs. Expected a positive number of milliseconds.`);
  }
  validateMateriaParseMode(name, rawMateria.parse);
  validateGeneratorMarker(name, rawMateria.generator);
  validateObsoleteGeneratorDeclaration(name, rawMateria.generates);
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

// Obsolete cleanup marker: saved editors may write `generates: null` to
// remove the obsolete declaration, but authored `generates` metadata must not
// activate or describe runtime generator output.
function validateObsoleteGeneratorDeclaration(name: string, generates: unknown): void {
  if (generates === undefined || generates === null) return;
  throw new Error(`Materia "${name}" configures obsolete generates metadata. Use generator: true and emit canonical JSON with workItems; custom generates.output aliases are not active runtime generator outputs.`);
}

function isGeneratorPipelineSocket(config: PiMateriaConfig, pipeline: MateriaPipelineConfig, socketId: string): boolean {
  const socket = getLoadoutSocket(pipeline, socketId);
  return Boolean(socket && isMateriaSocket(socket) && isGeneratorMateria(config.materia[socket.materia]));
}

function validateGeneratorSocketContracts(config: PiMateriaConfig, effective: EffectiveMateriaPipelineConfig): void {
  // Validate all agent generator sockets, not just pipeline-connected ones.
  // Generator materia owns the output contract (parse/assign); sockets are placement only.
  for (const [id, socket] of loadoutSocketEntries(effective.pipeline)) {
    if (!isGeneratorPipelineSocket(config, effective.pipeline, id)) continue;
    if (!isMateriaSocket(socket)) continue;
    const generator = canonicalGeneratorConfigFor(config.materia[socket.materia]);
    if (!generator) continue;
    if (generator.listType !== "array") throw new Error(`Generator materia "${socket.materia}" must resolve listType="array" for generator pipeline output "${generator.output}".`);
    if (!generator.itemType) throw new Error(`Generator materia "${socket.materia}" must resolve an itemType for generator pipeline output "${generator.output}".`);
    // generator materia owns the output contract; reject truly conflicting socket-local parse/assign values
    if (socket.parse !== undefined && socket.parse !== "json") {
      throw new Error(`Generator pipeline slot "${id}" configures conflicting parse mode "${String(socket.parse)}". Generator materia "${socket.materia}" requires JSON output. Omit parse from the socket or use the canonical parse: "json".`);
    }
    if (typeof socket.assign === "object" && socket.assign !== null && !Array.isArray(socket.assign)) {
      const assign = socket.assign as Record<string, unknown>;
      if (assign[generator.output] !== undefined && assign[generator.output] !== `$.${generator.output}`) {
        throw new Error(`Generator pipeline slot "${id}" configures conflicting assign.${generator.output} "${String(assign[generator.output])}". Generator materia "${socket.materia}" requires canonical assign.${generator.output}: "$.${generator.output}".`);
      }
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

function validateScript(id: string, script: unknown): void {
  if (!isShippedUtilityScriptRef(script)) throw new Error(`Utility pipeline slot "${id}" has malformed script. Expected a shippedUtility script reference.`);
  if (script.runtime !== undefined && script.runtime !== "node") throw new Error(`Utility pipeline slot "${id}" has malformed script runtime. Expected "node" when configured.`);
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
  const materia = config.materia[socket.materia];
  const isUtility = materia?.type === "utility";
  const details: string[] = [`materia=${socket.materia}`];
  if (!isUtility) {
    const agentMateria = materia;
    details.push(`tools=${agentMateria ? formatToolScopeSpec(agentMateria.tools) : "unknown"}`);
    if (agentMateria?.multiTurn) details.push("materia.multiTurn=true");
    if (agentMateria) details.push(formatMateriaModelSettings(agentMateria));
  } else {
    details.push(formatUtilityExecution(materia));
  }
  const effectiveParse = isUtility ? materia.parse : socket.parse;
  details.push(`parse=${effectiveParse ?? "text"}`);
  if (socket.edges?.length) details.push(`edges=${socket.edges.map((edge) => `${edgeLabel(edge)}->${edge.to}`).join(",")}`);
  if (socket.foreach) details.push(`foreach=${socket.foreach.items}${socket.foreach.as ? ` as ${socket.foreach.as}` : ""}${socket.foreach.done ? ` done ${socket.foreach.done}` : ""}`);
  if (socket.advance) details.push(`advance=${socket.advance.cursor}:${socket.advance.items}${socket.advance.when ? ` when ${socket.advance.when}` : ""}${socket.advance.done ? ` done ${socket.advance.done}` : ""}`);
  if (socket.limits) details.push(`limits=${formatSocketLimits(socket.limits)}`);
  if (isUtility && materia.timeoutMs !== undefined) details.push(`timeoutMs=${materia.timeoutMs}`);
  return details.join(", ");
}

function formatUtilityExecution(materia: MateriaUtilityConfig): string {
  if (materia.utility) return `utility=${materia.utility}`;
  if (materia.script) return `script=${materia.script.kind}:${materia.script.name}`;
  return `command=${formatCommand(materia.command)}`;
}

function formatCommand(command: string[] | undefined): string {
  return command?.length ? command.map((part) => JSON.stringify(part)).join(" ") : "<missing>";
}

function formatMateriaDetails(materia: MateriaConfig): string {
  const generatorConfig = canonicalGeneratorConfigFor(materia);
  const generator = generatorConfig ? `generator=${generatorConfig.output}:${generatorConfig.listType}<${generatorConfig.itemType}>` : undefined;
  if (materia.type === "utility") {
    return [`type=utility`, formatUtilityExecution(materia), `parse=${materia.parse ?? "text"}`, generator].filter(Boolean).join(", ");
  }
  return [
    `tools=${formatToolScopeSpec(materia.tools)}`,
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

function formatLoopDisplayText(pipeline: MateriaPipelineConfig, loopId: string, loop: MateriaLoopConfig): string {
  const members = loopSockets(loop).map((socketId) => {
    const materia = pipeline.sockets?.[socketId]?.materia;
    return typeof materia === "string" && materia.trim().length > 0 ? materia : socketId;
  });
  return members.length > 0 ? `${loopId} (${members.join(" → ")})` : loopId;
}

function renderGraph(config: PiMateriaConfig, pipeline: MateriaPipelineConfig): string[] {
  const lines: string[] = [];
  for (const [id, socket] of loadoutSocketEntries(pipeline)) {
    for (const edge of socket.edges ?? []) lines.push(`${id} --${edgeLabel(edge)}--> ${edge.to}`);
    if (!socket.edges?.length) lines.push(`${id}`);
  }
  const loops = resolveLoopIterators(config, { pipeline, loadoutName: "<render>" });
  for (const [id, loop] of Object.entries(loops ?? {})) {
    const label = formatLoopDisplayText(pipeline, id, loop);
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
  if (!isMateriaSocket(source)) throw new Error(`Loop "${loopId}" consumes "${consumer.from}", but the source socket does not reference materia.`);
  const generator = canonicalGeneratorConfigFor(config.materia[source.materia]);
  if (!generator) throw new Error(`Loop "${loopId}" consumes "${consumer.from}", but materia "${source.materia}" is not marked as a Generator.`);
  return generator;
}

function isMateriaSocket(socket: MateriaPipelineSocketConfig): socket is MateriaPipelineSocketConfig & { materia: string } {
  return typeof socket.materia === "string";
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
    `no-advance cycles ${config.limits?.maxNoAdvanceCycles ?? 3}`,
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
