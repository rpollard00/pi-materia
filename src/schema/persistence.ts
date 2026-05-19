import { validateReservedHandoffFields, type HandoffObject } from "../domain/handoff.js";
import { validateLoadout, type Loadout, type LoadoutLoop, type LoadoutSocket, type SocketId } from "../domain/loadout.js";
import type { DomainIssue, DomainResult } from "../domain/result.js";
import type { LoadoutSource, LoadoutUserLockState, MateriaConfig, MateriaLoopConfig, MateriaPipelineConfig, MateriaPipelineLayoutConfig, MateriaPipelineSocketConfig, PiMateriaConfig, MateriaProfileConfig } from "../types.js";

/**
 * Persistence/schema anti-corruption adapters.
 *
 * `sockets` is the canonical external spelling for loadout JSON handled by
 * these adapters. Socket fields are required by canonical validation.
 */

export interface CurrentPersistedConfig {
  artifactDir?: string;
  budget?: PiMateriaConfig["budget"];
  limits?: PiMateriaConfig["limits"];
  compaction?: PiMateriaConfig["compaction"];
  loadouts?: Record<string, CurrentPersistedLoadout | null>;
  activeLoadoutId?: string;
  activeLoadout?: string;
  materia?: Record<string, MateriaConfig | null>;
}

export interface CurrentPersistedProfileConfig {
  webui?: MateriaProfileConfig["webui"];
  defaultLoadoutId?: string | null;
  defaultSaveTarget?: MateriaProfileConfig["defaultSaveTarget"];
  roleGeneration?: MateriaProfileConfig["roleGeneration"];
}

export interface CurrentPersistedLoadout {
  id?: string;
  source?: LoadoutSource;
  lockState?: LoadoutUserLockState;
  originDefaultId?: string;
  entry: string;
  sockets?: Record<string, CurrentPersistedSocket>;
  loops?: Record<string, CurrentPersistedLoop>;
  layout?: MateriaPipelineLayoutConfig;
}

export interface CurrentPersistedSocket {
  materia: string;
  socketKind?: MateriaPipelineSocketConfig["socketKind"];
  parse?: MateriaPipelineSocketConfig["parse"];
  assign?: Record<string, string>;
  edges?: MateriaPipelineSocketConfig["edges"];
  foreach?: MateriaPipelineSocketConfig["foreach"];
  advance?: MateriaPipelineSocketConfig["advance"];
  limits?: MateriaPipelineSocketConfig["limits"];
  empty?: boolean;
}

export interface CurrentPersistedLoop {
  sockets?: string[];
  consumes?: MateriaLoopConfig["consumes"];
  iterator?: MateriaLoopConfig["iterator"];
  exit?: MateriaLoopConfig["exit"];
  exits?: MateriaLoopConfig["exits"];
}

export interface PersistedLoadoutSchema extends CurrentPersistedLoadout {}
export interface PersistedLoopSchema extends CurrentPersistedLoop {}

export function parsePersistedLoadout(value: unknown, path = "loadout", materia: Record<string, Pick<MateriaConfig, "type">> = {}): DomainResult<Loadout> {
  const issues: DomainIssue[] = [];
  if (!isPlainObject(value)) return { ok: false, issues: [{ path, message: "loadout must be an object" }] };

  const rawSockets = value.sockets;
  if (!isPlainObject(rawSockets)) issues.push({ path: `${path}.sockets`, message: "loadout must define a sockets object" });
  else rejectPersistedSocketTypes(rawSockets, `${path}.sockets`, issues);
  const loadout: Loadout = {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    entry: typeof value.entry === "string" ? value.entry : "",
    sockets: isPlainObject(rawSockets) ? materializeRuntimeSockets(rawSockets, materia) as Record<SocketId, LoadoutSocket> : {},
    ...(value.loops === undefined ? {} : { loops: parseLoops(value.loops, `${path}.loops`, issues) }),
  };
  if (typeof value.entry !== "string" || value.entry.length === 0) issues.push({ path: `${path}.entry`, message: "entry is required" });

  if (issues.length > 0) return { ok: false, issues };
  return validateLoadout(loadout);
}

