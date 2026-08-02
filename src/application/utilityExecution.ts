import { currentItem } from "./workflowTransitions.js";
import {
  extractUtilityScopeTransition,
  type UtilityExecutionScopeTransition,
} from "./executionScopeTransition.js";
import { stringifyDeterministicHandoffOutput } from "../handoff/handoffContract.js";
import { loopIteratorForSocket } from "../loadout/loadoutAccessors.js";
import { effectiveUtilityConfig, resolvedMateriaDisplayName, resolvedMateriaId, resolvedSocketConfig } from "../runtime/resolvedMateria.js";
import type { MateriaCastState, ResolvedMateriaUtilitySocket } from "../types.js";

export type UtilityResolvedSocket = ResolvedMateriaUtilitySocket;

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

export interface UtilitySocketExecutionResult {
  output: string;
  entryId: string;
  /** Typed utility-only sidecar, excluded from ordinary parsed output. */
  scopeTransition?: UtilityExecutionScopeTransition;
}

export async function executeUtilitySocketWithDeps(state: MateriaCastState, socket: UtilityResolvedSocket, deps: UtilityExecutionDeps): Promise<UtilitySocketExecutionResult> {
  const visit = socketVisit(state, socket.id);
  const input = buildUtilityInput(state, socket);
  const inputArtifact = await deps.recordUtilityInput(input);
  await deps.appendUtilityInputEvent(inputArtifact, visit);

  const utilityConfig = effectiveUtilityConfig(socket);
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
    throw new Error(`Unknown utility alias "${utilityConfig.utility}" for utility materia "${resolvedMateriaId(socket)}" on socket "${socket.id}".`);
  }

  const extracted = effectiveUtilityConfig(socket).parse === "json"
    ? extractUtilityScopeTransition(output)
    : { output };
  return {
    output: extracted.output,
    entryId: `utility:${socket.id}:${visit}`,
    ...(extracted.transition ? { scopeTransition: extracted.transition } : {}),
  };
}

export function buildUtilityInput(state: MateriaCastState, socket: UtilityResolvedSocket): Record<string, unknown> {
  const loop = resolvedSocketConfig(socket).foreach ?? loopIteratorForSocket(state.pipeline, socket.id);
  const cursorName = loop?.cursor ?? (loop ? `${socket.id}Index` : undefined);
  return {
    cwd: state.activeScope.cwd,
    executionScope: state.activeScope,
    runDir: state.runDir,
    request: state.request,
    castId: state.castId,
    socketId: socket.id,
    materiaId: resolvedMateriaId(socket),
    materiaLabel: resolvedMateriaDisplayName(socket),
    params: effectiveUtilityConfig(socket).params ?? {},
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

