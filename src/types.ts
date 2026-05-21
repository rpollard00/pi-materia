import type { ToolScopeSpec } from "./domain/toolScope.js";

export interface PiMateriaConfig {
  artifactDir?: string;
  budget?: MateriaBudgetConfig;
  limits?: MateriaLimitsConfig;
  compaction?: MateriaCompactionConfig;
  /** Named graph configs that share the top-level materia, limits, budget, and artifactDir. */
  loadouts?: Record<string, MateriaPipelineConfig>;
  /** Stable id of the loadout to use. Current-format runtime/UI identity must compare against loadout.id only. */
  activeLoadoutId?: string;
  /** Display name used for editor selection; activeLoadoutId is the stable runtime identity. */
  activeLoadout?: string;
  /** Top-level reusable materia behavior definitions. */
  materia: Record<string, MateriaConfig>;
}

export interface LoadedConfig {
  config: PiMateriaConfig;
  source: string;
  layers?: MateriaConfigLayer[];
  loadoutSources?: Record<string, MateriaConfigLayerScope>;
  materiaSources?: Record<string, MateriaConfigLayerScope>;
  defaultMateriaIds?: string[];
  /** Validated user preference for the default loadout. Missing or stale values are exposed as null. */
  defaultLoadoutId?: string | null;
  /** Human-readable warning when a configured default preference could not be resolved exactly. */
  defaultLoadoutWarning?: string;
  /** Validated profile preference for autonomous quest launches. Missing or stale values are exposed as null. */
  questDefaultLoadoutId?: string | null;
  /** Human-readable warning when a configured quest default preference could not be resolved exactly. */
  questDefaultLoadoutWarning?: string;
}

export type MateriaConfigLayerScope = "default" | "user" | "project" | "explicit";
export type LoadoutSource = MateriaConfigLayerScope;
export type LoadoutUserLockState = "locked" | "unlocked";
export type MateriaUserLockState = "locked" | "unlocked";
export type MateriaConfigPatch = Omit<Partial<PiMateriaConfig>, "materia"> & {
  materia?: Record<string, Partial<MateriaConfig> | null>;
};

export interface MateriaConfigLayer {
  scope: MateriaConfigLayerScope;
  path: string;
  loaded: boolean;
}

export type MateriaSaveTarget = "user" | "project" | "explicit";

export interface MateriaProfileConfig {
  webui?: {
    autoOpenBrowser?: boolean;
    openBrowser?: boolean;
    preferredPort?: number;
    port?: number;
    host?: string;
  };
  /** Durable user preference used only to initialize the runtime active loadout. */
  defaultLoadoutId?: string | null;
  /** Durable profile preference used for autonomous quest launches; null means explicitly cleared. */
  questDefaultLoadoutId?: string | null;
  defaultSaveTarget?: "user" | "project";
  roleGeneration?: MateriaRoleGenerationProfileConfig;
}

export interface MateriaRoleGenerationProfileConfig {
  /** Whether WebUI materia role-generation helpers are available. Defaults to true. */
  enabled?: boolean;
  /** Optional model override for isolated role-generation sessions. Defaults to Pi's active model. */
  model?: string;
  /** Optional provider override for isolated role-generation sessions when model is not provider-qualified. */
  provider?: string;
  /** Optional API override/metadata for provider-specific isolated role-generation sessions. */
  api?: string;
  /** Optional thinking override for isolated role-generation sessions. Defaults to Pi's active thinking setting. */
  thinking?: string;
  /** Extra operator instructions appended to the role-generation system prompt. */
  extraInstructions?: string;
  /** Whether future generation may include limited read-only project context. Defaults to false. */
  useReadOnlyProjectContext?: boolean;
}

export interface MateriaBudgetConfig {
  maxTokens?: number;
  maxCostUsd?: number;
  warnAtPercent?: number;
  stopAtLimit?: boolean;
}

export interface MateriaLimitsConfig {
  /** Canonical socket visit cap for a cast. */
  maxSocketVisits?: number;
  maxEdgeTraversals?: number;
}

export interface MateriaCompactionConfig {
  /** Single proactive compaction threshold percentage. */
  proactiveThresholdPercent?: number;
  /** Ordered min-inclusive/max-exclusive context-window tiers. Tiers must cover 0..infinity without gaps. */
  proactiveThresholdTiers?: MateriaCompactionThresholdTierConfig[];
}

export interface MateriaCompactionThresholdTierConfig {
  id?: string;
  minContextWindow?: number;
  maxContextWindow?: number;
  thresholdPercent: number;
}

export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface UsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export type UsageCostKind = "actual" | "estimated" | "subscription";

export interface UsageTotals {
  tokens: UsageTokens;
  cost: UsageCost;
}

