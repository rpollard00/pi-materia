import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadConfig, resolveArtifactRoot, saveActiveLoadout } from "../config.js";
import { renderLoadoutList } from "../loadouts.js";
import { activeMateriaSystemPrompt, buildIsolatedMateriaContext, continueNativeCast, currentMateria, handleAgentEnd, materiaStatusLabel, prepareMultiTurnRefinementTurn, resumeNativeCast, reviveNativeCast, startNativeCast } from "../native.js";
import { clearCastState, listLatestCastStates, listResumableCastStates, listRevivableCastStates, loadActiveCastState } from "./castStateRepository.js";
import { renderGrid, resolvePipeline } from "../pipeline.js";
import type { ArtifactCatalog, CastRuntime, CastStateRepository, ConfigRepository, EnvironmentLookup, Logger, PipelinePresenter } from "../application/index.js";
import { renderCastList } from "./castCatalog.js";

export function createConfigRepository(): ConfigRepository {
  return { load: loadConfig, saveActiveLoadout, resolveArtifactRoot };
}

export function createPipelinePresenter(): PipelinePresenter {
  return { resolve: resolvePipeline, renderGrid, renderLoadoutList };
}

export function createCastStateRepository(): CastStateRepository<ExtensionContext> {
  return {
    loadActive: loadActiveCastState,
    listLatest: listLatestCastStates,
    listResumable: listResumableCastStates,
    listRevivable: listRevivableCastStates,
  };
}

export function createArtifactCatalog(): ArtifactCatalog {
  return { renderCastList };
}

export function createNativeCastRuntime(): CastRuntime<ExtensionContext, ExtensionAPI, unknown> {
  return {
    buildIsolatedContext: buildIsolatedMateriaContext,
    activeSystemPrompt: (state, materia) => activeMateriaSystemPrompt(state, materia as Parameters<typeof activeMateriaSystemPrompt>[1]),
    currentMateria,
    prepareMultiTurnRefinementTurn,
    handleAgentEnd: (api, event, ctx) => handleAgentEnd(api, event as Parameters<typeof handleAgentEnd>[1], ctx),
    start: startNativeCast,
    continue: continueNativeCast,
    resume: async (api, ctx, castId) => { await resumeNativeCast(api, ctx, castId); },
    revive: async (api, ctx, castId) => { await reviveNativeCast(api, ctx, castId); },
    clear: clearCastState,
    statusLabel: materiaStatusLabel,
  };
}

export function createProcessEnvironmentLookup(env: NodeJS.ProcessEnv = process.env): EnvironmentLookup {
  return { get: (name) => env[name] };
}

export function createConsoleLogger(logger: Pick<Console, "info" | "warn" | "error"> = console): Logger {
  const write = (level: "info" | "warn" | "error", message: string, details?: Record<string, unknown>) => {
    if (details && Object.keys(details).length > 0) logger[level](`[pi-materia] ${message}`, details);
    else logger[level](`[pi-materia] ${message}`);
  };
  return {
    info: (message, details) => write("info", message, details),
    warn: (message, details) => write("warn", message, details),
    error: (message, details) => write("error", message, details),
  };
}

export interface MateriaPluginAdapters {
  configs: ConfigRepository;
  pipeline: PipelinePresenter;
  states: CastStateRepository<ExtensionContext>;
  artifacts: ArtifactCatalog;
  runtime: CastRuntime<ExtensionContext, ExtensionAPI, unknown>;
  environment: EnvironmentLookup;
  logger: Logger;
}

export function createMateriaPluginAdapters(env?: NodeJS.ProcessEnv): MateriaPluginAdapters {
  return {
    configs: createConfigRepository(),
    pipeline: createPipelinePresenter(),
    states: createCastStateRepository(),
    artifacts: createArtifactCatalog(),
    runtime: createNativeCastRuntime(),
    environment: createProcessEnvironmentLookup(env),
    logger: createConsoleLogger(),
  };
}
