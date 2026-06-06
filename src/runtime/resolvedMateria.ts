import { canonicalGeneratorConfigFor } from "../graph/generator.js";
import type { MateriaConfig, MateriaPipelineSocketConfig, MateriaUtilityConfig, ResolvedMateriaAgentSocket, ResolvedMateriaSocket, ResolvedMateriaUtilitySocket } from "../types.js";

export function isAgentResolvedSocket(socket: ResolvedMateriaSocket): socket is ResolvedMateriaAgentSocket {
  return typeof socket.materia === "object" && socket.materia !== null && "prompt" in socket.materia;
}

export function isUtilityResolvedSocket(socket: ResolvedMateriaSocket): socket is ResolvedMateriaUtilitySocket {
  return !isAgentResolvedSocket(socket);
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
  return socket.materia;
}

export function effectiveResolvedSocketConfig(socket: ResolvedMateriaSocket): MateriaPipelineSocketConfig {
  const generator = canonicalGeneratorConfigFor(socket.materia);

  if (isAgentResolvedSocket(socket)) {
    if (!generator) return socket.socket;
    return {
      ...socket.socket,
      parse: "json",
      assign: { ...(socket.socket.assign ?? {}), [generator.output]: `$.${generator.output}` },
    };
  }

  const utility = effectiveUtilityConfig(socket) ?? {} as MateriaUtilityConfig;
  const effective: MateriaPipelineSocketConfig = {
    materia: socket.materiaId,
    ...(socket.socket.socketKind ? { socketKind: socket.socket.socketKind } : {}),
    ...(socket.socket.edges ? { edges: socket.socket.edges } : {}),
    ...(socket.socket.foreach ? { foreach: socket.socket.foreach } : {}),
    ...(socket.socket.advance ? { advance: socket.socket.advance } : {}),
    ...(socket.socket.limits ? { limits: socket.socket.limits } : {}),
    ...(socket.socket.layout ? { layout: socket.socket.layout } : {}),
    ...(socket.socket.empty !== undefined ? { empty: socket.socket.empty } : {}),
    ...(utility.parse ? { parse: utility.parse } : {}),
    ...(utility.assign ? { assign: utility.assign } : {}),
  };
  if (generator) {
    effective.parse = "json";
    effective.assign = { ...(effective.assign ?? {}), [generator.output]: `$.${generator.output}` };
  }
  return effective;
}

export function utilityRuntimeMateriaId(materia: MateriaConfig & { id?: string }, fallback: string): string {
  return typeof materia.id === "string" && materia.id.trim().length > 0 ? materia.id : fallback;
}
