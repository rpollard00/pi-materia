import type { LoadedConfig, MateriaCastState, MateriaPipelineConfig, PiMateriaConfig, ResolvedMateriaPipeline } from "../types.js";
import { resolveLoadoutSelection } from "../loadout/defaultLoadoutResolver.js";
import type { ArtifactCatalog, CastAgentTurnPort, CastContextPort, CastLifecyclePort, CastStartOptions, CastStateRepository, CastStatusPort, ConfigRepository, EnvironmentLookup, Logger, PipelinePresenter, QuestBoardRepository } from "./ports.js";
import { compileLinkPlan, compileVirtualLoadoutFromResolvedTargets, createConfigLinkGraphSource } from "../link/compiler.js";
import { loadPreviousCastContext } from "../link/contextLoader.js";
import { parseLinkCommandArguments } from "../link/parser.js";
import { createLinkCastStateData, createLinkPlan, createLinkRuntimeState } from "../link/planner.js";
import { createConfigLinkTargetRegistry, resolveLinkTargets } from "../link/resolver.js";
import { PREVIOUS_CAST_CONTEXT_STATE_KEY, type LinkCastStateData, type LinkTargetRef, type ResolvedMateriaLinkTarget, type VirtualLoadoutMetadata } from "../link/types.js";
import { addQuest, completeQuest, createShortRandomQuestId, enableQuestRunner, failRunningQuest, findNextPendingQuest, generateUniqueQuestId, movePendingQuest, requeueQuest, resolveQuestRef, startQuest, stopQuestRunner, updatePendingQuest, type Quest, type QuestBoard, type QuestMovePlacement, type QuestRunResult, type QuestTerminalStatus } from "../domain/questBoard.js";
import type { DomainIssue } from "../domain/result.js";

export interface LoadoutUseCasesDeps {
  configs: ConfigRepository;
  pipeline: PipelinePresenter;
  logger?: Logger;
}

export interface EffectiveCastLoadout {
  requestedLoadoutOverride: string;
  effectiveLoadoutName: string;
  effectiveLoadoutId?: string;
}

export type QuestLaunchLoadoutSource = "override" | "quest_default" | "fallback";

export interface QuestLaunchLoadoutSelection {
  source: QuestLaunchLoadoutSource;
  loaded: LoadedConfig;
  pipeline: ResolvedMateriaPipeline;
  effectiveLoadout?: EffectiveCastLoadout;
  warning?: string;
}

export type PreparedCastLoadout = Pick<QuestLaunchLoadoutSelection, "loaded" | "pipeline" | "effectiveLoadout">;

export type AutoCastMode = "loadout" | "materia";

export interface AutoCastLoadoutMetadata {
  mode: "loadout";
  requestedTarget: string;
  activeLoadoutChanged: false;
  effectiveLoadout: { name: string; id?: string };
}

export interface AutoCastMateriaMetadata {
  mode: "materia";
  requestedTarget: string;
  activeLoadoutChanged: false;
  resolvedMateria: { id: string; name?: string };
  virtualLoadout: VirtualLoadoutMetadata;
}

export type AutoCastMetadata = AutoCastLoadoutMetadata | AutoCastMateriaMetadata;

export class LoadoutUseCases {
  constructor(private readonly deps: LoadoutUseCasesDeps) {}

  async prepareGrid(cwd: string, configuredPath?: string): Promise<{ loaded: LoadedConfig; pipeline: ResolvedMateriaPipeline; lines: string[] }> {
    const loaded = await this.deps.configs.load(cwd, configuredPath);
    const pipeline = this.deps.pipeline.resolve(loaded.config);
    return { loaded, pipeline, lines: this.deps.pipeline.renderGrid(loaded.config, pipeline, loaded.source, cwd) };
  }

  async listLoadouts(cwd: string, configuredPath?: string): Promise<{ loaded: LoadedConfig; lines: string[] }> {
    const loaded = await this.deps.configs.load(cwd, configuredPath);
    return { loaded, lines: this.deps.pipeline.renderLoadoutCatalog(loaded.config, loaded.source, loaded.loadoutSources) };
  }

  async selectActiveLoadout(input: { cwd: string; requestedLoadout: string; configuredPath?: string; activeCast?: MateriaCastState }): Promise<{ loaded: LoadedConfig; writtenPath: string }> {
    if (input.activeCast?.active) throw new ActiveCastConflictError(input.activeCast.castId);
    const writtenPath = await this.deps.configs.saveActiveLoadout(input.cwd, input.requestedLoadout, input.configuredPath);
    const loaded = await this.deps.configs.load(input.cwd, input.configuredPath);
    this.deps.logger?.info?.("active loadout selected", { loadout: loaded.config.activeLoadout ?? input.requestedLoadout, source: loaded.source, writtenPath });
    return { loaded, writtenPath };
  }

