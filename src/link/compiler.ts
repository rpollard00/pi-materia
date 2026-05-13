import { ok, type DomainIssue, type DomainResult } from "../domain/result.js";
import { validateLoadout, type Loadout, type LoadoutSocket, type SocketId } from "../domain/loadout.js";
import { remapGraphTargetPreservingTerminal } from "../domain/socket.js";
import type { MateriaConfig, MateriaPipelineConfig } from "../types.js";
import type { MateriaDefinition } from "../domain/materia.js";
import { LINK_METADATA_VERSION, type LinkPlan, type LinkStitchingDecision, type LinkTargetRemapping, type ResolvedLinkTarget, type VirtualLoadoutSpec } from "./types.js";

export interface LinkCompilationInput {
  /** Serializable plan metadata from the planner. */
  plan: LinkPlan;
}

export interface LinkCompilationResult {
  /** Ephemeral executable virtual loadout plus separately persisted metadata. */
  virtualLoadout: VirtualLoadoutSpec;
}

export interface LinkGraphSource {
  getMateria(id: string): MateriaDefinition | MateriaConfig | undefined;
  getLoadout(id: string): Loadout | MateriaPipelineConfig | undefined;
}

export interface LinkGraphCompilerOptions {
  source: LinkGraphSource;
}

/**
 * Compiler boundary for `/materia link`.
 *
 * Responsibility: expand materia/loadout targets into one virtual loadout,
 * remap ids, and deterministically stitch adjacent graph fragments. It returns
 * an ephemeral executable graph and metadata; it must not save the virtual
 * loadout as an active/default/named loadout or launch a cast.
 */
export interface LinkGraphCompiler {
  compile(input: LinkCompilationInput): Promise<DomainResult<LinkCompilationResult>> | DomainResult<LinkCompilationResult>;
}

export type CompileLinkPlan = LinkGraphCompiler["compile"];

interface CompiledFragment {
  target: ResolvedLinkTarget;
  loadout: Loadout;
  entrySocketIds: SocketId[];
  terminalSocketIds: SocketId[];
  remappings: LinkTargetRemapping[];
}

export function createLinkGraphCompiler(options: LinkGraphCompilerOptions): LinkGraphCompiler {
  return { compile: (input) => compileLinkPlan(input, options.source) };
}

export function createConfigLinkGraphSource(input: { materia?: Record<string, MateriaDefinition | MateriaConfig>; loadouts?: Record<string, Loadout | MateriaPipelineConfig> }): LinkGraphSource {
  const materiaById = new Map<string, MateriaDefinition | MateriaConfig>();
  for (const [name, definition] of Object.entries(input.materia ?? {})) {
    materiaById.set(name, definition);
    const id = (definition as { id?: unknown }).id;
    if (typeof id === "string" && id.trim().length > 0) materiaById.set(id, definition);
  }

  const loadoutById = new Map<string, Loadout | MateriaPipelineConfig>();
  for (const [name, loadout] of Object.entries(input.loadouts ?? {})) {
    loadoutById.set(name, loadout);
    const id = (loadout as { id?: unknown }).id;
    if (typeof id === "string" && id.trim().length > 0) loadoutById.set(id, loadout);
  }

  return {
    getMateria: (id) => materiaById.get(id),
    getLoadout: (id) => loadoutById.get(id),
  };
}

