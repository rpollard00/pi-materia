import { canonicalGeneratorConfigFor, type GeneratorMateriaLike } from "../graph/generator.js";
import { normalizePipelineGraph } from "../graph/graphValidation.js";
import { getLoadoutSocket, loadoutSocketEntries, loadoutSocketIds, materializeCanonicalSockets } from "./loadoutAccessors.js";
import { analyzeLoadoutGraph, type LoadoutGraphAnalysis } from "../graph/loadoutGraphAnalysis.js";
import { materializeLoadoutLoopSemantics } from "../graph/loopSemantics.js";
import type { MateriaConfig, MateriaPipelineConfig, MateriaPipelineLayoutConfig, MateriaPipelineSocketConfig, MateriaSocketLayoutConfig, PiMateriaConfig } from "../types.js";

export interface NormalizedLoadoutResult<TLoadout extends MateriaPipelineConfig = MateriaPipelineConfig> {
  loadout: TLoadout;
  analysis: LoadoutGraphAnalysis;
}

/**
 * Shared loadout normalization boundary used by config loading, saving, WebUI
 * validation/preparation, and runtime preparation.
 *
 * Performance: semantic analysis indexes loop membership once and then walks
 * sockets and socket edges once (O(sockets + edges + loop memberships + edge-loop
 * hits), where edge-loop hits are edges targeting sockets that belong to loops).
 * These helpers clone only at the boundary where persisted/runtime loadouts are
 * prepared; hot WebUI graph/layout edits should continue to use the immutable
 * transform utilities so dragging layout metadata does not force semantic work.
 */
export function normalizeLoadedLoadout<TLoadout extends MateriaPipelineConfig>(loadout: TLoadout, materia: Record<string, GeneratorMateriaLike> = {}): NormalizedLoadoutResult<TLoadout> {
  const normalized = materializeCanonicalSockets(normalizePipelineGraph(loadout) as TLoadout, materia as Record<string, Pick<MateriaConfig, "type">>);
  normalizeLoadoutSocketKinds(normalized);
  normalizeLoadoutLayout(normalized);
  const analysis = analyzeLoadoutGraph(normalized, materia);
  return { loadout: normalized, analysis };
}

export function prepareLoadoutForSave<TLoadout extends MateriaPipelineConfig>(loadout: TLoadout, materia: Record<string, GeneratorMateriaLike> = {}, options: { loadoutName?: string } = {}): NormalizedLoadoutResult<TLoadout> {
  const result = prepareLoadout(loadout, materia, options);
  pruneCanonicalUtilitySocketFields(result.loadout, materia);
  return { loadout: result.loadout, analysis: analyzeLoadoutGraph(result.loadout, materia) };
}

export function prepareLoadoutForRuntime<TLoadout extends MateriaPipelineConfig>(loadout: TLoadout, config: Pick<PiMateriaConfig, "materia">, options: { loadoutName?: string } = {}): NormalizedLoadoutResult<TLoadout> {
  return prepareLoadout(loadout, config.materia ?? {}, options);
}

function prepareLoadout<TLoadout extends MateriaPipelineConfig>(loadout: TLoadout, materia: Record<string, GeneratorMateriaLike>, options: { loadoutName?: string }): NormalizedLoadoutResult<TLoadout> {
  const { loadout: prepared } = normalizeLoadedLoadout(loadout, materia);
  reconcileLoopConsumers(prepared, materia);
  normalizeGeneratorPipelineSockets(prepared, materia);
  materializeLoadoutLoopSemantics({ materia: materia as Record<string, MateriaConfig> }, prepared, options);
  pruneLoadoutLayout(prepared);
  return { loadout: prepared, analysis: analyzeLoadoutGraph(prepared, materia) };
}

export function normalizeConfigLoadoutsForLoad(config: PiMateriaConfig): PiMateriaConfig {
  return normalizeConfigLoadouts(config, (loadout, name) => normalizeLoadedLoadout(loadout, config.materia ?? {}).loadout);
}

export function prepareConfigLoadoutsForSave(config: PiMateriaConfig): PiMateriaConfig {
  return normalizeConfigLoadouts(config, (loadout, name) => prepareLoadoutForSave(loadout, config.materia ?? {}, { loadoutName: name }).loadout);
}

export function prepareConfigLoadoutsForRuntime(config: PiMateriaConfig): PiMateriaConfig {
  return normalizeConfigLoadouts(config, (loadout, name) => prepareLoadoutForRuntime(loadout, config, { loadoutName: name }).loadout);
}

function normalizeConfigLoadouts(config: PiMateriaConfig, normalize: (loadout: MateriaPipelineConfig, name: string) => MateriaPipelineConfig): PiMateriaConfig {
  if (!config.loadouts) return { ...config };
  return {
    ...config,
    loadouts: Object.fromEntries(Object.entries(config.loadouts).map(([name, loadout]) => [name, normalize(loadout, name)])),
  };
}

