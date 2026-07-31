import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "../infrastructure/castArtifacts.js";
import { saveCastState } from "../infrastructure/castStateRepository.js";
import { normalizeBudgetConfig } from "../schema/persistence.js";
import { parseJson } from "../utilities/json.js";
import { getEffectivePipelineConfig } from "./pipeline.js";
import type { MateriaCastState, PiMateriaConfig } from "../types.js";

export async function loadConfigFromState(state: MateriaCastState): Promise<PiMateriaConfig> {
  const config = JSON.parse(await readFile(path.join(state.runDir, "config.resolved.json"), "utf8")) as PiMateriaConfig;
  const budget = normalizeBudgetConfig(config.budget);
  return {
    ...config,
    ...(budget !== undefined ? { budget } : {}),
  };
}

export interface PersistedCastLoadoutIdentity {
  loadoutId?: string;
  loadoutName?: string;
}

export async function resolvePersistedCastLoadoutIdentity(state: MateriaCastState): Promise<PersistedCastLoadoutIdentity | undefined> {
  try {
    const config = parseJson<PiMateriaConfig>(await readFile(path.join(state.runDir, "config.resolved.json"), "utf8"));
    const effective = getEffectivePipelineConfig(config);
    return castLoadoutIdentity(config, effective.pipeline, effective.loadoutName);
  } catch {
    return undefined;
  }
}

export async function resolvePersistedCastLoadoutName(state: MateriaCastState): Promise<string | undefined> {
  return (await resolvePersistedCastLoadoutIdentity(state))?.loadoutName;
}

export function castLoadoutIdentity(config: PiMateriaConfig, loadout: { id?: string } | undefined, loadoutName?: string): PersistedCastLoadoutIdentity {
  const loadoutId = nonEmpty(loadout?.id) ?? nonEmpty(config.activeLoadoutId);
  const name = nonEmpty(loadoutName) ?? nonEmpty(config.activeLoadout);
  return {
    ...(loadoutId ? { loadoutId } : {}),
    ...(name ? { loadoutName: name } : {}),
  };
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export interface PersistedCastBudgetUpdate {
  castId: string;
  previousMaxTokens?: number;
  maxTokens: number;
  consumedTokens: number;
}

/**
 * Update only the budget in a cast's resolved configuration snapshot.
 *
 * The snapshot is deliberately read and written as an opaque JSON object so
 * fields unrelated to the cast-local budget survive unchanged. The rename is
 * atomic, and the source configuration layers are never consulted or written.
 */
export async function persistCastBudget(
  pi: ExtensionAPI,
  state: MateriaCastState,
  maxTokens: number,
): Promise<PersistedCastBudgetUpdate> {
  const configPath = path.join(state.runDir, "config.resolved.json");
  const config = parseJson<Record<string, unknown>>(await readFile(configPath, "utf8"));
  if (!isRecord(config)) throw new Error(`Cast config ${configPath} must contain a JSON object.`);

  const previousBudget = isRecord(config.budget) ? config.budget : undefined;
  const previousMaxTokens = typeof previousBudget?.maxTokens === "number" ? previousBudget.maxTokens : undefined;
  const budget: Record<string, unknown> = { ...(previousBudget ?? {}), maxTokens };
  const updatedConfig = { ...config, budget };
  await writeJsonAtomic(configPath, updatedConfig);

  state.configHash = hashConfig(updatedConfig as unknown as PiMateriaConfig);
  const consumedTokens = state.runState.usage.tokens.total;
  const warnAtPercent = typeof budget.warnAtPercent === "number" ? budget.warnAtPercent : 75;
  const percent = maxTokens > 0
    ? (consumedTokens / maxTokens) * 100
    : consumedTokens >= maxTokens ? 100 : 0;
  if (percent < warnAtPercent) state.runState.budgetWarned = false;

  const update: PersistedCastBudgetUpdate = {
    castId: state.castId,
    ...(previousMaxTokens !== undefined ? { previousMaxTokens } : {}),
    maxTokens,
    consumedTokens,
  };
  saveCastState(pi, state);
  await appendEvent(state.runState, "budget_updated", update);
  return update;
}

export function hashConfig(config: PiMateriaConfig): string {
  const value = JSON.stringify(config);
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = Math.imul(31, hash) + value.charCodeAt(i) | 0;
  return (hash >>> 0).toString(16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}
