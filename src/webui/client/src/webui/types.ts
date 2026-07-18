import type { ToolScopeSpec } from '../../../../domain/toolScope.js';
import type { MateriaEdgeCondition } from '../../../../types.js';
import type { MateriaConfig, PipelineConfig, PipelineSocket } from '../loadoutModel.js';

export type SaveTarget = 'user' | 'project' | 'explicit';

/**
 * Operating mode reported by backend mode discovery
 * (docs/enterprise-control-plane.md §2). Defined locally to keep the frontend
 * response shape self-contained and decoupled from the backend application
 * layer.
 */
export type BackendControlPlaneMode = 'local-only' | 'central-connected' | 'central-admin';

/** Per-surface capability flags for separate central vs. local rendering. */
export interface BackendModeCapabilities {
  catalog?: boolean;
  modelPolicy?: boolean;
  telemetry?: boolean;
  admin?: boolean;
}

/** Frontend-facing endpoint routing hint returned by backend mode discovery. */
export interface BackendModeEndpointDescriptor {
  available?: boolean;
  sameOrigin?: boolean;
  baseUrl?: string;
}

/**
 * `GET /api/backend-mode` response body. Tells the frontend whether it is
 * connected to same-origin local session APIs, a configured central control
 * plane, or both, plus per-surface capability metadata.
 */
export interface BackendModeResponse {
  ok?: boolean;
  scope?: string;
  service?: string;
  mode?: BackendControlPlaneMode;
  hasLocalSession?: boolean;
  hasCentral?: boolean;
  centralApiBaseUrl?: string;
  capabilities?: BackendModeCapabilities;
  endpoints?: { local?: BackendModeEndpointDescriptor; central?: BackendModeEndpointDescriptor };
  label?: string;
}

export interface MateriaFormState {
  editingSocketId: string;
  name: string;
  behavior: 'prompt' | 'tool';
  label: string;
  description: string;
  group: string;
  prompt: string;
  toolAccess: ToolScopeSpec;
  model: string;
  thinking: string;
  color: string;
  outputFormat: 'text' | 'json';
  multiTurn: boolean;
  generator: boolean;
  utility: string;
  command: string;
  params: string;
  assign: string;
  timeoutMs: string;
  persistScope: SaveTarget;
}

export interface SocketPropertyFormState {
  maxVisits: string;
  maxEdgeTraversals: string;
  maxOutputBytes: string;
  layoutX: string;
  layoutY: string;
}

// Read-only `central` provenance is included so central-catalog definitions
// surface distinctly and are treated as non-writable (they are never a save
// target). See docs/enterprise-control-plane.md §5.
export type LoadoutSourceScope = 'default' | 'central' | 'user' | 'project' | 'explicit';

export type CatalogDefinitionKind = 'loadout' | 'materia';
export type CatalogLocalAction = 'copy' | 'update' | 'replace';
export type CatalogLocalTargetScope = SaveTarget;
export type CatalogDriftStatus = 'current' | 'behind' | 'diverged' | 'orphaned';

export interface CatalogOriginProvenance {
  catalogItemId: string;
  catalogVersion: string;
  catalogContentHash: string;
  source: CatalogLocalTargetScope;
}

export interface CatalogDriftInfo {
  status: CatalogDriftStatus;
  centralVersion?: string;
  centralContentHash?: string;
  stale?: boolean;
  reason?: string;
}

export interface ResolvedConfigCatalogDrift {
  loadouts?: Record<string, CatalogDriftInfo>;
  materia?: Record<string, CatalogDriftInfo>;
}

/** Secret-free connected-catalog metadata surfaced by the local config API. */
export interface ConnectedCatalogItemMetadata {
  id: string;
  kind: CatalogDefinitionKind;
  localKey: string;
  name?: string;
  description?: string;
  version: string;
  updatedAt: string;
  contentHash: string;
  provenance?: Readonly<Record<string, unknown>>;
}

export interface CentralCatalogSnapshotMetadata {
  status: 'fresh' | 'last-known';
  fetchedAt: string;
  attemptedAt: string;
  reason?: string;
}

