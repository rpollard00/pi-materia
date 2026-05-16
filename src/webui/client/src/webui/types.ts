import type { ToolScopeSpec } from '../../../../domain/toolScope.js';
import type { MateriaEdgeCondition } from '../../../../types.js';
import type { MateriaConfig, PipelineConfig, PipelineSocket } from '../loadoutModel.js';

export type SaveTarget = 'user' | 'project' | 'explicit';

export interface MateriaFormState {
  editingSocketId: string;
  name: string;
  behavior: 'prompt' | 'tool';
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
  defaultLoadoutId?: string | null;
}

export interface ConfigResponse {
  ok?: boolean;
  config?: MateriaConfig | LoadedConfigResponse;
  source?: string;
  loadoutSources?: Record<string, LoadoutSourceScope>;
  defaultLoadoutId?: string | null;
}

export interface ActiveLoadoutResponse {
  ok?: boolean;
  activeLoadout?: string;
  activeLoadoutId?: string;
  config?: MateriaConfig | LoadedConfigResponse;
  message?: string;
  error?: string | { code?: string; message?: string };
}

export interface DefaultLoadoutResponse {
  ok?: boolean;
  defaultLoadoutId?: string | null;
  message?: string;
  error?: string | { code?: string; message?: string };
}

export interface RoleGenerationResponse {
  ok?: boolean;
  prompt?: string;
  error?: string | { message?: string };
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

export type LoadoutEdgeKind = 'normal' | 'legacy-next' | 'loop-exit';

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

export type MateriaTabId = 'loadout' | 'materia-editor' | 'monitor';

export type GeneratedListOutputConfig = NonNullable<NonNullable<MateriaConfig['materia']>[string]['generates']>;

export interface LayoutSocketsResult {
  sockets: PositionedSocket[];
  edges: LoadoutEdge[];
  width: number;
  height: number;
}

export type { PipelineConfig };
