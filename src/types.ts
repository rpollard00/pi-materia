export interface PiMateriaConfig {
  artifactDir?: string;
  budget?: MateriaBudgetConfig;
  limits?: MateriaLimitsConfig;
  compaction?: MateriaCompactionConfig;
  /** Named graph configs that share the top-level materia, limits, budget, and artifactDir. */
  loadouts?: Record<string, MateriaPipelineConfig>;
  /** Name of the loadout to use. */
  activeLoadout?: string;
  /** Top-level materia behavior definitions. */
  materia: Record<string, MateriaConfig>;
}

export interface LoadedConfig {
  config: PiMateriaConfig;
  source: string;
  layers?: MateriaConfigLayer[];
}

export type MateriaConfigLayerScope = "default" | "user" | "project" | "explicit";

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
  defaultSaveTarget?: "user" | "project";
}

export interface MateriaBudgetConfig {
  maxTokens?: number;
  maxCostUsd?: number;
  warnAtPercent?: number;
  stopAtLimit?: boolean;
}

export interface MateriaLimitsConfig {
  maxNodeVisits?: number;
  maxEdgeTraversals?: number;
}

export interface MateriaCompactionConfig {
  /** Backward-compatible single proactive compaction threshold percentage. */
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
  modelExplicit: boolean;
  thinkingExplicit: boolean;
  source: "configured" | "active";
  label: string;
}

export interface UsageModelSelection extends MateriaModelSelection {
  node: string;
  materia: string;
  taskId?: string;
  attempt?: number;
}

export interface UsageTurn extends UsageTotals {
  node: string;
  materia: string;
  taskId?: string;
  attempt?: number;
  model?: string;
  provider?: string;
  api?: string;
  thinking?: string;
  requestedModel?: string;
  requestedThinking?: string;
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
  byNode: Record<string, UsageTotals>;
  byTask: Record<string, UsageTotals>;
  byAttempt: Record<string, UsageTotals>;
  turns?: UsageTurn[];
  modelSelections?: UsageModelSelection[];
}

export type MateriaCastPhase = string;

export type MateriaCastNodeState =
  | "awaiting_agent_response"
  | "awaiting_user_refinement"
  | "running_utility"
  | "idle"
  | "complete"
  | "failed";

export interface MateriaCastState {
  version: 1;
  active: boolean;
  castId: string;
  request: string;
  configSource: string;
  configHash: string;
  cwd: string;
  runDir: string;
  artifactRoot: string;
  phase: MateriaCastPhase;
  currentNode?: string;
  currentMateria?: string;
  currentItemKey?: string;
  currentItemLabel?: string;
  currentMateriaModel?: MateriaModelSelection;
  /**
   * Backward-compatible boolean used by existing runtime checks.
   * New code should prefer nodeState when it needs to distinguish active
   * multi-turn refinement pauses from turns awaiting an agent response.
   */
  awaitingResponse: boolean;
  nodeState?: MateriaCastNodeState;
  lastProcessedEntryId?: string;
  lastAssistantText?: string;
  /** Hidden prompt for the active in-flight agent turn; used to retry without re-running node start. */
  activeTurnPrompt?: string;
  multiTurnFinalizing?: boolean;
  failedReason?: string;
  startedAt: number;
  updatedAt: number;
  data: Record<string, unknown>;
  cursors: Record<string, number>;
  visits: Record<string, number>;
  multiTurnRefinements?: Record<string, number>;
  /** Bounded retry counters for same-node recovery of incomplete agent turns. */
  recoveryAttempts?: Record<string, number>;
  taskAttempts: Record<string, number>;
  edgeTraversals: Record<string, number>;
  lastOutput?: string;
  lastJson?: unknown;
  runState: MateriaRunState;
  pipeline: ResolvedMateriaPipeline;
}

export interface MateriaManifestEntry {
  phase: MateriaCastPhase;
  node?: string;
  materia?: string;
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
  runDir: string;
  eventsFile: string;
  usageFile: string;
  currentNode?: string;
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
  nodeId: string;
  materiaName: string;
  itemKey?: string;
  itemLabel?: string;
  visit?: number;
  runState: MateriaRunState;
  update: () => void;
  mirror?: (event: MateriaMirrorEvent) => void;
}

export interface MateriaPipelineConfig {
  entry: string;
  nodes: Record<string, MateriaPipelineNodeConfig>;
}

export type MateriaParseMode = "text" | "json";

export type MateriaPipelineNodeConfig = MateriaAgentNodeConfig | MateriaUtilityNodeConfig;

export interface MateriaPipelineNodeCommonConfig {
  parse?: MateriaParseMode;
  assign?: Record<string, string>;
  next?: string;
  edges?: MateriaEdgeConfig[];
  foreach?: MateriaForeachConfig;
  advance?: MateriaAdvanceConfig;
  limits?: MateriaNodeLimitsConfig;
}

export interface MateriaAgentNodeConfig extends MateriaPipelineNodeCommonConfig {
  type: "agent";
  materia: string;
}

export interface MateriaUtilityNodeConfig extends MateriaPipelineNodeCommonConfig {
  type: "utility";
  utility?: string;
  command?: string[];
  params?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface MateriaEdgeConfig {
  when?: string;
  to: string;
  maxTraversals?: number;
}

export interface MateriaForeachConfig {
  items: string;
  as?: string;
  cursor?: string;
  done?: string;
}

export interface MateriaAdvanceConfig {
  cursor: string;
  items: string;
  done?: string;
  when?: string;
}

export interface MateriaNodeLimitsConfig {
  maxVisits?: number;
  maxEdgeTraversals?: number;
  maxOutputBytes?: number;
}

export interface ResolvedMateriaPipeline {
  entry: ResolvedMateriaNode;
  nodes: Record<string, ResolvedMateriaNode>;
}

export type ResolvedMateriaNode = ResolvedMateriaAgentNode | ResolvedMateriaUtilityNode;

export interface ResolvedMateriaAgentNode {
  id: string;
  node: MateriaAgentNodeConfig;
  materia: MateriaConfig;
}

export interface ResolvedMateriaUtilityNode {
  id: string;
  node: MateriaUtilityNodeConfig;
}

export interface MateriaConfig {
  tools: "none" | "readOnly" | "coding";
  prompt: string;
  model?: string;
  thinking?: string;
  /** Tailwind gradient classes used by the Loadout UI for this materia. */
  color?: string;
  /** Keep agent nodes using this materia active for interactive refinement until finalized. */
  multiTurn?: boolean;
}
