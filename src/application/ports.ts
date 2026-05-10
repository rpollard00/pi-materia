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

// Temporary workflow facade around the existing native/plugin runtime. Keep this
// constrained to cast-execution operations until the native runtime is split.
export interface CastRuntime<TSession = unknown, TPi = unknown, TAgentEvent = unknown> {
  buildIsolatedContext(eventMessages: unknown, state: MateriaCastState): unknown;
  activeSystemPrompt(state: MateriaCastState, materia: unknown): string;
  currentMateria(state: MateriaCastState): unknown;
  prepareMultiTurnRefinementTurn(pi: TPi, session: TSession, state: MateriaCastState): Promise<void>;
  handleAgentEnd(pi: TPi, event: TAgentEvent, session: TSession): Promise<void>;
  start(pi: TPi, session: TSession, loaded: LoadedConfig, pipeline: ResolvedMateriaPipeline, request: string): Promise<void>;
  continue(pi: TPi, session: TSession, state: MateriaCastState): Promise<void>;
  resume(pi: TPi, session: TSession, castId: string): Promise<void>;
  revive(pi: TPi, session: TSession, castId: string): Promise<void>;
  clear(pi: TPi, state: MateriaCastState, reason: string): void;
  statusLabel(state: MateriaCastState): string;
}

export interface Logger {
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}

export interface EnvironmentLookup {
  get(name: string): string | undefined;
}