  async loadForCast(cwd: string, configuredPath?: string, loadoutOverride?: string): Promise<{ loaded: LoadedConfig; pipeline: ResolvedMateriaPipeline; effectiveLoadout?: EffectiveCastLoadout }> {
    const loaded = await this.deps.configs.load(cwd, configuredPath);
    const effectiveLoadout = resolveCastLoadoutOverride(loaded, loadoutOverride);
    const castLoaded = effectiveLoadout ? createLoadoutOverrideLoadedConfig(loaded, effectiveLoadout) : loaded;
    const pipeline = this.deps.pipeline.resolve(castLoaded.config);
    return { loaded: castLoaded, pipeline, ...(effectiveLoadout ? { effectiveLoadout } : {}) };
  }

  async loadForQuestCast(cwd: string, configuredPath: string | undefined, loadoutOverride?: string): Promise<QuestLaunchLoadoutSelection> {
    const loaded = await this.deps.configs.load(cwd, configuredPath);
    const selection = resolveQuestLaunchLoadout(loaded, loadoutOverride);
    const castLoaded = selection.effectiveLoadout ? createLoadoutOverrideLoadedConfig(loaded, selection.effectiveLoadout) : loaded;
    const pipeline = this.deps.pipeline.resolve(castLoaded.config);
    return { ...selection, loaded: castLoaded, pipeline };
  }
}

export function resolveQuestLaunchLoadout(loaded: LoadedConfig, loadoutOverride?: string): Omit<QuestLaunchLoadoutSelection, "loaded" | "pipeline"> {
  const override = resolveCastLoadoutOverride(loaded, loadoutOverride);
  if (override) return { source: "override", effectiveLoadout: override };

  if (loaded.questDefaultLoadoutId) {
    const resolved = resolveLoadoutSelection(loaded.questDefaultLoadoutId, loaded.config.loadouts ?? {}, loaded.loadoutSources);
    if (resolved) {
      return {
        source: "quest_default",
        effectiveLoadout: {
          requestedLoadoutOverride: loaded.questDefaultLoadoutId,
          effectiveLoadoutName: resolved.loadoutName,
          ...(resolved.loadoutId ? { effectiveLoadoutId: resolved.loadoutId } : {}),
        },
      };
    }
  }

  return { source: "fallback", ...(loaded.questDefaultLoadoutWarning ? { warning: loaded.questDefaultLoadoutWarning } : {}) };
}

function resolveCastLoadoutOverride(loaded: LoadedConfig, loadoutOverride?: string): EffectiveCastLoadout | undefined {
  const requestedLoadoutOverride = loadoutOverride?.trim();
  if (!requestedLoadoutOverride) return undefined;
  const loadoutNames = Object.keys(loaded.config.loadouts ?? {});
  if (loadoutNames.length === 0) {
    throw new Error(`Cannot override Materia loadout because this config does not define any loadouts.`);
  }
  const resolved = resolveLoadoutSelection(requestedLoadoutOverride, loaded.config.loadouts, loaded.loadoutSources);
  if (!resolved) {
    throw new Error(`Unknown Materia loadout override "${requestedLoadoutOverride}". Available loadouts: ${loadoutNames.join(", ")}.`);
  }
  return {
    requestedLoadoutOverride,
    effectiveLoadoutName: resolved.loadoutName,
    ...(resolved.loadoutId ? { effectiveLoadoutId: resolved.loadoutId } : {}),
  };
}

function createLoadoutOverrideLoadedConfig(loaded: LoadedConfig, effectiveLoadout: EffectiveCastLoadout): LoadedConfig {
  return {
    ...loaded,
    source: `${loaded.source}#loadout-override:${effectiveLoadout.effectiveLoadoutId ?? effectiveLoadout.effectiveLoadoutName}`,
    config: {
      ...loaded.config,
      materia: { ...loaded.config.materia },
      loadouts: { ...(loaded.config.loadouts ?? {}) },
      activeLoadout: effectiveLoadout.effectiveLoadoutName,
      ...(effectiveLoadout.effectiveLoadoutId ? { activeLoadoutId: effectiveLoadout.effectiveLoadoutId } : { activeLoadoutId: undefined }),
    },
  };
}

type ParsedAutoCastArguments =
  | { mode: "loadout"; rawTarget: string; name: string; prompt: string }
  | { mode: "materia"; rawTarget: string; name: string; prompt: string };

function parseAutoCastArguments(argumentsText: string): ParsedAutoCastArguments | undefined {
  const normalized = argumentsText.trim();
  if (!normalized) return undefined;
  const match = normalized.match(/^(\S+)\s+([\s\S]+)$/);
  if (!match) return undefined;
  const rawTarget = match[1]!.trim();
  const prompt = match[2]!.trim();
  if (!rawTarget || !prompt) return undefined;

  const separator = rawTarget.indexOf(":");
  if (separator > 0) {
    const prefix = rawTarget.slice(0, separator);
    const name = rawTarget.slice(separator + 1).trim();
    if (!name) return undefined;
    if (prefix === "materia") return { mode: "materia", rawTarget, name, prompt };
    if (prefix === "loadout") return { mode: "loadout", rawTarget, name, prompt };
    return { mode: "loadout", rawTarget, name: rawTarget, prompt };
  }

  return { mode: "loadout", rawTarget, name: rawTarget, prompt };
}

