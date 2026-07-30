import type { MateriaCompactionConfig, MateriaCompactionThresholdTierConfig } from "../types.js";

/**
 * Pi's default usable-context budget: contextWindow minus this reserve.
 * The reserve (16,384 tokens) is Pi's internal overhead for system prompts,
 * tool schemas, hidden prompts, and metadata injected into every request.
 */
const PI_RESERVE_TOKENS = 16_384;

export interface ResolvedProactiveCompactionThreshold {
  /** Diagnostics-only percentage, derived from usableBudget / contextWindow.
   *  `undefined` when context-window metadata is unavailable and no explicit
   *  threshold was configured. */
  thresholdPercent: number | undefined;
  mode: "reserve_budget" | "configured_tiered" | "single_percent";
  /** Usable token budget = contextWindow - PI_RESERVE_TOKENS, populated in
   *  reserve_budget mode when context-window metadata is available. */
  usableBudget?: number;
  /** Fixed reserve (16,384 tokens) subtracted from the context window,
   *  populated in reserve_budget mode. */
  reserve?: number;
  tier?: { id?: string; minContextWindow: number; maxContextWindow?: number };
}

export function defaultProactiveCompactionThresholdPercent(contextWindow: number | null | undefined): number | undefined {
  return resolveDefaultProactiveCompactionThreshold(contextWindow).thresholdPercent;
}

export function resolveProactiveCompactionThreshold(config: MateriaCompactionConfig | undefined, contextWindow: number | null | undefined): ResolvedProactiveCompactionThreshold {
  if (config?.proactiveThresholdPercent !== undefined) {
    validateThresholdPercent(config.proactiveThresholdPercent, "compaction.proactiveThresholdPercent");
    return { thresholdPercent: config.proactiveThresholdPercent, mode: "single_percent" };
  }
  if (config?.proactiveThresholdTiers !== undefined) {
    validateCompactionConfig(config);
    const tier = findMatchingTier(config.proactiveThresholdTiers, contextWindow);
    if (tier) {
      return {
        thresholdPercent: tier.thresholdPercent,
        mode: "configured_tiered",
        tier: normalizeTierForTelemetry(tier),
      };
    }
  }
  return resolveDefaultProactiveCompactionThreshold(contextWindow);
}

export function validateCompactionConfig(config: MateriaCompactionConfig | undefined): void {
  if (!config) return;
  if (config.proactiveThresholdPercent !== undefined) validateThresholdPercent(config.proactiveThresholdPercent, "compaction.proactiveThresholdPercent");
  if (config.proactiveThresholdTiers === undefined) return;
  if (!Array.isArray(config.proactiveThresholdTiers) || config.proactiveThresholdTiers.length === 0) {
    throw new Error("Materia compaction.proactiveThresholdTiers must be a non-empty array when configured.");
  }

  let expectedMin = 0;
  config.proactiveThresholdTiers.forEach((tier, index) => {
    const label = `compaction.proactiveThresholdTiers[${index}]`;
    if (!tier || typeof tier !== "object" || Array.isArray(tier)) throw new Error(`Materia ${label} must be an object.`);
    validateThresholdPercent(tier.thresholdPercent, `${label}.thresholdPercent`);
    const min = tier.minContextWindow ?? 0;
    if (!Number.isInteger(min) || min < 0) throw new Error(`Materia ${label}.minContextWindow must be a non-negative integer when configured.`);
    if (tier.maxContextWindow !== undefined && (!Number.isInteger(tier.maxContextWindow) || tier.maxContextWindow <= min)) {
      throw new Error(`Materia ${label}.maxContextWindow must be an integer greater than minContextWindow when configured.`);
    }
    if (min !== expectedMin) {
      throw new Error(`Materia compaction.proactiveThresholdTiers must cover context windows without gaps or overlaps; expected ${label}.minContextWindow to be ${expectedMin}.`);
    }
    if (tier.maxContextWindow === undefined) {
      if (index !== config.proactiveThresholdTiers!.length - 1) throw new Error(`Materia ${label}.maxContextWindow may be omitted only on the final tier.`);
      expectedMin = Number.POSITIVE_INFINITY;
    } else {
      expectedMin = tier.maxContextWindow;
    }
  });

  if (expectedMin !== Number.POSITIVE_INFINITY) {
    throw new Error("Materia compaction.proactiveThresholdTiers must include a final open-ended tier with no maxContextWindow.");
  }
}

function resolveDefaultProactiveCompactionThreshold(contextWindow: number | null | undefined): ResolvedProactiveCompactionThreshold {
  // If model/context-window metadata is unavailable, leave the proactive
  // default unresolved. The caller (compactionWorkflow) will skip proactive
  // compaction when no budget can be established, preventing premature
  // compaction at an arbitrary fallback percentage.
  if (!Number.isFinite(contextWindow) || contextWindow == null || contextWindow <= 0) {
    return { thresholdPercent: undefined, mode: "reserve_budget" };
  }
  const usableBudget = contextWindow - PI_RESERVE_TOKENS;
  const diagPercent = (usableBudget / contextWindow) * 100;
  return {
    thresholdPercent: diagPercent,
    mode: "reserve_budget",
    usableBudget,
    reserve: PI_RESERVE_TOKENS,
  };
}

function findMatchingTier(tiers: MateriaCompactionThresholdTierConfig[], contextWindow: number | null | undefined): MateriaCompactionThresholdTierConfig | undefined {
  if (!Number.isFinite(contextWindow) || contextWindow == null || contextWindow < 0) return undefined;
  return tiers.find((tier) => contextWindow >= (tier.minContextWindow ?? 0) && (tier.maxContextWindow === undefined || contextWindow < tier.maxContextWindow));
}

function normalizeTierForTelemetry(tier: MateriaCompactionThresholdTierConfig): { id?: string; minContextWindow: number; maxContextWindow?: number } {
  return { id: tier.id, minContextWindow: tier.minContextWindow ?? 0, maxContextWindow: tier.maxContextWindow };
}

function validateThresholdPercent(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) throw new Error(`Materia ${path} must be a number between 0 and 100.`);
}