export interface LoadedConfigResponse {
  config?: MateriaConfig;
  source?: string;
  centralCatalogItems?: readonly ConnectedCatalogItemMetadata[];
  centralCatalogSnapshot?: CentralCatalogSnapshotMetadata;
  catalogDrift?: ResolvedConfigCatalogDrift;
  loadoutSources?: Record<string, LoadoutSourceScope>;
  materiaSources?: Record<string, LoadoutSourceScope>;
  defaultMateriaIds?: string[];
  defaultLoadoutId?: string | null;
  defaultLoadoutWarning?: string;
  questDefaultLoadoutId?: string | null;
  questDefaultLoadoutWarning?: string;
}

export interface ConfigResponse {
  ok?: boolean;
  config?: MateriaConfig | LoadedConfigResponse;
  source?: string;
  centralCatalogItems?: readonly ConnectedCatalogItemMetadata[];
  centralCatalogSnapshot?: CentralCatalogSnapshotMetadata;
  catalogDrift?: ResolvedConfigCatalogDrift;
  loadoutSources?: Record<string, LoadoutSourceScope>;
  materiaSources?: Record<string, LoadoutSourceScope>;
  defaultMateriaIds?: string[];
  defaultLoadoutId?: string | null;
  defaultLoadoutWarning?: string;
  questDefaultLoadoutId?: string | null;
  questDefaultLoadoutWarning?: string;
}

export interface ActiveLoadoutResponse {
  ok?: boolean;
  activeLoadout?: string;
  activeLoadoutId?: string;
  config?: MateriaConfig | LoadedConfigResponse;
  source?: string;
  centralCatalogItems?: readonly ConnectedCatalogItemMetadata[];
  centralCatalogSnapshot?: CentralCatalogSnapshotMetadata;
  catalogDrift?: ResolvedConfigCatalogDrift;
  loadoutSources?: Record<string, LoadoutSourceScope>;
  materiaSources?: Record<string, LoadoutSourceScope>;
  defaultMateriaIds?: string[];
  defaultLoadoutId?: string | null;
  defaultLoadoutWarning?: string;
  questDefaultLoadoutId?: string | null;
  questDefaultLoadoutWarning?: string;
  message?: string;
  error?: string | { code?: string; message?: string };
}

export interface CatalogPromotionRequest {
  action: CatalogLocalAction;
  kind: CatalogDefinitionKind;
  catalogItemId: string;
  localKey: string;
  target: CatalogLocalTargetScope;
  confirmOverwrite?: boolean;
}

export interface CatalogPromotionResult {
  status: 'applied' | 'needs_confirmation' | 'rejected';
  action: CatalogLocalAction;
  kind: CatalogDefinitionKind;
  localKey: string;
  target: CatalogLocalTargetScope;
  path?: string;
  overwrite?: boolean;
  contentChanged?: boolean;
  reason?: string;
  code?: string;
  origin?: CatalogOriginProvenance;
  previousOrigin?: CatalogOriginProvenance;
}

export interface CatalogPromotionResponse {
  ok?: boolean;
  result?: CatalogPromotionResult;
  error?: string | { code?: string; message?: string };
  conflict?: {
    code?: string;
    confirmOverwriteRequired?: boolean;
    currentOrigin?: CatalogOriginProvenance;
    proposedOrigin?: CatalogOriginProvenance;
    currentVersion?: string;
  };
  provenance?: {
    origin?: CatalogOriginProvenance;
    previousOrigin?: CatalogOriginProvenance;
  };
  config?: ConfigResponse | LoadedConfigResponse;
  drift?: CatalogDriftInfo;
  configRefresh?: { ok?: boolean; error?: string };
}

export interface DefaultLoadoutResponse {
  ok?: boolean;
  defaultLoadoutId?: string | null;
  message?: string;
  error?: string | { code?: string; message?: string };
}

export interface QuestDefaultLoadoutResponse {
  ok?: boolean;
  questDefaultLoadoutId?: string | null;
  message?: string;
  error?: string | { code?: string; message?: string };
}

export interface RoleGenerationModelResolution {
  requestedModel: string | null;
  effectiveModel: string | null;
  fallback: boolean;
  warnings: string[];
}

export interface RoleGenerationThinkingResolution {
  requestedThinking: string | null;
  effectiveThinking: string | null;
  fallback: boolean;
  warnings: string[];
}

