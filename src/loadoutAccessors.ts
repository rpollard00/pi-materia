import type { MateriaLoopConfig, MateriaPipelineConfig, MateriaPipelineSocketConfig, ResolvedMateriaPipeline, ResolvedMateriaSocket } from "./types.js";

/**
 * Socket-first accessors for the loadout model.
 *
 * Legacy persisted/WebUI DTOs may still arrive with `nodes` and loop `nodes`.
 * Core/domain/application code should use these helpers or `sockets` directly so
 * that legacy names stay isolated at compatibility boundaries.
 */
export function loadoutSockets(loadout: MateriaPipelineConfig): Record<string, MateriaPipelineSocketConfig> {
  return loadout.sockets ?? loadout.nodes ?? {};
}

export function loopSockets(loop: MateriaLoopConfig): string[] {
  return loop.sockets ?? loop.nodes ?? [];
}

export function resolvedPipelineSockets(pipeline: Partial<Pick<ResolvedMateriaPipeline, "sockets">> & { nodes?: Record<string, ResolvedMateriaSocket> }): Record<string, ResolvedMateriaSocket> {
  return pipeline.sockets ?? pipeline.nodes ?? {};
}

export function materializeCanonicalSockets<TLoadout extends MateriaPipelineConfig>(loadout: TLoadout): TLoadout {
  const sockets = loadout.sockets ?? loadout.nodes ?? {};
  loadout.sockets = sockets;
  delete loadout.nodes;
  for (const loop of Object.values(loadout.loops ?? {})) {
    const socketsInLoop = loop.sockets ?? loop.nodes ?? [];
    loop.sockets = socketsInLoop;
    delete loop.nodes;
  }
  return loadout;
}
