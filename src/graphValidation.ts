import { HANDOFF_EDGE_CONDITIONS } from "./handoffContract.js";
import { getLoadoutSocket, loadoutSocketEntries, loadoutSocketIdSet, loopSockets, materializeCanonicalSockets } from "./loadoutAccessors.js";
import { formatInvalidSocketIdMessage, isCanonicalSocketId } from "./socketIds.js";
import type { LegacyMateriaPipelineSocketConfig, MateriaAdvanceConfig, MateriaEdgeCondition, MateriaEdgeConfig, MateriaLoopConfig, MateriaLoopExitConfig, MateriaLoopExitRouteConfig, MateriaPipelineConfig, MateriaPipelineSocketConfig } from "./types.js";

export const CANONICAL_EDGE_CONDITIONS = HANDOFF_EDGE_CONDITIONS;
export type MateriaGraphEdgeCondition = MateriaEdgeCondition | "invalid";
export type MateriaGraphEdgeGuard = "unconditional" | "guarded";

export interface MateriaGraphValidationError {
  code: "missing-endpoint" | "unknown-endpoint" | "invalid-socket-id" | "invalid-edge-condition" | "unreachable-edge" | "invalid-loop";
  message: string;
  source?: string;
  from?: string;
  to?: string;
}

export interface MateriaGraphValidationResult {
  ok: boolean;
  errors: MateriaGraphValidationError[];
}

export interface MateriaGraphValidationOptions {
  isGeneratorSocket?: (socketId: string) => boolean;
  /** @deprecated Compatibility alias for callers not yet migrated to isGeneratorSocket. */
  isGeneratorNode?: (socketId: string) => boolean;
}

export interface ValidatedGraphChangeResult<TGraph extends MateriaPipelineConfig = MateriaPipelineConfig> extends MateriaGraphValidationResult {
  graph: TGraph;
}

export function normalizePipelineGraph<TGraph extends MateriaPipelineConfig>(graph: TGraph): TGraph {
  const normalized = materializeCanonicalSockets(cloneGraph(graph));
  for (const [, socket] of loadoutSocketEntries(normalized) as [string, LegacyMateriaPipelineSocketConfig][]) {
    const edges = (socket.edges ?? []).map((edge) => ({ ...edge, when: normalizeEdgeCondition(edge.when) }));
    if (socket.next) edges.push({ when: "always", to: socket.next });
    socket.edges = edges.length > 0 ? edges : undefined;
    delete socket.next;
  }
  return normalized;
}

export function normalizeEdgeCondition(value: unknown): MateriaEdgeCondition {
  if (value === undefined || value === "" || value === "flow" || value === "Flow") return "always";
  if (isCanonicalEdgeCondition(value)) return value;
  return value as MateriaEdgeCondition;
}

export function canonicalOutgoingEdges(socket: MateriaPipelineSocketConfig): MateriaEdgeConfig[] {
  const legacySocket = socket as LegacyMateriaPipelineSocketConfig;
  const edges = (legacySocket.edges ?? []).map((edge) => ({ ...edge, when: normalizeEdgeCondition(edge.when) }));
  if (legacySocket.next) edges.push({ when: "always", to: legacySocket.next });
  return edges;
}

export function validatePipelineGraph(graph: MateriaPipelineConfig, options: MateriaGraphValidationOptions = {}): MateriaGraphValidationResult {
  const normalized = normalizePipelineGraph(graph);
  const errors: MateriaGraphValidationError[] = [];
  const socketIds = loadoutSocketIdSet(normalized);

  for (const id of socketIds) validateSocketId(errors, id, `sockets.${id}`);
  validateSocketReference(errors, socketIds, graph.entry, "entry");

  for (const [id, socket] of loadoutSocketEntries(normalized)) {
    const errorCountBeforeSocket = errors.length;
    validateSocketLinks(id, socket, errors, socketIds);
    if (errors.length === errorCountBeforeSocket) validateOutgoingEdgeConditions(id, socket.edges ?? [], errors);
  }
  validateLoops(normalized, errors, socketIds, options);

  // Materia graphs are workflow state machines, not DAGs: transitions may
  // intentionally revisit earlier sockets (for example Build -> Eval -> Maintain
  // -> Build). Runtime node-visit and edge-traversal limits bound iterative
  // execution, so validation only checks structural graph integrity here.
  return { ok: errors.length === 0, errors };
}

