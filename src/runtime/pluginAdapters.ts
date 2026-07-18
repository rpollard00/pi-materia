import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ArtifactCatalog, CastAgentTurnPort, CastContextPort, CastLifecyclePort, CastStateRepository, CastStatusPort, ConfigRepository, EnvironmentLookup, Logger, PipelinePresenter } from "../application/index.js";
import { buildIsolatedMateriaContext, cancelNativeCast, continueNativeCast, handleAgentEnd, handleAgentHandoffToolExecutionEnd, materiaStatusLabel, prepareAgentStartSystemPrompt, resumeNativeCast, reviveNativeCast, startNativeCast } from "../castRuntime.js";
import { createArtifactCatalog, createCastStateRepository, createCentralConnectedModelPolicyResolver, createCentralConnectedTelemetrySinkResolver, createConfigRepository, createConsoleLogger, createPipelinePresenter, createProcessEnvironmentLookup } from "../infrastructure/index.js";
import type { CentralTelemetrySinkResolver } from "./nativeEventing.js";
import type { ModelPolicyResolver } from "./modelPolicyResolver.js";

export function createCastContextPort(): CastContextPort {
  return { buildIsolatedContext: buildIsolatedMateriaContext };
}

export function createCastAgentTurnPort(): CastAgentTurnPort<ExtensionContext, ExtensionAPI, unknown> {
  return {
    prepareAgentStartSystemPrompt,
    handleAgentEnd: (api, event, ctx) => handleAgentEnd(api, event as Parameters<typeof handleAgentEnd>[1], ctx),
    handleToolExecutionEnd: (api, event, ctx) => handleAgentHandoffToolExecutionEnd(api, event as Parameters<typeof handleAgentHandoffToolExecutionEnd>[1], ctx),
  };
}

export function createCastLifecyclePort(): CastLifecyclePort<ExtensionContext, ExtensionAPI> {
  return {
    start: startNativeCast,
    continue: continueNativeCast,
    resume: async (api, ctx, castId) => { await resumeNativeCast(api, ctx, castId); },
    revive: async (api, ctx, castId) => { await reviveNativeCast(api, ctx, castId); },
    clear: async (pi, state, reason) => { await cancelNativeCast(pi, state, reason); },
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
  modelPolicies: ModelPolicyResolver;
  centralTelemetry: CentralTelemetrySinkResolver;
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
    modelPolicies: createCentralConnectedModelPolicyResolver(),
    centralTelemetry: createCentralConnectedTelemetrySinkResolver(),
  };
}