export function serializePersistedLoadout(loadout: Loadout): PersistedLoadoutSchema {
  return {
    ...(loadout.id ? { id: loadout.id } : {}),
    entry: loadout.entry,
    sockets: serializeCanonicalSockets(loadout.sockets) as Record<string, CurrentPersistedSocket>,
    ...(loadout.loops ? { loops: Object.fromEntries(Object.entries(loadout.loops).map(([id, loop]) => [id, serializeLoop(loop)])) } : {}),
  };
}

export function pipelineConfigToDomainLoadout(loadout: MateriaPipelineConfig, id?: string, materia: Record<string, Pick<MateriaConfig, "type">> = {}): Loadout {
  return {
    ...(id ? { id } : {}),
    entry: loadout.entry,
    sockets: materializeRuntimeSockets(loadout.sockets ?? {}, materia) as Record<SocketId, LoadoutSocket>,
    ...(loadout.loops ? { loops: Object.fromEntries(Object.entries(loadout.loops).map(([loopId, loop]) => [loopId, pipelineLoopToDomain(loop)])) } : {}),
  };
}

export function domainLoadoutToPipelineConfig(loadout: Loadout): MateriaPipelineConfig {
  return {
    entry: loadout.entry,
    sockets: serializeCanonicalSockets(loadout.sockets) as Record<string, MateriaPipelineSocketConfig>,
    ...(loadout.loops ? { loops: Object.fromEntries(Object.entries(loadout.loops).map(([loopId, loop]) => [loopId, domainLoopToPipeline(loop)])) } : {}),
  };
}

export function normalizePersistedConfigForApplication<T extends Partial<PiMateriaConfig>>(config: T): T {
  return parseCurrentPersistedConfig(config as CurrentPersistedConfig) as T;
}

export function normalizePersistedLoadoutForApplication(value: unknown, materia: Record<string, Pick<MateriaConfig, "type">> = {}): unknown {
  if (!isPlainObject(value) || !isPlainObject(value.sockets)) return value;
  const loops = isPlainObject(value.loops)
    ? Object.fromEntries(Object.entries(value.loops).map(([id, loop]) => [id, normalizeLoopForApplication(loop)]))
    : value.loops;
  const { sockets: _sockets, ...rest } = value;
  return { ...rest, sockets: materializeRuntimeSockets(value.sockets, materia), ...(loops === undefined ? {} : { loops }) };
}

export function parseCurrentPersistedConfig(config: CurrentPersistedConfig): Partial<PiMateriaConfig> {
  const materia = isPlainObject(config.materia) ? config.materia as PiMateriaConfig["materia"] : undefined;
  return {
    ...(config.artifactDir !== undefined ? { artifactDir: config.artifactDir } : {}),
    ...(config.budget !== undefined ? { budget: cloneRecord(config.budget) } : {}),
    ...(config.limits !== undefined ? { limits: cloneRecord(config.limits) } : {}),
    ...(config.compaction !== undefined ? { compaction: cloneRecord(config.compaction) } : {}),
    ...(config.activeLoadoutId !== undefined ? { activeLoadoutId: config.activeLoadoutId } : {}),
    ...(config.activeLoadout !== undefined ? { activeLoadout: config.activeLoadout } : {}),
    ...(materia !== undefined ? { materia: cloneRecord(materia) } : {}),
    ...(isPlainObject(config.loadouts) ? { loadouts: Object.fromEntries(Object.entries(config.loadouts).map(([name, loadout]) => [name, loadout === null ? null : normalizePersistedLoadoutForApplication(loadout, materia ?? {})])) as PiMateriaConfig["loadouts"] } : {}),
  };
}

