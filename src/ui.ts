import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { MateriaRunState, UsageReport, UsageTotals } from "./types.js";

export function updateWidget(ctx: ExtensionCommandContext, state: MateriaRunState): void {
  const elapsed = Math.max(0, Math.round((Date.now() - state.startedAt) / 1000));
  ctx.ui.setWidget("materia", [
    `Materia Cast ${state.runId}`,
    `node: ${state.currentNode ?? "-"}`,
    `role: ${state.currentRole ?? "-"}`,
    `task: ${state.currentTask ?? "-"}`,
    `attempt: ${state.attempt ?? "-"}`,
    `elapsed: ${elapsed}s`,
    `tokens: ${state.usage.tokens.total}`,
    `cost: $${state.usage.cost.total.toFixed(4)}`,
    `last: ${state.lastMessage ?? "-"}`,
  ], { placement: "belowEditor" });
}

export function showUsageSummary(ctx: ExtensionCommandContext, state: MateriaRunState): void {
  ctx.ui.setWidget("materia-usage", renderUsageSummary(state.usage), { placement: "belowEditor" });
}

function renderUsageSummary(usage: UsageReport): string[] {
  return [
    "Materia Usage Summary",
    `total: ${formatUsage(usage)}`,
    "",
    "By role:",
    ...renderBreakdown(usage.byRole),
    "",
    "By node:",
    ...renderBreakdown(usage.byNode),
    "",
    "By task:",
    ...renderBreakdown(usage.byTask),
  ];
}

function renderBreakdown(values: Record<string, UsageTotals>): string[] {
  const entries = Object.entries(values);
  if (entries.length === 0) return ["- none observed"];
  return entries
    .sort(([, a], [, b]) => b.tokens.total - a.tokens.total)
    .map(([key, usage]) => `- ${key}: ${formatUsage(usage)}`);
}

function formatUsage(usage: UsageTotals): string {
  return `${usage.tokens.total} tokens, $${usage.cost.total.toFixed(4)}`;
}
