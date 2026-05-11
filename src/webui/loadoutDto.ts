import type { MateriaLoopConfig, MateriaPipelineConfig, PiMateriaConfig } from "../types.js";

/** WebUI loadout DTOs are socket-first at the API boundary. */
export type WebUiLoadoutDto = Omit<MateriaPipelineConfig, "loops"> & {
  sockets?: MateriaPipelineConfig["sockets"];
  loops?: Record<string, WebUiLoopDto>;
};

export type WebUiLoopDto = MateriaLoopConfig & {
  sockets?: string[];
};

export type WebUiConfigDto<TConfig extends Partial<PiMateriaConfig> = Partial<PiMateriaConfig>> = Omit<TConfig, "loadouts"> & {
  loadouts?: Record<string, WebUiLoadoutDto | null>;
};

export function toWebUiLoadoutDto(loadout: MateriaPipelineConfig): WebUiLoadoutDto {
  const cloned = clone(loadout) as WebUiLoadoutDto;
  if (cloned.loops) {
    cloned.loops = Object.fromEntries(Object.entries(cloned.loops).map(([id, loop]) => [id, toWebUiLoopDto(loop)]));
  }
  return cloned;
}

export function fromWebUiLoadoutDto(loadout: WebUiLoadoutDto): MateriaPipelineConfig {
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
  return clone(loop) as WebUiLoopDto;
}

function fromWebUiLoopDto(loop: WebUiLoopDto): MateriaLoopConfig {
  return clone(loop) as MateriaLoopConfig;
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}
