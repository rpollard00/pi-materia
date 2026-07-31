import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { appendEvent } from "./castArtifacts.js";
import type { MateriaRunState, PiMateriaConfig } from "../types.js";

export async function writeUsage(state: MateriaRunState): Promise<void> {
  await writeFile(state.usageFile, JSON.stringify(state.usage, null, 2));
}

export async function assertBudget(config: PiMateriaConfig, state: MateriaRunState, ctx: ExtensionContext): Promise<void> {
  const budget = config.budget;
  if (!budget) return;

  const percent = budget.maxTokens ? (state.usage.tokens.total / budget.maxTokens) * 100 : 0;
  const warnAt = budget.warnAtPercent ?? 75;

  if (!state.budgetWarned && percent >= warnAt) {
    state.budgetWarned = true;
    ctx.ui.notify(`pi-materia budget warning: ${percent.toFixed(1)}% used`, "warning");
    await appendEvent(state, "budget_warning", { percent, usage: state.usage });
  }

  const overToken = budget.maxTokens !== undefined && state.usage.tokens.total >= budget.maxTokens;
  if (!overToken) return;

  await appendEvent(state, "budget_limit", {
    maxTokens: budget.maxTokens,
    consumedTokens: state.usage.tokens.total,
    usage: state.usage,
  });
  throw new Error("pi-materia budget limit reached");
}
