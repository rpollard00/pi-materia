import type { MateriaLoopConfig, MateriaPipelineConfig, MateriaPipelineSocketConfig, ResolvedMateriaPipeline, ResolvedMateriaSocket } from "./types.js";

/** Socket-first accessors for the loadout model. */
export function loadoutSockets(loadout: MateriaPipelineConfig): Record<string, MateriaPipelineSocketConfig> {
  return loadout.sockets ?? {};
}

export function loopSockets(loop: MateriaLoopConfig): string[] {
  return loop.sockets ?? [];
}

export function resolvedPipelineSockets(pipeline: Partial<Pick<ResolvedMateriaPipeline, "sockets">>): Record<string, ResolvedMateriaSocket> {
  return pipeline.sockets ?? {};
}

export function materializeCanonicalSockets<TLoadout extends MateriaPipelineConfig>(loadout: TLoadout): TLoadout {
  loadout.sockets = loadout.sockets ?? {};
  for (const loop of Object.values(loadout.loops ?? {})) {
    loop.sockets = loop.sockets ?? [];
  }
  return loadout;
}