export function compileLinkPlan(input: LinkCompilationInput, source: LinkGraphSource): DomainResult<LinkCompilationResult> {
  const issues: DomainIssue[] = [];
  const targets = input.plan.targets ?? [];
  if (targets.length === 0) return { ok: false, issues: [{ path: "link.targets", message: "link plan must include at least one resolved target" }] };

  const fragments: CompiledFragment[] = [];
  let nextSocketOrdinal = 1;
  for (const target of targets) {
    const fragment = expandTarget(target, source, nextSocketOrdinal, issues);
    if (!fragment) continue;
    nextSocketOrdinal += Object.keys(fragment.loadout.sockets).length;
    fragments.push(fragment);
  }
  if (issues.length > 0) return { ok: false, issues };

  const virtual: Loadout = { id: virtualLoadoutId(input.plan), entry: fragments[0]!.loadout.entry, sockets: {}, loops: {} };
  const remappings: LinkTargetRemapping[] = [];
  for (const fragment of fragments) {
    Object.assign(virtual.sockets, fragment.loadout.sockets);
    if (fragment.loadout.loops) Object.assign(virtual.loops!, fragment.loadout.loops);
    remappings.push(...fragment.remappings);
  }
  if (virtual.loops && Object.keys(virtual.loops).length === 0) delete virtual.loops;

  const stitching: LinkStitchingDecision[] = [];
  for (let index = 0; index < fragments.length - 1; index += 1) {
    const from = fragments[index]!;
    const to = fragments[index + 1]!;
    const fromSocketId = selectSingleTerminal(from, issues);
    const toSocketId = selectSingleEntry(to, issues);
    if (!fromSocketId || !toSocketId) continue;
    virtual.sockets[fromSocketId] = {
      ...virtual.sockets[fromSocketId]!,
      edges: [...(virtual.sockets[fromSocketId]!.edges ?? []), { when: "always", to: toSocketId }],
    };
    stitching.push({ fromTargetOrder: from.target.order, toTargetOrder: to.target.order, fromSocketId, toSocketId, mode: "implicit-single-compatible" });
  }
  if (issues.length > 0) return { ok: false, issues };

  const validation = validateLoadout(virtual);
  if (!validation.ok) return { ok: false, issues: validation.issues.map((issue) => ({ path: `virtualLoadout.${issue.path}`, message: issue.message })) };

  const cycleIssue = findUnsupportedCycle(validation.value);
  if (cycleIssue) return { ok: false, issues: [cycleIssue] };

  const metadata = {
    id: virtualLoadoutId(input.plan),
    name: virtualLoadoutName(input.plan),
    version: LINK_METADATA_VERSION,
    targets,
    remappings,
    stitching,
  };

  const virtualLoadout: VirtualLoadoutSpec = { metadata, loadout: validation.value };
  input.plan.lineage.virtualLoadout = metadata;
  return ok({ virtualLoadout });
}

function expandTarget(target: ResolvedLinkTarget, source: LinkGraphSource, socketStart: number, issues: DomainIssue[]): CompiledFragment | undefined {
  const sourceLoadout = target.kind === "materia" ? loadoutForMateriaTarget(target, source, issues) : loadoutForLoadoutTarget(target, source, issues);
  if (!sourceLoadout) return undefined;

  const validation = validateLoadout(sourceLoadout);
  if (!validation.ok) {
    issues.push(...validation.issues.map((issue) => ({ path: `link.targets.${target.order}.${issue.path}`, message: issue.message })));
    return undefined;
  }
  return remapFragment(target, validation.value, socketStart);
}

function loadoutForMateriaTarget(target: ResolvedLinkTarget, source: LinkGraphSource, issues: DomainIssue[]): Loadout | undefined {
  const definition = source.getMateria(target.id);
  if (!definition) {
    issues.push({ path: `link.targets.${target.order}`, message: `cannot compile unknown materia ${JSON.stringify(target.id)}` });
    return undefined;
  }
  if ((definition as { type?: unknown }).type === "utility") {
    const utility = definition as MateriaDefinition | MateriaConfig;
    return {
      entry: "Socket-1",
      sockets: { "Socket-1": { type: "utility", ...(typeof (utility as { utility?: unknown }).utility === "string" ? { utility: (utility as { utility: string }).utility } : {}), ...(isStringArray((utility as { command?: unknown }).command) ? { command: [...(utility as { command: string[] }).command] } : {}), ...copyRecordField(utility, "params"), ...(typeof (utility as { timeoutMs?: unknown }).timeoutMs === "number" ? { timeoutMs: (utility as { timeoutMs: number }).timeoutMs } : {}), ...copyStringRecordField(utility, "assign"), ...copyParseField(utility) } },
    };
  }
  return { entry: "Socket-1", sockets: { "Socket-1": { type: "agent", materia: target.id, ...copyParseField(definition) } } };
}

