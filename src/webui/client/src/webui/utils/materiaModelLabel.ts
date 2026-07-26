import type { MateriaBehaviorConfig } from '../../loadoutModel.js';

/**
 * Shared client-side presentation helper for the provider/model label shown on
 * materia chrome (palette cards, socket replacement rows, catalog rows).
 *
 * "Selected model" means a non-empty `model` explicitly configured on the
 * materia definition. The helper never substitutes the active-session model or
 * a model-catalog friendly name — it surfaces the raw configured provider/model
 * value so dense, provider-specific labels stay visible even when the same
 * model is offered by multiple providers. See
 * `docs/enterprise-control-plane.md` and the materia selector surfaces for the
 * "configured value, not friendly name" requirement.
 */

/**
 * Classifies a materia definition as deterministic. Mirrors the rule used by
 * `materiaPaletteSocket` and `resolvePaletteMateriaType`: utility-typed materia,
 * or any definition identified by `utility`/`command`/`script`, is deterministic
 * and carries no model selection.
 */
export function isDeterministicMateria(definition?: MateriaBehaviorConfig): boolean {
  if (!definition) return false;
  if (definition.type === 'utility') return true;
  return definition.utility !== undefined || definition.command !== undefined || definition.script !== undefined;
}

/**
 * Resolve the provider/model label to display for a materia definition, or
 * `undefined` when no label should be shown.
 *
 * Returns the trimmed configured `model` value for non-deterministic (agent)
 * materia with an explicit, non-blank model selection. Returns `undefined` for:
 *   - deterministic materia (utility type, or utility/command/script definitions)
 *   - agent materia with a missing or blank `model`
 *   - missing definitions
 *
 * Coerces non-string `model` values (e.g. malformed config) to no label rather
 * than rendering them, and never falls back to an active model or catalog name.
 */
export function resolveMateriaModelLabel(definition?: MateriaBehaviorConfig): string | undefined {
  if (!definition) return undefined;
  if (isDeterministicMateria(definition)) return undefined;
  const model = typeof definition.model === 'string' ? definition.model.trim() : '';
  return model || undefined;
}
