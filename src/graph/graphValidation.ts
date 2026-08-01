import { HANDOFF_EDGE_CONDITIONS } from "../handoff/handoffContract.js";
import { validateMateriaLoopParallelConfig } from "../domain/parallelLoop.js";
import { getLoadoutSocket, loadoutSocketEntries, loadoutSocketIdSet, loopSockets, materializeCanonicalSockets } from "../loadout/loadoutAccessors.js";
import { classifyGraphTarget, formatInvalidSocketIdMessage, isCanonicalSocketId } from "../domain/socket.js";
import type { MateriaAdvanceConfig, MateriaEdgeCondition, MateriaEdgeConfig, MateriaLoopConfig, MateriaLoopExitConfig, MateriaLoopExitRouteConfig, MateriaPipelineConfig, MateriaPipelineSocketConfig } from "../types.js";

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
  /** Optional parallel-plan producer predicate for normalizer utilities. */
  isParallelPlanProducerSocket?: (socketId: string) => boolean;
  /** Alias for callers that model the normalizer explicitly. */
  isNormalizerSocket?: (socketId: string) => boolean;
}

export interface ValidatedGraphChangeResult<TGraph extends MateriaPipelineConfig = MateriaPipelineConfig> extends MateriaGraphValidationResult {
  graph: TGraph;
}

export function normalizePipelineGraph<TGraph extends MateriaPipelineConfig>(graph: TGraph): TGraph {
  const normalized = materializeCanonicalSockets(cloneGraph(graph));
  for (const [, socket] of loadoutSocketEntries(normalized)) {
    socket.edges = socket.edges && socket.edges.length > 0 ? socket.edges.map((edge) => ({ ...edge })) : undefined;
  }
  return normalized;
}

export function normalizeEdgeCondition(value: unknown): MateriaEdgeCondition {
  if (isCanonicalEdgeCondition(value)) return value;
  return value as MateriaEdgeCondition;
}

