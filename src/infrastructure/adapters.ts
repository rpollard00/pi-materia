import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadConfig, resolveArtifactRoot, saveActiveLoadout } from "../config.js";
import { renderLoadoutList } from "../loadouts.js";
import { clearCastState, listLatestCastStates, listResumableCastStates, listRevivableCastStates, loadActiveCastState } from "./castStateRepository.js";
import { renderGrid, resolvePipeline } from "../pipeline.js";
import type { ArtifactCatalog, CastStateRepository, ConfigRepository, EnvironmentLookup, Logger, PipelinePresenter } from "../application/index.js";
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