export function assertValidPipelineGraph(graph: MateriaPipelineConfig, options: MateriaGraphValidationOptions = {}): void {
  const result = validatePipelineGraph(graph, options);
  if (!result.ok) throw new Error(formatGraphValidationErrors(result.errors));
}

export function stageValidatedPipelineGraphChange<TGraph extends MateriaPipelineConfig>(graph: TGraph, mutator: (draft: TGraph) => void, options: MateriaGraphValidationOptions = {}): ValidatedGraphChangeResult<TGraph> {
  const draft = cloneGraph(graph);
  mutator(draft);
  return stageValidatedPipelineGraphTransform(graph, () => draft, options);
}

export function stageValidatedPipelineGraphTransform<TGraph extends MateriaPipelineConfig>(graph: TGraph, transform: (current: TGraph) => TGraph, options: MateriaGraphValidationOptions = {}): ValidatedGraphChangeResult<TGraph> {
  const changed = transform(graph);
  const normalized = normalizePipelineGraph(changed);
  const result = validatePipelineGraph(normalized, options);
  return { graph: result.ok ? normalized : graph, ok: result.ok, errors: result.errors };
}

export function formatGraphValidationErrors(errors: MateriaGraphValidationError[]): string {
  return errors.map((error) => error.message).join("\n");
}

export function isCanonicalEdgeCondition(value: unknown): value is MateriaEdgeCondition {
  return typeof value === "string" && (CANONICAL_EDGE_CONDITIONS as readonly string[]).includes(value);
}

export function edgeConditionState(edge: { when?: unknown }): MateriaGraphEdgeCondition {
  return isCanonicalEdgeCondition(edge.when) ? edge.when : "invalid";
}

export function edgeGuard(edge: { when?: unknown }): MateriaGraphEdgeGuard {
  return edgeConditionState(edge) === "always" ? "unconditional" : "guarded";
}

function validateSocketLinks(id: string, socket: MateriaPipelineSocketConfig, errors: MateriaGraphValidationError[], socketIds: Set<string>): void {
  const legacySocket = socket as LegacyMateriaPipelineSocketConfig;
  validateOptionalTarget(errors, socketIds, id, legacySocket.next, `${id}.next`);
  validateOptionalTarget(errors, socketIds, id, socket.foreach?.done, `${id}.foreach.done`);
  validateOptionalTarget(errors, socketIds, id, socket.advance?.done, `${id}.advance.done`);
  for (const [index, edge] of (socket.edges ?? []).entries()) {
    validateOptionalTarget(errors, socketIds, id, edge.to, `${id}.edges[${index}].to`);
  }
}

function validateOutgoingEdgeConditions(id: string, edges: MateriaEdgeConfig[], errors: MateriaGraphValidationError[]): void {
  // Runtime treats outgoing edges as an ordered guard list: the first edge with
  // `when: "always"`, or whose canonical condition evaluates truthy, wins.
  // Only the closed canonical set is valid, and edges after an `always` edge are
  // structurally unreachable and rejected.
  let firstUnconditional: number | undefined;
  for (const [index, edge] of edges.entries()) {
    const validCondition = isCanonicalEdgeCondition(edge.when);
    if (!validCondition) {
      errors.push({
        code: "invalid-edge-condition",
        source: `${id}.edges[${index}].when`,
        from: id,
        to: edge.to,
        message: `Socket "${id}" has invalid edge condition at ${id}.edges[${index}].when. Expected one of: ${CANONICAL_EDGE_CONDITIONS.join(", ")}.`,
      });
    }
    if (firstUnconditional !== undefined) {
      errors.push({
        code: "unreachable-edge",
        source: `${id}.edges[${index}]`,
        from: id,
        message: `Socket "${id}" has an unreachable outgoing edge at ${id}.edges[${index}] because ${id}.edges[${firstUnconditional}] is unconditional and runtime selects the first satisfied edge in order.`,
      });
      continue;
    }
    if (validCondition && edgeGuard(edge) === "unconditional") firstUnconditional = index;
  }
}

