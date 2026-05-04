import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LoadedConfig, MateriaRoleConfig, PiMateriaConfig } from "./types.js";

export async function loadConfig(cwd: string, configuredPath?: string): Promise<LoadedConfig> {
  const explicitPath = configuredPath ? resolveFromCwd(cwd, configuredPath) : undefined;
  if (explicitPath) return loadConfigFile(explicitPath);

  const projectPath = getProjectConfigPath(cwd);
  if (existsSync(projectPath)) return loadConfigFile(projectPath);

  return loadConfigFile(getBundledDefaultConfigPath(), "<pi-materia bundled default loadout>");
}

export async function saveActiveLoadout(cwd: string, loadoutName: string, configuredPath?: string): Promise<string> {
  const loaded = await loadConfig(cwd, configuredPath);
  const loadoutNames = Object.keys(loaded.config.loadouts ?? {});
  if (loadoutNames.length === 0) {
    throw new Error(`Cannot change Materia loadout because this config does not define any loadouts.`);
  }
  if (!loaded.config.loadouts?.[loadoutName]) {
    throw new Error(`Unknown Materia loadout "${loadoutName}". Available loadouts: ${loadoutNames.join(", ")}.`);
  }

  const targetPath = getWritableConfigPath(cwd, configuredPath);
  await writeMinimalActiveLoadout(targetPath, loadoutName);
  return targetPath;
}

async function loadConfigFile(file: string, source = file): Promise<LoadedConfig> {
  if (!existsSync(file)) throw new Error(`pi-materia config file not found: ${file}`);
  const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<PiMateriaConfig>;
  return {
    config: await mergeConfig(parsed),
    source,
  };
}

function getBundledDefaultConfigPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "..", "config", "default.json");
}

function getProjectConfigPath(cwd: string): string {
  return path.join(cwd, ".pi", "pi-materia.json");
}

function getWritableConfigPath(cwd: string, configuredPath?: string): string {
  return configuredPath ? resolveFromCwd(cwd, configuredPath) : getProjectConfigPath(cwd);
}

async function writeMinimalActiveLoadout(file: string, loadoutName: string): Promise<void> {
  let parsed: Partial<PiMateriaConfig> = {};
  if (existsSync(file)) {
    const text = await readFile(file, "utf8");
    parsed = JSON.parse(text) as Partial<PiMateriaConfig>;
    if (!isPlainObject(parsed)) throw new Error(`Materia config file ${file} is invalid. Expected a JSON object.`);
  }

  const next = { ...parsed, activeLoadout: loadoutName };
  const dir = path.dirname(file);
  const temp = path.join(dir, `.pi-materia.${process.pid}.${Date.now()}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(temp, file);
  } catch (error) {
    throw new Error(`Failed to persist active Materia loadout to ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function mergeConfig(parsed: Partial<PiMateriaConfig>): Promise<PiMateriaConfig> {
  const base = await loadDefaultConfig();
  const usesLegacyPipeline = Boolean(parsed.pipeline && !parsed.loadouts);
  const config = {
    ...base,
    ...parsed,
    budget: { ...base.budget, ...(parsed.budget ?? {}) },
    pipeline: mergePipeline(base.pipeline, parsed.pipeline),
    loadouts: usesLegacyPipeline ? undefined : mergeLoadouts(base.loadouts, parsed.loadouts),
    activeLoadout: usesLegacyPipeline ? undefined : (parsed.activeLoadout ?? base.activeLoadout),
    roles: mergeRoles(base.roles, parsed.roles),
  } as PiMateriaConfig;
  validateRoles(config.roles);
  return config;
}

function mergePipeline(basePipeline: PiMateriaConfig["pipeline"], parsedPipeline: Partial<PiMateriaConfig>["pipeline"]): PiMateriaConfig["pipeline"] {
  if (!parsedPipeline) return basePipeline;
  return {
    ...(basePipeline ?? {}),
    ...parsedPipeline,
    nodes: parsedPipeline.nodes ?? basePipeline?.nodes ?? {},
  } as PiMateriaConfig["pipeline"];
}

function mergeLoadouts(baseLoadouts: PiMateriaConfig["loadouts"], parsedLoadouts: Partial<PiMateriaConfig>["loadouts"]): PiMateriaConfig["loadouts"] {
  if (!parsedLoadouts) return baseLoadouts;
  const merged: Record<string, NonNullable<PiMateriaConfig["pipeline"]>> = { ...(baseLoadouts ?? {}) };
  for (const [name, loadout] of Object.entries(parsedLoadouts)) {
    if (!isPlainObject(loadout)) throw new Error(`Materia loadout "${name}" is invalid. Expected a pipeline object.`);
    const baseLoadout = baseLoadouts?.[name];
    merged[name] = {
      ...(baseLoadout ?? {}),
      ...loadout,
      nodes: loadout.nodes ?? baseLoadout?.nodes ?? {},
    } as NonNullable<PiMateriaConfig["pipeline"]>;
  }
  return merged;
}

function mergeRoles(baseRoles: Record<string, MateriaRoleConfig>, parsedRoles: Partial<PiMateriaConfig>["roles"]): Record<string, MateriaRoleConfig> {
  if (!parsedRoles) return baseRoles;
  const merged: Record<string, MateriaRoleConfig> = { ...baseRoles };
  for (const [name, role] of Object.entries(parsedRoles as Record<string, unknown>)) {
    if (!isPlainObject(role)) throw new Error(`Materia role "${name}" is invalid. Expected a role object.`);
    merged[name] = { ...(baseRoles[name] ?? {}), ...role } as MateriaRoleConfig;
  }
  return merged;
}

function validateRoles(roles: Record<string, MateriaRoleConfig>): void {
  for (const [name, role] of Object.entries(roles as Record<string, unknown>)) {
    if (!isPlainObject(role)) throw new Error(`Materia role "${name}" is invalid. Expected a role object.`);
    if (role.systemPrompt === undefined || typeof role.systemPrompt !== "string") {
      throw new Error(`Materia role "${name}" has invalid systemPrompt. Expected a string.`);
    }
    if (role.tools === undefined || !["none", "readOnly", "coding"].includes(String(role.tools))) {
      throw new Error(`Materia role "${name}" has invalid tools. Expected "none", "readOnly", or "coding".`);
    }
    if (role.model !== undefined && typeof role.model !== "string") {
      throw new Error(`Materia role "${name}" has invalid model. Expected a string when configured.`);
    }
    if (role.thinking !== undefined && typeof role.thinking !== "string") {
      throw new Error(`Materia role "${name}" has invalid thinking. Expected a string when configured.`);
    }
    if (role.multiTurn !== undefined && typeof role.multiTurn !== "boolean") {
      throw new Error(`Materia role "${name}" has invalid multiTurn. Expected a boolean when configured.`);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadDefaultConfig(): Promise<PiMateriaConfig> {
  return JSON.parse(await readFile(getBundledDefaultConfigPath(), "utf8")) as PiMateriaConfig;
}

export function resolveArtifactRoot(cwd: string, artifactDir?: string): string {
  return artifactDir ? resolveFromCwd(cwd, artifactDir) : path.join(cwd, ".pi", "pi-materia");
}

export function resolveFromCwd(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
}
