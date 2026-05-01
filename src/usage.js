import { writeFile } from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "./artifacts.js";
export function createRunState(runId, runDir, model) {
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
        },
        budgetWarned: false,
    };
}
export async function writeUsage(state) {
    await writeFile(state.usageFile, JSON.stringify(state.usage, null, 2));
}
export async function assertBudget(config, state, ctx) {
    const budget = config.budget;
    if (!budget)
        return;
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
    if (!overToken && !overCost)
        return;
    await appendEvent(state, "budget_limit", { overToken, overCost, usage: state.usage });
    if (budget.stopAtLimit !== false)
        throw new Error("pi-materia budget limit reached");
    if (ctx.hasUI) {
        ctx.ui.notify("pi-materia budget limit reached.", "error");
    }
}
export function extractUsage(message) {
    const usage = message?.usage;
    if (!usage)
        return undefined;
    const input = numberOrZero(usage.input);
    const output = numberOrZero(usage.output);
    const cacheRead = numberOrZero(usage.cacheRead);
    const cacheWrite = numberOrZero(usage.cacheWrite);
    const total = numberOrZero(usage.totalTokens) || input + output + cacheRead + cacheWrite;
    const costInput = numberOrZero(usage.cost?.input);
    const costOutput = numberOrZero(usage.cost?.output);
    const costCacheRead = numberOrZero(usage.cost?.cacheRead);
    const costCacheWrite = numberOrZero(usage.cost?.cacheWrite);
    const costTotal = numberOrZero(usage.cost?.total) || costInput + costOutput + costCacheRead + costCacheWrite;
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
export function addUsage(report, usage, key) {
    addUsageTotals(report, usage);
    addUsageTotals(report.byNode[key.node] ??= emptyUsageTotals(), usage);
    addUsageTotals(report.byRole[key.role] ??= emptyUsageTotals(), usage);
    if (key.taskId)
        addUsageTotals(report.byTask[key.taskId] ??= emptyUsageTotals(), usage);
    if (key.taskId && key.attempt !== undefined)
        addUsageTotals(report.byAttempt[`${key.taskId}:${key.attempt}`] ??= emptyUsageTotals(), usage);
}
function emptyUsageTotals() {
    return {
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}
function addUsageTotals(target, usage) {
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
function getModelInfo(model) {
    const value = model;
    return {
        model: typeof value.id === "string" ? value.id : typeof value.model?.id === "string" ? value.model.id : undefined,
        provider: typeof value.provider === "string" ? value.provider : typeof value.model?.provider === "string" ? value.model.provider : undefined,
        api: typeof value.api === "string" ? value.api : typeof value.model?.api === "string" ? value.model.api : undefined,
        thinkingLevel: typeof value.thinkingLevel === "string" ? value.thinkingLevel : undefined,
    };
}
function numberOrZero(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