function loadoutForLoadoutTarget(target: ResolvedLinkTarget, source: LinkGraphSource, issues: DomainIssue[]): Loadout | undefined {
  const loadout = source.getLoadout(target.id);
  if (!loadout) {
    issues.push({ path: `link.targets.${target.order}`, message: `cannot compile unknown loadout ${JSON.stringify(target.id)}` });
    return undefined;
  }
  return cloneLoadout(loadout as Loadout);
}

function remapFragment(target: ResolvedLinkTarget, loadout: Loadout, socketStart: number): CompiledFragment {
  const socketIds = Object.keys(loadout.sockets).sort((a, b) => socketOrdinal(a) - socketOrdinal(b));
  const socketMap = new Map<SocketId, SocketId>();
  socketIds.forEach((socketId, index) => socketMap.set(socketId, `Socket-${socketStart + index}`));

  const sockets: Record<SocketId, LoadoutSocket> = {};
  for (const socketId of socketIds) {
    const remappedId = socketMap.get(socketId)!;
    sockets[remappedId] = remapSocket(loadout.sockets[socketId]!, socketMap);
  }

  const loops = loadout.loops
    ? Object.fromEntries(Object.entries(loadout.loops).map(([loopId, loop]) => [`t${target.order}-${loopId}`, {
        ...loop,
        sockets: loop.sockets.map((socketId) => remapGraphTarget(socketId, socketMap)),
        ...(loop.consumes ? { consumes: { ...loop.consumes, from: remapGraphTarget(loop.consumes.from, socketMap), ...(loop.consumes.done ? { done: remapGraphTarget(loop.consumes.done, socketMap) } : {}) } } : {}),
        ...(loop.iterator ? { iterator: { ...loop.iterator, ...(loop.iterator.done ? { done: remapGraphTarget(loop.iterator.done, socketMap) } : {}) } } : {}),
        ...(loop.exit ? { exit: { ...loop.exit, from: remapGraphTarget(loop.exit.from, socketMap), to: remapGraphTarget(loop.exit.to, socketMap) } } : {}),
        ...(loop.exits ? { exits: loop.exits.map((exit) => ({ ...exit, from: remapGraphTarget(exit.from, socketMap), targetSocketId: remapGraphTarget(exit.targetSocketId, socketMap) })) } : {}),
      }]))
    : undefined;

  return {
    target,
    loadout: { id: undefined, entry: socketMap.get(loadout.entry)!, sockets, ...(loops ? { loops } : {}) },
    entrySocketIds: entrySocketIds(loadout).map((socketId) => socketMap.get(socketId) ?? socketId),
    terminalSocketIds: terminalSocketIds(loadout).map((socketId) => socketMap.get(socketId) ?? socketId),
    remappings: socketIds.map((socketId) => ({ targetOrder: target.order, fromSocketId: socketId, toSocketId: socketMap.get(socketId)! })),
  };
}

function remapSocket(socket: LoadoutSocket, socketMap: Map<SocketId, SocketId>): LoadoutSocket {
  return {
    ...socket,
    ...(socket.edges ? { edges: socket.edges.map((edge) => ({ ...edge, to: remapGraphTarget(edge.to, socketMap) })) } : {}),
    ...(socket.foreach ? { foreach: { ...socket.foreach, ...(socket.foreach.done ? { done: remapGraphTarget(socket.foreach.done, socketMap) } : {}) } } : {}),
    ...(socket.advance ? { advance: { ...socket.advance, ...(socket.advance.done ? { done: remapGraphTarget(socket.advance.done, socketMap) } : {}) } } : {}),
    ...(socket.type === "utility" && socket.command ? { command: [...socket.command] } : {}),
    ...(socket.type === "utility" && socket.params ? { params: { ...socket.params } } : {}),
    ...(socket.assign ? { assign: { ...socket.assign } } : {}),
  };
}

function remapGraphTarget(socketId: SocketId, socketMap: Map<SocketId, SocketId>): SocketId {
  return remapGraphTargetPreservingTerminal(socketId, socketMap);
}

