import type { ToolScopeSpec } from "./domain/toolScope.js";
import type { CatalogDriftInfo, CatalogOriginProvenance } from "./domain/catalogProvenance.js";
import type { MateriaThinkingLevel } from "./domain/thinking.js";

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
  /** Runtime eventing configuration for webhook sinks, heartbeats, and presets. */
  eventing?: EventingConfig;
}

export interface LoadedConfig {
  config: PiMateriaConfig;
  source: string;
  layers?: MateriaConfigLayer[];
  loadoutSources?: Record<string, MateriaConfigLayerScope>;
  materiaSources?: Record<string, MateriaConfigLayerScope>;
  /**
   * Resolved catalog drift for local definitions that originated from a central
   * catalog item, keyed by loadout name / materia id. Informational only; never
   * auto-applied (docs/enterprise-control-plane.md §14). Absent when central
   * drift could not be resolved (central unreachable or no summaries).
   */
  catalogDrift?: ResolvedConfigCatalogDrift;
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

/**
 * Resolved catalog drift surfaced in {@link LoadedConfig} and WebUI API responses.
 * A re-export of the config-layer drift snapshot shape so `types.ts` consumers
 * do not need to import the config module directly.
 */
export interface ResolvedConfigCatalogDrift {
  loadouts?: Record<string, CatalogDriftInfo>;
  materia?: Record<string, CatalogDriftInfo>;
}

/**
 * Config layer scope / definition provenance. Precedence is lowest-to-highest:
 * `default` < `central` < `user` < `project` < `explicit`.
 *
 * `central` is a read-only provenance value for definitions surfaced from the
 * central catalog layer; it is never a writable local save target
 * (docs/enterprise-control-plane.md §5). The writable local scopes remain
 * `default | user | project | explicit`.
 */
export type MateriaConfigLayerScope = "default" | "central" | "user" | "project" | "explicit";
export type LoadoutSource = MateriaConfigLayerScope;
export type LoadoutUserLockState = "locked" | "unlocked";
export type MateriaUserLockState = "locked" | "unlocked";
export type MateriaConfigPatch = Omit<Partial<PiMateriaConfig>, "materia" | "eventing"> & {
  materia?: Record<string, Partial<MateriaConfig> | null>;
  eventing?: Partial<EventingConfig> | null;
};

export interface MateriaConfigLayer {
  scope: MateriaConfigLayerScope;
  /**
   * Filesystem path backing the layer. Absent for non-file layers such as the
   * read-only `central` catalog layer, which has no local backing file
   * (docs/enterprise-control-plane.md §5).
   */
  path?: string;
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
    /**
     * Optional absolute base URL of a central control plane the local WebUI
     * runtime should connect to. When set, the WebUI reports
     * `central-connected` mode and surfaces central catalog/model-policy/admin
     * state separately from local session state
     * (docs/enterprise-control-plane.md §2, §8). Unset/invalid means purely
     * local (`local-only`) and changes no default behavior.
     */
    centralApiBaseUrl?: string;
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
  /** Optional model override for isolated role-generation sessions. Null/default uses Pi's active model. */
  model?: string | null;
  /** Optional provider override for isolated role-generation sessions when model is not provider-qualified. */
  provider?: string;
  /** Optional API override/metadata for provider-specific isolated role-generation sessions. */
  api?: string;
  /** Optional thinking override for isolated role-generation sessions. Null/default uses Pi's active thinking setting. */
  thinking?: MateriaThinkingLevel | null;
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
  /**
   * Active-turn provenance captured when a prompt is dispatched: the socket id,
   * visit, materia, and the session entry boundary after which an assistant
   * response is valid for this turn. handleAgentEnd uses this to ignore
   * duplicate or stale agent_end callbacks that do not belong to the turn
   * currently awaiting a response (e.g. a duplicate source-socket agent_end
   * arriving after routing has advanced to the target socket).
   */
  activeTurn?: {
    socketId: string;
    visit: number;
    materia?: string;
    boundaryEntryId?: string;
  };
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
  /** Per-context recovery reason, keyed like recoveryAttempts. Persists the classified reason across retries so prompt assembly can inject reason-specific hints. */
  recoveryReasons?: Record<string, MateriaRecoveryReason>;
  /** Per-context original error message from the first failure that triggered recovery, keyed like recoveryAttempts. */
  recoveryErrorMessages?: Record<string, string>;
  /** Structured terminal metadata for casts failed by same-socket recovery exhaustion or edge traversal exhaustion. */
  recoveryExhaustion?: MateriaRecoveryExhaustion;
  /** Per-edge cast-local effective traversal limits, keyed like edgeTraversals. Populated on first traversal and updated by revive. */
  edgeAllowances?: Record<string, MateriaEdgeAllowance>;
  /** Clearable flag so the runtime can drop stale timeout hints after a successful retry. */
  recoveryHintSuppressed?: boolean;
  /** Bounded metadata for the next same-socket retry after invalid final JSON output. */
  jsonOutputRepair?: MateriaJsonOutputRepairContext;
  /** Bounded runtime-owned provenance rendered into follow-up prompts after not_satisfied routing. */
  reworkFeedback?: MateriaReworkFeedbackEntry[];
  /** Same recovery keys that have already retried a strong context-window failure without compaction. */
  contextWindowRecoveryGuards?: Record<string, number>;
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
  validationIssues?: Array<{ path: string; message: string; expected?: string; reason?: string }>;
  invalidOutputExcerpt: string;
  excerptLength: number;
  truncated: boolean;
}

export interface MateriaReworkFeedbackEntry {
  sourceSocketId: string;
  sourceMateria?: string;
  sourceMateriaLabel?: string;
  targetSocketId: string;
  condition: "not_satisfied";
  itemKey?: string;
  itemLabel?: string;
  reason: string;
  createdAt: number;
}

export type MateriaRecoveryReason = "context_window" | "tool_timeout" | "turn_failure";

export interface MateriaEdgeAllowance {
  originalLimit: number;
  effectiveLimit: number;
  reviveCount: number;
}

export interface MateriaSameSocketRecoveryExhaustion {
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
  recoveryKind?: "json_output_repair";
  validationKind?: MateriaJsonOutputValidationKind;
  excerptLength?: number;
  excerptTruncated?: boolean;
  mode: "normal" | "refinement" | "finalization";
  exhaustedAt: number;
}

export interface MateriaEdgeTraversalExhaustion {
  kind: "edge_traversal_exhausted";
  from: string;
  to: string;
  key: string;
  count: number;
  originalLimit: number;
  effectiveLimit: number;
  reviveCount: number;
  failedReason: string;
  exhaustedAt: number;
}

export type MateriaRecoveryExhaustion = MateriaSameSocketRecoveryExhaustion | MateriaEdgeTraversalExhaustion;

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
  /** Stable loadout id used to execute this cast. */
  loadoutId?: string;
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
  /**
   * Catalog origin provenance for a local copy that originated from a central
   * catalog item. Informational; never auto-applied
   * (docs/enterprise-control-plane.md §14). Only present on writable local
   * (user/project/explicit) loadouts.
   */
  catalogOrigin?: CatalogOriginProvenance;
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
  /**
   * Catalog origin provenance for a local copy that originated from a central
   * catalog item. Informational; never auto-applied
   * (docs/enterprise-control-plane.md §14). Only present on writable local
   * (user/project/explicit) definitions.
   */
  catalogOrigin?: CatalogOriginProvenance;
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

// ── Eventing Configuration ──────────────────────────────────────────────

/** Top-level runtime eventing configuration. */
export interface EventingConfig {
  /** Master switch — default false. When false, no events are dispatched and no sinks are active. */
  enabled?: boolean;
  /** Named sink configurations keyed by sink id. */
  sinks?: Record<string, EventSinkConfig>;
  /** Heartbeat emission interval in milliseconds (default 30000 = 30s). Set to 0 or negative to disable. */
  heartbeatIntervalMs?: number;
  /** Named preset configurations to apply (e.g. "agent-controller"). */
  presets?: string[];
}

/** Union of all supported sink config kinds. */
export type EventSinkConfig = EventingWebhookSinkConfig | EventingDisabledSinkConfig;

/** A webhook sink delivers events to an external HTTP endpoint. */
export interface EventingWebhookSinkConfig {
  id: string;
  kind?: "webhook";
  enabled?: boolean;
  /** POST endpoint URL. Supports `{runId}` template resolved from AGENT_CONTROLLER_RUN_ID env var or context file. */
  url: string;
  /** HTTP method (default "POST"). */
  method?: "POST" | "PUT";
  /** Static headers added to every delivery request. Secret values are redacted in logs/artifacts. */
  headers?: Record<string, string>;
  /** Body construction strategy. "mapped" (default) uses bodyMapping; "passthrough" sends the entire enriched event; "none" sends an empty object. */
  bodyTemplate?: "passthrough" | "mapped" | "none";
  /** Field mapping used when bodyTemplate is "mapped". */
  bodyMapping?: EventBodyFieldMapping;
  /** Optional pi-materia → controller event type mapping. Keys are pi-materia event types; values are the mapped type to send. */
  typeMap?: Record<string, string>;
  /** Optional severity value mapping. Keys are internal severity values; values are the mapped severity to send. Useful when an external system only accepts a subset of severities (e.g. the agent controller does not accept `debug`, so `{ "debug": "info" }` maps heartbeats to `info`). */
  severityMap?: Record<string, string>;
  /** Optional event type filter applied before delivery. */
  eventFilter?: EventFilter;
  /** Delivery request timeout in milliseconds (default 10000). */
  timeoutMs?: number;
  /** Maximum delivery retries on network/5xx errors (default 3). */
  maxRetries?: number;
  /** Initial backoff in milliseconds for retries (default 1000, exponential). */
  retryBackoffMs?: number;
  /** Maximum backoff cap in milliseconds (default 30000). */
  maxBackoffMs?: number;
  /** Drop sink after this many consecutive failures (default 10). */
  discardingAfter?: number;
}

/** A disabled sink entry preserved in config but skipped during dispatch. */
export interface EventingDisabledSinkConfig {
  id: string;
  enabled: false;
}

/** Webhook body field mapping — controls which enriched event fields appear in the HTTP body. */
export interface EventBodyFieldMapping {
  /** Field name for the event id. */
  eventId?: "eventId" | string;
  /** Field name for the event type. */
  eventType?: "type" | string;
  /** Field name for the occurrence timestamp. */
  occurredAt?: "occurredAt" | string;
  /** Field name for severity. */
  severity?: "severity" | string;
  /** Field name for the message. */
  message?: "message" | string;
  /** Field name for the payload. */
  payload?: "payload" | string;
  /** Field name for the runtime-assigned run id (maps from enriched event's castId by default). */
  runtimeRunId?: "castId" | string;
  /** Field name for the monotonic per-cast event sequence. */
  sequence?: "sequence" | string;
  /** Additional static fields merged into every delivery body. */
  static?: Record<string, unknown>;
}

/** Event filter controls which event types are delivered to a sink. */
export interface EventFilter {
  /** Glob-like type patterns to include (e.g. ["result.*", "lifecycle.*"]). */
  include?: string[];
  /** Glob-like patterns to exclude (takes priority over include). */
  exclude?: string[];
}
