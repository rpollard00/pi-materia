import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  MateriaRunState,
  UsageCostKind,
  UsageReport,
  UsageTotals,
} from "../types.js";
import {
  createMateriaThemedWidgetFactory,
  supportsThemedWidgets,
} from "./themedWidget.js";
import type {
  MateriaSemanticTheme,
  MateriaThemeRole,
} from "./theme.js";
import {
  formatCompactNumber,
  truncateLine,
} from "./materiaStatus.js";

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
