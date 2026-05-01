import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "./artifacts.js";
import type { MateriaRunState, PiMateriaConfig, RoleModelSelection, UsageReport, UsageTotals } from "./types.js";

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
  const cacheRead = numberOrZero(firstNumber(usage, ["cacheRead", "cacheReadTokens", "cache_read", "cache_read_tokens", "cache_read_input_tokens", "cachedInputTokens", "cached_input_tokens"]));
  const cacheWrite = numberOrZero(firstNumber(usage, ["cacheWrite", "cacheWriteTokens", "cache_write", "cache_write_tokens", "cache_creation_input_tokens", "cacheCreationTokens", "cache_creation_tokens"]));
  const providedTotal = firstNumber(usage, ["totalTokens", "total", "tokens", "total_tokens"]);
  const total = providedTotal ?? input + output + cacheRead + cacheWrite;

  const costValue = usage.cost;
  const cost = costValue && typeof costValue === "object" ? costValue as Record<string, unknown> : undefined;
  const costInput = numberOrZero(firstNumber(cost, ["input", "inputCost", "inputUsd", "prompt", "promptCost", "promptUsd"]) ?? firstNumber(usage, ["inputCost", "inputCostUsd", "inputUsd", "promptCost", "promptCostUsd", "promptUsd"]));
  const costOutput = numberOrZero(firstNumber(cost, ["output", "outputCost", "outputUsd", "completion", "completionCost", "completionUsd"]) ?? firstNumber(usage, ["outputCost", "outputCostUsd", "outputUsd", "completionCost", "completionCostUsd", "completionUsd"]));
  const costCacheRead = numberOrZero(firstNumber(cost, ["cacheRead", "cacheReadCost", "cacheReadUsd", "cachedInput", "cachedInputCost", "cachedInputUsd"]) ?? firstNumber(usage, ["cacheReadCost", "cacheReadCostUsd", "cacheReadUsd", "cachedInputCost", "cachedInputCostUsd", "cachedInputUsd"]));
  const costCacheWrite = numberOrZero(firstNumber(cost, ["cacheWrite", "cacheWriteCost", "cacheWriteUsd", "cacheCreation", "cacheCreationCost", "cacheCreationUsd"]) ?? firstNumber(usage, ["cacheWriteCost", "cacheWriteCostUsd", "cacheWriteUsd", "cacheCreationCost", "cacheCreationCostUsd", "cacheCreationUsd"]));
  const providedCostTotal = firstNumber(cost, ["total", "totalCost", "totalUsd", "costUsd", "usd"])
    ?? numberOrUndefined(costValue)
    ?? firstNumber(usage, ["totalCost", "totalCostUsd", "totalUsd", "costUsd", "usd"]);
  const costTotal = providedCostTotal ?? costInput + costOutput + costCacheRead + costCacheWrite;
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
