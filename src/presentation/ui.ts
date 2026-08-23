import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  usageBySocket,
} from "../runtime/castStateAccessors.js";
import type {
  MateriaRunState,
  UsageCostKind,
  UsageReport,
  UsageTotals,
} from "../types.js";
import {
  createMateriaThemedWidgetFactory,
} from "./themedWidget.js";
import type {
  MateriaSemanticTheme,
  MateriaThemeRole,
} from "./theme.js";
import {
  renderMateriaStatus,
  renderConfiguredLoadoutWidget,
  MATERIA_WIDGET_MAX_LINES,
  formatCompactNumber,
  truncateLine,
  widgetRunState,
  isMateriaCastWidgetState,
  type MateriaWidgetState,
} from "./materiaStatus.js";

type MateriaWidgetController = {
  scope: string;
  ctx: ExtensionContext;
  runId: string;
  identity: string;
  freshness?: number;
  state: MateriaWidgetState;
  lines: string[];
  ticker?: ReturnType<typeof setInterval>;
};
const materiaWidgetControllers = new Map<string, MateriaWidgetController>();
const fallbackWidgetScopes = new WeakMap<ExtensionContext, string>();
let nextFallbackWidgetScope = 1;

export function updateWidget(
  ctx: ExtensionContext,
  state: MateriaWidgetState,
  options: { replaceOwner?: boolean } = {},
): string[] | undefined {
  const runState = widgetRunState(state);
  const scope = getMateriaWidgetScope(ctx);
  const controller = materiaWidgetControllers.get(scope);
  const identity = widgetIdentity(state);
  const freshness = widgetFreshness(state);
  if (controller && controller.runId !== runState.runId && !options.replaceOwner) return controller.lines;
  if (
    controller &&
    controller.runId === runState.runId &&
    controller.identity === identity &&
    isOlderFreshness(freshness, controller.freshness)
  ) return controller.lines;

  const replacedController = !controller || controller.runId !== runState.runId || controller.ctx !== ctx;
  const nextController = acceptMateriaWidgetState(scope, ctx, state, identity, freshness);
  if (replacedController) clearMateriaAuxiliaryWidgets(ctx);
  renderMateriaWidgetController(nextController);

  if (runState.endedAt !== undefined) {
    stopMateriaWidgetControllerTicker(nextController, runState.runId);
    return nextController.lines;
  }

  ensureMateriaWidgetControllerTicker(nextController);
  return nextController.lines;
}

export function clearWidgetTicker(ctx: ExtensionContext): void {
  const controller = materiaWidgetControllers.get(getMateriaWidgetScope(ctx));
  if (!controller) return;
  stopMateriaWidgetControllerTicker(controller);
  materiaWidgetControllers.delete(controller.scope);
}

export function syncConfiguredLoadoutWidget(
  ctx: ExtensionContext,
  loadoutName: string,
): boolean {
  const controller = materiaWidgetControllers.get(getMateriaWidgetScope(ctx));
  if (controller && widgetRunState(controller.state).endedAt === undefined) return false;

  if (controller) {
    controller.state = withWidgetLoadout(controller.state, loadoutName);
    renderMateriaWidgetController(controller);
    return true;
  }

  setMateriaWidgetLines(
    ctx,
    renderConfiguredLoadoutWidget(loadoutName),
    (theme) => renderConfiguredLoadoutWidget(loadoutName, theme),
  );
  return true;
}

function acceptMateriaWidgetState(
  scope: string,
  ctx: ExtensionContext,
  state: MateriaWidgetState,
  identity: string,
  freshness: number | undefined,
): MateriaWidgetController {
  const runId = widgetRunState(state).runId;
  const existing = materiaWidgetControllers.get(scope);
  if (existing) {
    existing.ctx = ctx;
    existing.runId = runId;
    existing.identity = identity;
    existing.freshness = freshness;
    existing.state = state;
    return existing;
  }

  const controller: MateriaWidgetController = {
    scope,
    ctx,
    runId,
    identity,
    freshness,
    state,
    lines: [],
  };
  materiaWidgetControllers.set(scope, controller);
  return controller;
}

function renderMateriaWidgetController(controller: MateriaWidgetController): void {
  controller.lines = renderMateriaStatus(controller.state);
  setMateriaWidgetLines(
    controller.ctx,
    controller.lines,
    (theme, width) => renderMateriaStatus(controller.state, { theme, width }),
  );
}

