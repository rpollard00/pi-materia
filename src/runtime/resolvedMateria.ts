import { canonicalGeneratorConfigFor } from "../graph/generator.js";
import type { MateriaConfig, MateriaPipelineSocketConfig, MateriaUtilityConfig, ResolvedMateriaAgentSocket, ResolvedMateriaSocket, ResolvedMateriaUtilitySocket } from "../types.js";

export function isAgentResolvedSocket(socket: ResolvedMateriaSocket): socket is ResolvedMateriaAgentSocket {
  return socket.socket.type === "agent";
}

export function isUtilityResolvedSocket(socket: ResolvedMateriaSocket): socket is ResolvedMateriaUtilitySocket {
  return socket.socket.type === "utility";
}

export function resolvedMateriaId(socket: ResolvedMateriaSocket | undefined): string | undefined {
  if (!socket) return undefined;
  return isUtilityResolvedSocket(socket) ? socket.materiaId : socket.socket.materia;
}

export function resolvedMateriaLabel(socket: ResolvedMateriaSocket | undefined): string | undefined {
  return socket?.materia?.label;
}

export function resolvedMateriaDisplayName(socket: ResolvedMateriaSocket | undefined): string | undefined {
  if (!socket) return undefined;
  return resolvedMateriaLabel(socket) ?? resolvedMateriaId(socket);
}

export function resolvedSocketConfig<TSocket extends ResolvedMateriaSocket>(socket: TSocket): TSocket["socket"] {
  return socket.socket;
}

export function effectiveUtilityConfig(socket: ResolvedMateriaUtilitySocket): MateriaUtilityConfig {
  return socket.materia ?? legacyInlineUtilityConfig(socket);
}

export function effectiveResolvedSocketConfig(socket: ResolvedMateriaSocket): MateriaPipelineSocketConfig {
  if (isAgentResolvedSocket(socket)) return socket.socket;
  const utility = effectiveUtilityConfig(socket);
  const generator = canonicalGeneratorConfigFor(socket.materia);
  const effective: MateriaPipelineSocketConfig = {
    ...socket.socket,
    ...(utility.parse ? { parse: utility.parse } : {}),
    ...(utility.assign ? { assign: utility.assign } : {}),
  };
  if (generator) {
    effective.parse = "json";
    effective.assign = { ...(effective.assign ?? {}), [generator.output]: `$.${generator.output}` };
  }
  return effective;
}

function legacyInlineUtilityConfig(socket: ResolvedMateriaUtilitySocket): MateriaUtilityConfig {
  const legacy = socket.socket as ResolvedMateriaUtilitySocket["socket"] & MateriaUtilityConfig;
  return {
    type: "utility",
    ...(legacy.utility ? { utility: legacy.utility } : {}),
    ...(legacy.command ? { command: legacy.command } : {}),
    ...(legacy.params ? { params: legacy.params } : {}),
    ...(legacy.timeoutMs ? { timeoutMs: legacy.timeoutMs } : {}),
    ...(legacy.parse ? { parse: legacy.parse } : {}),
    ...(legacy.assign ? { assign: legacy.assign } : {}),
  };
}

export function utilityRuntimeMateriaId(materia: MateriaConfig & { id?: string }, fallback: string): string {
  return typeof materia.id === "string" && materia.id.trim().length > 0 ? materia.id : fallback;
}
