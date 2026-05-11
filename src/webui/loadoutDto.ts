import { loadoutSockets, loopSockets } from "../loadoutAccessors.js";
import type { MateriaLoopConfig, MateriaPipelineConfig, PiMateriaConfig } from "../types.js";

/**
 * Explicit compatibility adapter for the WebUI editor DTO.
 *
 * Core/domain/application loadouts are socket-first (`sockets`, loop `sockets`).
 * The current WebUI graph editor still edits a legacy nodes-shaped DTO. Keep
 * that shape at this boundary only and convert saves back to canonical sockets.
 */
export type WebUiLoadoutDto = Omit<MateriaPipelineConfig, "sockets" | "loops"> & {
  nodes?: MateriaPipelineConfig["sockets"];
  loops?: Record<string, WebUiLoopDto>;
};

export type WebUiLoopDto = Omit<MateriaLoopConfig, "sockets"> & {
  nodes?: string[];
};

export type WebUiConfigDto<TConfig extends Partial<PiMateriaConfig> = Partial<PiMateriaConfig>> = Omit<TConfig, "loadouts"> & {
  loadouts?: Record<string, WebUiLoadoutDto | null>;
};

export function toWebUiLoadoutDto(loadout: MateriaPipelineConfig): WebUiLoadoutDto {
  const cloned = clone(loadout) as WebUiLoadoutDto & { sockets?: MateriaPipelineConfig["sockets"] };
  const nodes = clone(cloned.sockets ? loadoutSockets(loadout) : cloned.nodes ?? {});
  delete cloned.sockets;
  cloned.nodes = nodes;
  if (cloned.loops) {
    cloned.loops = Object.fromEntries(Object.entries(cloned.loops).map(([id, loop]) => [id, toWebUiLoopDto(loop)]));
  }
  return cloned;
}

export function fromWebUiLoadoutDto(loadout: WebUiLoadoutDto | MateriaPipelineConfig): MateriaPipelineConfig {
  const cloned = clone(loadout) as MateriaPipelineConfig;
  const sockets = clone(cloned.sockets ?? cloned.nodes ?? {});
  delete cloned.nodes;
  cloned.sockets = sockets;
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
  const cloned = clone(loop) as WebUiLoopDto & { sockets?: string[] };
  const nodes = [...(cloned.sockets ? loopSockets(loop) : cloned.nodes ?? [])];
  delete cloned.sockets;
  cloned.nodes = nodes;
  return cloned;
}

function fromWebUiLoopDto(loop: WebUiLoopDto | MateriaLoopConfig): MateriaLoopConfig {
  const cloned = clone(loop) as MateriaLoopConfig;
  const sockets = [...(cloned.sockets ?? cloned.nodes ?? [])];
  delete cloned.nodes;
  cloned.sockets = sockets;
  return cloned;
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}
