import type { PiMateriaConfig } from "../types.js";

export function renderLoadoutList(config: PiMateriaConfig, _source: string): string[] {
  const loadoutNames = Object.keys(config.loadouts ?? {});
  const active = config.activeLoadout ?? "-";
  if (loadoutNames.length === 0) {
    return ["No materia loadouts configured."];
  }

  const visible = loadoutNames.slice(0, 4).map((name) => `${name}${name === config.activeLoadout ? "*" : ""}`);
  const suffix = loadoutNames.length > visible.length ? ` +${loadoutNames.length - visible.length}` : "";
  // Keep this command/event output concise: the permanent status widget already owns the active loadout.
  return [`⌘ ${truncateLine(active, 96)} (${truncateLine(visible.join(", ") + suffix, 108)})`];
}

function truncateLine(value: string, max: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, Math.max(0, max - 1))}…` : singleLine;
}
