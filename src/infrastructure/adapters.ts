import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveArtifactRoot } from "../config/config.js";
import { renderLoadoutCatalog, renderLoadoutList } from "../loadout/loadouts.js";
import { clearCastState, listLatestCastStates, listResumableCastStates, listRevivableCastStates, loadActiveCastState } from "./castStateRepository.js";
import { renderGrid, resolvePipeline } from "../runtime/pipeline.js";
import type { ArtifactCatalog, CastStateRepository, ConfigRepository, EnvironmentLookup, Logger, PipelinePresenter } from "../application/index.js";
import { renderCastList } from "./castCatalog.js";
import { createCentralConnectedConfigRepository } from "./centralConnectedConfigRepository.js";

// One process-local source manager lets every runtime surface share the same
// last-known central snapshot without persisting central reads to disk.
const runtimeConfigs = createCentralConnectedConfigRepository();

export function loadRuntimeConfig(cwd: string, configuredPath?: string) {
  return runtimeConfigs.load(cwd, configuredPath);
}

export function saveRuntimeActiveLoadout(cwd: string, loadoutName: string, configuredPath?: string) {
  return runtimeConfigs.saveActiveLoadout(cwd, loadoutName, configuredPath);
}

export function createConfigRepository(): ConfigRepository {
  return { load: loadRuntimeConfig, saveActiveLoadout: saveRuntimeActiveLoadout, resolveArtifactRoot };
}

export function createPipelinePresenter(): PipelinePresenter {
  return { resolve: resolvePipeline, renderGrid, renderLoadoutList, renderLoadoutCatalog };
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
