import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderLoadoutList } from "../loadout/loadouts.js";
import type { PiMateriaConfig } from "../types.js";
import { createMateriaThemedWidgetFactory } from "./themedWidget.js";
import type { MateriaSemanticTheme } from "./theme.js";

/**
 * Publish the compact loadout list through the late-bound themed widget path.
 * The string renderer remains the source of truth for transcript and fallback
 * output, while TUI renders apply semantic roles from the active Pi theme.
 */
export function updateMateriaLoadoutWidget(
  ctx: ExtensionContext,
  config: PiMateriaConfig,
  source = "",
): void {
  const lines = renderLoadoutList(config, source);
  const options = { placement: "belowEditor" as const };
  if (supportsThemedWidgets(ctx)) {
    ctx.ui.setWidget(
      "materia-loadouts",
      createMateriaThemedWidgetFactory(
        (theme) => renderLoadoutListThemed(config, theme),
        { maxLines: 1 },
      ),
      options,
    );
    return;
  }
  ctx.ui.setWidget("materia-loadouts", lines, options);
}

/** Render the compact loadout list with semantic roles and no hardcoded colors. */
export function renderLoadoutListThemed(
  config: PiMateriaConfig,
  theme: MateriaSemanticTheme,
): string[] {
  const loadoutNames = Object.keys(config.loadouts ?? {});
  if (loadoutNames.length === 0) {
    return [theme.fg("muted", "No materia loadouts configured.")];
  }

  const active = config.activeLoadout ?? "-";
  const visibleNames = loadoutNames.map((name) => ({
    name: `${name}${name === config.activeLoadout ? "*" : ""}`,
    active: name === config.activeLoadout,
  }));
  const activeText = truncateValue(active, 96);
  const catalogText = truncateValue(visibleNames.map(({ name }) => name).join(", "), 108);
  const catalogWithSeparators = styleLoadoutCatalogText(catalogText, visibleNames, theme);

  return [
    `${theme.fg("accent", "⌘")} ${theme.fg("accent", activeText)} ${theme.fg("muted", "(")}${catalogWithSeparators}${theme.fg("muted", ")")}`,
  ];
}

function supportsThemedWidgets(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui" && typeof ctx.ui.theme?.fg === "function";
}

function styleLoadoutCatalogText(
  catalogText: string,
  visibleNames: Array<{ name: string; active: boolean }>,
  theme: MateriaSemanticTheme,
): string {
  const styled: string[] = [];
  let cursor = 0;
  for (let index = 0; index < visibleNames.length && cursor < catalogText.length; index += 1) {
    const item = visibleNames[index]!;
    const visibleName = catalogText.slice(cursor, Math.min(cursor + item.name.length, catalogText.length));
    if (visibleName.length === 0) break;
    if (item.active) {
      const marker = visibleName.endsWith("*") ? "*" : "";
      const name = marker ? visibleName.slice(0, -1) : visibleName;
      styled.push(theme.fg("success", name));
      if (marker) styled.push(theme.fg("success", marker));
    } else {
      styled.push(theme.fg("muted", visibleName));
    }
    cursor += visibleName.length;
    if (cursor >= catalogText.length) break;
    const separator = catalogText.slice(cursor, cursor + 2);
    if (separator === ", ") {
      styled.push(theme.fg("muted", separator));
      cursor += separator.length;
    }
  }
  if (cursor < catalogText.length) styled.push(theme.fg("muted", catalogText.slice(cursor)));
  return styled.join("");
}

function truncateValue(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  if (maxLength <= 1) return "…".slice(0, maxLength);
  return `${normalized.slice(0, maxLength - 1)}…`;
}