export function serializeCurrentPersistedConfig(config: Partial<PiMateriaConfig>): CurrentPersistedConfig {
  return {
    ...(config.artifactDir !== undefined ? { artifactDir: config.artifactDir } : {}),
    ...(config.budget !== undefined ? { budget: cloneRecord(config.budget) } : {}),
    ...(config.limits !== undefined ? { limits: cloneRecord(config.limits) } : {}),
    ...(config.compaction !== undefined ? { compaction: cloneRecord(config.compaction) } : {}),
    ...(config.loadouts !== undefined ? { loadouts: Object.fromEntries(Object.entries(config.loadouts as Record<string, MateriaPipelineConfig | null>).map(([name, loadout]) => [name, loadout === null ? null : serializePipelineLoadout(loadout)])) } : {}),
    ...(config.activeLoadoutId !== undefined ? { activeLoadoutId: config.activeLoadoutId } : {}),
    ...(config.activeLoadout !== undefined ? { activeLoadout: config.activeLoadout } : {}),
    ...(config.materia !== undefined ? { materia: cloneRecord(config.materia) } : {}),
  };
}

export function serializeCurrentProfileConfig(profile: MateriaProfileConfig): CurrentPersistedProfileConfig {
  return {
    ...(profile.webui !== undefined ? { webui: cloneRecord(profile.webui) } : {}),
    ...(profile.defaultLoadoutId !== undefined ? { defaultLoadoutId: profile.defaultLoadoutId } : {}),
    ...(profile.defaultSaveTarget !== undefined ? { defaultSaveTarget: profile.defaultSaveTarget } : {}),
    ...(profile.roleGeneration !== undefined ? { roleGeneration: cloneRecord(profile.roleGeneration) } : {}),
  };
}

export function validatePersistedHandoffPayload(value: unknown, path = "handoff"): DomainResult<HandoffObject> {
  if (!isPlainObject(value)) return { ok: false, issues: [{ path, message: "handoff payload must be an object" }] };
  const issues: DomainIssue[] = [];
  if ("tasks" in value && !("workItems" in value)) issues.push({ path: `${path}.tasks`, message: "tasks are not canonical persisted work; use workItems" });
  if ("workItems" in value && !Array.isArray(value.workItems)) issues.push({ path: `${path}.workItems`, message: "workItems must be an array when present" });
  const reserved = validateReservedHandoffFields(value, path);
  if (!reserved.ok) issues.push(...reserved.issues);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: { ...value } };
}

function serializePipelineLoadout(loadout: MateriaPipelineConfig): CurrentPersistedLoadout {
  return {
    ...(loadout.id ? { id: loadout.id } : {}),
    ...(loadout.source ? { source: loadout.source } : {}),
    ...(loadout.lockState ? { lockState: loadout.lockState } : {}),
    ...(loadout.originDefaultId ? { originDefaultId: loadout.originDefaultId } : {}),
    entry: loadout.entry,
    sockets: serializeCanonicalSockets(loadout.sockets ?? {}) as Record<string, CurrentPersistedSocket>,
    ...(loadout.layout ? { layout: cloneRecord(loadout.layout) } : {}),
    ...(loadout.loops ? { loops: Object.fromEntries(Object.entries(loadout.loops).map(([id, loop]) => [id, serializePipelineLoop(loop)])) } : {}),
  };
}

function serializePipelineLoop(loop: MateriaLoopConfig): CurrentPersistedLoop {
  return {
    ...(loop.sockets ? { sockets: [...loop.sockets] } : {}),
    ...(loop.consumes ? { consumes: { ...loop.consumes } } : {}),
    ...(loop.iterator ? { iterator: { ...loop.iterator } } : {}),
    ...(loop.exit ? { exit: { ...loop.exit } } : {}),
    ...(loop.exits ? { exits: loop.exits.map((exit) => ({ ...exit })) } : {}),
  };
}