function validateLoops(graph: MateriaPipelineConfig, errors: MateriaGraphValidationError[], socketIds: Set<string>, options: MateriaGraphValidationOptions): void {
  for (const [loopId, loop] of Object.entries(graph.loops ?? {})) {
    const sockets = loopSockets(loop);
    if (!Array.isArray(sockets) || sockets.length === 0) {
      errors.push({ code: "invalid-loop", source: `loops.${loopId}.sockets`, message: `Loop "${loopId}" must include at least one socket id in loops.${loopId}.sockets.` });
      continue;
    }
    let loopSocketsAreValid = true;
    for (const [index, socketId] of sockets.entries()) {
      if (!validateSocketReference(errors, socketIds, socketId, `loops.${loopId}.sockets[${index}]`)) loopSocketsAreValid = false;
    }
    const consumesFromIsValid = !loop.consumes || validateSocketReference(errors, socketIds, loop.consumes.from, `loops.${loopId}.consumes.from`, { from: loop.consumes.from });
    validateOptionalTarget(errors, socketIds, loopId, loop.consumes?.done, `loops.${loopId}.consumes.done`);
    validateOptionalTarget(errors, socketIds, loopId, loop.iterator?.done, `loops.${loopId}.iterator.done`);
    const exitIsValid = validateLoopExit(errors, socketIds, loopId, sockets, loop.exit);
    validateLoopExitRoutes(errors, socketIds, loopId, sockets, loop.exits);
    if (loop.consumes && consumesFromIsValid && loopSocketsAreValid) validateLoopTopology(graph, errors, loopId, sockets, loop.consumes.from, options);
    if (loop.consumes && loopSocketsAreValid && exitIsValid) validateExecutableLoopSemantics(graph, errors, loopId, sockets, loop.consumes, loop.exit);
  }
}