function createVirtualAutoCastLoadedConfig(loaded: LoadedConfig, virtualLoadoutId: string, virtualLoadout: MateriaPipelineConfig): LoadedConfig {
  const config: PiMateriaConfig = {
    ...loaded.config,
    materia: { ...loaded.config.materia },
    activeLoadout: virtualLoadoutId,
    activeLoadoutId: virtualLoadoutId,
    loadouts: { ...(loaded.config.loadouts ?? {}), [virtualLoadoutId]: virtualLoadout },
  };
  return { ...loaded, source: `${loaded.source}#${virtualLoadoutId}`, config };
}

function virtualAutoCastLoadoutId(materiaId: string): string {
  const safe = materiaId.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "materia";
  return `virtual-autocast-materia-${safe}`;
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
    if (!state) return undefined;
    const isolated = this.deps.context.buildIsolatedContext(messages, state);
    return isolated === messages ? undefined : isolated;
  }

  async prepareAgentStart(input: { pi: TPi; session: TSession; systemPrompt: string }): Promise<string | undefined> {
    const state = this.deps.states.loadActive(input.session);
    if (!state?.active) return undefined;
    return this.deps.agentTurns.prepareAgentStartSystemPrompt({ ...input, state });
  }

  handleAgentEnd(pi: TPi, event: TAgentEvent, session: TSession): Promise<void> {
    return this.deps.agentTurns.handleAgentEnd(pi, event, session);
  }

  handleToolExecutionEnd(pi: TPi, event: TAgentEvent, session: TSession): Promise<void> | undefined {
    return this.deps.agentTurns.handleToolExecutionEnd?.(pi, event, session);
  }

  async startCast(input: { pi: TPi; session: TSession; cwd: string; request: string; configuredPath?: string; loadoutOverride?: string; prepared?: PreparedCastLoadout; options?: CastStartOptions }): Promise<{ loaded: LoadedConfig; pipeline: ResolvedMateriaPipeline; effectiveLoadout?: EffectiveCastLoadout; state?: MateriaCastState }> {
    this.assertNoActiveCast(input.session);
    const prepared = input.prepared ?? await this.deps.loadouts.loadForCast(input.cwd, input.configuredPath, input.loadoutOverride);
    const options = withEffectiveLoadoutInitialData(mergeCastStartOptions(input.options, prepared.effectiveLoadout ? { startEventDetails: { loadoutOverride: prepared.effectiveLoadout } } : undefined), prepared.effectiveLoadout);
    const state = await this.startPreparedCast({ pi: input.pi, session: input.session, loaded: prepared.loaded, pipeline: prepared.pipeline, request: input.request, options });
    return { ...prepared, ...(state ? { state } : {}) };
  }

  async startAutoCast(input: { pi: TPi; session: TSession; cwd: string; argumentsText: string; rawCommand?: string; configuredPath?: string }): Promise<{ loaded: LoadedConfig; pipeline: ResolvedMateriaPipeline; autocast: AutoCastMetadata; effectiveLoadout?: EffectiveCastLoadout; state?: MateriaCastState }> {
    const parsed = parseAutoCastArguments(input.argumentsText);
    if (!parsed) throw new AutoCastCommandValidationError("Usage: /materia autocast <loadout|materia:name> <prompt>");
    this.assertNoActiveCast(input.session);

    if (parsed.mode === "materia") {
      return this.startMateriaAutoCast(input, parsed);
    }

    const loaded = await this.deps.configs.load(input.cwd, input.configuredPath);
    const effectiveLoadout = resolveCastLoadoutOverride(loaded, parsed.name);
    if (!effectiveLoadout) throw new AutoCastCommandValidationError("Usage: /materia autocast <loadout|materia:name> <prompt>");
    const castLoaded = createLoadoutOverrideLoadedConfig(loaded, effectiveLoadout);
    const pipeline = this.deps.pipeline.resolve(castLoaded.config);
    const autocast: AutoCastLoadoutMetadata = {
      mode: "loadout",
      requestedTarget: parsed.rawTarget,
      activeLoadoutChanged: false,
      effectiveLoadout: { name: effectiveLoadout.effectiveLoadoutName, ...(effectiveLoadout.effectiveLoadoutId ? { id: effectiveLoadout.effectiveLoadoutId } : {}) },
    };
    const state = await this.startPreparedCast({ pi: input.pi, session: input.session, loaded: castLoaded, pipeline, request: parsed.prompt, options: { initialData: { autocast }, startEventDetails: { autocast } } });
    return { loaded: castLoaded, pipeline, autocast, effectiveLoadout, ...(state ? { state } : {}) };
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

    await this.startPreparedCast({
      pi: input.pi,
      session: input.session,
      loaded: linkedLoaded,
      pipeline,
      request: parsed.value.prompt,
      options: {
        initialData,
        startEventDetails: { link: { invocation: link.plan.invocation, targets: link.plan.targets, virtualLoadout: link.virtualLoadout, ...(link.fromCastId ? { fromCastId: link.fromCastId } : {}) } },
      },
    });
    return { loaded: linkedLoaded, pipeline, link };
  }

  private async startMateriaAutoCast(input: { pi: TPi; session: TSession; cwd: string; configuredPath?: string }, parsed: ParsedAutoCastArguments & { mode: "materia" }): Promise<{ loaded: LoadedConfig; pipeline: ResolvedMateriaPipeline; autocast: AutoCastMateriaMetadata; state?: MateriaCastState }> {
    const loaded = await this.deps.configs.load(input.cwd, input.configuredPath);
    const registry = createConfigLinkTargetRegistry(loaded.config);
    const materia = registry.getMateria(parsed.name);
    if (!materia) throw new AutoCastCommandValidationError(`Unknown Materia ${JSON.stringify(parsed.name)}.`);

    const targetRef: LinkTargetRef = { order: 0, raw: parsed.rawTarget, prefix: "materia", name: parsed.name };
    const target: ResolvedMateriaLinkTarget = { order: 0, requested: targetRef, kind: "materia", id: materia.id, ...(materia.displayName ? { displayName: materia.displayName } : {}) };
    const virtualId = virtualAutoCastLoadoutId(materia.id);
    const compiled = compileVirtualLoadoutFromResolvedTargets({
      targets: [target],
      source: createConfigLinkGraphSource({ materia: loaded.config.materia, loadouts: loaded.config.loadouts }),
      virtualLoadout: { id: virtualId, name: `Autocast virtual loadout: ${materia.displayName ?? materia.id}` },
    });
    if (!compiled.ok) throw new AutoCastCommandValidationError(formatDomainIssues(compiled.issues));

    const virtualLoaded = createVirtualAutoCastLoadedConfig(loaded, compiled.value.metadata.id, compiled.value.loadout as MateriaPipelineConfig);
    const pipeline = this.deps.pipeline.resolve(virtualLoaded.config);
    const autocast: AutoCastMateriaMetadata = {
      mode: "materia",
      requestedTarget: parsed.rawTarget,
      activeLoadoutChanged: false,
      resolvedMateria: { id: materia.id, ...(materia.displayName ? { name: materia.displayName } : {}) },
      virtualLoadout: compiled.value.metadata,
    };
    const state = await this.startPreparedCast({ pi: input.pi, session: input.session, loaded: virtualLoaded, pipeline, request: parsed.prompt, options: { initialData: { autocast }, startEventDetails: { autocast } } });
    return { loaded: virtualLoaded, pipeline, autocast, ...(state ? { state } : {}) };
  }

  private assertNoActiveCast(session: TSession): void {
    const active = this.deps.states.loadActive(session);
    if (active?.active) throw new ActiveCastConflictError(active.castId);
  }

  private async startPreparedCast(input: { pi: TPi; session: TSession; loaded: LoadedConfig; pipeline: ResolvedMateriaPipeline; request: string; options?: CastStartOptions }): Promise<MateriaCastState | undefined> {
    const startedState = await this.deps.lifecycle.start(input.pi, input.session, input.loaded, input.pipeline, input.request, input.options);
    return startedState ?? this.deps.states.loadActive(input.session);
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

export interface QuestRunnerClock {
  now(): string;
}

export interface QuestRunnerIdGenerator {
  nextId(): string;
}

export interface QuestRunnerUseCasesDeps<TSession = unknown, TPi = unknown> {
  boards: QuestBoardRepository;
  casts: Pick<CastExecutionUseCases<TSession, TPi>, "startCast">;
  loadouts: Pick<LoadoutUseCases, "loadForCast"> & Partial<Pick<LoadoutUseCases, "loadForQuestCast">>;
  states: Pick<CastStateRepository<TSession>, "loadActive">;
  clock?: QuestRunnerClock;
  ids?: QuestRunnerIdGenerator;
  logger?: Logger;
}

export interface QuestStatusSnapshot {
  board: QuestBoard;
  boardPath: string;
  activeCast?: MateriaCastState;
  activeQuest?: Quest;
  pendingCount: number;
  runningQuest?: Quest;
  activeLoadoutName?: string;
  activeLoadoutId?: string;
  defaultLoadoutId?: string | null;
  defaultLoadoutWarning?: string;
  questDefaultLoadoutId?: string | null;
  questDefaultLoadoutWarning?: string;
}

export interface QuestStartResult {
  board: QuestBoard;
  quest: Quest;
  state: MateriaCastState;
  effectiveLoadout?: EffectiveCastLoadout;
  loadoutSource?: QuestLaunchLoadoutSource;
  loadoutWarning?: string;
}

export type QuestRunContinuousReason = QuestDrainReason;

export interface QuestRunContinuousResult {
  board: QuestBoard;
  started: QuestStartResult[];
  reason?: QuestRunContinuousReason;
}

export type QuestDrainReason = "runner_stopped" | "active_cast" | "running_quest" | "waiting" | "not_found" | "safety_limit";

export interface QuestDrainResult {
  board: QuestBoard;
  started: QuestStartResult[];
  reason?: QuestDrainReason;
}

export interface HandleQuestCastSettledInput {
  castId: string;
  status?: QuestTerminalStatus;
  state?: MateriaCastState;
  message?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export class QuestRunnerUseCases<TSession = unknown, TPi = unknown> {
  private readonly clock: QuestRunnerClock;
  private readonly ids: QuestRunnerIdGenerator;

  constructor(private readonly deps: QuestRunnerUseCasesDeps<TSession, TPi>) {
    this.clock = deps.clock ?? { now: () => new Date().toISOString() };
    this.ids = deps.ids ?? { nextId: () => createShortRandomQuestId() };
  }

  async addQuest(input: { title?: string; prompt: string; loadoutOverride?: string }): Promise<{ board: QuestBoard; quest: Quest }> {
    const board = await this.deps.boards.loadOrCreate();
    const now = this.clock.now();
    const id = generateUniqueQuestId(board, { nextId: () => this.ids.nextId() });
    if (!id.ok) throw new QuestBoardValidationError(id.issues);
    const result = addQuest(board, { id: id.value, title: input.title?.trim() || deriveQuestTitle(input.prompt), prompt: input.prompt, now, ...(input.loadoutOverride ? { loadoutOverride: input.loadoutOverride } : {}) });
    if (!result.ok) throw new QuestBoardValidationError(result.issues);
    await this.deps.boards.save(result.value);
    return { board: result.value, quest: result.value.quests[result.value.quests.length - 1]! };
  }

  async updatePendingQuest(input: { questRef: string; prompt: string; loadoutOverride?: string }): Promise<{ board: QuestBoard; quest: Quest }> {
    const board = await this.deps.boards.loadOrCreate();
    const quest = resolveQuestRef(board, input.questRef);
    if (!quest.ok) throw new QuestBoardValidationError(quest.issues);
    const prompt = input.prompt.trim();
    const loadoutOverride = input.loadoutOverride?.trim();
    const updated = updatePendingQuest(board, {
      questId: quest.value.id,
      title: deriveQuestTitle(prompt),
      prompt,
      now: this.clock.now(),
      ...(loadoutOverride ? { loadoutOverride } : {}),
    });
    if (!updated.ok) throw new QuestBoardValidationError(updated.issues);
    await this.deps.boards.save(updated.value);
    const updatedQuest = updated.value.quests.find((candidate) => candidate.id === quest.value.id)!;
    return { board: updated.value, quest: updatedQuest };
  }

  async getStatus(session?: TSession): Promise<QuestStatusSnapshot> {
    const board = await this.deps.boards.loadOrCreate();
    const activeCast = session === undefined ? undefined : this.deps.states.loadActive(session);
    const runningQuest = board.quests.find((quest) => quest.status === "running");
    const activeQuest = board.runner.activeQuestId ? board.quests.find((quest) => quest.id === board.runner.activeQuestId) : runningQuest;
    return { board, boardPath: this.deps.boards.boardPath, ...(activeCast ? { activeCast } : {}), ...(activeQuest ? { activeQuest } : {}), pendingCount: board.quests.filter((quest) => quest.status === "pending").length, ...(runningQuest ? { runningQuest } : {}) };
  }

  async moveQuest(input: { questRef: string; placement: QuestMovePlacement; targetRef?: string }): Promise<{ board: QuestBoard; quest: Quest; target?: Quest }> {
    const board = await this.deps.boards.loadOrCreate();
    const quest = resolveQuestRef(board, input.questRef);
    if (!quest.ok) throw new QuestBoardValidationError(quest.issues);
    const target = input.targetRef === undefined ? undefined : resolveQuestRef(board, input.targetRef);
    if (target !== undefined && !target.ok) throw new QuestBoardValidationError(target.issues);
    const moved = movePendingQuest(board, { questId: quest.value.id, placement: input.placement, ...(target?.value ? { targetId: target.value.id } : {}), now: this.clock.now() });
    if (!moved.ok) throw new QuestBoardValidationError(moved.issues);
    await this.deps.boards.save(moved.value);
    return { board: moved.value, quest: quest.value, ...(target?.value ? { target: target.value } : {}) };
  }

  async requeueQuest(input: { questRef: string }): Promise<{ board: QuestBoard; quest: Quest }> {
    const board = await this.deps.boards.loadOrCreate();
    const quest = resolveQuestRef(board, input.questRef);
    if (!quest.ok) throw new QuestBoardValidationError(quest.issues);
    const requeued = requeueQuest(board, { questId: quest.value.id, now: this.clock.now() });
    if (!requeued.ok) throw new QuestBoardValidationError(requeued.issues);
    await this.deps.boards.save(requeued.value);
    const updatedQuest = requeued.value.quests.find((candidate) => candidate.id === quest.value.id)!;
    return { board: requeued.value, quest: updatedQuest };
  }

  async runNext(input: { pi: TPi; session: TSession; cwd: string; configuredPath?: string }): Promise<QuestStartResult | undefined> {
    return this.runOnce(input);
  }

  async runOnce(input: { pi: TPi; session: TSession; cwd: string; questId?: string; configuredPath?: string }): Promise<QuestStartResult | undefined> {
    const board = await this.deps.boards.loadOrCreate();
    const quest = selectPendingQuest(board, input.questId);
    if (!quest) return undefined;
    return this.startPendingQuest({ pi: input.pi, session: input.session, cwd: input.cwd, configuredPath: input.configuredPath, board, quest });
  }

  async runContinuous(input: { pi: TPi; session: TSession; cwd: string; questId?: string; configuredPath?: string }): Promise<QuestRunContinuousResult> {
    const board = await this.deps.boards.loadOrCreate();
    const prepared = enableQuestRunner(board, this.clock.now());
    await this.deps.boards.save(prepared);
    return this.drainEnabledRunner({ pi: input.pi, session: input.session, cwd: input.cwd, configuredPath: input.configuredPath, ...(input.questId ? { firstQuestId: input.questId } : {}) });
  }

  async enableRunner(input: { pi: TPi; session: TSession; cwd: string; questId?: string; configuredPath?: string }): Promise<QuestStartResult | undefined> {
    return (await this.runContinuous(input)).started[0];
  }

  async stopRunner(): Promise<QuestBoard> {
    const board = await this.deps.boards.loadOrCreate();
    const next = stopQuestRunner(board, this.clock.now());
    await this.deps.boards.save(next);
    return next;
  }

  async handleCastSettled(input: HandleQuestCastSettledInput): Promise<{ board: QuestBoard; quest?: Quest }> {
    const board = await this.deps.boards.loadOrCreate();
    const quest = board.quests.find((candidate) => candidate.status === "running" && candidate.currentCastId === input.castId);
    if (!quest) return { board };
    const now = this.clock.now();
    const status = input.status ?? terminalQuestStatusFromCast(input.state);
    const result = completeQuest(board, { questId: quest.id, castId: input.castId, now, result: buildQuestRunResult({ status, now, input, quest }) });
    if (!result.ok) throw new QuestBoardValidationError(result.issues);
    await this.deps.boards.save(result.value);
    return { board: result.value, quest: result.value.quests.find((candidate) => candidate.id === quest.id) };
  }

  async autoAdvanceNext(input: { pi: TPi; session: TSession; cwd: string; configuredPath?: string; board?: QuestBoard; options?: CastStartOptions }): Promise<QuestStartResult | undefined> {
    return (await this.drainEnabledRunner({ pi: input.pi, session: input.session, cwd: input.cwd, configuredPath: input.configuredPath, board: input.board, maxStarts: 1, options: input.options })).started[0];
  }

  async drainEnabledRunner(input: { pi: TPi; session: TSession; cwd: string; configuredPath?: string; board?: QuestBoard; firstQuestId?: string; maxStarts?: number; options?: CastStartOptions }): Promise<QuestDrainResult> {
    let board = input.board ?? await this.deps.boards.loadOrCreate();
    const started: QuestStartResult[] = [];
    const maxStarts = input.maxStarts ?? Math.max(1, board.quests.filter((quest) => quest.status === "pending").length + 1);
    let firstQuestId = input.firstQuestId;

    for (let iteration = 0; iteration < maxStarts; iteration += 1) {
      board = await this.deps.boards.loadOrCreate();
      if (!board.runner.enabled) return { board, started, reason: "runner_stopped" };

      const active = this.deps.states.loadActive(input.session);
      if (active?.active) return { board, started, reason: "active_cast" };
      if (board.quests.some((quest) => quest.status === "running")) return { board, started, reason: "running_quest" };

      const quest = selectPendingQuest(board, firstQuestId);
      if (!quest) return { board, started, reason: firstQuestId ? "not_found" : "waiting" };
      firstQuestId = undefined;

      const result = await this.startPendingQuest({ pi: input.pi, session: input.session, cwd: input.cwd, configuredPath: input.configuredPath, board, quest, options: input.options });
      started.push(result);
      board = result.board;

      if (result.state.active) return { board, started, reason: "active_cast" };
    }

    board = await this.deps.boards.loadOrCreate();
    return { board, started, reason: "safety_limit" };
  }

  async reconcileOnSessionStart(): Promise<{ board: QuestBoard; reconciled: Quest[] }> {
    const board = await this.deps.boards.loadOrCreate();
    let next = board;
    const reconciled: Quest[] = [];
    for (const quest of board.quests.filter((candidate) => candidate.status === "running")) {
      const result = failRunningQuest(next, { questId: quest.id, now: this.clock.now(), status: "blocked", message: "Quest was running when the Pi session started; reconcile manually before resuming automation.", code: "stale_running_quest" });
      if (!result.ok) throw new QuestBoardValidationError(result.issues);
      next = result.value;
      const updated = next.quests.find((candidate) => candidate.id === quest.id);
      if (updated) reconciled.push(updated);
    }
    if (reconciled.length > 0) await this.deps.boards.save(next);
    return { board: next, reconciled };
  }

  private async startPendingQuest(input: { pi: TPi; session: TSession; cwd: string; configuredPath?: string; board: QuestBoard; quest: Quest; options?: CastStartOptions }): Promise<QuestStartResult> {
    const active = this.deps.states.loadActive(input.session);
    if (active?.active) throw new ActiveCastConflictError(active.castId);
    const running = input.board.quests.find((quest) => quest.status === "running");
    if (running) throw new ActiveQuestConflictError(running.id);
    if (input.quest.status !== "pending") throw new Error(`Quest ${input.quest.id} is ${input.quest.status}, not pending.`);

    let selected: QuestLaunchLoadoutSelection;
    try {
      selected = await this.resolveQuestCastLoadout(input.cwd, input.configuredPath, input.quest.loadoutOverride);
    } catch (error) {
      const failed = recordQuestStartupFailure(input.board, input.quest, this.clock.now(), error);
      await this.deps.boards.save(failed);
      throw error;
    }

    let started: Awaited<ReturnType<CastExecutionUseCases<TSession, TPi>["startCast"]>>;
    try {
      started = await this.deps.casts.startCast({ pi: input.pi, session: input.session, cwd: input.cwd, request: input.quest.prompt, configuredPath: input.configuredPath, loadoutOverride: input.quest.loadoutOverride, prepared: selected, options: mergeCastStartOptions(input.options, questCastStartOptions(input.quest, selected)) });
    } catch (error) {
      const failed = recordQuestStartupFailure(input.board, input.quest, this.clock.now(), error);
      await this.deps.boards.save(failed);
      throw error;
    }

    const state = started.state ?? this.deps.states.loadActive(input.session);
    if (!state) throw new Error(`Quest ${input.quest.id} started a cast but no cast state was returned.`);
    let board = input.board;
    const startResult = startQuest(board, { questId: input.quest.id, castId: state.castId, now: this.clock.now() });
    if (!startResult.ok) throw new QuestBoardValidationError(startResult.issues);
    board = startResult.value;
    await this.deps.boards.save(board);

    if (!state.active) {
      const settled = await this.handleCastSettled({ castId: state.castId, state, metadata: { immediateTerminal: true } });
      board = settled.board;
    }

    const quest = board.quests.find((candidate) => candidate.id === input.quest.id)!;
    return { board, quest, state, ...(started.effectiveLoadout ? { effectiveLoadout: started.effectiveLoadout } : {}), loadoutSource: selected.source, ...(selected.warning ? { loadoutWarning: selected.warning } : {}) };
  }

  private async resolveQuestCastLoadout(cwd: string, configuredPath: string | undefined, loadoutOverride?: string): Promise<QuestLaunchLoadoutSelection> {
    if (this.deps.loadouts.loadForQuestCast) return this.deps.loadouts.loadForQuestCast(cwd, configuredPath, loadoutOverride);
    const prepared = await this.deps.loadouts.loadForCast(cwd, configuredPath, loadoutOverride);
    return { ...prepared, source: prepared.effectiveLoadout ? "override" : "fallback" };
  }
}

export class ActiveQuestConflictError extends Error {
  readonly code = "active_quest_conflict";
  constructor(readonly questId: string) {
    super(`Cannot start quest because quest ${questId} is already running.`);
  }
}

export class QuestBoardValidationError extends Error {
  readonly code = "quest_board_validation";
  constructor(readonly issues: DomainIssue[]) {
    super(`Invalid quest board transition: ${formatDomainIssues(issues)}`);
  }
}

function questCastStartOptions(quest: Quest, selection: Pick<QuestLaunchLoadoutSelection, "source" | "warning" | "effectiveLoadout">): CastStartOptions {
  const metadata = {
    questId: quest.id,
    title: quest.title,
    loadoutSource: selection.source,
    ...(quest.loadoutOverride ? { loadoutOverride: quest.loadoutOverride } : {}),
    ...(selection.effectiveLoadout ? { requestedLoadoutOverride: selection.effectiveLoadout.requestedLoadoutOverride, effectiveLoadoutName: selection.effectiveLoadout.effectiveLoadoutName, ...(selection.effectiveLoadout.effectiveLoadoutId ? { effectiveLoadoutId: selection.effectiveLoadout.effectiveLoadoutId } : {}) } : {}),
    ...(selection.warning ? { questDefaultLoadoutWarning: selection.warning } : {}),
  };
  return { initialData: { quest: metadata }, startEventDetails: { quest: metadata } };
}

function deriveQuestTitle(prompt: string): string {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  return normalized.length > 60 ? `${normalized.slice(0, 57)}...` : normalized || "Untitled quest";
}

function terminalQuestStatusFromCast(state?: MateriaCastState): QuestTerminalStatus {
  if (!state) return "blocked";
  if (state.phase === "complete" || state.socketState === "complete") return "succeeded";
  if (state.phase === "failed" || state.socketState === "failed") return "failed";
  return state.active ? "blocked" : "failed";
}

function buildQuestRunResult(input: { status: QuestTerminalStatus; now: string; input: HandleQuestCastSettledInput; quest: Quest }): Omit<QuestRunResult, "castId" | "finishedAt"> & Partial<Pick<QuestRunResult, "castId" | "finishedAt">> {
  const state = input.input.state;
  const questMetadata = isRecord(state?.data.quest) ? state.data.quest : undefined;
  return {
    status: input.status,
    castId: input.input.castId,
    finishedAt: input.now,
    ...(input.input.message ?? state?.runState?.lastMessage ? { message: input.input.message ?? state?.runState?.lastMessage } : {}),
    ...(input.input.error ?? state?.failedReason ? { error: input.input.error ?? state?.failedReason } : {}),
    ...(state?.runDir ? { runDirectory: state.runDir } : {}),
    ...(state?.artifactRoot ? { artifactDirectory: state.artifactRoot } : {}),
    ...(typeof questMetadata?.requestedLoadoutOverride === "string" ? { requestedLoadoutOverride: questMetadata.requestedLoadoutOverride } : input.quest.loadoutOverride ? { requestedLoadoutOverride: input.quest.loadoutOverride } : {}),
    ...(typeof questMetadata?.effectiveLoadoutName === "string" ? { effectiveLoadoutName: questMetadata.effectiveLoadoutName } : {}),
    ...(typeof questMetadata?.effectiveLoadoutId === "string" ? { effectiveLoadoutId: questMetadata.effectiveLoadoutId } : {}),
    ...(typeof questMetadata?.loadoutSource === "string" ? { effectiveLoadoutSource: questMetadata.loadoutSource } : {}),
    ...(input.input.metadata ? { metadata: input.input.metadata } : {}),
  };
}

function selectPendingQuest(board: QuestBoard, questId?: string): Quest | undefined {
  if (!questId) return findNextPendingQuest(board);
  const resolved = resolveQuestRef(board, questId);
  if (!resolved.ok) return undefined;
  return resolved.value.status === "pending" ? resolved.value : undefined;
}

function recordQuestStartupFailure(board: QuestBoard, quest: Quest, now: string, error: unknown): QuestBoard {
  const message = error instanceof Error ? error.message : String(error);
  const nextQuest: Quest = { ...quest, status: "blocked", updatedAt: now, lastError: { message, occurredAt: now, code: "cast_start_failed" } };
  return { ...board, updatedAt: now, quests: board.quests.map((candidate) => candidate.id === quest.id ? nextQuest : candidate) };
}

function mergeCastStartOptions(left?: CastStartOptions, right?: CastStartOptions): CastStartOptions | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    initialData: { ...(left.initialData ?? {}), ...(right.initialData ?? {}) },
    startEventDetails: { ...(left.startEventDetails ?? {}), ...(right.startEventDetails ?? {}) },
    initialPromptDispatch: right.initialPromptDispatch ?? left.initialPromptDispatch,
  };
}

function withEffectiveLoadoutInitialData(options: CastStartOptions | undefined, effectiveLoadout?: EffectiveCastLoadout): CastStartOptions | undefined {
  if (!effectiveLoadout || !options?.initialData || !isRecord(options.initialData.quest)) return options;
  return { ...options, initialData: { ...options.initialData, quest: { ...options.initialData.quest, requestedLoadoutOverride: effectiveLoadout.requestedLoadoutOverride, effectiveLoadoutName: effectiveLoadout.effectiveLoadoutName, ...(effectiveLoadout.effectiveLoadoutId ? { effectiveLoadoutId: effectiveLoadout.effectiveLoadoutId } : {}) } } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class AutoCastCommandValidationError extends Error {
  readonly code = "autocast_command_validation";
  constructor(message: string) {
    super(message);
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
