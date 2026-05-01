import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LoadedConfig, MateriaRoleConfig, PiMateriaConfig } from "./types.js";

export async function loadConfig(cwd: string, configuredPath?: string): Promise<LoadedConfig> {
  const explicitPath = configuredPath ? resolveFromCwd(cwd, configuredPath) : undefined;
  if (explicitPath) return loadConfigFile(explicitPath);

  const projectPath = path.join(cwd, ".pi", "pi-materia.json");
  if (existsSync(projectPath)) return loadConfigFile(projectPath);

  return loadConfigFile(getBundledDefaultConfigPath(), "<pi-materia bundled default loadout>");
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

async function mergeConfig(parsed: Partial<PiMateriaConfig>): Promise<PiMateriaConfig> {
  const base = await loadDefaultConfig();
  const config = {
    ...base,
    ...parsed,
    budget: { ...base.budget, ...(parsed.budget ?? {}) },
    pipeline: mergePipeline(base.pipeline, parsed.pipeline),
    loadouts: mergeLoadouts(base.loadouts, parsed.loadouts),
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
