import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { appendEvent } from "./castArtifacts.js";
import type { MateriaRunState, PiMateriaConfig } from "../types.js";

export async function writeUsage(state: MateriaRunState): Promise<void> {
  await writeFile(state.usageFile, JSON.stringify(state.usage, null, 2));
}

export async function assertBudget(config: PiMateriaConfig, state: MateriaRunState, ctx: ExtensionContext): Promise<void> {
  const budget = config.budget;
  const maxTokens = budget?.maxTokens;
  if (!budget || maxTokens === undefined) return;

  const consumedTokens = state.usage.tokens.total;
  // A zero-token budget is already exhausted. Treat it as 100% for warning
  // telemetry instead of dividing by zero; positive limits use the normal
  // consumed/max calculation.
  const percent = maxTokens > 0
    ? (consumedTokens / maxTokens) * 100
    : consumedTokens >= maxTokens ? 100 : 0;
  const warnAt = budget.warnAtPercent ?? 75;
  const tokenBudgetData = { maxTokens, consumedTokens, percent, usage: state.usage };

  if (!state.budgetWarned && percent >= warnAt) {
    state.budgetWarned = true;
    ctx.ui.notify(`pi-materia budget warning: ${percent.toFixed(1)}% used`, "warning");
    await appendEvent(state, "budget_warning", tokenBudgetData);
  }

  // Token limits are unconditional: legacy monetary fields and stopAtLimit
  // values, if present in an older in-memory config, have no effect.
  if (consumedTokens < maxTokens) return;

  await appendEvent(state, "budget_limit", tokenBudgetData);
  throw new Error("pi-materia budget limit reached");
}