function setMateriaWidgetLines(
  ctx: ExtensionContext,
  lines: string[] | undefined,
  themedRenderer?: (theme: MateriaSemanticTheme, width: number) => readonly string[],
): void {
  const options = { placement: "belowEditor" as const };
  if (themedRenderer && supportsThemedWidgets(ctx)) {
    ctx.ui.setWidget(
      "materia",
      createMateriaThemedWidgetFactory(themedRenderer, {
        maxLines: MATERIA_WIDGET_MAX_LINES,
      }),
      options,
    );
    return;
  }
  ctx.ui.setWidget("materia", lines, options);
}

function supportsThemedWidgets(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui" && typeof ctx.ui.theme?.fg === "function";
}

function ensureMateriaWidgetControllerTicker(controller: MateriaWidgetController): void {
  if (controller.ticker) return;
  const scope = controller.scope;
  const ticker = setInterval(() => {
    const current = materiaWidgetControllers.get(scope);
    if (!current || current.ticker !== ticker) {
      if (!current) clearInterval(ticker);
      return;
    }
    if (widgetRunState(current.state).endedAt !== undefined) {
      stopMateriaWidgetControllerTicker(current);
      return;
    }
    renderMateriaWidgetController(current);
  }, 5000);
  ticker.unref?.();
  controller.ticker = ticker;
}

function stopMateriaWidgetControllerTicker(controller: MateriaWidgetController, runId?: string): void {
  if (runId !== undefined && controller.runId !== runId) return;
  if (controller.ticker) clearInterval(controller.ticker);
  controller.ticker = undefined;
}

function getMateriaWidgetScope(ctx: ExtensionContext): string {
  const sessionManager = (ctx as ExtensionContext & { sessionManager?: MateriaWidgetSessionManager }).sessionManager;
  const sessionFile = readMateriaWidgetSessionValue(() => sessionManager?.getSessionFile?.());
  if (sessionFile) return `materia:session-file:${path.normalize(sessionFile)}`;

  const sessionId = readMateriaWidgetSessionValue(() => sessionManager?.getSessionId?.());
  if (sessionId) return `materia:session-id:${sessionId}`;

  let fallback = fallbackWidgetScopes.get(ctx);
  if (!fallback) {
    fallback = `materia:context:${nextFallbackWidgetScope++}`;
    fallbackWidgetScopes.set(ctx, fallback);
  }
  return fallback;
}

type MateriaWidgetSessionManager = {
  getSessionFile?: () => string | undefined;
  getSessionId?: () => string | undefined;
};

