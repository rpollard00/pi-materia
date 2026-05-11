import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ArtifactCatalog, CastAgentTurnPort, CastContextPort, CastLifecyclePort, CastStateRepository, CastStatusPort, ConfigRepository, EnvironmentLookup, Logger, PipelinePresenter } from "../application/index.js";
import { buildIsolatedMateriaContext, continueNativeCast, handleAgentEnd, materiaStatusLabel, prepareAgentStartSystemPrompt, resumeNativeCast, reviveNativeCast, startNativeCast } from "../castRuntime.js";
import { clearCastState } from "../infrastructure/castStateRepository.js";
import { createArtifactCatalog, createCastStateRepository, createConfigRepository, createConsoleLogger, createPipelinePresenter, createProcessEnvironmentLookup } from "../infrastructure/index.js";

export function createCastContextPort(): CastContextPort {
  return { buildIsolatedContext: buildIsolatedMateriaContext };
}

export function createCastAgentTurnPort(): CastAgentTurnPort<ExtensionContext, ExtensionAPI, unknown> {
  return {
    prepareAgentStartSystemPrompt,
    handleAgentEnd: (api, event, ctx) => handleAgentEnd(api, event as Parameters<typeof handleAgentEnd>[1], ctx),
  };
}

export function createCastLifecyclePort(): CastLifecyclePort<ExtensionContext, ExtensionAPI> {
  return {
    start: startNativeCast,
    continue: continueNativeCast,
    resume: async (api, ctx, castId) => { await resumeNativeCast(api, ctx, castId); },
    revive: async (api, ctx, castId) => { await reviveNativeCast(api, ctx, castId); },
    clear: clearCastState,
  };
}

export function createCastStatusPort(): CastStatusPort {
  return { statusLabel: materiaStatusLabel };
}

export interface MateriaPluginAdapters {
  configs: ConfigRepository;
  pipeline: PipelinePresenter;
  states: CastStateRepository<ExtensionContext>;
  artifacts: ArtifactCatalog;
  context: CastContextPort;
  agentTurns: CastAgentTurnPort<ExtensionContext, ExtensionAPI, unknown>;
  lifecycle: CastLifecyclePort<ExtensionContext, ExtensionAPI>;
  statusPresenter: CastStatusPort;
  environment: EnvironmentLookup;
  logger: Logger;
}

export function createMateriaPluginAdapters(env?: NodeJS.ProcessEnv): MateriaPluginAdapters {
  return {
    configs: createConfigRepository(),
    pipeline: createPipelinePresenter(),
    states: createCastStateRepository(),
    artifacts: createArtifactCatalog(),
    context: createCastContextPort(),
    agentTurns: createCastAgentTurnPort(),
    lifecycle: createCastLifecyclePort(),
    statusPresenter: createCastStatusPort(),
    environment: createProcessEnvironmentLookup(env),
    logger: createConsoleLogger(),
  };
}