function validateExecutableLoopSemantics(graph: MateriaPipelineConfig, errors: MateriaGraphValidationError[], loopId: string, loopMemberSockets: string[], consumes: NonNullable<MateriaLoopConfig["consumes"]>, exit: MateriaLoopExitConfig | undefined): void {
  if (!exit) return;

  const socket = getLoadoutSocket(graph, exit.from);
  if (!socket) return;
  const sourceLabel = `Loop "${loopId}" exit source "${exit.from}"`;
  if ((exit.when === "satisfied" || exit.when === "not_satisfied") && socket.parse !== undefined && socket.parse !== "json") {
    errors.push({
      code: "invalid-loop",
      source: `${exit.from}.parse`,
      from: exit.from,
      message: `${sourceLabel} field parse has current value ${JSON.stringify(socket.parse)}, expected "json" because loops.${loopId}.exit.when is "${exit.when}" and runtime reads the canonical satisfied JSON field. Suggested fix: set ${exit.from}.parse to "json" or choose an unconditional exit condition.`,
    });
  }

  const output = consumes.output ?? "workItems";
  const expectedAdvance: MateriaAdvanceConfig = {
    cursor: consumes.cursor ?? defaultLoopCursor(output),
    items: `state.${output}`,
    done: exit.to,
    when: exit.when,
  };
  if (socket.advance) {
    for (const [field, expectedValue] of Object.entries(expectedAdvance)) {
      const currentValue = socket.advance[field as keyof MateriaAdvanceConfig];
      if (currentValue !== expectedValue) {
        errors.push({
          code: "invalid-loop",
          source: `${exit.from}.advance.${field}`,
          from: exit.from,
          message: `${sourceLabel} field advance.${field} has current value ${JSON.stringify(currentValue)}, expected ${JSON.stringify(expectedValue)} so loops.${loopId}.exit plus consumes can compile to canonical runtime control flow. Suggested fix: align ${exit.from}.advance.${field} with loops.${loopId}.consumes/exit or remove the advance block so it can be materialized.`,
        });
      }
    }
  }

  const continuationEdges = canonicalOutgoingEdges(socket).filter((edge) => loopMemberSockets.includes(edge.to));
  if (continuationEdges.length === 0) {
    errors.push({
      code: "invalid-loop",
      source: `${exit.from}.edges`,
      from: exit.from,
      message: `${sourceLabel} has no outgoing route back into loop members (${loopMemberSockets.join(", ")}) for non-final consumed items after advance runs. Suggested fix: add an always edge, or an opposite-condition retry edge, from ${exit.from} to a loop socket.`,
    });
  }

  const hasConditionalContinuation = continuationEdges.some((edge) => edge.when !== "always");
  const opposite = oppositeCondition(exit.when);
  if (hasConditionalContinuation && opposite && !continuationEdges.some((edge) => edge.when === opposite)) {
    errors.push({
      code: "invalid-loop",
      source: `${exit.from}.edges`,
      from: exit.from,
      message: `${sourceLabel} uses conditional continuation edges but has no ${opposite} route back into the loop for retry/opposite-condition execution. Current continuation conditions: ${continuationEdges.map((edge) => edge.when).join(", ")}. Expected an ${opposite} edge or an always edge. Suggested fix: add ${exit.from} --${opposite}--> <loop socket>, or use an unconditional back-edge when advance should control final completion.`,
    });
  }
}

function defaultLoopCursor(output: string): string {
  return output === "workItems" ? "workItemIndex" : `${output}Index`;
}

function oppositeCondition(condition: MateriaEdgeCondition): MateriaEdgeCondition | undefined {
  if (condition === "satisfied") return "not_satisfied";
  if (condition === "not_satisfied") return "satisfied";
  return undefined;
}

function validateLoopExit(errors: MateriaGraphValidationError[], socketIds: Set<string>, loopId: string, loopMemberSockets: string[], exit: MateriaLoopExitConfig | undefined): boolean {
  if (!exit) return true;
  const errorCount = errors.length;
  validateOptionalTarget(errors, socketIds, loopId, exit.to, `loops.${loopId}.exit.to`);
  if (!exit.from) {
    errors.push({ code: "missing-endpoint", source: `loops.${loopId}.exit.from`, message: `Missing graph endpoint referenced by loops.${loopId}.exit.from.` });
  } else if (!validateSocketId(errors, exit.from, `loops.${loopId}.exit.from`, { from: exit.from })) {
    return false;
  } else if (!socketIds.has(exit.from)) {
    errors.push({ code: "unknown-endpoint", source: `loops.${loopId}.exit.from`, from: exit.from, message: `Unknown graph endpoint "${exit.from}" referenced by loops.${loopId}.exit.from.` });
  } else if (!loopMemberSockets.includes(exit.from)) {
    errors.push({ code: "invalid-loop", source: `loops.${loopId}.exit.from`, from: exit.from, message: `Loop "${loopId}" exit source "${exit.from}" must be one of its member sockets: ${loopMemberSockets.join(", ")}.` });
  }
  if (!isCanonicalEdgeCondition(exit.when)) {
    errors.push({ code: "invalid-edge-condition", source: `loops.${loopId}.exit.when`, from: exit.from, to: exit.to, message: `Loop "${loopId}" has invalid exit condition at loops.${loopId}.exit.when. Expected one of: ${CANONICAL_EDGE_CONDITIONS.join(", ")}.` });
  }
  return errors.length === errorCount;
}