export function canonicalOutgoingEdges(socket: MateriaPipelineSocketConfig): MateriaEdgeConfig[] {
  return (socket.edges ?? []).map((edge) => ({ ...edge }));
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
  validateParallelRegionInteractions(normalized, errors, socketIds);

  // Materia graphs are workflow state machines, not DAGs: transitions may
  // intentionally revisit earlier sockets (for example Build -> Eval -> Maintain
  // -> Build). Runtime socket-visit and edge-traversal limits bound iterative
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
    const parallelMetadataIssues = validateMateriaLoopParallelConfig(loop.parallel, `loops.${loopId}.parallel`);
    for (const issue of parallelMetadataIssues) {
      errors.push({ code: "invalid-loop", source: issue.path, message: `Loop "${loopId}" has invalid parallel execution metadata at ${issue.path}: ${issue.message}.` });
    }
    for (const [index, socketId] of sockets.entries()) {
      if (!validateSocketReference(errors, socketIds, socketId, `loops.${loopId}.sockets[${index}]`)) loopSocketsAreValid = false;
    }
    const consumesFromIsValid = !loop.consumes || validateSocketReference(errors, socketIds, loop.consumes.from, `loops.${loopId}.consumes.from`, { from: loop.consumes.from });
    validateOptionalTarget(errors, socketIds, loopId, loop.consumes?.done, `loops.${loopId}.consumes.done`);
    validateOptionalTarget(errors, socketIds, loopId, loop.iterator?.done, `loops.${loopId}.iterator.done`);
    const exitIsValid = validateLoopExit(errors, socketIds, loopId, sockets, loop.exit);
    validateLoopExitRoutes(errors, socketIds, loopId, sockets, loop.exits);
    const parallelMetadataIsValid = parallelMetadataIssues.length === 0;
    if (loop.parallel && parallelMetadataIsValid && loopSocketsAreValid) {
      validateParallelLoopTopology(graph, errors, loopId, sockets, loop.consumes, loop.exit, loop.exits, options);
    } else if (!loop.parallel && loop.consumes && consumesFromIsValid && loopSocketsAreValid) {
      validateLoopTopology(graph, errors, loopId, sockets, loop.consumes.from, options);
    }
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
  const expectedAdvance: Pick<MateriaAdvanceConfig, "cursor" | "items" | "when"> = {
    cursor: consumes.cursor ?? defaultLoopCursor(output),
    items: `state.${output}`,
    when: exit.when,
  };
  if (socket.advance) {
    for (const [field, expectedValue] of Object.entries(expectedAdvance)) {
      const currentValue = socket.advance[field as keyof typeof expectedAdvance];
      if (currentValue !== expectedValue) {
        errors.push({
          code: "invalid-loop",
          source: `${exit.from}.advance.${field}`,
          from: exit.from,
          message: `${sourceLabel} field advance.${field} has current value ${JSON.stringify(currentValue)}, expected ${JSON.stringify(expectedValue)} so advance only tracks cursor movement/exhaustion for loops.${loopId}.consumes. Suggested fix: align ${exit.from}.advance.${field} with loops.${loopId}.consumes/exit condition or remove the advance block so it can be materialized.`,
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

    if (!route.targetSocketId) {
      errors.push({ code: "missing-endpoint", source: `${routeSource}.targetSocketId`, from: route.from, message: `Missing graph endpoint referenced by ${routeSource}.targetSocketId.` });
    } else {
      validateOptionalTarget(errors, socketIds, route.from, route.targetSocketId, `${routeSource}.targetSocketId`);
    }
  }
}

function validateParallelLoopTopology(
  graph: MateriaPipelineConfig,
  errors: MateriaGraphValidationError[],
  loopId: string,
  loopMemberSockets: string[],
  consumes: MateriaLoopConfig["consumes"],
  exit: MateriaLoopExitConfig | undefined,
  exits: MateriaLoopExitRouteConfig[] | undefined,
  options: MateriaGraphValidationOptions,
): void {
  const loopPath = `loops.${loopId}`;
  const loopSet = new Set(loopMemberSockets);
  const parallel = graph.loops?.[loopId]?.parallel;
  if (!parallel) return;
  const configuredExits = Array.isArray(exits) ? exits : [];

  const duplicateMembers = loopMemberSockets.filter((socketId, index) => loopMemberSockets.indexOf(socketId) !== index);
  if (duplicateMembers.length > 0) {
    errors.push({
      code: "invalid-loop",
      source: `${loopPath}.sockets`,
      message: `Parallel loop "${loopId}" has duplicate lane socket ids: ${Array.from(new Set(duplicateMembers)).join(", ")}. A parallel region must have a deterministic member boundary.`,
    });
  }

  if (!isNormalizedPlanInput(parallel.planInput)) {
    errors.push({
      code: "invalid-loop",
      source: `${loopPath}.parallel.planInput`,
      message: `Parallel loop "${loopId}" requires parallel.planInput to be a normalized-plan state path starting with "state."; received ${JSON.stringify(parallel.planInput)}.`,
    });
  }

  if (!consumes) {
    errors.push({
      code: "invalid-loop",
      source: `${loopPath}.consumes`,
      message: `Parallel loop "${loopId}" must consume workItems from exactly one generator or normalizer socket before its lanes can be scheduled.`,
    });
    return;
  }

  const consumesFrom = consumes.from;
  const inputPredicateConfigured = options.isGeneratorSocket !== undefined || options.isParallelPlanProducerSocket !== undefined || options.isNormalizerSocket !== undefined;
  const isParallelInput = inputPredicateConfigured && (
    options.isGeneratorSocket?.(consumesFrom) === true
    || options.isParallelPlanProducerSocket?.(consumesFrom) === true
    || options.isNormalizerSocket?.(consumesFrom) === true
  );
  if (inputPredicateConfigured && !isParallelInput) {
    errors.push({
      code: "invalid-loop",
      source: `${loopPath}.consumes.from`,
      from: consumesFrom,
      message: `Parallel loop "${loopId}" consumes "${consumesFrom}", but that socket is not declared as a generator or parallel normalizer input.`,
    });
  }
  if (consumes.output !== undefined && consumes.output !== "workItems") {
    errors.push({
      code: "invalid-loop",
      source: `${loopPath}.consumes.output`,
      from: consumesFrom,
      message: `Parallel loop "${loopId}" must consume the canonical workItems list; custom loop output ${JSON.stringify(consumes.output)} cannot be normalized into ordered lanes.`,
    });
  }

  if (!containsDirectedCycle(graph, loopSet)) {
    errors.push({ code: "invalid-loop", source: `${loopPath}.sockets`, message: `Parallel loop "${loopId}" must contain a directed cycle among its selected lane sockets.` });
  }

  const inboundEdges = loadoutSocketEntries(graph).flatMap(([from, socket]) => {
    if (loopSet.has(from)) return [];
    return (socket.edges ?? []).filter((edge) => loopSet.has(edge.to)).map((edge) => ({ from, to: edge.to, edgeWhen: edge.when }));
  });
  if (inboundEdges.length === 0) {
    errors.push({ code: "invalid-loop", source: `${loopPath}.consumes`, from: consumesFrom, message: `Parallel loop "${loopId}" requires one deterministic inbound edge from "${consumesFrom}" into its lane subgraph; found none.` });
  } else if (inboundEdges.length > 1) {
    const details = inboundEdges.map((edge) => `${edge.from}->${edge.to}`).join(", ");
    errors.push({ code: "invalid-loop", source: `${loopPath}.consumes`, from: consumesFrom, message: `Parallel loop "${loopId}" has an ambiguous entry boundary. Expected exactly one inbound edge from its generator/normalizer, found ${inboundEdges.length}: ${details}.` });
  } else if (inboundEdges[0]?.from !== consumesFrom) {
    errors.push({ code: "invalid-loop", source: `${loopPath}.consumes.from`, from: consumesFrom, message: `Parallel loop "${loopId}" consumes "${consumesFrom}" but its only inbound lane edge comes from "${inboundEdges[0]?.from}".` });
  } else if (inboundEdges[0]?.edgeWhen !== "always") {
    errors.push({ code: "invalid-loop", source: `${loopPath}.consumes`, from: consumesFrom, message: `Parallel loop "${loopId}" requires an unconditional generator/normalizer entry edge; its boundary uses condition "${inboundEdges[0]?.edgeWhen}".` });
  }

  const entrySocket = inboundEdges.length === 1 ? inboundEdges[0]?.to : undefined;
  if (entrySocket && !reachableWithinLoop(graph, entrySocket, loopSet)) {
    const unreachable = loopMemberSockets.filter((socketId) => !reachableWithinLoop(graph, entrySocket, loopSet, socketId));
    if (unreachable.length > 0) {
      errors.push({ code: "invalid-loop", source: `${loopPath}.sockets`, message: `Parallel loop "${loopId}" has unreachable lane sockets from deterministic entry "${entrySocket}": ${unreachable.join(", ")}.` });
    }
  }

  const terminalSources = new Set<string>();
  if (exit?.from) terminalSources.add(exit.from);
  for (const route of configuredExits) if (route?.from) terminalSources.add(route.from);
  const validTerminalSources = Array.from(terminalSources).filter((socketId) => loopSet.has(socketId));
  if (terminalSources.size === 0) {
    errors.push({ code: "invalid-loop", source: `${loopPath}.exit`, message: `Parallel loop "${loopId}" requires one explicit terminal boundary via exit.from or loop-exit routes.` });
  } else if (terminalSources.size !== 1 || validTerminalSources.length !== terminalSources.size) {
    errors.push({ code: "invalid-loop", source: `${loopPath}.exit`, message: `Parallel loop "${loopId}" has ambiguous terminal boundaries. exit.from and every parallel fan-in route must identify the same member socket.` });
  }
  const terminalSource = validTerminalSources.length === 1 && terminalSources.size === 1 ? validTerminalSources[0] : undefined;
  if (terminalSource) {
    const cannotReachTerminal = loopMemberSockets.filter((socketId) => !canReachWithinLoop(graph, socketId, terminalSource, loopSet));
    if (cannotReachTerminal.length > 0) {
      errors.push({ code: "invalid-loop", source: `${loopPath}.sockets`, message: `Parallel loop "${loopId}" has lane sockets that cannot reach terminal boundary "${terminalSource}": ${cannotReachTerminal.join(", ")}.` });
    }
  }

  for (const from of loopMemberSockets) {
    const socket = getLoadoutSocket(graph, from);
    for (const [index, edge] of (socket?.edges ?? []).entries()) {
      if (loopSet.has(edge.to)) continue;
      errors.push({
        code: "invalid-loop",
        source: `${from}.edges[${index}].to`,
        from,
        to: edge.to,
        message: `Parallel loop "${loopId}" has a parent route from lane socket "${from}" to "${edge.to}". Lane sockets must terminate through the symbolic parallel fan-in routes, not direct parent edges.`,
      });
    }
    for (const [field, target] of [["foreach.done", socket?.foreach?.done], ["advance.done", socket?.advance?.done]] as const) {
      if (target && target !== "end" && !loopSet.has(target)) {
        errors.push({
          code: "invalid-loop",
          source: `${from}.${field}`,
          from,
          to: target,
          message: `Parallel loop "${loopId}" has a parent route from lane socket "${from}" through ${field} to "${target}". Lane exhaustion must terminate locally before symbolic fan-in.`,
        });
      }
    }
  }

  const fanInRoutes = configuredExits.filter((route) => route?.from === terminalSource);
  const cleanRoute = fanInRoutes.find((route) => route.condition === "satisfied");
  const conflictRoute = fanInRoutes.find((route) => route.condition === "not_satisfied");
  if (!terminalSource || !cleanRoute || !conflictRoute) {
    errors.push({
      code: "invalid-loop",
      source: `${loopPath}.exits`,
      message: `Parallel loop "${loopId}" must define compatible fan-in exits from one terminal boundary: a satisfied clean-join route and a not_satisfied conflict/resolver route.`,
    });
  } else {
    validateParallelFanInTarget(errors, graph, loopId, cleanRoute, loopSet, "clean join");
    validateParallelFanInTarget(errors, graph, loopId, conflictRoute, loopSet, "conflict resolver");
    if (cleanRoute.targetSocketId === conflictRoute.targetSocketId) {
      errors.push({ code: "invalid-loop", source: `${loopPath}.exits`, message: `Parallel loop "${loopId}" routes clean fan-in and conflicted fan-in to the same socket "${cleanRoute.targetSocketId}"; configure distinct join and resolver boundaries.` });
    }
  }

  if (exit?.to && exit.to !== "end") {
    errors.push({ code: "invalid-loop", source: `${loopPath}.exit.to`, from: exit.from, to: exit.to, message: `Parallel loop "${loopId}" exit.to must be the local terminal "end"; parent completion must use symbolic fan-in exits instead of routing directly to "${exit.to}".` });
  }
  const loop = graph.loops?.[loopId];
  for (const [field, target] of [["consumes.done", loop?.consumes?.done], ["iterator.done", loop?.iterator?.done]] as const) {
    if (target && target !== "end" && !loopSet.has(target)) {
      errors.push({ code: "invalid-loop", source: `${loopPath}.${field}`, from: terminalSource, to: target, message: `Parallel loop "${loopId}" ${field} must terminate locally at "end"; parent completion must use symbolic fan-in exits.` });
    }
  }
}

function validateParallelFanInTarget(
  errors: MateriaGraphValidationError[],
  graph: MateriaPipelineConfig,
  loopId: string,
  route: MateriaLoopExitRouteConfig,
  loopSet: Set<string>,
  label: string,
): void {
  const target = route.targetSocketId;
  if (target === "end") {
    errors.push({ code: "invalid-loop", source: `loops.${loopId}.exits`, from: route.from, to: target, message: `Parallel loop "${loopId}" ${label} route cannot terminate at "end"; it needs an explicit post-integration socket.` });
    return;
  }
  if (loopSet.has(target)) {
    errors.push({ code: "invalid-loop", source: `loops.${loopId}.exits`, from: route.from, to: target, message: `Parallel loop "${loopId}" ${label} route targets lane socket "${target}". Fan-in targets must be outside the parallel region.` });
    return;
  }
  if (!getLoadoutSocket(graph, target)) return;
}

function validateParallelRegionInteractions(graph: MateriaPipelineConfig, errors: MateriaGraphValidationError[], socketIds: Set<string>): void {
  const parallelRegions = Object.entries(graph.loops ?? {})
    .filter(([, loop]) => Boolean(loop?.parallel))
    .map(([loopId, loop]) => ({ loopId, members: loopSockets(loop).filter((socketId) => socketIds.has(socketId)) }));

  for (let leftIndex = 0; leftIndex < parallelRegions.length; leftIndex += 1) {
    const left = parallelRegions[leftIndex]!;
    const leftMembers = new Set(left.members);
    for (let rightIndex = leftIndex + 1; rightIndex < parallelRegions.length; rightIndex += 1) {
      const right = parallelRegions[rightIndex]!;
      const overlap = right.members.filter((socketId) => leftMembers.has(socketId));
      if (overlap.length === 0) continue;
      errors.push({
        code: "invalid-loop",
        source: `loops.${left.loopId}.sockets`,
        message: `Parallel loops "${left.loopId}" and "${right.loopId}" overlap or nest through lane sockets ${Array.from(new Set(overlap)).join(", ")}. Parallel regions must be disjoint; nested parallel execution is not supported.`,
      });
    }
  }
}

function isNormalizedPlanInput(value: unknown): value is string {
  return typeof value === "string" && /^state\.[A-Za-z_$][A-Za-z0-9_$-]*(?:\.[A-Za-z0-9_$-]+)*$/.test(value.trim());
}

function reachableWithinLoop(graph: MateriaPipelineConfig, start: string, loopSet: Set<string>, target?: string): boolean {
  const visited = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    if (target === undefined && visited.size === loopSet.size) return true;
    if (target !== undefined && current === target) return true;
    for (const edge of getLoadoutSocket(graph, current)?.edges ?? []) {
      if (loopSet.has(edge.to) && !visited.has(edge.to)) queue.push(edge.to);
    }
  }
  return target === undefined ? visited.size === loopSet.size : false;
}

function canReachWithinLoop(graph: MateriaPipelineConfig, start: string, target: string, loopSet: Set<string>): boolean {
  return reachableWithinLoop(graph, start, loopSet, target);
}

function validateLoopTopology(graph: MateriaPipelineConfig, errors: MateriaGraphValidationError[], loopId: string, loopMemberSockets: string[], consumesFrom: string, options: MateriaGraphValidationOptions): void {
  const loopSet = new Set(loopMemberSockets);
  if (!containsDirectedCycle(graph, loopSet)) {
    errors.push({ code: "invalid-loop", source: `loops.${loopId}.sockets`, message: `Loop "${loopId}" must contain a directed cycle among its selected sockets before it can be created.` });
  }
  const isGeneratorSocket = options.isGeneratorSocket;
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

function validateOptionalTarget(errors: MateriaGraphValidationError[], socketIds: Set<string>, from: string, to: string | undefined, source: string, options: { allowTerminal?: boolean } = {}): void {
  if (!to) {
    if (source.includes(".edges[")) errors.push({ code: "missing-endpoint", source, from, message: `Missing graph endpoint referenced by ${source}.` });
    return;
  }
  const classification = classifyGraphTarget(to, socketIds);
  if (classification.kind === "terminal") {
    if (options.allowTerminal === false) errors.push({ code: "invalid-socket-id", source, from, to, message: `Terminal graph target "${to}" is not valid for ${source}; expected an existing socket id.` });
    return;
  }
  if (!validateSocketId(errors, to, source, { from, to })) return;
  if (classification.kind === "unknown") errors.push({ code: "unknown-endpoint", source, from, to, message: `Unknown graph endpoint "${to}" referenced by ${source}.` });
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