export interface MateriaModelSelection {
  model?: string;
  provider?: string;
  api?: string;
  thinking?: string;
  requestedModel?: string;
  requestedThinking?: string;
  effectiveModel?: string;
  effectiveThinking?: string;
  modelFallbackReason?: string;
  thinkingFallbackReason?: string;
  fallbackReason?: string;
  modelExplicit: boolean;
  thinkingExplicit: boolean;
  source: "configured" | "active";
  label: string;
}

export interface UsageModelSelection extends MateriaModelSelection {
  socket: string;
  materia: string;
  taskId?: string;
  attempt?: number;
}

export interface UsageTurn extends UsageTotals {
  socket: string;
  materia: string;
  taskId?: string;
  attempt?: number;
  model?: string;
  provider?: string;
  api?: string;
  thinking?: string;
  requestedModel?: string;
  requestedThinking?: string;
  effectiveModel?: string;
  effectiveThinking?: string;
  modelFallbackReason?: string;
  thinkingFallbackReason?: string;
  fallbackReason?: string;
  modelExplicit?: boolean;
  thinkingExplicit?: boolean;
  source?: "configured" | "active";
}

export interface UsageReport extends UsageTotals {
  model?: string;
  provider?: string;
  api?: string;
  thinkingLevel?: string;
  costKind?: UsageCostKind;
  byMateria: Record<string, UsageTotals>;
  bySocket: Record<string, UsageTotals>;
  byTask: Record<string, UsageTotals>;
  byAttempt: Record<string, UsageTotals>;
  turns?: UsageTurn[];
  modelSelections?: UsageModelSelection[];
}

export interface SocketUsageReportView extends UsageReport {}

export type MateriaCastPhase = string;

export type MateriaCastSocketState =
  | "awaiting_agent_response"
  | "awaiting_user_refinement"
  | "running_utility"
  | "idle"
  | "complete"
  | "failed";

export interface MateriaCastRuntimeView {
  currentSocketId?: string;
  currentSocketState?: MateriaCastSocketState;
}

export interface MateriaCastState {
  version: 2;
  active: boolean;
  castId: string;
  request: string;
  configSource: string;
  configHash: string;
  cwd: string;
  runDir: string;
  artifactRoot: string;
  phase: MateriaCastPhase;
  currentSocketId?: string;
  currentMateria?: string;
  currentItemKey?: string;
  currentItemLabel?: string;
  currentMateriaModel?: MateriaModelSelection;
  /**
   * Backward-compatible boolean used by existing runtime checks.
   * New code should prefer socket-state accessors when it needs to distinguish active
   * multi-turn refinement pauses from turns awaiting an agent response.
   */
  awaitingResponse: boolean;
  socketState?: MateriaCastSocketState;
  lastProcessedEntryId?: string;
  lastAssistantText?: string;
  /** Hidden prompt for the active in-flight agent turn; used to retry without re-running socket start. */
  activeTurnPrompt?: string;
  multiTurnFinalizing?: boolean;
  failedReason?: string;
  startedAt: number;
  updatedAt: number;
  data: Record<string, unknown>;
  cursors: Record<string, number>;
  visits: Record<string, number>;
  multiTurnRefinements?: Record<string, number>;
  /** Bounded retry counters for same-socket recovery of incomplete agent turns. */
  recoveryAttempts?: Record<string, number>;
  /** Scoped per-context same-socket recovery allowance metadata, keyed like recoveryAttempts. */
  recoveryAllowances?: Record<string, MateriaRecoveryAllowance>;
  /** Structured terminal metadata for casts failed by same-socket recovery exhaustion. */
  recoveryExhaustion?: MateriaRecoveryExhaustion;
  /** Bounded metadata for the next same-socket retry after invalid final JSON output. */
  jsonOutputRepair?: MateriaJsonOutputRepairContext;
  taskAttempts: Record<string, number>;
  edgeTraversals: Record<string, number>;
  lastOutput?: string;
  lastJson?: unknown;
  runState: MateriaRunState;
  pipeline: ResolvedMateriaPipeline;
}

export interface MateriaRecoveryAllowance {
  originalMaxAttempts: number;
  effectiveMaxAttempts: number;
  reviveCount: number;
}

export type MateriaJsonOutputValidationKind = "json_parse" | "handoff_validation";

export interface MateriaJsonOutputRepairContext {
  validationKind: MateriaJsonOutputValidationKind;
  errorMessage: string;
  invalidOutputExcerpt: string;
  excerptLength: number;
  truncated: boolean;
}

export type MateriaRecoveryReason = "context_window" | "turn_failure";

