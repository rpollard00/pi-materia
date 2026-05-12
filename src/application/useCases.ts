import type { LoadedConfig, MateriaCastState, MateriaPipelineConfig, PiMateriaConfig, ResolvedMateriaPipeline } from "../types.js";
import type { ArtifactCatalog, CastAgentTurnPort, CastContextPort, CastLifecyclePort, CastStateRepository, CastStatusPort, ConfigRepository, EnvironmentLookup, Logger, PipelinePresenter } from "./ports.js";
import { compileLinkPlan, createConfigLinkGraphSource } from "../link/compiler.js";
import { loadPreviousCastContext } from "../link/contextLoader.js";
import { parseLinkCommandArguments } from "../link/parser.js";
import { createLinkCastStateData, createLinkPlan, createLinkRuntimeState } from "../link/planner.js";
import { createConfigLinkTargetRegistry, resolveLinkTargets } from "../link/resolver.js";
import { PREVIOUS_CAST_CONTEXT_STATE_KEY, type LinkCastStateData } from "../link/types.js";
import type { DomainIssue } from "../domain/result.js";

export interface LoadoutUseCasesDeps {
  configs: ConfigRepository;
  pipeline: PipelinePresenter;
  logger?: Logger;
}

export class LoadoutUseCases {
  constructor(private readonly deps: LoadoutUseCasesDeps) {}

  async prepareGrid(cwd: string, configuredPath?: string): Promise<{ loaded: LoadedConfig; pipeline: ResolvedMateriaPipeline; lines: string[] }> {
    const loaded = await this.deps.configs.load(cwd, configuredPath);
    const pipeline = this.deps.pipeline.resolve(loaded.config);
    return { loaded, pipeline, lines: this.deps.pipeline.renderGrid(loaded.config, pipeline, loaded.source, cwd) };
  }

  async listLoadouts(cwd: string, configuredPath?: string): Promise<{ loaded: LoadedConfig; lines: string[] }> {
    const loaded = await this.deps.configs.load(cwd, configuredPath);
    return { loaded, lines: this.deps.pipeline.renderLoadoutList(loaded.config, loaded.source) };
  }

  async selectActiveLoadout(input: { cwd: string; requestedLoadout: string; configuredPath?: string; activeCast?: MateriaCastState }): Promise<{ loaded: LoadedConfig; writtenPath: string }> {
    if (input.activeCast?.active) throw new ActiveCastConflictError(input.activeCast.castId);
    const writtenPath = await this.deps.configs.saveActiveLoadout(input.cwd, input.requestedLoadout, input.configuredPath);
    const loaded = await this.deps.configs.load(input.cwd, input.configuredPath);
    this.deps.logger?.info?.("active loadout selected", { loadout: loaded.config.activeLoadout ?? input.requestedLoadout, source: loaded.source, writtenPath });
    return { loaded, writtenPath };
  }

  async loadForCast(cwd: string, configuredPath?: string): Promise<{ loaded: LoadedConfig; pipeline: ResolvedMateriaPipeline }> {
    const loaded = await this.deps.configs.load(cwd, configuredPath);
    const pipeline = this.deps.pipeline.resolve(loaded.config);
    return { loaded, pipeline };
  }
}

export class ActiveCastConflictError extends Error {
  readonly code = "active_cast_conflict";
  constructor(readonly castId: string) {
    super(`Cannot change active loadout during active cast ${castId}.`);
  }
}

export interface CastCatalogUseCasesDeps<TSession = unknown> {
  configs: ConfigRepository;
  states: Pick<CastStateRepository<TSession>, "listLatest">;
  artifacts: ArtifactCatalog;
}

export class CastCatalogUseCases<TSession = unknown> {
  constructor(private readonly deps: CastCatalogUseCasesDeps<TSession>) {}

