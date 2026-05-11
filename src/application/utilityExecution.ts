import { currentItem } from "./workflowTransitions.js";
import { stringifyDeterministicHandoffOutput } from "../handoff/handoffContract.js";
import { loopIteratorForSocket } from "../loadout/loadoutAccessors.js";
import type { MateriaCastState, ResolvedMateriaSocket } from "../types.js";

export type UtilityResolvedSocket = Extract<ResolvedMateriaSocket, { socket: { type: "utility" } }>;

export interface UtilityExecutionDeps {
  executeCommand(input: CommandUtilityRequest): Promise<string>;
  executeBuiltInUtility(name: string, input: Record<string, unknown>): Promise<string> | string;
  hasBuiltInUtility(name: string): boolean;
  recordUtilityInput(input: Record<string, unknown>): Promise<string>;
  appendUtilityInputEvent(artifact: string, visit: number): Promise<void>;
}

export interface CommandUtilityRequest {
  state: MateriaCastState;
  socket: UtilityResolvedSocket;
  input: Record<string, unknown>;
}

export async function executeUtilitySocketWithDeps(state: MateriaCastState, socket: UtilityResolvedSocket, deps: UtilityExecutionDeps): Promise<{ output: string; entryId: string }> {
  const visit = socketVisit(state, socket.id);
  const input = buildUtilityInput(state, socket);
  const inputArtifact = await deps.recordUtilityInput(input);
  await deps.appendUtilityInputEvent(inputArtifact, visit);

  const utilityConfig = resolvedSocketConfig(socket);
  const params = utilityConfig.params ?? {};
  let output: string;
  if (utilityConfig.command) {
    output = await deps.executeCommand({ state, socket, input });
  } else if (Object.prototype.hasOwnProperty.call(params, "output")) {
    const value = params.output;
    output = typeof value === "string" ? value : stringifyDeterministicHandoffOutput(value);
  } else if (deps.hasBuiltInUtility(utilityConfig.utility ?? "")) {
    output = await deps.executeBuiltInUtility(utilityConfig.utility ?? "", input);
  } else {
    throw new Error(`Unknown utility alias "${utilityConfig.utility}" for socket "${socket.id}".`);
  }

  return { output, entryId: `utility:${socket.id}:${visit}` };
}

export function buildUtilityInput(state: MateriaCastState, socket: UtilityResolvedSocket): Record<string, unknown> {
  const loop = resolvedSocketConfig(socket).foreach ?? loopIteratorForSocket(state.pipeline, socket.id);
  const cursorName = loop?.cursor ?? (loop ? `${socket.id}Index` : undefined);
  return {
    cwd: state.cwd,
    runDir: state.runDir,
    request: state.request,
    castId: state.castId,
    socketId: socket.id,
    params: resolvedSocketConfig(socket).params ?? {},
    state: state.data,
    item: currentItem(state) ?? null,
    itemKey: state.currentItemKey ?? null,
    itemLabel: state.currentItemLabel ?? null,
    cursor: cursorName ? { name: cursorName, index: state.cursors[cursorName] ?? 0 } : null,
    cursors: state.cursors,
  };
}

function socketVisit(state: MateriaCastState, socketId: string): number {
  return state.visits[socketId] ?? 0;
}

function resolvedSocketConfig<TSocket extends ResolvedMateriaSocket>(socket: TSocket): TSocket["socket"] {
  return socket.socket;
}
