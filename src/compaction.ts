import type { MateriaCompactionConfig, MateriaCompactionThresholdTierConfig } from "./types.js";

const SMALL_CONTEXT_WINDOW_LIMIT = 128_000;
const LARGE_CONTEXT_WINDOW_LIMIT = 200_000;
const FALLBACK_PROACTIVE_COMPACTION_THRESHOLD_PERCENT = 55;

export interface ResolvedProactiveCompactionThreshold {
  thresholdPercent: number;
  mode: "default_tiered" | "configured_tiered" | "single_percent";
  tier?: { id?: string; minContextWindow: number; maxContextWindow?: number };
}

export function defaultProactiveCompactionThresholdPercent(contextWindow: number | null | undefined): number {
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
  // If model/context-window metadata is unavailable, fall back to the most
  // conservative default tier so Materia compacts early rather than risking a
  // provider-side context_length_exceeded failure.
  if (!Number.isFinite(contextWindow) || contextWindow == null || contextWindow <= 0) {
    return { thresholdPercent: FALLBACK_PROACTIVE_COMPACTION_THRESHOLD_PERCENT, mode: "default_tiered" };
  }
  if (contextWindow < SMALL_CONTEXT_WINDOW_LIMIT) return { thresholdPercent: 75, mode: "default_tiered", tier: { id: "lt-128k", minContextWindow: 0, maxContextWindow: SMALL_CONTEXT_WINDOW_LIMIT } };
  if (contextWindow < LARGE_CONTEXT_WINDOW_LIMIT) return { thresholdPercent: 65, mode: "default_tiered", tier: { id: "128k-to-199999", minContextWindow: SMALL_CONTEXT_WINDOW_LIMIT, maxContextWindow: LARGE_CONTEXT_WINDOW_LIMIT } };
  return { thresholdPercent: 55, mode: "default_tiered", tier: { id: "gte-200k", minContextWindow: LARGE_CONTEXT_WINDOW_LIMIT } };
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
