import type { MateriaLoopConfig, MateriaPipelineConfig, MateriaPipelineSocketConfig, ResolvedMateriaPipeline, ResolvedMateriaSocket } from "../types.js";

export class LoadoutTopologyError extends Error {
  constructor(public readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "LoadoutTopologyError";
  }
}

export interface SocketReferenceIssue {
  path: string;
  message: string;
}

export interface SocketReferenceValidation {
  ok: boolean;
  issues: SocketReferenceIssue[];
}

/** Socket-first accessors for the loadout model. */
export function loadoutSockets(loadout: Pick<MateriaPipelineConfig, "sockets">): Record<string, MateriaPipelineSocketConfig> {
  return loadout.sockets ?? {};
}

export function loadoutSocketEntries(loadout: Pick<MateriaPipelineConfig, "sockets">): [string, MateriaPipelineSocketConfig][] {
  return Object.entries(loadoutSockets(loadout));
}

export function loadoutSocketIds(loadout: Pick<MateriaPipelineConfig, "sockets">): string[] {
  return Object.keys(loadoutSockets(loadout));
}

export function loadoutSocketIdSet(loadout: Pick<MateriaPipelineConfig, "sockets">): Set<string> {
  return new Set(loadoutSocketIds(loadout));
}

export function getLoadoutSocket(loadout: Pick<MateriaPipelineConfig, "sockets">, socketId: string): MateriaPipelineSocketConfig | undefined {
  return loadoutSockets(loadout)[socketId];
}

export function requireLoadoutSocket(loadout: Pick<MateriaPipelineConfig, "sockets">, socketId: string, path = `sockets.${socketId}`): MateriaPipelineSocketConfig {
  const socket = getLoadoutSocket(loadout, socketId);
  if (!socket) throw new LoadoutTopologyError(path, `unknown socket ${JSON.stringify(socketId)}`);
  return socket;
}

export function loopSockets(loop: Pick<MateriaLoopConfig, "sockets">): string[] {
  return loop.sockets ?? [];
}

export function loopSocketSet(loop: Pick<MateriaLoopConfig, "sockets">): Set<string> {
  return new Set(loopSockets(loop));
}

export function loadoutLoopEntries(loadout: Pick<MateriaPipelineConfig, "loops">): [string, MateriaLoopConfig][] {
  return Object.entries(loadout.loops ?? {}).filter((entry): entry is [string, MateriaLoopConfig] => Boolean(entry[1]));
}

export function resolvedPipelineSockets(pipeline: Partial<Pick<ResolvedMateriaPipeline, "sockets">>): Record<string, ResolvedMateriaSocket> {
  return pipeline.sockets ?? {};
}

export function resolvedPipelineSocketEntries(pipeline: Partial<Pick<ResolvedMateriaPipeline, "sockets">>): [string, ResolvedMateriaSocket][] {
  return Object.entries(resolvedPipelineSockets(pipeline));
}

export function getResolvedPipelineSocket(pipeline: Partial<Pick<ResolvedMateriaPipeline, "sockets">>, socketId: string): ResolvedMateriaSocket | undefined {
  return resolvedPipelineSockets(pipeline)[socketId];
}

export function validateLoadoutSocketReferences(loadout: Pick<MateriaPipelineConfig, "entry" | "sockets" | "loops">): SocketReferenceValidation {
  const issues: SocketReferenceIssue[] = [];
  const socketIds = loadoutSocketIdSet(loadout);
  if (!socketIds.has(loadout.entry)) issues.push({ path: "entry", message: `entry must reference an existing socket ${JSON.stringify(loadout.entry)}` });

  for (const [socketId, socket] of loadoutSocketEntries(loadout)) {
    for (const [index, edge] of (socket.edges ?? []).entries()) addMissingReferenceIssue(issues, socketIds, edge.to, `sockets.${socketId}.edges.${index}.to`, "edge target");
    addMissingReferenceIssue(issues, socketIds, socket.foreach?.done, `sockets.${socketId}.foreach.done`, "foreach done target");
    addMissingReferenceIssue(issues, socketIds, socket.advance?.done, `sockets.${socketId}.advance.done`, "advance done target");
  }

  for (const [loopId, loop] of loadoutLoopEntries(loadout)) {
    for (const [index, socketId] of loopSockets(loop).entries()) addMissingReferenceIssue(issues, socketIds, socketId, `loops.${loopId}.sockets.${index}`, "loop socket");
    addMissingReferenceIssue(issues, socketIds, loop.consumes?.from, `loops.${loopId}.consumes.from`, "loop consumer source");
    addMissingReferenceIssue(issues, socketIds, loop.consumes?.done, `loops.${loopId}.consumes.done`, "loop consumer done target");
    addMissingReferenceIssue(issues, socketIds, loop.iterator?.done, `loops.${loopId}.iterator.done`, "loop iterator done target");
    addMissingReferenceIssue(issues, socketIds, loop.exit?.from, `loops.${loopId}.exit.from`, "loop exit source");
    addMissingReferenceIssue(issues, socketIds, loop.exit?.to, `loops.${loopId}.exit.to`, "loop exit target");
    for (const [index, route] of (loop.exits ?? []).entries()) {
      addMissingReferenceIssue(issues, socketIds, route.from, `loops.${loopId}.exits.${index}.from`, "loop-exit route source");
      addMissingReferenceIssue(issues, socketIds, route.targetSocketId, `loops.${loopId}.exits.${index}.targetSocketId`, "loop-exit route target");
    }
  }

  return { ok: issues.length === 0, issues };
}

export function assertValidLoadoutSocketReferences(loadout: Pick<MateriaPipelineConfig, "entry" | "sockets" | "loops">): void {
  const result = validateLoadoutSocketReferences(loadout);
  if (!result.ok) throw new LoadoutTopologyError(result.issues[0]?.path ?? "loadout", result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
}

export function materializeCanonicalSockets<TLoadout extends MateriaPipelineConfig>(loadout: TLoadout): TLoadout {
  loadout.sockets = loadout.sockets ?? {};
  for (const loop of Object.values(loadout.loops ?? {})) {
    loop.sockets = loop.sockets ?? [];
  }
  return loadout;
}

function addMissingReferenceIssue(issues: SocketReferenceIssue[], socketIds: Set<string>, socketId: string | undefined, path: string, label: string): void {
  if (!socketId || socketId === "end") return;
  if (!socketIds.has(socketId)) issues.push({ path, message: `${label} must reference an existing socket ${JSON.stringify(socketId)}` });
}