  async listCasts(input: { cwd: string; session: TSession; configuredPath?: string }): Promise<{ loaded: LoadedConfig; artifactRoot: string; lines: string[] }> {
    const loaded = await this.deps.configs.load(input.cwd, input.configuredPath);
    const artifactRoot = this.deps.configs.resolveArtifactRoot(input.cwd, loaded.config.artifactDir);
    const lines = await this.deps.artifacts.renderCastList(artifactRoot, this.deps.states.listLatest(input.session));
    return { loaded, artifactRoot, lines };
  }
}

export interface CastExecutionUseCasesDeps<TSession = unknown, TPi = unknown, TAgentEvent = unknown> {
  states: CastStateRepository<TSession>;
  context: CastContextPort;
  agentTurns: CastAgentTurnPort<TSession, TPi, TAgentEvent>;
  lifecycle: CastLifecyclePort<TSession, TPi>;
  statusPresenter: CastStatusPort;
  loadouts: LoadoutUseCases;
  configs: Pick<ConfigRepository, "load" | "resolveArtifactRoot">;
  pipeline: PipelinePresenter;
}

export class CastExecutionUseCases<TSession = unknown, TPi = unknown, TAgentEvent = unknown> {
  constructor(private readonly deps: CastExecutionUseCasesDeps<TSession, TPi, TAgentEvent>) {}

  buildIsolatedContext(messages: unknown, session: TSession): unknown | undefined {
    const state = this.deps.states.loadActive(session);
    if (!state?.active) return undefined;
    return this.deps.context.buildIsolatedContext(messages, state);
  }

  async prepareAgentStart(input: { pi: TPi; session: TSession; systemPrompt: string }): Promise<string | undefined> {
    const state = this.deps.states.loadActive(input.session);
    if (!state?.active) return undefined;
    return this.deps.agentTurns.prepareAgentStartSystemPrompt({ ...input, state });
  }

  handleAgentEnd(pi: TPi, event: TAgentEvent, session: TSession): Promise<void> {
    return this.deps.agentTurns.handleAgentEnd(pi, event, session);
  }

  async startCast(input: { pi: TPi; session: TSession; cwd: string; request: string; configuredPath?: string }): Promise<{ loaded: LoadedConfig; pipeline: ResolvedMateriaPipeline }> {
    const active = this.deps.states.loadActive(input.session);
    if (active?.active) throw new ActiveCastConflictError(active.castId);
    const prepared = await this.deps.loadouts.loadForCast(input.cwd, input.configuredPath);
    await this.deps.lifecycle.start(input.pi, input.session, prepared.loaded, prepared.pipeline, input.request);
    return prepared;
  }

  async startLinkedCast(input: { pi: TPi; session: TSession; cwd: string; argumentsText: string; rawCommand?: string; configuredPath?: string }): Promise<{ loaded: LoadedConfig; pipeline: ResolvedMateriaPipeline; link: LinkCastStateData }> {
    const active = this.deps.states.loadActive(input.session);
    if (active?.active) throw new ActiveCastConflictError(active.castId);

    const loaded = await this.deps.configs.load(input.cwd, input.configuredPath);
    const parsed = parseLinkCommandArguments(input.argumentsText, input.rawCommand);
    if (!parsed.ok) throw new LinkCommandValidationError(parsed.issues);

    const resolved = resolveLinkTargets({ targets: parsed.value.targets }, createConfigLinkTargetRegistry(loaded.config));
    if (!resolved.ok) throw new LinkCommandValidationError(resolved.issues);

    const planResult = createLinkPlan({ invocation: parsed.value.invocation, prompt: parsed.value.prompt, ...(parsed.value.fromCastId ? { fromCastId: parsed.value.fromCastId } : {}), targets: resolved.value.targets });
    if (!planResult.ok) throw new LinkCommandValidationError(planResult.issues);

    const previousContextResult = parsed.value.fromCastId
      ? await loadPreviousCastContext({ fromCastId: parsed.value.fromCastId, artifactRoot: this.deps.configs.resolveArtifactRoot(input.cwd, loaded.config.artifactDir) })
      : undefined;
    if (previousContextResult && !previousContextResult.ok) throw new LinkCommandValidationError(previousContextResult.issues);

    const compiled = compileLinkPlan({ plan: planResult.value }, createConfigLinkGraphSource({ materia: loaded.config.materia, loadouts: loaded.config.loadouts }));
    if (!compiled.ok) throw new LinkCommandValidationError(compiled.issues);

    const runtime = createLinkRuntimeState(compiled.value.virtualLoadout, previousContextResult?.ok ? previousContextResult.value : undefined);
    const link = createLinkCastStateData(planResult.value, runtime.virtualLoadout);
    const linkedLoaded = createLinkedLoadedConfig(loaded, compiled.value.virtualLoadout.metadata.id, compiled.value.virtualLoadout.loadout as MateriaPipelineConfig);
    const pipeline = this.deps.pipeline.resolve(linkedLoaded.config);
    const initialData: Record<string, unknown> = { link };
    if (runtime.previousCastContext) initialData[PREVIOUS_CAST_CONTEXT_STATE_KEY] = runtime.previousCastContext;

    await this.deps.lifecycle.start(input.pi, input.session, linkedLoaded, pipeline, parsed.value.prompt, {
      initialData,
      startEventDetails: { link: { invocation: link.plan.invocation, targets: link.plan.targets, virtualLoadout: link.virtualLoadout, ...(link.fromCastId ? { fromCastId: link.fromCastId } : {}) } },
    });
    return { loaded: linkedLoaded, pipeline, link };
  }

