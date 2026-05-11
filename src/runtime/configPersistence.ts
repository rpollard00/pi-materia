import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseJson } from "../json.js";
import { getEffectivePipelineConfig } from "../pipeline.js";
import type { MateriaCastState, PiMateriaConfig } from "../types.js";

export async function loadConfigFromState(state: MateriaCastState): Promise<PiMateriaConfig> {
  return JSON.parse(await readFile(path.join(state.runDir, "config.resolved.json"), "utf8")) as PiMateriaConfig;
}

export async function resolvePersistedCastLoadoutName(state: MateriaCastState): Promise<string | undefined> {
  try {
    const config = parseJson<PiMateriaConfig>(await readFile(path.join(state.runDir, "config.resolved.json"), "utf8"));
    return getEffectivePipelineConfig(config).loadoutName;
  } catch {
    return undefined;
  }
}

export function hashConfig(config: PiMateriaConfig): string {
  const value = JSON.stringify(config);
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = Math.imul(31, hash) + value.charCodeAt(i) | 0;
  return (hash >>> 0).toString(16);
}