export interface RoleGenerationResponse {
  ok?: boolean;
  prompt?: string;
  error?: string | { message?: string };
  warnings?: string[];
  modelResolution?: RoleGenerationModelResolution;
  thinkingResolution?: RoleGenerationThinkingResolution;
}

export interface RoleGenerationPreferenceResponse {
  ok?: boolean;
  model?: string | null;
  thinking?: string | null;
  error?: string | { code?: string; message?: string };
}

export interface RoleGenerationPreferenceSavePayload {
  model?: string | null;
  thinking?: string | null;
}

export interface ModelCatalogModel {
  value: string;
  label: string;
  provider?: string;
  id?: string;
  supportedThinkingLevels: string[];
}

export interface ModelCatalogResponse {
  ok?: boolean;
  activeModel?: ModelCatalogModel | null;
  activeModelValue?: string | null;
  activeThinking?: string | null;
  models: ModelCatalogModel[];
  warnings?: string[];
}

export type ModelCatalogLoadState = 'idle' | 'loading' | 'ready' | 'error';

// ───────────────────────────────────────────────────────────────────────
// Central model-policy / model-catalog (docs/enterprise-control-plane.md §11)
//
// These mirror the central control-plane `/api/model-policy` and
// `/api/model-catalog` response shapes but are defined locally here so the
// frontend stays decoupled from the backend application layer (the same way
// `BackendModeResponse` is). Central model-policy state is read and rendered
// **independently** from local Pi model availability: the panel below the local
// model selector reflects what the central control plane declares, not what
// the local runtime currently offers.
// ───────────────────────────────────────────────────────────────────────

/** A model reference declared by a central model-policy document. */
export interface CentralModelPolicyModelRef {
  value: string;
  label?: string;
}

/** Thinking-level constraint declared by a central model-policy document. */
export interface CentralModelPolicyThinkingConstraint {
  allow?: readonly string[];
  max?: string;
}

/** Severity the central control plane assigns to unsatisfiable constraints. */
export type CentralModelPolicySeverity = 'advisory' | 'enforced';

/**
 * A central model-policy document, served independently of local Pi model
 * availability. Field semantics follow §11: `deny` is hard; `allow`
 * constrains the selectable set; `prefer` is advisory; `thinking` constrains
 * thinking-level selection.
 */
export interface CentralModelPolicyDocument {
  id: string;
  name?: string;
  description?: string;
  allow?: readonly CentralModelPolicyModelRef[];
  deny?: readonly CentralModelPolicyModelRef[];
  prefer?: readonly CentralModelPolicyModelRef[];
  thinking?: CentralModelPolicyThinkingConstraint;
  severity?: CentralModelPolicySeverity;
  /** Central version of the policy document (provenance/drift). */
  version?: string;
  /** RFC3339 timestamp the policy was last updated centrally. */
  updatedAt?: string;
}

/** `GET /api/model-policy` envelope: the active policy, when one is configured. */
export interface CentralModelPolicyResponse {
  ok?: boolean;
  scope?: string;
  service?: string;
  activePolicyId?: string;
  policy?: CentralModelPolicyDocument;
}

/** A model the central control plane knows about, independent of local runtime availability. */
export interface CentralModelCatalogEntry {
  value: string;
  label?: string;
  vendor?: string;
  supportedThinkingLevels?: readonly string[];
  deprecated?: boolean;
  notes?: string;
}

/** Optional central model-catalog metadata served separately from local Pi availability. */
export interface CentralModelCatalog {
  entries: readonly CentralModelCatalogEntry[];
  updatedAt?: string;
}

/** `GET /api/model-catalog` envelope: optional central catalog metadata. */
export interface CentralModelCatalogResponse {
  ok?: boolean;
  scope?: string;
  service?: string;
  catalog?: CentralModelCatalog;
}

/** Load state for central model-policy/catalog reads. */
export type CentralModelPolicyLoadState = 'idle' | 'loading' | 'ready' | 'error';

export interface OriginalMateriaModelSettings {
  editingSocketId: string;
  model: string;
  thinking: string;
}

export interface SelectOption {
  value: string;
  label: string;
  unavailable?: boolean;
}