export interface MateriaRecoveryExhaustion {
  kind: "same_socket_recovery_exhausted";
  reason: MateriaRecoveryReason;
  key: string;
  attempts: number;
  originalMaxAttempts: number;
  effectiveMaxAttempts: number;
  reviveCount: number;
  /** Exact terminal failedReason recorded for the exhaustion failure; guards against stale revive metadata. */
  failedReason: string;
  socket?: string;
  itemKey?: string;
  mode: "normal" | "refinement" | "finalization";
  exhaustedAt: number;
}

export interface MateriaManifestEntry {
  phase: MateriaCastPhase;
  socket?: string;
  materia?: string;
  materiaLabel?: string;
  itemKey?: string;
  itemLabel?: string;
  itemLabelShort?: string;
  visit?: number;
  entryId?: string;
  artifact?: string;
  kind?: string;
  refinementTurn?: number;
  finalized?: boolean;
  materiaModel?: MateriaModelSelection;
  timestamp: number;
}

export interface MateriaManifest {
  castId: string;
  request: string;
  configSource: string;
  sessionFile?: string;
  entries: MateriaManifestEntry[];
}

export interface MateriaRunState {
  runId: string;
  startedAt: number;
  /** Canonical terminal timestamp. */
  endedAt?: number;
  /** Active loadout name used to execute this cast. */
  loadoutName?: string;
  runDir: string;
  eventsFile: string;
  usageFile: string;
  currentSocketId?: string;
  currentMateria?: string;
  currentTask?: string;
  attempt?: number;
  currentMateriaModel?: MateriaModelSelection;
  lastMessage?: string;
  usage: UsageReport;
  budgetWarned: boolean;
}

export type MateriaMirrorEvent =
  | { type: "materia_start" }
  | { type: "text_chunk"; text: string }
  | { type: "tool_start"; toolName: string; args: unknown }
  | { type: "tool_end"; toolName: string; isError: boolean; result: unknown }
  | { type: "materia_end"; output: string };

export interface MateriaRunContext {
  socketId: string;
  materiaName: string;
  itemKey?: string;
  itemLabel?: string;
  visit?: number;
  runState: MateriaRunState;
  update: () => void;
  mirror?: (event: MateriaMirrorEvent) => void;
}

export interface MateriaPipelineConfig {
  /** Stable loadout identity; display names are map keys and may change. */
  id?: string;
  /** Persisted ownership/source metadata. Names are display labels and must not define ownership. */
  source?: LoadoutSource;
  /** User-controlled lock state for editable loadout sources. Policy may still force readonly. */
  lockState?: LoadoutUserLockState;
  /** Optional provenance for duplicates or local copies derived from a shipped default. */
  originDefaultId?: string;
  entry: string;
  /** Canonical socket map for core/domain/application code. */
  sockets?: Record<string, MateriaPipelineSocketConfig>;
  /** Persisted visual metadata for this loadout. Semantic validation must ignore it. */
  layout?: MateriaPipelineLayoutConfig;
  /** Explicit loop consumer regions that group sockets and can consume a generator-provided list. */
  loops?: Record<string, MateriaLoopConfig>;
}

export interface MateriaPipelineLayoutConfig {
  /** Socket positions keyed by socket id. */
  sockets?: Record<string, MateriaSocketLayoutConfig>;
}

export interface MateriaSocketLayoutConfig {
  x?: number;
  y?: number;
}

export type MateriaParseMode = "text" | "json";

export type MateriaSocketKind = "entry" | "normal";

export interface MateriaPipelineSocketConfig {
  materia: string;
  socketKind?: MateriaSocketKind;
  parse?: MateriaParseMode;
  assign?: Record<string, string>;
  edges?: MateriaEdgeConfig[];
  foreach?: MateriaForeachConfig;
  advance?: MateriaAdvanceConfig;
  limits?: MateriaSocketLimitsConfig;
  layout?: MateriaSocketLayoutConfig;
  empty?: boolean;
}

export type MateriaAgentSocketConfig = MateriaPipelineSocketConfig;
export type MateriaUtilitySocketConfig = MateriaPipelineSocketConfig;

export type MateriaEdgeCondition = "always" | "satisfied" | "not_satisfied";

export interface MateriaEdgeConfig {
  when: MateriaEdgeCondition;
  to: string;
  maxTraversals?: number;
}

export interface MateriaForeachConfig {
  items: string;
  as?: string;
  cursor?: string;
  done?: string;
}

export interface MateriaGeneratorConfig {
  /** Output key in the materia handoff JSON that contains the generated list. */
  output: string;
  /** Runtime state path for the generated list consumed by loops; defaults to `state.${output}`. */
  items?: string;
  /** Metadata describing the generated list type. Must be "array" for loop consumers. */
  listType: "array";
  /** Metadata describing each generated item type. */
  itemType: string;
  /** Item variable name used by loop consumers when not overridden on the loop. */
  as?: string;
  /** Cursor name used by loop consumers when not overridden on the loop. */
  cursor?: string;
  /** Graph target used when the generated list is exhausted. */
  done?: string;
}

