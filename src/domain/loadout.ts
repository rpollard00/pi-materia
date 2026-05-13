import { HANDOFF_EDGE_CONDITIONS, isHandoffEdgeCondition, type HandoffEdgeCondition } from "./handoff.js";
import { err, ok, type DomainIssue, type DomainResult } from "./result.js";
import { classifyGraphTarget, isCanonicalSocketId } from "./socket.js";

export type MateriaParseMode = "text" | "json";
export type MateriaSocketKind = "entry" | "normal";
export type MateriaSocketType = "agent" | "utility";
export type MateriaCastSocketState = "awaiting_agent_response" | "awaiting_user_refinement" | "running_utility" | "idle" | "complete" | "failed";
export type MateriaRoutingOutcome = { kind: "next"; to: SocketId; condition: HandoffEdgeCondition } | { kind: "complete" } | { kind: "blocked"; reason: string };
export type SocketId = string;
export type MateriaId = string;
export type LoadoutId = string;

export interface ArtifactMetadata {
  phase: string;
  socketId?: SocketId;
  materiaId?: MateriaId;
  workItemId?: string;
  kind?: string;
  timestamp: number;
}

export interface PromptIntent {
  socketId: SocketId;
  materiaId: MateriaId;
  parse: MateriaParseMode;
  workItemId?: string;
  includeHandoffContract: boolean;
}

export interface Loadout {
  id?: LoadoutId;
  entry: SocketId;
  sockets: Record<SocketId, LoadoutSocket>;
  loops?: Record<string, LoadoutLoop>;
}

export type LoadoutSocket = AgentSocket | UtilitySocket;

export interface LoadoutSocketCommon {
  type: MateriaSocketType;
  socketKind?: MateriaSocketKind;
  parse?: MateriaParseMode;
  assign?: Record<string, string>;
  edges?: LoadoutEdge[];
  foreach?: ForeachConfig;
  advance?: AdvanceConfig;
  empty?: boolean;
}

export interface AgentSocket extends LoadoutSocketCommon {
  type: "agent";
  materia: MateriaId;
}

