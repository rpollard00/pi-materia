import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MateriaCastState, MateriaRunState, UsageCostKind, UsageReport, UsageTotals } from "./types.js";

const WIDGET_MAX_LINE_LENGTH = 78;
const widgetTickerState = new WeakMap<ExtensionContext, MateriaRunState>();
const widgetTickers = new WeakMap<ExtensionContext, ReturnType<typeof setInterval>>();

export function updateWidget(ctx: ExtensionContext, state: MateriaRunState): void {
  widgetTickerState.set(ctx, state);
  clearMateriaAuxiliaryWidgets(ctx);
  ctx.ui.setWidget("materia", renderMateriaRunWidget(state), { placement: "belowEditor" });
  if (!widgetTickers.has(ctx)) {
    const ticker = setInterval(() => {
      const latest = widgetTickerState.get(ctx);
      if (latest) ctx.ui.setWidget("materia", renderMateriaRunWidget(latest), { placement: "belowEditor" });
    }, 5000);
    ticker.unref?.();
    widgetTickers.set(ctx, ticker);
  }
}

export function clearWidgetTicker(ctx: ExtensionContext): void {
  const ticker = widgetTickers.get(ctx);
  if (ticker) clearInterval(ticker);
  widgetTickers.delete(ctx);
  widgetTickerState.delete(ctx);
}

export function renderMateriaRunWidget(state: MateriaRunState, now = Date.now()): string[] {
  const materia = displayMateriaName(state);
  const attempt = state.attempt ?? "-";
  const task = displayMateriaStatusValue(state, state.currentTask ?? "-");
  const usage = state.usage.tokens;
  const lines = [
    `✦ ${shortCastId(state.runId)} | ◉ ${truncateValue(materia, 24)} | ↻ ${attempt}`,
    `◆ ${truncateValue(task, 24)} | ◷ ${formatElapsed(now - state.startedAt)} | Σ ${formatCompactNumber(usage.input + usage.cacheRead)}/${formatCompactNumber(usage.output + usage.cacheWrite)}`,
    `› ${truncateValue(displayMateriaStatusValue(state, state.lastMessage ?? "-"), 68)}`,
  ];
  return lines.map((line) => truncateLine(line));
}

export function renderMateriaCastStatusWidget(state: MateriaCastState, now = Date.now()): string[] {
  const runLines = renderMateriaRunWidget(state.runState, now);
  const displayState = { ...state.runState, currentNode: state.currentNode ?? state.runState.currentNode, currentMateria: state.currentMateria ?? state.runState.currentMateria };
  const nodeState = state.nodeState ?? (state.awaitingResponse ? "awaiting_agent_response" : state.active ? "idle" : state.phase);
  const status = state.failedReason ? `failed: ${state.failedReason}` : nodeState === "awaiting_user_refinement" ? "waiting for refinement; /materia continue to finalize" : `${displayState.currentMateria ?? state.phase}${state.active ? " active" : ""}`;
  return [...runLines.slice(0, 2), `› ${truncateValue(displayMateriaStatusValue(displayState, status), 68)}`].map((line) => truncateLine(line));
}

export function clearMateriaAuxiliaryWidgets(ctx: ExtensionContext): void {
  for (const key of ["materia-webui", "materia-loadouts", "materia-status", "materia-casts", "materia-usage", "materia-grid"] as const) {
    ctx.ui.setWidget(key, undefined, { placement: "belowEditor" });
  }
}

export function showUsageSummary(ctx: ExtensionContext, state: MateriaRunState): void {
  ctx.ui.setWidget("materia-usage", renderCompactUsageWidget(state.usage), { placement: "belowEditor" });
}

export function renderCompactUsageWidget(usage: UsageReport): string[] {
  return [`Usage total ${formatCompactNumber(usage.tokens.total)} tokens`];
}

export function renderUsageSummary(usage: UsageReport): string[] {
  return [
    "Materia Usage Summary",
    usageCostNote(usage.costKind),
    `total: ${formatUsage(usage, usage.costKind)}`,
    "",
    "By materia:",
    ...renderBreakdown(usage.byMateria, usage.costKind),
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

function displayMateriaName(state: MateriaRunState): string {
  return state.currentMateria ?? state.currentNode ?? "-";
}

function displayMateriaStatusValue(state: MateriaRunState, value: string): string {
  const node = state.currentNode;
  const materia = state.currentMateria;
  if (!node || !materia || node === materia) return value;
  const normalized = value.trim();
  if (normalized === node) return materia;
  const escapedNode = escapeRegExp(node);
  return value
    .replace(new RegExp(`node\\s+"${escapedNode}"`, "g"), materia)
    .replace(new RegExp(`node\\s+${escapedNode}`, "g"), materia)
    .replace(new RegExp(`\\b${escapedNode}\\b`, "g"), materia);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shortCastId(runId: string): string {
  return truncateValue(runId.replace(/T(\d{2})-(\d{2})-(\d{2})-/, " $1:$2:$3."), 30);
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
  return `${seconds}s`;
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${trimFixed(value / 1_000_000)}m`;
  if (value >= 1_000) return `${trimFixed(value / 1_000)}k`;
  return String(value);
}

function trimFixed(value: number): string {
  return value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, "");
}

function truncateLine(line: string): string {
  return truncateValue(line, WIDGET_MAX_LINE_LENGTH);
}

function truncateValue(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  if (maxLength <= 1) return "…".slice(0, maxLength);
  return `${normalized.slice(0, maxLength - 1)}…`;
}