  async continueCast(pi: TPi, session: TSession): Promise<void> {
    const state = this.deps.states.loadActive(session);
    if (!state) throw new Error("No pi-materia cast state in this session.");
    await this.deps.lifecycle.continue(pi, session, state);
  }

  async resumeLatestOrRequested(pi: TPi, session: TSession, requestedCastId?: string): Promise<string | undefined> {
    const castId = requestedCastId || this.deps.states.listResumable(session)[0]?.castId;
    if (!castId) return undefined;
    await this.deps.lifecycle.resume(pi, session, castId);
    return castId;
  }

  async reviveLatestOrRequested(pi: TPi, session: TSession, requestedCastId?: string): Promise<string | undefined> {
    const castId = requestedCastId || this.deps.states.listRevivable(session)[0]?.castId;
    if (!castId) return undefined;
    await this.deps.lifecycle.revive(pi, session, castId);
    return castId;
  }

  abortActive(pi: TPi, session: TSession, reason = "aborted by user"): MateriaCastState | undefined {
    const state = this.deps.states.loadActive(session);
    if (!state?.active) return undefined;
    this.deps.lifecycle.clear(pi, state, reason);
    return state;
  }

  status(session: TSession): MateriaCastState | undefined {
    return this.deps.states.loadActive(session);
  }

  statusLabel(state: MateriaCastState): string {
    return this.deps.statusPresenter.statusLabel(state);
  }
}

export class LinkCommandValidationError extends Error {
  readonly code = "link_command_validation";
  constructor(readonly issues: DomainIssue[]) {
    super(`Invalid /materia link command: ${formatDomainIssues(issues)}`);
  }
}

function createLinkedLoadedConfig(loaded: LoadedConfig, virtualLoadoutId: string, virtualLoadout: MateriaPipelineConfig): LoadedConfig {
  const config: PiMateriaConfig = {
    ...loaded.config,
    activeLoadout: virtualLoadoutId,
    loadouts: { ...(loaded.config.loadouts ?? {}), [virtualLoadoutId]: virtualLoadout },
  };
  return { ...loaded, source: `${loaded.source}#${virtualLoadoutId}`, config };
}

function formatDomainIssues(issues: DomainIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

export function configuredConfigPath(flags: { getFlag(name: string): unknown }, env: EnvironmentLookup): string | undefined {
  const flagValue = flags.getFlag("materia-config");
  if (typeof flagValue === "string" && flagValue.trim()) return flagValue.trim();
  const envValue = env.get("MATERIA_CONFIG");
  return envValue?.trim() || undefined;
}
