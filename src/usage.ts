import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "./artifacts.js";
import type { MateriaRunState, PiMateriaConfig, RoleModelSelection, UsageCostKind, UsageReport, UsageTotals } from "./types.js";

export function createRunState(runId: string, runDir: string, model: unknown): MateriaRunState {
  const modelInfo = getModelInfo(model);
  return {
    runId,
    startedAt: Date.now(),
    runDir,
    eventsFile: path.join(runDir, "events.jsonl"),
    usageFile: path.join(runDir, "usage.json"),
    usage: {
      ...emptyUsageTotals(),
      ...modelInfo,
      costKind: inferUsageCostKind(modelInfo),
      byRole: {},
      byNode: {},
      byTask: {},
      byAttempt: {},
      turns: [],
      modelSelections: [],
    },
    budgetWarned: false,
  };
}

export async function writeUsage(state: MateriaRunState): Promise<void> {
  await writeFile(state.usageFile, JSON.stringify(state.usage, null, 2));
}

export async function assertBudget(config: PiMateriaConfig, state: MateriaRunState, ctx: ExtensionContext): Promise<void> {
  const budget = config.budget;
  if (!budget) return;

  const tokenPercent = budget.maxTokens ? (state.usage.tokens.total / budget.maxTokens) * 100 : 0;
  const costPercent = budget.maxCostUsd ? (state.usage.cost.total / budget.maxCostUsd) * 100 : 0;
  const percent = Math.max(tokenPercent, costPercent);
  const warnAt = budget.warnAtPercent ?? 75;

  if (!state.budgetWarned && percent >= warnAt) {
    state.budgetWarned = true;
    ctx.ui.notify(`pi-materia budget warning: ${percent.toFixed(1)}% used`, "warning");
    await appendEvent(state, "budget_warning", { percent, usage: state.usage });
  }

  const overToken = budget.maxTokens !== undefined && state.usage.tokens.total >= budget.maxTokens;
  const overCost = budget.maxCostUsd !== undefined && state.usage.cost.total >= budget.maxCostUsd;
  if (!overToken && !overCost) return;

  await appendEvent(state, "budget_limit", { overToken, overCost, usage: state.usage });
  if (budget.stopAtLimit !== false) throw new Error("pi-materia budget limit reached");
  if (ctx.hasUI) {
    ctx.ui.notify("pi-materia budget limit reached.", "error");
  }
}