function validateLoopExitRoutes(errors: MateriaGraphValidationError[], socketIds: Set<string>, loopId: string, loopMemberSockets: string[], exits: MateriaLoopExitRouteConfig[] | undefined): void {
  if (exits === undefined) return;
  if (!Array.isArray(exits)) {
    errors.push({ code: "invalid-loop", source: `loops.${loopId}.exits`, message: `Loop "${loopId}" exits must be an array of loop-owned exit route records.` });
    return;
  }

  const seenRouteIds = new Set<string>();
  const seenConditionsBySource = new Set<string>();
  for (const [index, route] of exits.entries()) {
    const routeSource = `loops.${loopId}.exits[${index}]`;
    if (!route || typeof route !== "object") {
      errors.push({ code: "invalid-loop", source: routeSource, message: `Loop "${loopId}" has a malformed loop-exit route at ${routeSource}.` });
      continue;
    }

    if (typeof route.id !== "string" || route.id.trim() === "") {
      errors.push({ code: "invalid-loop", source: `${routeSource}.id`, message: `Loop "${loopId}" loop-exit route at ${routeSource} must include a stable non-empty id.` });
    } else if (seenRouteIds.has(route.id)) {
      errors.push({ code: "invalid-loop", source: `${routeSource}.id`, message: `Loop "${loopId}" has duplicate loop-exit route id "${route.id}". Route ids must be stable and unique within the owning loop.` });
    } else {
      seenRouteIds.add(route.id);
    }

    if (!route.from) {
      errors.push({ code: "missing-endpoint", source: `${routeSource}.from`, message: `Missing graph endpoint referenced by ${routeSource}.from.` });
    } else if (validateSocketId(errors, route.from, `${routeSource}.from`, { from: route.from })) {
      if (!socketIds.has(route.from)) {
        errors.push({ code: "unknown-endpoint", source: `${routeSource}.from`, from: route.from, message: `Unknown graph endpoint "${route.from}" referenced by ${routeSource}.from.` });
      } else if (!loopMemberSockets.includes(route.from)) {
        errors.push({ code: "invalid-loop", source: `${routeSource}.from`, from: route.from, message: `Loop "${loopId}" loop-exit route source "${route.from}" must be one of its member sockets: ${loopMemberSockets.join(", ")}.` });
      }
    }

    if (!isCanonicalEdgeCondition(route.condition)) {
      errors.push({ code: "invalid-edge-condition", source: `${routeSource}.condition`, from: route.from, to: route.targetSocketId, message: `Loop "${loopId}" has invalid loop-exit route condition at ${routeSource}.condition. Expected one of: ${CANONICAL_EDGE_CONDITIONS.join(", ")}.` });
    } else if (route.from) {
      const conditionKey = `${route.from}\u0000${route.condition}`;
      if (seenConditionsBySource.has(conditionKey)) {
        errors.push({ code: "invalid-loop", source: `${routeSource}.condition`, from: route.from, to: route.targetSocketId, message: `Loop "${loopId}" has more than one ${route.condition} loop-exit route from "${route.from}". Only one route per condition per loop exit source is allowed.` });
      } else {
        seenConditionsBySource.add(conditionKey);
      }
    }

    validateSocketReference(errors, socketIds, route.targetSocketId, `${routeSource}.targetSocketId`, { from: route.from, to: route.targetSocketId });
  }
}