function rejectPersistedSocketTypes(sockets: Record<string, unknown>, path: string, issues: DomainIssue[]): void {
  for (const [id, socket] of Object.entries(sockets)) {
    if (isPlainObject(socket) && "type" in socket) issues.push({ path: `${path}.${id}.type`, message: "persisted sockets must not configure type; define behavior on referenced materia" });
  }
}

function materializeRuntimeSockets(sockets: Record<string, unknown>, materia: Record<string, Pick<MateriaConfig, "type">>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(sockets).map(([id, socket]) => [id, cloneRecord(socket)]));
}

function serializeCanonicalSockets(sockets: Record<SocketId, LoadoutSocket> | Record<string, MateriaPipelineSocketConfig>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(sockets).map(([id, socket]) => {
    const copy = cloneRecord(socket) as unknown as Record<string, unknown>;
    delete copy.utility;
    delete copy.command;
    delete copy.params;
    delete copy.timeoutMs;
    return [id, copy];
  }));
}

function parseLoops(value: unknown, path: string, issues: DomainIssue[]): Record<string, LoadoutLoop> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    issues.push({ path, message: "loops must be an object when present" });
    return undefined;
  }
  return Object.fromEntries(Object.entries(value).map(([id, loop]) => [id, parseLoop(loop, `${path}.${id}`, issues)]));
}

function parseLoop(value: unknown, path: string, issues: DomainIssue[]): LoadoutLoop {
  if (!isPlainObject(value)) {
    issues.push({ path, message: "loop must be an object" });
    return { sockets: [] };
  }
  const rawSockets = value.sockets;
  if ("label" in value) issues.push({ path: `${path}.label`, message: "persisted loops must not configure label" });
  if (!Array.isArray(rawSockets) || !rawSockets.every((item) => typeof item === "string")) issues.push({ path: `${path}.sockets`, message: "loop must define a sockets string array" });
  return {
    sockets: Array.isArray(rawSockets) ? rawSockets.filter((item): item is string => typeof item === "string") : [],
    ...(isPlainObject(value.consumes) ? { consumes: { ...value.consumes } as unknown as LoadoutLoop["consumes"] } : {}),
    ...(isPlainObject(value.iterator) ? { iterator: { ...value.iterator } as unknown as LoadoutLoop["iterator"] } : {}),
    ...(Array.isArray(value.exits) ? { exits: value.exits.map((exit) => ({ ...(isPlainObject(exit) ? exit : {}) })) as unknown as LoadoutLoop["exits"] } : {}),
  };
}

function serializeLoop(loop: LoadoutLoop): PersistedLoopSchema {
  return {
    sockets: [...loop.sockets],
    ...(loop.consumes ? { consumes: { ...loop.consumes } } : {}),
    ...(loop.iterator ? { iterator: { ...loop.iterator } } : {}),
    ...(loop.exits ? { exits: loop.exits.map((exit) => ({ ...exit })) } : {}),
  };
}

function pipelineLoopToDomain(loop: MateriaLoopConfig): LoadoutLoop {
  return {
    sockets: [...(loop.sockets ?? [])],
    ...(loop.consumes ? { consumes: { ...loop.consumes } } : {}),
    ...(loop.iterator ? { iterator: { ...loop.iterator } } : {}),
    ...(loop.exits ? { exits: loop.exits.map((exit) => ({ ...exit })) } : {}),
  };
}

function domainLoopToPipeline(loop: LoadoutLoop): MateriaLoopConfig {
  return {
    sockets: [...loop.sockets],
    ...(loop.consumes ? { consumes: { ...loop.consumes } } : {}),
    ...(loop.iterator ? { iterator: { ...loop.iterator } } : {}),
    ...(loop.exits ? { exits: loop.exits.map((exit) => ({ ...exit })) } : {}),
  };
}

function normalizeLoopForApplication(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const { sockets: _sockets, ...rest } = value;
  return { ...rest, ...(Array.isArray(value.sockets) ? { sockets: [...value.sockets] } : {}) };
}

function cloneRecord<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