function normalizeLoadoutSocketKinds(loadout: MateriaPipelineConfig): void {
  const entryId = loadout.entry && getLoadoutSocket(loadout, loadout.entry) ? loadout.entry : loadoutSocketIds(loadout)[0];
  if (entryId && !loadout.entry) loadout.entry = entryId;
  for (const [id, socket] of loadoutSocketEntries(loadout)) socket.socketKind = id === entryId ? "entry" : "normal";
}

function normalizeLoadoutLayout(loadout: MateriaPipelineConfig): void {
  const existing = isPlainObject(loadout.layout) ? loadout.layout : {};
  const existingSockets = isPlainObject(existing.sockets) ? existing.sockets : {};
  const socketLayouts: Record<string, MateriaSocketLayoutConfig> = {};

  for (const id of loadoutSocketIds(loadout).sort((a, b) => a.localeCompare(b))) {
    const socket = getLoadoutSocket(loadout, id);
    const source = existingSockets[id] ?? (socket as { layout?: unknown } | undefined)?.layout;
    if (isSocketLayout(source)) socketLayouts[id] = { ...(typeof source.x === "number" ? { x: source.x } : {}), ...(typeof source.y === "number" ? { y: source.y } : {}) };
    if (socket && "layout" in socket) delete socket.layout;
  }

  const nextLayout: MateriaPipelineLayoutConfig = { ...existing };
  if (Object.keys(socketLayouts).length > 0) nextLayout.sockets = socketLayouts;
  else delete nextLayout.sockets;
  if (Object.keys(nextLayout).length > 0) loadout.layout = nextLayout;
  else delete loadout.layout;
}

function pruneLoadoutLayout(loadout: MateriaPipelineConfig): void {
  normalizeLoadoutLayout(loadout);
}

function pruneCanonicalUtilitySocketFields(loadout: MateriaPipelineConfig, materia: Record<string, GeneratorMateriaLike> = {}): void {
  for (const [, socket] of loadoutSocketEntries(loadout)) {
    const canonicalSocket = socket as unknown as Record<string, unknown>;
    for (const key of ["utility", "command", "params", "timeoutMs"]) delete canonicalSocket[key];
    const socketMateria = typeof socket.materia === "string" ? materia[socket.materia] : undefined;
    // Utility sockets: prune all parse/assign (materia owns these)
    if (socketMateria?.type === "utility" || socketMateria?.utility !== undefined || socketMateria?.command !== undefined) {
      delete canonicalSocket["parse"];
      delete canonicalSocket["assign"];
    }
    // Agent generator sockets: prune canonical parse/assign that are derived at runtime
    const generator = socketMateria ? canonicalGeneratorConfigFor(socketMateria) : undefined;
    if (generator && socketMateria && !(socketMateria.type === "utility" || socketMateria.utility !== undefined || socketMateria.command !== undefined)) {
      if (canonicalSocket["parse"] === "json") delete canonicalSocket["parse"];
      if (canonicalSocket["assign"] !== undefined && typeof canonicalSocket["assign"] === "object" && !Array.isArray(canonicalSocket["assign"])) {
        const assign = canonicalSocket["assign"] as Record<string, unknown>;
        if (assign[generator.output] === `$.${generator.output}`) {
          delete assign[generator.output];
          if (Object.keys(assign).length === 0) delete canonicalSocket["assign"];
        }
      }
    }
  }
}

function reconcileLoopConsumers(loadout: MateriaPipelineConfig, materia: Record<string, GeneratorMateriaLike>): void {
  const analysis = analyzeLoadoutGraph(loadout, materia);
  for (const [loopId, source] of analysis.loopConsumerSources) {
    const loop = loadout.loops?.[loopId];
    if (!loop || (!loop.consumes && !loop.iterator)) continue;
    loop.consumes = { ...(loop.consumes ?? {}), from: source.from, output: loop.consumes?.output ?? source.output };
  }
}

/**
 * Generator parse/assign fields are derived at runtime by effectiveResolvedSocketConfig.
 * This function exists for backward-compatible normalization of legacy persisted fields.
 * It no longer materializes generator output fields onto sockets.
 */
function normalizeGeneratorPipelineSockets(_loadout: MateriaPipelineConfig, _materia: Record<string, GeneratorMateriaLike>): void {
  // No-op: parse and assign are derived at runtime via effectiveResolvedSocketConfig.
}

function isMateriaSocket(socket: MateriaPipelineSocketConfig): socket is MateriaPipelineSocketConfig & { materia: string } {
  return typeof socket.materia === "string";
}

function isSocketLayout(value: unknown): value is MateriaSocketLayoutConfig {
  if (!isPlainObject(value)) return false;
  return typeof value.x === "number" || typeof value.y === "number";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
