import type { PiMateriaConfig } from "../types.js";

export function renderLoadoutList(config: PiMateriaConfig, _source: string): string[] {
  const loadoutNames = Object.keys(config.loadouts ?? {});
  const active = config.activeLoadout ?? "-";
  if (loadoutNames.length === 0) {
    return ["No materia loadouts configured."];
  }

  const visible = loadoutNames.map((name) => `${name}${name === config.activeLoadout ? "*" : ""}`);
  return [`⌘ ${truncateLine(active, 96)} (${truncateLine(visible.join(", "), 108)})`];
}

/**
 * Detailed loadout catalog for `/materia loadout` (no-args) command output.
 * Lists every configured loadout on its own line with active marker, id, and source.
 */
export function renderLoadoutCatalog(
  config: PiMateriaConfig,
  source: string,
  loadoutSources?: Record<string, string>,
): string[] {
  const loadouts = config.loadouts ?? {};
  const names = Object.keys(loadouts);
  if (names.length === 0) {
    return ["No materia loadouts configured."];
  }

  const maxNameLen = Math.max(...names.map((n) => n.length));
  const lines = names.map((name) => {
    const loadout = loadouts[name];
    const isActive = name === config.activeLoadout;
    const activeMarker = isActive ? "*" : " ";
    const paddedName = name.padEnd(maxNameLen);
    const raw = loadout as unknown as Record<string, unknown> | undefined;
    const id = typeof raw?.id === "string" ? raw.id : undefined;
    const scope = (loadoutSources?.[name] ?? "") || undefined;
    const meta = [id ? `id:${id}` : "", scope ? `source:${scope}` : ""].filter(Boolean).join("  ");
    return `${paddedName} ${activeMarker}  ${meta}`.trimEnd();
  });

  return [`${names.length} loadout(s) from ${source}`, "", ...lines];
}

function truncateLine(value: string, max: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, Math.max(0, max - 1))}…` : singleLine;
}