function validateLoopTopology(graph: MateriaPipelineConfig, errors: MateriaGraphValidationError[], loopId: string, loopMemberSockets: string[], consumesFrom: string, options: MateriaGraphValidationOptions): void {
  const loopSet = new Set(loopMemberSockets);
  if (!containsDirectedCycle(graph, loopSet)) {
    errors.push({ code: "invalid-loop", source: `loops.${loopId}.sockets`, message: `Loop "${loopId}" must contain a directed cycle among its selected sockets before it can be created.` });
  }
  const isGeneratorSocket = options.isGeneratorSocket ?? options.isGeneratorNode;
  if (!isGeneratorSocket) return;

  const inboundGeneratorEdges = loadoutSocketEntries(graph).flatMap(([from, socket]) => {
    if (loopSet.has(from) || !isGeneratorSocket(from)) return [];
    return (socket.edges ?? []).filter((edge) => loopSet.has(edge.to)).map((edge) => ({ from, to: edge.to }));
  });

  if (inboundGeneratorEdges.length === 0) {
    errors.push({ code: "invalid-loop", source: `loops.${loopId}.consumes`, message: `Loop "${loopId}" must have exactly one inbound edge from a generator socket into the selected cycle; found none.` });
  } else if (inboundGeneratorEdges.length > 1) {
    const details = inboundGeneratorEdges.map((edge) => `${edge.from}->${edge.to}`).join(", ");
    errors.push({ code: "invalid-loop", source: `loops.${loopId}.consumes`, message: `Loop "${loopId}" must have exactly one inbound edge from a generator socket into the selected cycle; found ${inboundGeneratorEdges.length}: ${details}.` });
  } else if (inboundGeneratorEdges[0]?.from !== consumesFrom) {
    errors.push({ code: "invalid-loop", source: `loops.${loopId}.consumes.from`, from: consumesFrom, message: `Loop "${loopId}" consumes "${consumesFrom}" but its only inbound generator edge comes from "${inboundGeneratorEdges[0]?.from}".` });
  }
}

function containsDirectedCycle(graph: MateriaPipelineConfig, loopSet: Set<string>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (socketId: string): boolean => {
    if (visiting.has(socketId)) return true;
    if (visited.has(socketId)) return false;
    visiting.add(socketId);
    for (const edge of getLoadoutSocket(graph, socketId)?.edges ?? []) {
      if (loopSet.has(edge.to) && visit(edge.to)) return true;
    }
    visiting.delete(socketId);
    visited.add(socketId);
    return false;
  };
  return Array.from(loopSet).some((socketId) => visit(socketId));
}

function validateOptionalTarget(errors: MateriaGraphValidationError[], socketIds: Set<string>, from: string, to: string | undefined, source: string): void {
  if (!to) {
    if (source.includes(".edges[")) errors.push({ code: "missing-endpoint", source, from, message: `Missing graph endpoint referenced by ${source}.` });
    return;
  }
  if (to === "end") return;
  if (!validateSocketId(errors, to, source, { from, to })) return;
  if (!socketIds.has(to)) errors.push({ code: "unknown-endpoint", source, from, to, message: `Unknown graph endpoint "${to}" referenced by ${source}.` });
}

function validateSocketReference(errors: MateriaGraphValidationError[], socketIds: Set<string>, to: string | undefined, source: string, endpoint: Pick<MateriaGraphValidationError, "from" | "to"> = { to }): boolean {
  if (!to) {
    errors.push({ code: "missing-endpoint", source, message: `Missing graph endpoint referenced by ${source}.` });
    return false;
  }
  if (!validateSocketId(errors, to, source, endpoint)) return false;
  if (!socketIds.has(to)) {
    errors.push({ code: "unknown-endpoint", source, to, message: `Unknown graph endpoint "${to}" referenced by ${source}.` });
    return false;
  }
  return true;
}

function validateSocketId(errors: MateriaGraphValidationError[], value: string, source: string, endpoint: Pick<MateriaGraphValidationError, "from" | "to"> = {}): boolean {
  if (isCanonicalSocketId(value)) return true;
  errors.push({ code: "invalid-socket-id", source, ...endpoint, message: formatInvalidSocketIdMessage(value, source) });
  return false;
}


function cloneGraph<TGraph extends MateriaPipelineConfig>(graph: TGraph): TGraph {
  return JSON.parse(JSON.stringify(graph)) as TGraph;
}
