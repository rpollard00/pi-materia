import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCompactionConfig } from "./compaction.js";
import type { LoadedConfig, MateriaConfigLayer, MateriaProfileConfig, MateriaRoleConfig, MateriaSaveTarget, PiMateriaConfig } from "./types.js";

export async function loadConfig(cwd: string, configuredPath?: string): Promise<LoadedConfig> {
  await ensureUserProfileConfig();
  const defaultPath = getBundledDefaultConfigPath();
  const userPath = getUserMateriaAssetPath();
  const projectPath = getProjectConfigPath(cwd);
  const explicitPath = configuredPath ? resolveFromCwd(cwd, configuredPath) : undefined;
  const layers: MateriaConfigLayer[] = [{ scope: "default", path: defaultPath, loaded: true }];
  const partials: Partial<PiMateriaConfig>[] = [await readConfigPartial(defaultPath)];

  if (existsSync(userPath)) {
    layers.push({ scope: "user", path: userPath, loaded: true });
    partials.push(await readConfigPartial(userPath));
  } else {
    layers.push({ scope: "user", path: userPath, loaded: false });
  }

  if (existsSync(projectPath)) {
    layers.push({ scope: "project", path: projectPath, loaded: true });
    partials.push(await readConfigPartial(projectPath));
  } else {
    layers.push({ scope: "project", path: projectPath, loaded: false });
  }

  if (explicitPath) {
    if (!existsSync(explicitPath)) throw new Error(`pi-materia config file not found: ${explicitPath}`);
    layers.push({ scope: "explicit", path: explicitPath, loaded: true });
    partials.push(await readConfigPartial(explicitPath));
  }

  return {
    config: await mergeConfigLayers(partials),
    source: layers.filter((layer) => layer.loaded).map((layer) => layer.path).join(" < "),
    layers,
  };
}

export async function loadProfileConfig(): Promise<MateriaProfileConfig> {
  await ensureUserProfileConfig();
  try {
    const parsed = JSON.parse(await readFile(getUserProfileConfigPath(), "utf8")) as MateriaProfileConfig;
    return isPlainObject(parsed) ? parsed : defaultProfileConfig();
  } catch {
    return defaultProfileConfig();
  }
}

export async function ensureUserProfileConfig(): Promise<string> {
  const dir = getUserMateriaDir();
  const file = getUserProfileConfigPath();
  await mkdir(dir, { recursive: true });
  if (!existsSync(file)) await writeJsonAtomic(file, defaultProfileConfig());
  return file;
}

export async function saveMateriaConfigPatch(cwd: string, patch: Partial<PiMateriaConfig>, options: { target?: MateriaSaveTarget; configuredPath?: string } = {}): Promise<string> {
  const target = options.target ?? "user";
  const file = getWritableConfigPath(cwd, options.configuredPath, target);
  const existing = existsSync(file) ? await readConfigPartial(file) : {};
  const next = mergeConfigPatch(existing, patch);
  await writeJsonAtomic(file, next);
  return file;
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

  const targetPath = getWritableConfigPath(cwd, configuredPath, configuredPath ? "explicit" : "project");
  await writeMinimalActiveLoadout(targetPath, loadoutName);
  return targetPath;
}

async function readConfigPartial(file: string): Promise<Partial<PiMateriaConfig>> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<PiMateriaConfig>;
  if (!isPlainObject(parsed)) throw new Error(`Materia config file ${file} is invalid. Expected a JSON object.`);
  return parsed;
}

function getBundledDefaultConfigPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "..", "config", "default.json");
}

export function getProjectConfigPath(cwd: string): string {
  return path.join(cwd, ".pi", "pi-materia.json");
}

export function getUserMateriaDir(): string {
  return process.env.PI_MATERIA_PROFILE_DIR?.trim() || path.join(homedir(), ".config", "pi", "pi-materia");
}

export function getUserProfileConfigPath(): string {
  return path.join(getUserMateriaDir(), "config.json");
}

export function getUserMateriaAssetPath(): string {
  return path.join(getUserMateriaDir(), "materia.json");
}

function getWritableConfigPath(cwd: string, configuredPath?: string, target: MateriaSaveTarget = configuredPath ? "explicit" : "user"): string {
  if (target === "explicit") {
    if (!configuredPath) throw new Error("Cannot save to explicit Materia config because no explicit config path is active.");
    return resolveFromCwd(cwd, configuredPath);
  }
  return target === "project" ? getProjectConfigPath(cwd) : getUserMateriaAssetPath();
}

