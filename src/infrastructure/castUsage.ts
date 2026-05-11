import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { appendEvent } from "./castArtifacts.js";
import type { MateriaRunState, PiMateriaConfig } from "../types.js";

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
