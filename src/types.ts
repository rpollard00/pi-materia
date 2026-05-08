export interface PiMateriaConfig {
  artifactDir?: string;
  budget?: MateriaBudgetConfig;
  limits?: MateriaLimitsConfig;
  compaction?: MateriaCompactionConfig;
  /** Named graph configs that share the top-level materia, limits, budget, and artifactDir. */
  loadouts?: Record<string, MateriaPipelineConfig>;
  /** Name of the loadout to use. */
  activeLoadout?: string;
  /** Top-level reusable materia behavior definitions. */
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
  /** Explicit loop consumer regions that group sockets and can consume a generator-provided list. */
  loops?: Record<string, MateriaLoopConfig>;
}

export type MateriaParseMode = "text" | "json";

export type MateriaPipelineNodeConfig = MateriaAgentNodeConfig | MateriaUtilityNodeConfig;
export type LegacyMateriaPipelineNodeConfig = MateriaPipelineNodeConfig & { next?: string };

export interface MateriaPipelineNodeCommonConfig {
  parse?: MateriaParseMode;
  assign?: Record<string, string>;
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
  /** Human-readable label for graph/UI display. */
  label?: string;
  /** Socket ids contained by this loop region. */
  nodes: string[];
  /** Optional generator consumed by this loop region. Prefer this over directly tagging loop members as iterators. */
  consumes?: MateriaLoopConsumerConfig;
  /** Legacy/shared iterator metadata. Prefer consumes so this is derived from generator metadata. */
  iterator?: MateriaForeachConfig;
  /** Optional documented exit edge/condition for UI and validation. Runtime routing remains canonical edges. */
  exit?: MateriaLoopExitConfig;
}

export interface MateriaLoopConsumerConfig {
  /** Socket id of an agent node whose referenced materia is marked `generator: true`. */
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

export interface MateriaNodeLimitsConfig {
  maxVisits?: number;
  maxEdgeTraversals?: number;
  maxOutputBytes?: number;
}

export interface ResolvedMateriaPipeline {
  entry: ResolvedMateriaNode;
  nodes: Record<string, ResolvedMateriaNode>;
  loops?: Record<string, MateriaLoopConfig>;
}

export type ResolvedMateriaNode = ResolvedMateriaAgentNode | ResolvedMateriaUtilityNode;

export interface ResolvedMateriaAgentNode {
  id: string;
  node: MateriaAgentNodeConfig;
  materia: MateriaAgentConfig;
}

export interface ResolvedMateriaUtilityNode {
  id: string;
  node: MateriaUtilityNodeConfig;
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
  /** Marks this materia as a generator; runtime resolves the canonical workItems contract. */
  generator?: boolean;
  /** Legacy migration-only generated list metadata. Prefer generator: true. */
  generates?: MateriaGeneratorConfig;
}

export interface MateriaAgentConfig extends MateriaDefinitionMetadata {
  type?: "agent";
  tools: "none" | "readOnly" | "coding";
  prompt: string;
  model?: string;
  thinking?: string;
  /** Keep agent nodes using this materia active for interactive refinement until finalized. */
  multiTurn?: boolean;
}

export interface MateriaUtilityConfig extends MateriaDefinitionMetadata {
  type: "utility";
  utility?: string;
  command?: string[];
  params?: Record<string, unknown>;
  timeoutMs?: number;
  parse?: MateriaParseMode;
  assign?: Record<string, string>;
}