function readMateriaWidgetSessionValue(read: () => unknown): string | undefined {
  try {
    const value = read();
    return typeof value === "string" && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

function widgetIdentity(state: MateriaWidgetState): string {
  if (isMateriaCastWidgetState(state)) return `cast:${state.castId ?? state.runState.runId}`;
  return `run:${state.runId}`;
}

function widgetFreshness(state: MateriaWidgetState): number | undefined {
  if (isMateriaCastWidgetState(state)) return toTimestamp(state.updatedAt) ?? runWidgetFreshness(state.runState);
  return runWidgetFreshness(state);
}

function runWidgetFreshness(state: MateriaRunState): number | undefined {
  return toTimestamp(state.endedAt) ?? toTimestamp((state as MateriaRunState & { updatedAt?: unknown }).updatedAt) ?? toTimestamp(state.startedAt);
}

function toTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" || value instanceof Date) {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  return undefined;
}

function isOlderFreshness(incoming: number | undefined, current: number | undefined): boolean {
  if (current === undefined) return false;
  if (incoming === undefined) return true;
  return incoming < current;
}

function withWidgetLoadout(
  state: MateriaWidgetState,
  loadoutName: string,
): MateriaWidgetState {
  if (!isMateriaCastWidgetState(state)) return { ...state, loadoutName };
  return { ...state, runState: { ...state.runState, loadoutName } };
}

export function updateMateriaWebUiStatusWidget(
  ctx: ExtensionContext,
  input: { url: string; status: "started" | "reused" },
): void {
  const options = { placement: "belowEditor" as const };
  const lines = renderMateriaWebUiStatusWidget(input);
  if (supportsThemedWidgets(ctx)) {
    ctx.ui.setWidget(
      "materia-webui",
      createMateriaThemedWidgetFactory(
        (theme) => renderMateriaWebUiStatusWidgetThemed(input, theme),
        { maxLines: 1 },
      ),
      options,
    );
    return;
  }
  ctx.ui.setWidget("materia-webui", lines, options);
}

export function renderMateriaWebUiStatusWidget(input: {
  url: string;
  status: "started" | "reused";
}): string[] {
  const state = input.status === "reused" ? "ready (reused)" : "started";
  return [`WebUI ${state}: ${truncateLine(input.url)}`];
}

export function renderMateriaWebUiStatusWidgetThemed(
  input: {
    url: string;
    status: "started" | "reused";
  },
  theme: MateriaSemanticTheme,
): string[] {
  const state = input.status === "reused" ? "ready (reused)" : "started";
  const stateRole: MateriaThemeRole = input.status === "reused" ? "success" : "accent";
  return [
    `${theme.fg("accent", "WebUI")} ${theme.fg(stateRole, state)}${theme.fg("dim", ":")} ${theme.fg("muted", truncateLine(input.url))}`,
  ];
}

export function clearMateriaAuxiliaryWidgets(ctx: ExtensionContext): void {
  for (const key of [
    "materia-loadouts",
    "materia-status",
    "materia-casts",
    "materia-usage",
    "materia-grid",
  ] as const) {
    ctx.ui.setWidget(key, undefined, { placement: "belowEditor" });
  }
}

export function showUsageSummary(
  ctx: ExtensionContext,
  state: MateriaRunState,
): void {
  const options = { placement: "belowEditor" as const };
  const lines = renderCompactUsageWidget(state.usage);
  if (supportsThemedWidgets(ctx)) {
    ctx.ui.setWidget(
      "materia-usage",
      createMateriaThemedWidgetFactory(
        (theme) => renderCompactUsageWidgetThemed(state.usage, theme),
        { maxLines: 1 },
      ),
      options,
    );
    return;
  }
  ctx.ui.setWidget("materia-usage", lines, options);
}

export function renderCompactUsageWidget(usage: UsageReport): string[] {
  return [`Usage total ${formatCompactNumber(usage.tokens.total)} tokens`];
}

/** Render compact usage with the active Pi theme while preserving its wording. */
export function renderCompactUsageWidgetThemed(
  usage: UsageReport,
  theme: MateriaSemanticTheme,
): string[] {
  return [
    [
      theme.fg("muted", "Usage total"),
      theme.fg("accent", formatCompactNumber(usage.tokens.total)),
      theme.fg("dim", "tokens"),
    ].join(" "),
  ];
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
    "By socket:",
    ...renderBreakdown(usageBySocket(usage), usage.costKind),
    "",
    "By task:",
    ...renderBreakdown(usage.byTask, usage.costKind),
  ];
}

function renderBreakdown(
  values: Record<string, UsageTotals>,
  costKind: UsageCostKind = "actual",
): string[] {
  const entries = Object.entries(values);
  if (entries.length === 0) return ["- none observed"];
  return entries
    .sort(([, a], [, b]) => b.tokens.total - a.tokens.total)
    .map(([key, usage]) => `- ${key}: ${formatUsage(usage, costKind)}`);
}

export function formatUsage(
  usage: UsageTotals,
  costKind: UsageCostKind = "actual",
): string {
  if (costKind === "subscription" && usage.cost.total === 0) {
    return `${usage.tokens.total} tokens, no per-token billing (subscription)`;
  }
  return `${usage.tokens.total} tokens, ${formatCostLabel(usage.cost.total, costKind)}`;
}

export function formatCostLabel(
  costUsd: number,
  costKind: UsageCostKind = "actual",
): string {
  if (costKind === "subscription")
    return `estimated token value: $${costUsd.toFixed(4)} (subscription; no per-token billing implied)`;
  if (costKind === "estimated")
    return `estimated USD value: $${costUsd.toFixed(4)}`;
  return `billed cost: $${costUsd.toFixed(4)}`;
}

export function usageCostNote(costKind: UsageCostKind = "actual"): string {
  if (costKind === "subscription")
    return "Cost display: estimated token value only; subscription usage is not billed per token.";
  if (costKind === "estimated")
    return "Cost display: estimated USD value, not confirmed billed charges.";
  return "Cost display: billed USD cost.";
}
