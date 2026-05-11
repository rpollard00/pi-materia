import { validateReservedHandoffFields, type HandoffObject } from "../domain/handoff.js";
import { validateLoadout, type Loadout, type LoadoutLoop, type LoadoutSocket, type SocketId } from "../domain/loadout.js";
import type { DomainIssue, DomainResult } from "../domain/result.js";
import type { MateriaLoopConfig, MateriaPipelineConfig, MateriaPipelineSocketConfig, PiMateriaConfig } from "../types.js";

/**
 * Persistence/schema anti-corruption adapters.
 *
 * `sockets` is the canonical external spelling for loadout JSON handled by
 * these adapters. Socket fields are required by canonical validation; legacy
 * socket-collection aliases are not adapted at this boundary.
 */

export interface PersistedLoadoutSchema {
  schemaVersion?: number;
  id?: string;
  entry?: unknown;
  sockets?: unknown;
  loops?: unknown;
  layout?: unknown;
}

export interface PersistedLoopSchema {
  label?: unknown;
  sockets?: unknown;
  consumes?: unknown;
  iterator?: unknown;
  exits?: unknown;
}

export function parsePersistedLoadout(value: unknown, path = "loadout"): DomainResult<Loadout> {
  const issues: DomainIssue[] = [];
  if (!isPlainObject(value)) return { ok: false, issues: [{ path, message: "loadout must be an object" }] };

  const rawSockets = value.sockets;
  if (!isPlainObject(rawSockets)) issues.push({ path: `${path}.sockets`, message: "loadout must define a sockets object" });
  const loadout: Loadout = {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    entry: typeof value.entry === "string" ? value.entry : "",
    sockets: isPlainObject(rawSockets) ? cloneRecord(rawSockets) as Record<SocketId, LoadoutSocket> : {},
    ...(value.loops === undefined ? {} : { loops: parseLoops(value.loops, `${path}.loops`, issues) }),
  };
  if (typeof value.entry !== "string" || value.entry.length === 0) issues.push({ path: `${path}.entry`, message: "entry is required" });

  if (issues.length > 0) return { ok: false, issues };
  return validateLoadout(loadout);
}

export function serializePersistedLoadout(loadout: Loadout): PersistedLoadoutSchema {
  return {
    schemaVersion: 2,
    ...(loadout.id ? { id: loadout.id } : {}),
    entry: loadout.entry,
    sockets: cloneRecord(loadout.sockets),
    ...(loadout.loops ? { loops: Object.fromEntries(Object.entries(loadout.loops).map(([id, loop]) => [id, serializeLoop(loop)])) } : {}),
  };
}

export function pipelineConfigToDomainLoadout(loadout: MateriaPipelineConfig, id?: string): Loadout {
  return {
    ...(id ? { id } : {}),
    entry: loadout.entry,
    sockets: cloneRecord(loadout.sockets ?? {}) as Record<SocketId, LoadoutSocket>,
    ...(loadout.loops ? { loops: Object.fromEntries(Object.entries(loadout.loops).map(([loopId, loop]) => [loopId, pipelineLoopToDomain(loop)])) } : {}),
  };
}

export function domainLoadoutToPipelineConfig(loadout: Loadout): MateriaPipelineConfig {
  return {
    entry: loadout.entry,
    sockets: cloneRecord(loadout.sockets) as Record<string, MateriaPipelineSocketConfig>,
    ...(loadout.loops ? { loops: Object.fromEntries(Object.entries(loadout.loops).map(([loopId, loop]) => [loopId, domainLoopToPipeline(loop)])) } : {}),
  };
}

export function normalizePersistedConfigForApplication<T extends Partial<PiMateriaConfig>>(config: T): T {
  if (!isPlainObject(config.loadouts)) return config;
  return {
    ...config,
    loadouts: Object.fromEntries(Object.entries(config.loadouts as Record<string, unknown>).map(([name, value]) => [name, normalizePersistedLoadoutForApplication(value)])) as PiMateriaConfig["loadouts"],
  };
}

export function normalizePersistedLoadoutForApplication(value: unknown): unknown {
  if (!isPlainObject(value) || !isPlainObject(value.sockets)) return value;
  const loops = isPlainObject(value.loops)
    ? Object.fromEntries(Object.entries(value.loops).map(([id, loop]) => [id, normalizeLoopForApplication(loop)]))
    : value.loops;
  const { sockets: _sockets, ...rest } = value;
  return { ...rest, sockets: cloneRecord(value.sockets), ...(loops === undefined ? {} : { loops }) };
}

export function validatePersistedHandoffPayload(value: unknown, path = "handoff"): DomainResult<HandoffObject> {
  if (!isPlainObject(value)) return { ok: false, issues: [{ path, message: "handoff payload must be an object" }] };
  const issues: DomainIssue[] = [];
  if ("tasks" in value && !("workItems" in value)) issues.push({ path: `${path}.tasks`, message: "legacy tasks are not canonical persisted work; use workItems" });
  if ("workItems" in value && !Array.isArray(value.workItems)) issues.push({ path: `${path}.workItems`, message: "workItems must be an array when present" });
  const reserved = validateReservedHandoffFields(value, path);
  if (!reserved.ok) issues.push(...reserved.issues);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: { ...value } };
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
  if (!Array.isArray(rawSockets) || !rawSockets.every((item) => typeof item === "string")) issues.push({ path: `${path}.sockets`, message: "loop must define a sockets string array" });
  return {
    ...(typeof value.label === "string" ? { label: value.label } : {}),
    sockets: Array.isArray(rawSockets) ? rawSockets.filter((item): item is string => typeof item === "string") : [],
    ...(isPlainObject(value.consumes) ? { consumes: { ...value.consumes } as unknown as LoadoutLoop["consumes"] } : {}),
    ...(isPlainObject(value.iterator) ? { iterator: { ...value.iterator } as unknown as LoadoutLoop["iterator"] } : {}),
    ...(Array.isArray(value.exits) ? { exits: value.exits.map((exit) => ({ ...(isPlainObject(exit) ? exit : {}) })) as unknown as LoadoutLoop["exits"] } : {}),
  };
}

function serializeLoop(loop: LoadoutLoop): PersistedLoopSchema {
  return {
    ...(loop.label ? { label: loop.label } : {}),
    sockets: [...loop.sockets],
    ...(loop.consumes ? { consumes: { ...loop.consumes } } : {}),
    ...(loop.iterator ? { iterator: { ...loop.iterator } } : {}),
    ...(loop.exits ? { exits: loop.exits.map((exit) => ({ ...exit })) } : {}),
  };
}

function pipelineLoopToDomain(loop: MateriaLoopConfig): LoadoutLoop {
  return {
    ...(loop.label ? { label: loop.label } : {}),
    sockets: [...(loop.sockets ?? [])],
    ...(loop.consumes ? { consumes: { ...loop.consumes } } : {}),
    ...(loop.iterator ? { iterator: { ...loop.iterator } } : {}),
    ...(loop.exits ? { exits: loop.exits.map((exit) => ({ ...exit })) } : {}),
  };
}

function domainLoopToPipeline(loop: LoadoutLoop): MateriaLoopConfig {
  return {
    ...(loop.label ? { label: loop.label } : {}),
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