export interface UtilitySocket extends LoadoutSocketCommon {
  type: "utility";
  utility?: string;
  command?: string[];
  params?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface LoadoutEdge {
  when: HandoffEdgeCondition;
  to: SocketId;
  maxTraversals?: number;
}

export interface ForeachConfig {
  items: string;
  as?: string;
  cursor?: string;
  done?: SocketId;
}

export interface AdvanceConfig {
  cursor: string;
  items: string;
  done?: SocketId;
  when?: HandoffEdgeCondition;
}

export interface LoadoutLoop {
  label?: string;
  sockets: SocketId[];
  consumes?: LoadoutLoopConsumer;
  iterator?: ForeachConfig;
  exit?: LoadoutLoopExit;
  exits?: LoadoutLoopExitRoute[];
}

export interface LoadoutLoopExit {
  from: SocketId;
  when: HandoffEdgeCondition;
  to: SocketId;
}

export interface LoadoutLoopConsumer {
  from: SocketId;
  output?: string;
  as?: string;
  cursor?: string;
  done?: SocketId;
}

export interface LoadoutLoopExitRoute {
  id: string;
  from: SocketId;
  condition: HandoffEdgeCondition;
  targetSocketId: SocketId;
}

export interface CastStateCore {
  active: boolean;
  castId: string;
  request: string;
  phase: string;
  currentSocketId?: SocketId;
  currentMateriaId?: MateriaId;
  currentWorkItemId?: string;
  socketState?: MateriaCastSocketState;
  data: Record<string, unknown>;
  cursors: Record<string, number>;
  visits: Record<string, number>;
  edgeTraversals: Record<string, number>;
}

export function createPromptIntent(init: PromptIntent): DomainResult<PromptIntent> {
  const issues: DomainIssue[] = [];
  if (!isCanonicalSocketId(init.socketId)) issues.push({ path: "promptIntent.socketId", message: "socketId must be a canonical Socket-N id" });
  if (!isNonEmptyString(init.materiaId)) issues.push({ path: "promptIntent.materiaId", message: "materiaId is required" });
  if (init.parse !== "text" && init.parse !== "json") issues.push({ path: "promptIntent.parse", message: "parse must be text or json" });
  return issues.length > 0 ? { ok: false, issues } : ok({ ...init });
}

export function validateLoadout(loadout: Loadout): DomainResult<Loadout> {
  const issues: DomainIssue[] = [];
  if (!isCanonicalSocketId(loadout.entry)) issues.push({ path: "loadout.entry", message: "entry must be a canonical Socket-N id" });
  const sockets = loadout.sockets ?? {};
  if (!Object.prototype.hasOwnProperty.call(sockets, loadout.entry)) issues.push({ path: "loadout.entry", message: "entry must reference an existing socket" });
  for (const [socketId, socket] of Object.entries(sockets)) {
    const socketPath = `loadout.sockets.${socketId}`;
    if (!isCanonicalSocketId(socketId)) issues.push({ path: socketPath, message: "socket key must be a canonical Socket-N id" });
    if (socket.type !== "agent" && socket.type !== "utility") issues.push({ path: `${socketPath}.type`, message: "socket type must be agent or utility" });
    if (socket.type === "agent" && !isNonEmptyString(socket.materia)) issues.push({ path: `${socketPath}.materia`, message: "agent socket requires materia" });
    if (socket.parse !== undefined && socket.parse !== "text" && socket.parse !== "json") issues.push({ path: `${socketPath}.parse`, message: "parse must be text or json" });
    for (const [index, edge] of (socket.edges ?? []).entries()) validateEdge(edge, sockets, `${socketPath}.edges.${index}`, issues);
    if (socket.advance?.when !== undefined && !isHandoffEdgeCondition(socket.advance.when)) issues.push({ path: `${socketPath}.advance.when`, message: `advance condition must be one of ${HANDOFF_EDGE_CONDITIONS.join(", ")}` });
    validateSocketOrTerminalTarget(socket.foreach?.done, sockets, `${socketPath}.foreach.done`, "foreach done target", issues);
    validateSocketOrTerminalTarget(socket.advance?.done, sockets, `${socketPath}.advance.done`, "advance exhaustion target", issues);
  }
  for (const [loopId, loop] of Object.entries(loadout.loops ?? {})) {
    const loopPath = `loadout.loops.${loopId}`;
    if (!isNonEmptyString(loopId)) issues.push({ path: loopPath, message: "loop id is required" });
    for (const [index, socketId] of loop.sockets.entries()) {
      if (!Object.prototype.hasOwnProperty.call(sockets, socketId)) issues.push({ path: `${loopPath}.sockets.${index}`, message: "loop socket must reference an existing socket" });
    }
    if (loop.consumes && !Object.prototype.hasOwnProperty.call(sockets, loop.consumes.from)) issues.push({ path: `${loopPath}.consumes.from`, message: "loop consumer source must reference an existing socket" });
    validateSocketOrTerminalTarget(loop.consumes?.done, sockets, `${loopPath}.consumes.done`, "loop consumer done target", issues);
    validateSocketOrTerminalTarget(loop.iterator?.done, sockets, `${loopPath}.iterator.done`, "loop iterator done target", issues);
    if (loop.exit) {
      if (!Object.prototype.hasOwnProperty.call(sockets, loop.exit.from)) issues.push({ path: `${loopPath}.exit.from`, message: "loop exit source must reference an existing socket" });
      if (!isHandoffEdgeCondition(loop.exit.when)) issues.push({ path: `${loopPath}.exit.when`, message: `loop exit condition must be one of ${HANDOFF_EDGE_CONDITIONS.join(", ")}` });
      validateSocketOrTerminalTarget(loop.exit.to, sockets, `${loopPath}.exit.to`, "loop exit target", issues);
    }
    for (const [index, route] of (loop.exits ?? []).entries()) {
      if (!isNonEmptyString(route.id)) issues.push({ path: `${loopPath}.exits.${index}.id`, message: "route id is required" });
      if (!Object.prototype.hasOwnProperty.call(sockets, route.from)) issues.push({ path: `${loopPath}.exits.${index}.from`, message: "route source must reference an existing socket" });
      if (!isHandoffEdgeCondition(route.condition)) issues.push({ path: `${loopPath}.exits.${index}.condition`, message: `route condition must be one of ${HANDOFF_EDGE_CONDITIONS.join(", ")}` });
      validateSocketOrTerminalTarget(route.targetSocketId, sockets, `${loopPath}.exits.${index}.targetSocketId`, "loop-exit route target", issues);
    }
  }
  return issues.length > 0 ? { ok: false, issues } : ok(copyLoadout(loadout));
}

export function chooseRoutingOutcome(socket: Pick<LoadoutSocket, "edges">, handoff: Record<string, unknown>): MateriaRoutingOutcome {
  for (const edge of socket.edges ?? []) {
    if (edge.when === "always") return { kind: "next", to: edge.to, condition: edge.when };
    if (edge.when === "satisfied" && handoff.satisfied === true) return { kind: "next", to: edge.to, condition: edge.when };
    if (edge.when === "not_satisfied" && handoff.satisfied === false) return { kind: "next", to: edge.to, condition: edge.when };
  }
  return { kind: "complete" };
}

export function recordSocketVisit<TState extends Pick<CastStateCore, "visits">>(state: TState, socketId: SocketId): TState {
  return { ...state, visits: { ...state.visits, [socketId]: (state.visits[socketId] ?? 0) + 1 } };
}

function validateEdge(edge: LoadoutEdge, sockets: Record<SocketId, LoadoutSocket>, path: string, issues: DomainIssue[]): void {
  if (!isHandoffEdgeCondition(edge.when)) issues.push({ path: `${path}.when`, message: `edge condition must be one of ${HANDOFF_EDGE_CONDITIONS.join(", ")}` });
  const classification = classifyGraphTarget(edge.to, sockets);
  if (classification.kind === "unknown") {
    if (!isCanonicalSocketId(edge.to)) issues.push({ path: `${path}.to`, message: "edge target must be a canonical Socket-N id or terminal end" });
    else issues.push({ path: `${path}.to`, message: "edge target must reference an existing socket or terminal end" });
  }
}

function validateSocketOrTerminalTarget(target: SocketId | undefined, sockets: Record<SocketId, LoadoutSocket>, path: string, label: string, issues: DomainIssue[]): void {
  if (target === undefined) return;
  const classification = classifyGraphTarget(target, sockets);
  if (classification.kind === "unknown") issues.push({ path, message: `${label} must reference an existing socket or terminal end` });
}

function copyLoadout(loadout: Loadout): Loadout {
  return {
    ...loadout,
    sockets: Object.fromEntries(Object.entries(loadout.sockets).map(([id, socket]) => [id, { ...socket, edges: socket.edges?.map((edge) => ({ ...edge })) }])),
    ...(loadout.loops ? { loops: Object.fromEntries(Object.entries(loadout.loops).map(([id, loop]) => [id, { ...loop, sockets: [...loop.sockets], ...(loop.consumes ? { consumes: { ...loop.consumes } } : {}), ...(loop.iterator ? { iterator: { ...loop.iterator } } : {}), ...(loop.exit ? { exit: { ...loop.exit } } : {}), ...(loop.exits ? { exits: loop.exits.map((exit) => ({ ...exit })) } : {}) }])) } : {}),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
