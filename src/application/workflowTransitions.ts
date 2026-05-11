import { selectMatchingEdge } from "../domain/routing.js";
import { HANDOFF_SATISFIED_FIELD } from "../handoffContract.js";
import { canonicalOutgoingEdges } from "../graphValidation.js";
import { loopSockets } from "../loadoutAccessors.js";
import { resolveLoopExitRoute } from "../loopExitRoutes.js";
import { loopIteratorForSocket } from "../pipeline.js";
import type { MateriaCastState, MateriaEdgeCondition, MateriaEdgeConfig, PiMateriaConfig, ResolvedMateriaSocket } from "../types.js";

export const DEFAULT_WORKFLOW_MAX_EDGE_TRAVERSALS = 25;

export function applyAssignments(state: MateriaCastState, socket: ResolvedMateriaSocket, parsed: unknown): void {
  for (const [target, source] of Object.entries(resolvedSocketConfig(socket).assign ?? {})) {
    setPath(state.data, target, resolveValue(source, state, parsed));
  }
}

export function applyAdvance(state: MateriaCastState, socket: ResolvedMateriaSocket, parsed: unknown): string | undefined {
  const advance = resolvedSocketConfig(socket).advance;
  if (!advance) return undefined;
  if (advance.when && !evaluateCondition(advance.when, state, parsed)) return undefined;
  const items = asArray(resolveValue(advance.items, state));
  const next = (state.cursors[advance.cursor] ?? 0) + 1;
  state.cursors[advance.cursor] = next;
  state.currentItemKey = undefined;
  state.currentItemLabel = undefined;
  if (next < items.length) return undefined;
  return resolveRuntimeLoopExitTarget(state, socket.id, parsed) ?? advance.done;
}

function resolveRuntimeLoopExitTarget(state: MateriaCastState, from: string, parsed: unknown): string | undefined {
  const loop = Object.values(state.pipeline.loops ?? {}).find((candidate) => loopSockets(candidate).includes(from) && candidate.exits?.some((route) => route.from === from));
  if (!loop) return undefined;
  return resolveLoopExitRoute(loop, { from, satisfied: canonicalSatisfiedOutcome(state, parsed) })?.targetSocketId;
}

export function canonicalSatisfiedOutcome(state: MateriaCastState, parsed: unknown): boolean | undefined {
  const satisfied = resolveValue(`$.${HANDOFF_SATISFIED_FIELD}`, state, parsed);
  return typeof satisfied === "boolean" ? satisfied : undefined;
}

export function selectNextTarget(state: MateriaCastState, socket: ResolvedMateriaSocket, parsed: unknown, config: PiMateriaConfig): string {
  const edge = selectMatchingEdge(canonicalOutgoingEdges(resolvedSocketConfig(socket)), canonicalSatisfiedOutcome(state, parsed));
  if (edge) {
    enforceEdgeLimit(state, socket.id, edge, config);
    return edge.to;
  }
  return "end";
}

export function enforceEdgeLimit(state: MateriaCastState, from: string, edge: MateriaEdgeConfig, config: PiMateriaConfig): void {
  const key = `${from}->${edge.to}`;
  const count = (state.edgeTraversals[key] ?? 0) + 1;
  state.edgeTraversals[key] = count;
  const limit = edge.maxTraversals ?? config.limits?.maxEdgeTraversals ?? DEFAULT_WORKFLOW_MAX_EDGE_TRAVERSALS;
  if (count > limit) throw new Error(`Materia edge traversal limit exceeded for ${key} (${count}/${limit}).`);
}