function defaultProfileConfig(): MateriaProfileConfig {
  return { webui: { autoOpenBrowser: false }, defaultSaveTarget: "user" };
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.pi-materia.${process.pid}.${Date.now()}.tmp`);
  await mkdir(dir, { recursive: true });
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

async function writeMinimalActiveLoadout(file: string, loadoutName: string): Promise<void> {
  let parsed: Partial<PiMateriaConfig> = {};
  if (existsSync(file)) {
    const text = await readFile(file, "utf8");
    parsed = JSON.parse(text) as Partial<PiMateriaConfig>;
    if (!isPlainObject(parsed)) throw new Error(`Materia config file ${file} is invalid. Expected a JSON object.`);
  }

  const next = { ...parsed, activeLoadout: loadoutName };
  try {
    await writeJsonAtomic(file, next);
  } catch (error) {
    throw new Error(`Failed to persist active Materia loadout to ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function mergeConfigLayers(layers: Partial<PiMateriaConfig>[]): Promise<PiMateriaConfig> {
  const [base, ...overrides] = layers;
  let config = { ...base } as PiMateriaConfig;
  for (const parsed of overrides) config = mergeConfig(config, parsed);
  validateRoles(config.roles);
  validateCompactionConfig(config.compaction);
  return config;
}

function mergeConfigPatch(base: Partial<PiMateriaConfig>, patch: Partial<PiMateriaConfig>): Partial<PiMateriaConfig> {
  return {
    ...base,
    ...patch,
    budget: patch.budget ? { ...(base.budget ?? {}), ...patch.budget } : base.budget,
    limits: patch.limits ? { ...(base.limits ?? {}), ...patch.limits } : base.limits,
    compaction: patch.compaction ? { ...(base.compaction ?? {}), ...patch.compaction } : base.compaction,
    loadouts: mergeLoadouts(base.loadouts, patch.loadouts),
    activeLoadout: patch.activeLoadout ?? base.activeLoadout,
    materiaDefinitions: mergeMateriaDefinitions(base.materiaDefinitions, patch.materiaDefinitions),
    roles: patch.roles ? mergeRoles(base.roles ?? {}, patch.roles) : base.roles,
  };
}

function mergeConfig(base: PiMateriaConfig, parsed: Partial<PiMateriaConfig>): PiMateriaConfig {
  return {
    ...base,
    ...parsed,
    budget: { ...base.budget, ...(parsed.budget ?? {}) },
    limits: { ...base.limits, ...(parsed.limits ?? {}) },
    compaction: { ...base.compaction, ...(parsed.compaction ?? {}) },
    loadouts: mergeLoadouts(base.loadouts, parsed.loadouts),
    activeLoadout: parsed.activeLoadout ?? base.activeLoadout,
    materiaDefinitions: mergeMateriaDefinitions(base.materiaDefinitions, parsed.materiaDefinitions),
    roles: mergeRoles(base.roles, parsed.roles),
  } as PiMateriaConfig;
}

function mergeLoadouts(baseLoadouts: PiMateriaConfig["loadouts"], parsedLoadouts: Partial<PiMateriaConfig>["loadouts"]): PiMateriaConfig["loadouts"] {
  if (!parsedLoadouts) return baseLoadouts;
  const merged: NonNullable<PiMateriaConfig["loadouts"]> = { ...(baseLoadouts ?? {}) };
  for (const [name, loadout] of Object.entries(parsedLoadouts)) {
    if (!isPlainObject(loadout)) throw new Error(`Materia loadout "${name}" is invalid. Expected a pipeline object.`);
    const baseLoadout = baseLoadouts?.[name];
    merged[name] = {
      ...(baseLoadout ?? {}),
      ...loadout,
      nodes: loadout.nodes ?? baseLoadout?.nodes ?? {},
    };
  }
  return merged;
}

function mergeMateriaDefinitions(baseDefinitions: PiMateriaConfig["materiaDefinitions"], parsedDefinitions: Partial<PiMateriaConfig>["materiaDefinitions"]): PiMateriaConfig["materiaDefinitions"] {
  if (!parsedDefinitions) return baseDefinitions;
  return { ...(baseDefinitions ?? {}), ...parsedDefinitions };
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