function selectSingleTerminal(fragment: CompiledFragment, issues: DomainIssue[]): SocketId | undefined {
  if (fragment.terminalSocketIds.length === 1) return fragment.terminalSocketIds[0];
  issues.push({ path: `link.targets.${fragment.target.order}`, message: `ambiguous implicit terminal stitching for target ${fragment.target.order}; found ${fragment.terminalSocketIds.length} terminal sockets: ${fragment.terminalSocketIds.join(", ") || "none"}. Explicit socket mapping is not available in v1.` });
  return undefined;
}

function selectSingleEntry(fragment: CompiledFragment, issues: DomainIssue[]): SocketId | undefined {
  if (fragment.entrySocketIds.length === 1) return fragment.entrySocketIds[0];
  issues.push({ path: `link.targets.${fragment.target.order}`, message: `ambiguous implicit entry stitching for target ${fragment.target.order}; found ${fragment.entrySocketIds.length} entry sockets: ${fragment.entrySocketIds.join(", ") || "none"}. Explicit socket mapping is not available in v1.` });
  return undefined;
}

function entrySocketIds(loadout: Loadout): SocketId[] {
  const marked = Object.entries(loadout.sockets).filter(([, socket]) => socket.socketKind === "entry").map(([id]) => id);
  return Array.from(new Set([loadout.entry, ...marked]));
}

function terminalSocketIds(loadout: Loadout): SocketId[] {
  return Object.entries(loadout.sockets)
    .filter(([, socket]) => (socket.edges ?? []).length === 0 && !socket.foreach && !socket.advance)
    .map(([id]) => id);
}

function findUnsupportedCycle(loadout: Loadout): DomainIssue | undefined {
  const allowed = new Set<string>();
  for (const loop of Object.values(loadout.loops ?? {})) for (const socketId of loop.sockets) allowed.add(socketId);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (socketId: string, stack: string[]): DomainIssue | undefined => {
    if (visiting.has(socketId)) {
      const cycle = [...stack.slice(stack.indexOf(socketId)), socketId];
      if (cycle.every((id) => allowed.has(id))) return undefined;
      return { path: "virtualLoadout.sockets", message: `unsupported cycle introduced by linked graph: ${cycle.join(" -> ")}. Cycles must be represented by loadout loop metadata.` };
    }
    if (visited.has(socketId)) return undefined;
    visiting.add(socketId);
    for (const edge of loadout.sockets[socketId]?.edges ?? []) {
      const issue = visit(edge.to, [...stack, edge.to]);
      if (issue) return issue;
    }
    visiting.delete(socketId);
    visited.add(socketId);
    return undefined;
  };
  return visit(loadout.entry, [loadout.entry]);
}

function virtualLoadoutId(plan: LinkPlan): string {
  return `virtual-link-${plan.targets.map((target) => `${target.kind}-${target.id}`).join("-").replace(/[^A-Za-z0-9_-]+/g, "-")}`;
}

function virtualLoadoutName(plan: LinkPlan): string {
  return `Linked virtual loadout: ${plan.targets.map((target) => target.displayName ?? target.id).join(" → ")}`;
}

function socketOrdinal(socketId: string): number {
  const match = /^Socket-(\d+)$/.exec(socketId);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function cloneLoadout(loadout: Loadout): Loadout {
  return JSON.parse(JSON.stringify(loadout)) as Loadout;
}

function copyParseField(value: unknown): { parse?: "text" | "json" } {
  const parse = (value as { parse?: unknown }).parse;
  return parse === "text" || parse === "json" ? { parse } : {};
}

function copyRecordField<T extends string>(value: unknown, field: T): Record<T, Record<string, unknown>> | {} {
  const record = (value as Record<T, unknown>)[field];
  return record && typeof record === "object" && !Array.isArray(record) ? { [field]: { ...record as Record<string, unknown> } } as Record<T, Record<string, unknown>> : {};
}

function copyStringRecordField<T extends string>(value: unknown, field: T): Record<T, Record<string, string>> | {} {
  const record = (value as Record<T, unknown>)[field];
  return record && typeof record === "object" && !Array.isArray(record) && Object.values(record).every((entry) => typeof entry === "string") ? { [field]: { ...record as Record<string, string> } } as Record<T, Record<string, string>> : {};
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
