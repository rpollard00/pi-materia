import type { QuestBoard } from "../domain/questBoard.js";
import type { LoadedConfig, MateriaCastState, ResolvedMateriaPipeline } from "../types.js";

export interface ConfigRepository {
  load(cwd: string, configuredPath?: string): Promise<LoadedConfig>;
  saveActiveLoadout(cwd: string, loadoutName: string, configuredPath?: string): Promise<string>;
  resolveArtifactRoot(cwd: string, artifactDir?: string): string;
}

export interface PipelinePresenter {
  resolve(config: LoadedConfig["config"]): ResolvedMateriaPipeline;
  renderGrid(config: LoadedConfig["config"], pipeline: ResolvedMateriaPipeline, source: string, cwd: string): string[];
  renderLoadoutList(config: LoadedConfig["config"], source: string): string[];
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

export interface CastContextPort {
  buildIsolatedContext(eventMessages: unknown, state: MateriaCastState): unknown;
}

export interface CastAgentTurnPort<TSession = unknown, TPi = unknown, TAgentEvent = unknown> {
  prepareAgentStartSystemPrompt(input: { pi: TPi; session: TSession; state: MateriaCastState; systemPrompt: string }): Promise<string | undefined>;
  handleAgentEnd(pi: TPi, event: TAgentEvent, session: TSession): Promise<void>;
}

export interface CastStartOptions {
  /** Optional shared cast data to seed before the first socket starts. */
  initialData?: Record<string, unknown>;
  /** Optional extra details recorded on the normal cast_start event. */
  startEventDetails?: Record<string, unknown>;
}

export interface CastLifecyclePort<TSession = unknown, TPi = unknown> {
  start(pi: TPi, session: TSession, loaded: LoadedConfig, pipeline: ResolvedMateriaPipeline, request: string, options?: CastStartOptions): Promise<void>;
  continue(pi: TPi, session: TSession, state: MateriaCastState): Promise<void>;
  resume(pi: TPi, session: TSession, castId: string): Promise<void>;
  revive(pi: TPi, session: TSession, castId: string): Promise<void>;
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
