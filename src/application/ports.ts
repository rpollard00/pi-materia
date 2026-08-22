import type { QuestBoard } from "../domain/questBoard.js";
import type { ExecutionScope } from "../domain/executionScope.js";
import type { ParallelRecoveryOperation, ResolvedParallelRecoveryTarget } from "../domain/parallelRecovery.js";
import type { LoadedConfig, MateriaCastState, PiMateriaConfig, ResolvedMateriaPipeline } from "../types.js";

export * from "./childCastRunner.js";
export * from "./fakeChildCastRunner.js";
export * from "./parallelArtifacts.js";

export interface ConfigRepository {
  load(cwd: string, configuredPath?: string): Promise<LoadedConfig>;
  saveActiveLoadout(cwd: string, loadoutName: string, configuredPath?: string): Promise<string>;
  resolveArtifactRoot(cwd: string, artifactDir?: string): string;
}

export interface PipelinePresenter {
  resolve(config: LoadedConfig["config"]): ResolvedMateriaPipeline;
  renderGrid(config: LoadedConfig["config"], pipeline: ResolvedMateriaPipeline, source: string, cwd: string): string[];
  renderLoadoutList(config: LoadedConfig["config"], source: string): string[];
  renderLoadoutCatalog(config: LoadedConfig["config"], source: string, loadoutSources?: Record<string, string>): string[];
}

export interface CastStateRepository<TSession = unknown> {
  loadActive(session: TSession): MateriaCastState | undefined;
  listLatest(session: TSession): MateriaCastState[];
  listResumable(session: TSession): MateriaCastState[];
  listRevivable(session: TSession): MateriaCastState[];
}

export interface ArtifactCatalog {
  renderCastList(artifactRoot: string, sessionStates?: MateriaCastState[]): Promise<string[]>;
}

export interface CastBudgetPersistencePort<TPi = unknown> {
  loadConfig(state: MateriaCastState): Promise<Pick<PiMateriaConfig, "budget">>;
  persist(pi: TPi, state: MateriaCastState, maxTokens: number): Promise<unknown>;
}

export interface CastContextPort {
  /** Project every context request, including sessions without an active cast. */
  buildIsolatedContext(eventMessages: unknown, state?: MateriaCastState): unknown;
}

export interface CastAgentTurnPort<TSession = unknown, TPi = unknown, TAgentEvent = unknown> {
  prepareAgentStartSystemPrompt(input: { pi: TPi; session: TSession; state: MateriaCastState; systemPrompt: string }): Promise<string | undefined>;
  handleAgentEnd(pi: TPi, event: TAgentEvent, session: TSession): Promise<void>;
  handleToolExecutionEnd?(pi: TPi, event: TAgentEvent, session: TSession): Promise<void>;
}

export type InitialPromptDispatchPolicy = "immediate" | "defer-agent-trigger";

export interface ParallelCastRecoveryRequest {
  operation: ParallelRecoveryOperation;
  loopId: string;
  laneIds: readonly string[];
  /** Stable 1-based command position, when recovery originated from a lane command. */
  laneNumber?: number;
}

export interface CastStartOptions {
  /** Optional shared cast data to seed before the first socket starts. */
  initialData?: Record<string, unknown>;
  /** Optional active scope supplied by a parent branch dispatcher. */
  initialExecutionScope?: ExecutionScope;
  /** Optional extra details recorded on the normal cast_start event. */
  startEventDetails?: Record<string, unknown>;
  /** Transient policy for dispatching the first agent prompt of a new cast. */
  initialPromptDispatch?: InitialPromptDispatchPolicy;
}

export interface CastLifecyclePort<TSession = unknown, TPi = unknown> {
  start(pi: TPi, session: TSession, loaded: LoadedConfig, pipeline: ResolvedMateriaPipeline, request: string, options?: CastStartOptions): Promise<MateriaCastState | void>;
  continue(pi: TPi, session: TSession, state: MateriaCastState): Promise<void>;
  resume(pi: TPi, session: TSession, castId: string): Promise<void>;
  revive(pi: TPi, session: TSession, castId: string): Promise<void>;
  /** Resolve a numbered or bulk parallel recovery target without dispatching lifecycle work. */
  resolveParallelRecoveryTarget?(session: TSession, operation: ParallelRecoveryOperation, argumentsText?: string): ResolvedParallelRecoveryTarget;
  /** Recover selected retained lanes without reopening the parent as a new cast. */
  recoverParallel?(pi: TPi, session: TSession, castId: string, request: ParallelCastRecoveryRequest): Promise<void>;
  /**
   * Reactivate a dormant queued cast (marked with questQueuedResurrection)
   * for same-cast resumption. Restores runtime services and awaiting state
   * without dispatching any prompt. The cast stays active until the user nudges.
   */
  reactivateQueuedCast(pi: TPi, session: TSession, castId: string): Promise<MateriaCastState>;
  clear(pi: TPi, state: MateriaCastState, reason: string): void;
}

export interface CastStatusPort {
  statusLabel(state: MateriaCastState): string;
}

export interface Logger {
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}

export interface QuestBoardRepository {
  /** Stable project-local board path, currently <cwd>/.pi/pi-materia/quest-board.json. */
  readonly boardPath: string;
  loadOrCreate(): Promise<QuestBoard>;
  save(board: QuestBoard): Promise<void>;
}

export interface EnvironmentLookup {
  get(name: string): string | undefined;
}
