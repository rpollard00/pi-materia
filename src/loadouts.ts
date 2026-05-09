import type { PiMateriaConfig } from "./types.js";

export function renderLoadoutList(config: PiMateriaConfig, _source: string): string[] {
  const loadoutNames = Object.keys(config.loadouts ?? {});
  const active = config.activeLoadout ?? "-";
  if (loadoutNames.length === 0) {
    return ["Loadouts: none configured", "Active: -"];
  }

  const visible = loadoutNames.slice(0, 4).map((name) => `${name}${name === config.activeLoadout ? "*" : ""}`);
  const suffix = loadoutNames.length > visible.length ? ` +${loadoutNames.length - visible.length}` : "";
  return [
    `Loadout: ${truncateLine(active, 96)}`,
    `Available: ${truncateLine(visible.join(", ") + suffix, 108)}`,
  ];
}

function truncateLine(value: string, max: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, Math.max(0, max - 1))}…` : singleLine;
}