export function setCurrentItem(state: MateriaCastState, socket: ResolvedMateriaSocket): boolean {
  const loop = resolvedSocketConfig(socket).foreach ?? loopIteratorForSocket(state.pipeline, socket.id);
  if (!loop) {
    state.currentItemKey = undefined;
    state.currentItemLabel = undefined;
    return true;
  }
  const cursor = loop.cursor ?? `${socket.id}Index`;
  const index = state.cursors[cursor] ?? 0;
  state.cursors[cursor] = index;
  const item = asArray(resolveValue(loop.items, state))[index];
  if (item === undefined) {
    state.currentItemKey = undefined;
    state.currentItemLabel = undefined;
    return false;
  }
  const alias = loop.as ?? "item";
  setPath(state.data, "item", item);
  setPath(state.data, "currentWorkItem", item);
  if (alias !== "item") setPath(state.data, alias, item);
  if (alias === "workItem" || loop.items.includes("workItems")) setPath(state.data, "workItem", item);
  const key = readObjectField(item, "id") ?? readObjectField(item, "key") ?? index;
  const label = readObjectField(item, "title") ?? readObjectField(item, "name") ?? key;
  state.currentItemKey = String(key);
  state.currentItemLabel = String(label);
  return true;
}

export function evaluateEdgeCondition(condition: string, state: MateriaCastState, parsed: unknown): boolean {
  const edge = selectMatchingEdge([{ when: condition as MateriaEdgeCondition, to: "_" }], canonicalSatisfiedOutcome(state, parsed));
  return Boolean(edge);
}

export function evaluateCondition(condition: string, state: MateriaCastState, parsed: unknown): boolean {
  const text = condition.trim();
  if (text === "always") return true;
  if (text === "satisfied") return resolveValue(`$.${HANDOFF_SATISFIED_FIELD}`, state, parsed) === true;
  if (text === "not_satisfied") return resolveValue(`$.${HANDOFF_SATISFIED_FIELD}`, state, parsed) === false;
  const exists = text.match(/^!?exists\((.+)\)$/);
  if (exists) {
    const value = resolveValue(exists[1].trim(), state, parsed);
    return text.startsWith("!") ? value === undefined : value !== undefined;
  }
  const match = text.match(/^(.+?)\s*(==|!=)\s*(.+)$/);
  if (!match) throw new Error(`Unsupported Materia condition: ${condition}`);
  const left = resolveValue(match[1].trim(), state, parsed);
  const right = parseLiteral(match[3].trim(), state, parsed);
  return match[2] === "==" ? left === right : left !== right;
}

function parseLiteral(input: string, state: MateriaCastState, parsed: unknown): unknown {
  if (input === "true") return true;
  if (input === "false") return false;
  if (input === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(input)) return Number(input);
  if ((input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'"))) return input.slice(1, -1);
  return resolveValue(input, state, parsed);
}

export function resolveValue(source: string, state: MateriaCastState, parsed: unknown = state.lastJson): unknown {
  if (source === "$") return parsed;
  if (source.startsWith("$.")) return getPath(parsed, source.slice(2));
  if (source === "state") return state.data;
  if (source.startsWith("state.")) return getPath(state.data, source.slice("state.".length));
  if (source === "item") return currentItem(state);
  if (source.startsWith("item.")) return getPath(currentItem(state), source.slice("item.".length));
  if (source === "lastJson") return state.lastJson;
  if (source.startsWith("lastJson.")) return getPath(state.lastJson, source.slice("lastJson.".length));
  if (source === "lastOutput") return state.lastOutput;
  return getPath(state.data, source);
}

export function currentItem(state: MateriaCastState): unknown {
  return state.data.item;
}

export function getPath(value: unknown, pathValue: string): unknown {
  if (!pathValue) return value;
  return pathValue.split(".").reduce<unknown>((current, part) => {
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(part)) return current[Number(part)];
    if (typeof current === "object") return (current as Record<string, unknown>)[part];
    return undefined;
  }, value);
}

export function setPath(target: Record<string, unknown>, pathValue: string, value: unknown): void {
  const parts = pathValue.split(".").filter(Boolean);
  if (!parts.length) throw new Error("Materia assignment target cannot be empty.");
  let current: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function readObjectField(value: unknown, field: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[field] : undefined;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function resolvedSocketConfig<TSocket extends ResolvedMateriaSocket>(socket: TSocket): TSocket["socket"] {
  // Compatibility for legacy test/fixture helpers that still construct resolved
  // sockets with `node`; canonical resolved pipelines now materialize `socket` only.
  return (socket.socket ?? (socket as unknown as { node: TSocket["socket"] }).node) as TSocket["socket"];
}
