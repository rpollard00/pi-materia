import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MateriaRunState, UsageCostKind, UsageReport, UsageTotals } from "./types.js";

export function updateWidget(ctx: ExtensionContext, state: MateriaRunState): void {
  const elapsed = Math.max(0, Math.round((Date.now() - state.startedAt) / 1000));
  ctx.ui.setWidget("materia", [
    `Materia Cast ${state.runId}`,
    `node: ${state.currentNode ?? "-"}`,
    `role: ${state.currentRole ?? "-"}`,
    `task: ${state.currentTask ?? "-"}`,
    `attempt: ${state.attempt ?? "-"}`,
    `elapsed: ${elapsed}s`,
    `tokens: ${state.usage.tokens.total}`,
    formatCostLine(state.usage, state.usage.costKind),
    `last: ${state.lastMessage ?? "-"}`,
  ], { placement: "belowEditor" });
}

export function showUsageSummary(ctx: ExtensionContext, state: MateriaRunState): void {
  ctx.ui.setWidget("materia-usage", renderUsageSummary(state.usage), { placement: "belowEditor" });
}

export function renderUsageSummary(usage: UsageReport): string[] {
  return [
    "Materia Usage Summary",
    usageCostNote(usage.costKind),
    `total: ${formatUsage(usage, usage.costKind)}`,
    "",
    "By role:",
    ...renderBreakdown(usage.byRole, usage.costKind),
    "",
    "By node:",
    ...renderBreakdown(usage.byNode, usage.costKind),
    "",
    "By task:",
    ...renderBreakdown(usage.byTask, usage.costKind),
  ];
}

function renderBreakdown(values: Record<string, UsageTotals>, costKind: UsageCostKind = "actual"): string[] {
  const entries = Object.entries(values);
  if (entries.length === 0) return ["- none observed"];
  return entries
    .sort(([, a], [, b]) => b.tokens.total - a.tokens.total)
    .map(([key, usage]) => `- ${key}: ${formatUsage(usage, costKind)}`);
}

export function formatUsage(usage: UsageTotals, costKind: UsageCostKind = "actual"): string {
  if (costKind === "subscription" && usage.cost.total === 0) {
    return `${usage.tokens.total} tokens, no per-token billing (subscription)`;
  }
  return `${usage.tokens.total} tokens, ${formatCostLabel(usage.cost.total, costKind)}`;
}

export function formatCostLabel(costUsd: number, costKind: UsageCostKind = "actual"): string {
  if (costKind === "subscription") return `estimated token value: $${costUsd.toFixed(4)} (subscription; no per-token billing implied)`;
  if (costKind === "estimated") return `estimated USD value: $${costUsd.toFixed(4)}`;
  return `billed cost: $${costUsd.toFixed(4)}`;
}

export function usageCostNote(costKind: UsageCostKind = "actual"): string {
  if (costKind === "subscription") return "Cost display: estimated token value only; subscription usage is not billed per token.";
  if (costKind === "estimated") return "Cost display: estimated USD value, not confirmed billed charges.";
  return "Cost display: billed USD cost.";
}

function formatCostLine(usage: UsageTotals, costKind: UsageCostKind = "actual"): string {
  return costKind === "actual" ? `cost: $${usage.cost.total.toFixed(4)}` : formatCostLabel(usage.cost.total, costKind);
}
