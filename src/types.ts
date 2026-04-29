export interface PiMateriaConfig {
  maxBuilderAttempts: number;
  autoCommit: boolean;
  artifactDir?: string;
  budget?: MateriaBudgetConfig;
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

export type MateriaCastPhase = "planning" | "building" | "evaluating" | "maintaining" | "complete" | "failed";

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
  currentTaskId?: string;
  currentTaskTitle?: string;
  currentTaskIndex: number;
  tasks: PlannedTask[];
  attempt: number;
  awaitingResponse: boolean;
  lastProcessedEntryId?: string;
  lastAssistantText?: string;
  lastBuildSummary?: string;
  lastFeedback?: string;
  failedReason?: string;
  startedAt: number;
  updatedAt: number;
  runState: MateriaRunState;
  pipeline: ResolvedMateriaPipeline;
}

export interface MateriaManifestEntry {
  phase: MateriaCastPhase;
  node?: string;
  role?: string;
  taskId?: string;
  attempt?: number;
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
  taskId?: string;
  taskTitle?: string;
  attempt?: number;
  runState: MateriaRunState;
  update: () => void;
  mirror?: (event: MateriaMirrorEvent) => void;
}

export interface MateriaPipelineConfig {
  entry: string;
  nodes: Record<string, MateriaPipelineNodeConfig>;
}

export interface MateriaPipelineNodeConfig {
  type: "agent";
  role: string;
  next?: string;
  edges?: Record<string, string>;
}

export interface ResolvedMateriaPipeline {
  planner: ResolvedMateriaNode;
  builder: ResolvedMateriaNode;
  evaluator: ResolvedMateriaNode;
  maintainer?: ResolvedMateriaNode;
}

export interface ResolvedMateriaNode {
  id: string;
  node: MateriaPipelineNodeConfig;
  role: MateriaRoleConfig;
}

export interface MateriaRoleConfig {
  tools: "none" | "readOnly" | "coding";
  systemPrompt: string;
}

export interface PlannedTask {
  id: string;
  title: string;
  description: string;
  acceptance: string[];
}

export interface PlanResult {
  tasks: PlannedTask[];
}

export interface EvaluationResult {
  passed: boolean;
  feedback: string;
  missing?: string[];
}