export function extractUsage(message: unknown): UsageTotals | undefined {
  const value = message && typeof message === "object" ? message as Record<string, unknown> : undefined;
  const usage = value?.usage && typeof value.usage === "object" ? value.usage as Record<string, unknown> : undefined;
  if (!usage) return undefined;

  const input = numberOrZero(firstNumber(usage, ["input", "inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]));
  const output = numberOrZero(firstNumber(usage, ["output", "outputTokens", "output_tokens", "completionTokens", "completion_tokens"]));
  const cacheRead = numberOrZero(firstNumber(usage, ["cacheRead", "cacheReadTokens", "cache_read", "cache_read_tokens", "cache_read_input_tokens", "cachedInputTokens", "cached_input_tokens", "cachedTokens", "cached_tokens"]));
  const cacheWrite = numberOrZero(firstNumber(usage, ["cacheWrite", "cacheWriteTokens", "cache_write", "cache_write_tokens", "cache_creation_input_tokens", "cacheCreationTokens", "cache_creation_tokens"]));
  const providedTotal = firstNumber(usage, ["totalTokens", "total", "tokens", "total_tokens"]);
  const total = providedTotal ?? input + output + cacheRead + cacheWrite;

  const costValue = usage.cost;
  const cost = costValue && typeof costValue === "object" ? costValue as Record<string, unknown> : undefined;
  const costInput = numberOrZero(firstNumber(cost, ["input", "inputCost", "input_cost", "inputUsd", "input_usd", "inputCostUsd", "input_cost_usd", "prompt", "promptCost", "prompt_cost", "promptUsd", "prompt_usd", "promptCostUsd", "prompt_cost_usd"])
    ?? firstNumber(usage, ["inputCost", "input_cost", "inputCostUsd", "input_cost_usd", "inputUsd", "input_usd", "promptCost", "prompt_cost", "promptCostUsd", "prompt_cost_usd", "promptUsd", "prompt_usd"]));
  const costOutput = numberOrZero(firstNumber(cost, ["output", "outputCost", "output_cost", "outputUsd", "output_usd", "outputCostUsd", "output_cost_usd", "completion", "completionCost", "completion_cost", "completionUsd", "completion_usd", "completionCostUsd", "completion_cost_usd"])
    ?? firstNumber(usage, ["outputCost", "output_cost", "outputCostUsd", "output_cost_usd", "outputUsd", "output_usd", "completionCost", "completion_cost", "completionCostUsd", "completion_cost_usd", "completionUsd", "completion_usd"]));
  const costCacheRead = numberOrZero(firstNumber(cost, ["cacheRead", "cache_read", "cacheReadCost", "cache_read_cost", "cacheReadUsd", "cache_read_usd", "cacheReadCostUsd", "cache_read_cost_usd", "cachedInput", "cached_input", "cachedInputCost", "cached_input_cost", "cachedInputUsd", "cached_input_usd", "cachedInputCostUsd", "cached_input_cost_usd"])
    ?? firstNumber(usage, ["cacheReadCost", "cache_read_cost", "cacheReadCostUsd", "cache_read_cost_usd", "cacheReadUsd", "cache_read_usd", "cachedInputCost", "cached_input_cost", "cachedInputCostUsd", "cached_input_cost_usd", "cachedInputUsd", "cached_input_usd"]));
  const costCacheWrite = numberOrZero(firstNumber(cost, ["cacheWrite", "cache_write", "cacheWriteCost", "cache_write_cost", "cacheWriteUsd", "cache_write_usd", "cacheWriteCostUsd", "cache_write_cost_usd", "cacheCreation", "cache_creation", "cacheCreationCost", "cache_creation_cost", "cacheCreationUsd", "cache_creation_usd", "cacheCreationCostUsd", "cache_creation_cost_usd"])
    ?? firstNumber(usage, ["cacheWriteCost", "cache_write_cost", "cacheWriteCostUsd", "cache_write_cost_usd", "cacheWriteUsd", "cache_write_usd", "cacheCreationCost", "cache_creation_cost", "cacheCreationCostUsd", "cache_creation_cost_usd", "cacheCreationUsd", "cache_creation_usd"]));
  const providedCostTotal = firstNumber(cost, ["total", "totalCost", "total_cost", "totalUsd", "total_usd", "totalCostUsd", "total_cost_usd", "costUsd", "cost_usd", "usd"])
    ?? numberOrUndefined(costValue)
    ?? firstNumber(usage, ["totalCost", "total_cost", "totalCostUsd", "total_cost_usd", "totalUsd", "total_usd", "costUsd", "cost_usd", "usd"]);
  const componentCostTotal = costInput + costOutput + costCacheRead + costCacheWrite;
  const costTotal = providedCostTotal === undefined ? componentCostTotal : Math.max(providedCostTotal, componentCostTotal);
  return {
    tokens: { input, output, cacheRead, cacheWrite, total },
    cost: {
      input: costInput,
      output: costOutput,
      cacheRead: costCacheRead,
      cacheWrite: costCacheWrite,
      total: costTotal,
    },
  };
}

export function recordUsageModelSelection(report: UsageReport, key: { node: string; role: string; taskId?: string; attempt?: number; roleModel: RoleModelSelection }): void {
  if (key.roleModel.model) report.model = key.roleModel.model;
  if (key.roleModel.provider) report.provider = key.roleModel.provider;
  if (key.roleModel.api) report.api = key.roleModel.api;
  if (key.roleModel.thinking) report.thinkingLevel = key.roleModel.thinking;
  updateUsageCostKind(report, key.roleModel);
  report.modelSelections ??= [];
  report.modelSelections.push({ ...key.roleModel, node: key.node, role: key.role, taskId: key.taskId, attempt: key.attempt });
}

export function addUsage(report: UsageReport, usage: UsageTotals, key: { node: string; role: string; taskId?: string; attempt?: number; roleModel?: RoleModelSelection; messageModel?: Partial<RoleModelSelection> }): void {
  addUsageTotals(report, usage);
  addUsageTotals(report.byNode[key.node] ??= emptyUsageTotals(), usage);
  addUsageTotals(report.byRole[key.role] ??= emptyUsageTotals(), usage);
  if (key.taskId) addUsageTotals(report.byTask[key.taskId] ??= emptyUsageTotals(), usage);
  if (key.taskId && key.attempt !== undefined) addUsageTotals(report.byAttempt[`${key.taskId}:${key.attempt}`] ??= emptyUsageTotals(), usage);

  const metadata = { ...key.roleModel, ...key.messageModel };
  if (metadata.model) report.model = metadata.model;
  if (metadata.provider) report.provider = metadata.provider;
  if (metadata.api) report.api = metadata.api;
  if (metadata.thinking) report.thinkingLevel = metadata.thinking;
  updateUsageCostKind(report, metadata);
  report.turns ??= [];
  report.turns.push({
    ...cloneUsageTotals(usage),
    node: key.node,
    role: key.role,
    taskId: key.taskId,
    attempt: key.attempt,
    model: metadata.model,
    provider: metadata.provider,
    api: metadata.api,
    thinking: metadata.thinking,
    requestedModel: metadata.requestedModel,
    requestedThinking: metadata.requestedThinking,
    modelExplicit: metadata.modelExplicit,
    thinkingExplicit: metadata.thinkingExplicit,
    source: metadata.source,
  });
}

export function extractMessageModelInfo(message: unknown): Partial<RoleModelSelection> {
  const value = (message && typeof message === "object" ? message : {}) as Record<string, unknown>;
  const modelValue = value.model;
  const nestedModel = modelValue && typeof modelValue === "object" ? modelValue as Record<string, unknown> : undefined;
  const model = stringField(value.modelId) ?? stringField(value.modelName) ?? (typeof modelValue === "string" ? modelValue : undefined) ?? stringField(nestedModel?.id) ?? stringField(nestedModel?.name);
  return compactModelInfo({
    model,
    provider: stringField(value.provider) ?? stringField(nestedModel?.provider),
    api: stringField(value.api) ?? stringField(nestedModel?.api),
    thinking: stringField(value.thinkingLevel) ?? stringField(value.thinking),
  });
}

function emptyUsageTotals(): UsageTotals {
  return {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function cloneUsageTotals(usage: UsageTotals): UsageTotals {
  return {
    tokens: { ...usage.tokens },
    cost: { ...usage.cost },
  };
}

function addUsageTotals(target: UsageTotals, usage: UsageTotals): void {
  target.tokens.input += usage.tokens.input;
  target.tokens.output += usage.tokens.output;
  target.tokens.cacheRead += usage.tokens.cacheRead;
  target.tokens.cacheWrite += usage.tokens.cacheWrite;
  target.tokens.total += usage.tokens.total;
  target.cost.input += usage.cost.input;
  target.cost.output += usage.cost.output;
  target.cost.cacheRead += usage.cost.cacheRead;
  target.cost.cacheWrite += usage.cost.cacheWrite;
  target.cost.total += usage.cost.total;
}

function getModelInfo(model: unknown): Pick<UsageReport, "model" | "provider" | "api" | "thinkingLevel"> {
  const value = (model && typeof model === "object" ? model : {}) as { id?: unknown; provider?: unknown; api?: unknown; thinkingLevel?: unknown; model?: { id?: unknown; provider?: unknown; api?: unknown } };
  return {
    model: typeof value.id === "string" ? value.id : typeof value.model?.id === "string" ? value.model.id : undefined,
    provider: typeof value.provider === "string" ? value.provider : typeof value.model?.provider === "string" ? value.model.provider : undefined,
    api: typeof value.api === "string" ? value.api : typeof value.model?.api === "string" ? value.model.api : undefined,
    thinkingLevel: typeof value.thinkingLevel === "string" ? value.thinkingLevel : undefined,
  };
}

function compactModelInfo(info: Partial<RoleModelSelection>): Partial<RoleModelSelection> {
  return Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined)) as Partial<RoleModelSelection>;
}

function updateUsageCostKind(report: UsageReport, info: Partial<RoleModelSelection>): void {
  const kind = inferUsageCostKind(info);
  if (kind === "subscription" || !report.costKind) report.costKind = kind;
}

function inferUsageCostKind(info: Partial<RoleModelSelection>): UsageCostKind {
  return isCodexSubscriptionModel(info) ? "subscription" : "actual";
}

function isCodexSubscriptionModel(info: Partial<RoleModelSelection>): boolean {
  return [info.provider, info.api, info.model, info.requestedModel]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase().includes("openai-codex") || value.toLowerCase().startsWith("codex/"));
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function firstNumber(record: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = numberOrUndefined(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberOrZero(value: unknown): number {
  return numberOrUndefined(value) ?? 0;
}
