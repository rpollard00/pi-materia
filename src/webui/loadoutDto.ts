import type { MateriaLoopConfig, MateriaPipelineConfig, PiMateriaConfig } from "../types.js";

/**
 * WebUI loadout DTOs are socket-first at the API boundary.
 * Legacy `nodes` payloads are rejected instead of being adapted.
 */
export type WebUiLoadoutDto = Omit<MateriaPipelineConfig, "nodes" | "loops"> & {
  sockets?: MateriaPipelineConfig["sockets"];
  loops?: Record<string, WebUiLoopDto>;
};

export type WebUiLoopDto = Omit<MateriaLoopConfig, "nodes"> & {
  sockets?: string[];
};

export type WebUiConfigDto<TConfig extends Partial<PiMateriaConfig> = Partial<PiMateriaConfig>> = Omit<TConfig, "loadouts"> & {
  loadouts?: Record<string, WebUiLoadoutDto | null>;
};

export function toWebUiLoadoutDto(loadout: MateriaPipelineConfig): WebUiLoadoutDto {
  rejectLegacyNodes(loadout, "loadout");
  const cloned = clone(loadout) as WebUiLoadoutDto;
  if (cloned.loops) {
    cloned.loops = Object.fromEntries(Object.entries(cloned.loops).map(([id, loop]) => [id, toWebUiLoopDto(loop)]));
  }
  return cloned;
}

export function fromWebUiLoadoutDto(loadout: WebUiLoadoutDto): MateriaPipelineConfig {
  rejectLegacyNodes(loadout, "loadout");
  const cloned = clone(loadout) as MateriaPipelineConfig;
  if (cloned.loops) {
    cloned.loops = Object.fromEntries(Object.entries(cloned.loops).map(([id, loop]) => [id, fromWebUiLoopDto(loop)]));
  }
  return cloned;
}

export function toWebUiConfigDto<TConfig extends Partial<PiMateriaConfig>>(config: TConfig): WebUiConfigDto<TConfig> {
  const cloned = clone(config) as WebUiConfigDto<TConfig>;
  if (cloned.loadouts) {
    cloned.loadouts = Object.fromEntries(Object.entries(cloned.loadouts).map(([name, loadout]) => [name, loadout === null ? null : toWebUiLoadoutDto(loadout as MateriaPipelineConfig)]));
  }
  return cloned;
}

export function fromWebUiConfigDto<TConfig extends WebUiConfigDto>(config: TConfig): Omit<TConfig, "loadouts"> & { loadouts?: Record<string, MateriaPipelineConfig | null> } {
  const cloned = clone(config) as Omit<TConfig, "loadouts"> & { loadouts?: Record<string, MateriaPipelineConfig | null> };
  if (cloned.loadouts) {
    cloned.loadouts = Object.fromEntries(Object.entries(cloned.loadouts).map(([name, loadout]) => [name, loadout === null ? null : fromWebUiLoadoutDto(loadout as WebUiLoadoutDto)]));
  }
  return cloned;
}

function toWebUiLoopDto(loop: MateriaLoopConfig): WebUiLoopDto {
  rejectLegacyNodes(loop, "loop");
  return clone(loop) as WebUiLoopDto;
}

function fromWebUiLoopDto(loop: WebUiLoopDto): MateriaLoopConfig {
  rejectLegacyNodes(loop, "loop");
  return clone(loop) as MateriaLoopConfig;
}

function rejectLegacyNodes(value: unknown, label: string): void {
  if (value && typeof value === "object" && "nodes" in value) {
    throw new Error(`Legacy WebUI ${label} nodes are not supported; use sockets instead.`);
  }
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}