export interface MateriaSavedEventDetail {
  id: string;
  name: string;
  behavior: MateriaFormState['behavior'];
  requestedScope: SaveTarget;
  scope: SaveTarget | string;
}

export interface ToolRegistrySnapshot {
  ok?: boolean;
  available?: boolean;
  tools?: string[];
  warnings?: string[];
}

/** Severity levels for runtime events (docs/runtime-eventing.md §2.3). */
export type RuntimeEventSeverity = 'debug' | 'info' | 'warning' | 'error' | 'critical';

/**
 * Enriched runtime event rendered in the monitor feed.
 *
 * Mirrors the canonical enriched event shape from docs/runtime-eventing.md §3.3.
 * Fields are optional to tolerate partial/malformed recorded events, and an
 * index signature preserves forward-compatible unknown fields for the raw
 * debugging view. Newest events arrive first in `MonitorSnapshot.runtimeEvents`.
 */
export interface RuntimeEvent {
  // Runtime-enriched canonical fields
  eventId?: string;
  occurredAt?: string;
  sequence?: number;
  castId?: string;
  socketId?: string;
  materia?: string;
  materiaLabel?: string;
  visit?: number;
  itemKey?: string;
  itemLabel?: string;
  // Materia-emitted canonical fields
  type?: string;
  severity?: RuntimeEventSeverity;
  message?: string;
  payload?: Record<string, unknown>;
  source?: { materia?: string; socketId?: string };
  // Forward-compatible unknown fields preserved verbatim for raw debugging.
  [key: string]: unknown;
}

export type QuestStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'blocked';

export interface QuestRunnerState {
  enabled: boolean;
  activeQuestId?: string;
  lastStartedAt?: string;
  lastStoppedAt?: string;
}

export interface QuestRunResultSummary {
  status: Exclude<QuestStatus, 'pending' | 'running'>;
  castId: string;
  finishedAt: string;
  message?: string;
  error?: string;
  artifactDirectory?: string;
  runDirectory?: string;
  requestedLoadoutOverride?: string;
  effectiveLoadoutId?: string;
  effectiveLoadoutName?: string;
  effectiveLoadoutSource?: string;
}

export interface QuestRunErrorSummary {
  message: string;
  occurredAt: string;
  castId?: string;
  code?: string;
}

export interface QuestSummary {
  id: string;
  title: string;
  prompt: string;
  promptPreview: string;
  status: QuestStatus;
  attempts: number;
  loadoutOverride?: string;
  createdAt: string;
  updatedAt: string;
  currentCastId?: string;
  lastCastId?: string;
  lastResult?: QuestRunResultSummary;
  lastError?: QuestRunErrorSummary;
}

export interface QuestCounts {
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  blocked: number;
  completed: number;
  terminal: number;
}

export interface QuestBoardResponse {
  ok?: boolean;
  boardPath?: string;
  runner?: QuestRunnerState;
  counts?: QuestCounts;
  activeQuest?: QuestSummary;
  runningQuest?: QuestSummary;
  pendingQuests?: QuestSummary[];
  completedQuests?: QuestSummary[];
  failedQuests?: QuestSummary[];
  quests?: QuestSummary[];
  status?: {
    statuses?: QuestStatus[];
    activeQuestId?: string;
    updatedAt?: string;
    generatedAt?: string;
  };
  error?: string | { code?: string; message?: string };
  code?: string;
}

export interface AddQuestRequest {
  prompt: string;
  loadoutOverride?: string;
}

export interface AddQuestResponse {
  ok?: boolean;
  quest?: QuestSummary;
  board?: QuestBoardResponse;
  error?: string | { code?: string; message?: string };
  code?: string;
}

export interface UpdateQuestRequest {
  prompt: string;
  loadoutOverride?: string;
}

export interface UpdateQuestResponse {
  ok?: boolean;
  quest?: QuestSummary;
  board?: QuestBoardResponse;
  error?: string | { code?: string; message?: string };
  code?: string;
}

export interface DeleteQuestResponse {
  ok?: boolean;
  quest?: QuestSummary;
  board?: QuestBoardResponse;
  error?: string | { code?: string; message?: string };
  code?: string;
}

export type QuestReorderPlacement = 'first' | 'before' | 'after';

export interface ReorderQuestRequest {
  questId: string;
  placement: QuestReorderPlacement;
  targetId?: string;
}

