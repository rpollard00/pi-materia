import type { PiMateriaConfig } from "../types.js";
import { fuzzyFilter } from "@earendil-works/pi-tui";

export interface LoadoutPickerCandidate {
  /** The completion value — selecting this entry runs the command. */
  value: string;
  /** Short display text with active marker. */
  label: string;
  /** Longer description shown in the completion list. */
  description?: string;
}

export interface LoadoutPickerCandidatesInput {
  config: PiMateriaConfig;
  /** Source scope for each loadout name, keyed by display name. */
  loadoutSources?: Record<string, string>;
}

/**
 * Builds autocomplete-style candidate entries for every configured loadout
 * without truncation. Marks the active loadout with a `*` suffix in the
 * label and includes source/id metadata in the description.
 *
 * Returns all candidates for an empty query. When the user types a query,
 * filters with the same fuzzy matching approach used by pi's model picker
 * (`fuzzyFilter` from `@earendil-works/pi-tui`), searching across the
 * loadout name, id, and source.
 */
export function loadoutPickerCandidates(
  input: LoadoutPickerCandidatesInput,
  query?: string,
): LoadoutPickerCandidate[] {
  const { config, loadoutSources = {} } = input;
  const loadouts = config.loadouts ?? {};
  const activeLoadout = config.activeLoadout;
  const activeLoadoutId = config.activeLoadoutId;

  const candidates: LoadoutPickerCandidate[] = Object.entries(loadouts)
    .filter((entry): entry is [string, NonNullable<PiMateriaConfig["loadouts"]>[string]] => {
      const [, loadout] = entry;
      return loadout !== null && typeof loadout === "object";
    })
    .map(([name, loadout]) => {
      const raw = loadout as unknown as Record<string, unknown>;
      const source = loadoutSources[name] ??
        (typeof raw.source === "string"
          ? raw.source
          : undefined);
      const id = typeof raw.id === "string"
        ? raw.id
        : undefined;
      const isActive =
        name === activeLoadout ||
        (id !== undefined && id === activeLoadoutId);

      const activeMarker = isActive ? " *" : "";
      const idText = id ? `id:${id}` : "";
      const sourceText = source ? `source:${source}` : "";
      const description = [idText, sourceText].filter(Boolean).join(" ");

      return {
        value: name,
        label: `${name}${activeMarker}`,
        ...(description ? { description } : {}),
      };
    });

  if (!query || !query.trim()) {
    return candidates;
  }

  const trimmed = query.trim();
  return fuzzyFilter(candidates, trimmed, (candidate) => {
    const parts = [candidate.value];
    if (candidate.description) parts.push(candidate.description);
    return parts.join(" ");
  });
}
