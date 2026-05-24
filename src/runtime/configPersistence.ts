import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseJson } from "../utilities/json.js";
import { getEffectivePipelineConfig } from "./pipeline.js";
import type { MateriaCastState, PiMateriaConfig } from "../types.js";

export async function loadConfigFromState(state: MateriaCastState): Promise<PiMateriaConfig> {
  return JSON.parse(await readFile(path.join(state.runDir, "config.resolved.json"), "utf8")) as PiMateriaConfig;
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

export function hashConfig(config: PiMateriaConfig): string {
  const value = JSON.stringify(config);
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = Math.imul(31, hash) + value.charCodeAt(i) | 0;
  return (hash >>> 0).toString(16);
}