export interface RequeueQuestRequest {
  questId: string;
}

export type QuestControlAction = 'run' | 'runonce' | 'stop';
export type QuestNoStartReason = 'runner_stopped' | 'active_cast' | 'running_quest' | 'waiting' | 'not_found' | 'safety_limit' | 'unavailable';

export interface QuestControlRequest {
  questId?: string;
}

export interface QuestControlStartedSummary {
  quest: QuestSummary;
  castId: string;
  currentSocketId?: string;
  artifactRoot?: string;
  runDir?: string;
}

export interface QuestControlResponse {
  ok?: boolean;
  action?: QuestControlAction;
  board?: QuestBoardResponse;
  message?: string;
  reason?: QuestNoStartReason;
  started?: QuestControlStartedSummary;
  error?: string | { code?: string; message?: string };
  code?: string;
}

export interface MonitorSnapshot {
  ok?: boolean;
  sessionKey?: string;
  uiStartedAt?: number;
  now?: number;
  emittedOutputs?: Array<{ id: string; type: string; text: string; timestamp?: number; socket?: string }>;
  /**
   * Bounded, newest-first enriched runtime events from the runtime eventing
   * `events/events.jsonl` artifact (docs/runtime-eventing.md §5). Each event is
   * preserved verbatim so the raw debugging view can show the exact recorded
   * object, including forward-compatible unknown fields.
   */
  runtimeEvents?: RuntimeEvent[];
  activeLoadoutId?: string;
  activeLoadout?: string;
  toolRegistry?: ToolRegistrySnapshot;
  artifactSummary?: {
    runDir?: string;
    request?: string;
    summary?: string;
    events?: Array<{ ts?: number; type?: string; data?: unknown }>;
    outputs?: Array<{ socket?: string; materia?: string; phase?: string; kind?: string; artifact?: string; timestamp?: number; content?: string }>;
  };
  activeCast?: {
    castId: string;
    active: boolean;
    phase: string;
    loadoutId?: string;
    loadoutName?: string;
    currentSocketId?: string;
    currentMateria?: string;
    socketState?: string;
    awaitingResponse: boolean;
    runDir: string;
    artifactRoot: string;
    startedAt: number;
    updatedAt: number;
  };
}

export interface DragPayload {
  kind: 'palette' | 'socket';
  materiaId: string;
  fromLoadout?: string;
  fromSocket?: string;
}

export type LoadoutEdgeKind = 'normal' | 'loop-exit';

export interface LoadoutEdge {
  id: string;
  from: string;
  to: string;
  when: MateriaEdgeCondition;
  kind: LoadoutEdgeKind;
  edgeIndex?: number;
  loopId?: string;
  loopExitRouteId?: string;
}

export interface PositionedSocket {
  id: string;
  socket: PipelineSocket;
  index: number;
  x: number;
  y: number;
}

export interface RoutedLoadoutEdge {
  edge: LoadoutEdge;
  path: string;
  labelX: number;
  labelY: number;
  labelRotate: number;
  routeClass: 'forward' | 'backward' | 'loop';
}

export interface LoopRegion {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  summary: string;
  cyclePath: string;
  accent: string;
  accentSoft: string;
}

export interface LoopMembership {
  loopIds: string[];
  accent: string;
  accentSoft: string;
}

export interface LoopExitBadge {
  loopIds: string[];
  title: string;
  accent: string;
  accentSoft: string;
}

export type SocketAnchorSide = 'top' | 'right' | 'bottom' | 'left';

export interface SocketAnchorPoint {
  x: number;
  y: number;
  side: SocketAnchorSide;
}

export interface SocketLayoutDragState {
  socketId: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  originX: number;
  originY: number;
  currentX: number;
  currentY: number;
  moved: boolean;
}

export interface SocketRegionSelectionDragState {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

export type MateriaTabId = 'loadout' | 'materia-editor' | 'quests' | 'monitor';

export type GeneratedListOutputConfig = NonNullable<NonNullable<MateriaConfig['materia']>[string]['generates']>;

export interface LayoutSocketsResult {
  sockets: PositionedSocket[];
  edges: LoadoutEdge[];
  width: number;
  height: number;
}

export type { PipelineConfig };