export interface MateriaAdvanceConfig {
  cursor: string;
  items: string;
  done?: string;
  when?: string;
}

export interface MateriaLoopConfig {
  /** Socket ids contained by this loop region. */
  sockets?: string[];
  /** Optional generator consumed by this loop region. Prefer this over directly tagging loop members as iterators. */
  consumes?: MateriaLoopConsumerConfig;
  /** Shared iterator metadata. Prefer consumes so this is derived from generator metadata. */
  iterator?: MateriaForeachConfig;
  /** Optional documented exit edge/condition. */
  exit?: MateriaLoopExitConfig;
  /**
   * Canonical loop-owned routes followed after the loop exits.
   * These are graph semantics metadata, not normal socket edges, generator edges,
   * or derived runtime/render edges.
   */
  exits?: MateriaLoopExitRouteConfig[];
}

export interface MateriaLoopConsumerConfig {
  /** Socket id of an agent socket whose referenced materia is marked `generator: true`. */
  from: string;
  /** Generated output key to consume. Defaults to the canonical generator output (`workItems`). */
  output?: string;
  /** Loop item variable override. Defaults to generator.as. */
  as?: string;
  /** Cursor override. Defaults to generator.cursor. */
  cursor?: string;
  /** Exhaustion target override. Defaults to generator.done. */
  done?: string;
}

export interface MateriaLoopExitConfig {
  /** Socket id within the loop whose canonical edge condition controls this exit. */
  from: string;
  when: MateriaEdgeCondition;
  to: string;
}

export type MateriaLoopExitRouteCondition = MateriaEdgeCondition;

export interface MateriaLoopExitRouteConfig {
  /** Stable route identifier scoped to the owning loop. */
  id: string;
  /** Socket id within the owning loop that acts as the loop exit source. */
  from: string;
  /** Route condition evaluated from the canonical satisfied boolean at loop completion. */
  condition: MateriaLoopExitRouteCondition;
  /** Target socket id reached after loop completion. Loop-exit routes do not target the terminal "end" sentinel. */
  targetSocketId: string;
}

export interface MateriaSocketLimitsConfig {
  maxVisits?: number;
  maxEdgeTraversals?: number;
  maxOutputBytes?: number;
}

export interface ResolvedMateriaPipeline {
  entry: ResolvedMateriaSocket;
  sockets: Record<string, ResolvedMateriaSocket>;
  loops?: Record<string, MateriaLoopConfig>;
}

export type ResolvedMateriaSocket = ResolvedMateriaAgentSocket | ResolvedMateriaUtilitySocket;

export interface ResolvedMateriaAgentSocket {
  id: string;
  socket: MateriaAgentSocketConfig;
  materia: MateriaAgentConfig;
}

export interface ResolvedMateriaUtilitySocket {
  id: string;
  /** Structural socket config: graph placement, routing, foreach/advance, limits, and layout. */
  socket: MateriaUtilitySocketConfig;
  /** Referenced utility materia id. */
  materiaId: string;
  /** Resolved reusable utility behavior, appearance, parse, assignment, params, and execution config. */
  materia: MateriaUtilityConfig;
}

export type MateriaConfig = MateriaAgentConfig | MateriaUtilityConfig;

export interface MateriaDefinitionMetadata {
  /** Human-readable display label used by palette UIs. */
  label?: string;
  /** Short user-facing description used by palette UIs. */
  description?: string;
  /** Palette grouping/tag, for example "Utility". */
  group?: string;
  /** Tailwind gradient classes used by the Loadout UI for this materia. */
  color?: string;
  /** Canonical parse mode used when palette UIs materialize this reusable materia into a socket. */
  parse?: MateriaParseMode;
  /** Marks this materia as a generator; runtime resolves the canonical workItems contract. */
  generator?: boolean;
  /** User-controlled lock state for editable materia definitions. */
  lockState?: MateriaUserLockState;
  /** Generated list metadata. Prefer generator: true for the standard workItems contract. */
  generates?: MateriaGeneratorConfig;
}

export interface MateriaAgentConfig extends MateriaDefinitionMetadata {
  type: "agent";
  tools: ToolScopeSpec;
  prompt: string;
  model?: string;
  thinking?: string;
  /** Keep agent sockets using this materia active for interactive refinement until finalized. */
  multiTurn?: boolean;
}

export interface ShippedUtilityScriptConfig {
  kind: "shippedUtility";
  name: string;
  runtime?: "node";
}

export interface MateriaUtilityConfig extends MateriaDefinitionMetadata {
  type: "utility";
  utility?: string;
  command?: string[];
  script?: ShippedUtilityScriptConfig;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  assign?: Record<string, string>;
}
