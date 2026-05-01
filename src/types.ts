export interface PiMateriaConfig {
  artifactDir?: string;
  budget?: MateriaBudgetConfig;
  limits?: MateriaLimitsConfig;
  pipeline: MateriaPipelineConfig;
  roles: Record<string, MateriaRoleConfig>;
}

export interface LoadedConfig {
  config: PiMateriaConfig;
  source: string;
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

export interface UsageTotals {
  tokens: UsageTokens;
  cost: UsageCost;
}

export interface UsageReport extends UsageTotals {
  model?: string;
  provider?: string;
  api?: string;
  thinkingLevel?: string;
  byRole: Record<string, UsageTotals>;
  byNode: Record<string, UsageTotals>;
  byTask: Record<string, UsageTotals>;
  byAttempt: Record<string, UsageTotals>;
}

export type MateriaCastPhase = string;

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
  currentRole?: string;
  currentItemKey?: string;
  currentItemLabel?: string;
  awaitingResponse: boolean;
  lastProcessedEntryId?: string;
  lastAssistantText?: string;
  failedReason?: string;
  startedAt: number;
  updatedAt: number;
  data: Record<string, unknown>;
  cursors: Record<string, number>;
  visits: Record<string, number>;
  edgeTraversals: Record<string, number>;
  lastOutput?: string;
  lastJson?: unknown;
  runState: MateriaRunState;
  pipeline: ResolvedMateriaPipeline;
}

export interface MateriaManifestEntry {
  phase: MateriaCastPhase;
  node?: string;
  role?: string;
  itemKey?: string;
  itemLabel?: string;
  itemLabelShort?: string;
  visit?: number;
  entryId?: string;
  artifact?: string;
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
  currentRole?: string;
  currentTask?: string;
  attempt?: number;
  lastMessage?: string;
  usage: UsageReport;
  budgetWarned: boolean;
}

export type MateriaMirrorEvent =
  | { type: "role_start" }
  | { type: "text_chunk"; text: string }
  | { type: "tool_start"; toolName: string; args: unknown }
  | { type: "tool_end"; toolName: string; isError: boolean; result: unknown }
  | { type: "role_end"; output: string };

export interface RoleRunContext {
  nodeId: string;
  roleName: string;
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
  role: string;
  prompt?: string;
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
  role: MateriaRoleConfig;
}

export interface ResolvedMateriaUtilityNode {
  id: string;
  node: MateriaUtilityNodeConfig;
}

export interface MateriaRoleConfig {
  tools: "none" | "readOnly" | "coding";
  systemPrompt: string;
}
