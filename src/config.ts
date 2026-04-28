import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "./defaultConfig.js";
import type { LoadedConfig, PiMateriaConfig } from "./types.js";

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
    config: mergeConfig(parsed),
    source,
  };
}

function getBundledDefaultConfigPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "..", "config", "default.json");
}

function mergeConfig(parsed: Partial<PiMateriaConfig>): PiMateriaConfig {
  const base = cloneDefaultConfig();
  return {
    ...base,
    ...parsed,
    budget: { ...base.budget, ...(parsed.budget ?? {}) },
    pipeline: {
      ...base.pipeline,
      ...(parsed.pipeline ?? {}),
      nodes: { ...base.pipeline.nodes, ...(parsed.pipeline?.nodes ?? {}) },
    },
    roles: { ...base.roles, ...(parsed.roles ?? {}) },
  };
}

function cloneDefaultConfig(): PiMateriaConfig {
  return JSON.parse(JSON.stringify(defaultConfig)) as PiMateriaConfig;
}

export function resolveArtifactRoot(cwd: string, artifactDir?: string): string {
  return artifactDir ? resolveFromCwd(cwd, artifactDir) : path.join(cwd, ".pi", "pi-materia");
}

export function resolveFromCwd(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
}
