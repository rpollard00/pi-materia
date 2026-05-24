import type { ToolScopeSpec } from '../../../../domain/toolScope.js';
import type { MateriaEdgeCondition } from '../../../../types.js';
import type { MateriaConfig, PipelineConfig, PipelineSocket } from '../loadoutModel.js';

export type SaveTarget = 'user' | 'project' | 'explicit';

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

export type LoadoutSourceScope = 'default' | 'user' | 'project' | 'explicit';

export interface LoadedConfigResponse {
  config?: MateriaConfig;
  source?: string;
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
