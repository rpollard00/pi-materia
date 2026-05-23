import { canonicalGeneratorConfigFor } from "../graph/generator.js";
import {
  HANDOFF_CONTEXT_FIELD,
  HANDOFF_SATISFIED_FIELD,
  HANDOFF_WORK_ITEMS_FIELD,
  pickHandoffEnvelopeFields,
} from "../handoff/handoffContract.js";
import type { MateriaCastState, ResolvedMateriaSocket } from "../types.js";
import { isPlainObject } from "./workflowTransitions.js";

export function applyGenericHandoffEnvelope(state: MateriaCastState, parsed: unknown, socket?: ResolvedMateriaSocket): void {
  if (!isPlainObject(parsed)) return;

  applyUtilityStatePatch(state, parsed, socket);

  const envelope = isPlainObject(state.data.envelope)
    ? { ...(state.data.envelope as Record<string, unknown>) }
    : {};
  Object.assign(envelope, pickHandoffEnvelopeFields(parsed));
  if (Object.keys(envelope).length > 0) state.data.envelope = envelope;

  const workItems = parsed[HANDOFF_WORK_ITEMS_FIELD];
  if (hasOwn(parsed, HANDOFF_WORK_ITEMS_FIELD) && Array.isArray(workItems) && shouldAdoptEnvelopeWorkItems(state, socket)) {
    state.data.workItems = workItems;
  }
  const context = parsed[HANDOFF_CONTEXT_FIELD];
  if (hasOwn(parsed, HANDOFF_CONTEXT_FIELD) && typeof context === "string") state.data.context = appendAgentContext(state.data.context, context, socket);
}

function applyUtilityStatePatch(state: MateriaCastState, parsed: Record<string, unknown>, socket?: ResolvedMateriaSocket): void {
  if (!socket || socket.materia.type !== "utility") return;
  const patch = parsed.state;
  if (!isPlainObject(patch)) return;
  const filteredPatch = { ...patch };
  delete filteredPatch[HANDOFF_WORK_ITEMS_FIELD];
  delete filteredPatch[HANDOFF_SATISFIED_FIELD];
  state.data = { ...state.data, ...filteredPatch };
}

function appendAgentContext(existing: unknown, context: string, socket?: ResolvedMateriaSocket): string {
  const trimmed = context.trim();
  if (!trimmed) return typeof existing === "string" ? existing : "";
  const labeled = `[${contextLabel(socket)}] ${context}`;
  return typeof existing === "string" && existing.trim().length > 0 ? `${existing}\n\n${labeled}` : labeled;
}

function contextLabel(socket?: ResolvedMateriaSocket): string {
  if (!socket) return "handoff context";
  const materia = socket.materia.label ?? (isUtilitySocket(socket) ? socket.materiaId : socket.socket.materia) ?? "materia";
  return `${socket.id} ${materia}`;
}

function isUtilitySocket(socket: ResolvedMateriaSocket): socket is Extract<ResolvedMateriaSocket, { materiaId: string }> {
  return socket.materia.type === "utility";
}

function hasOwn(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function shouldAdoptEnvelopeWorkItems(state: MateriaCastState, socket?: ResolvedMateriaSocket): boolean {
  if (!Array.isArray(state.data.workItems) || state.data.workItems.length === 0) return true;
  return Boolean(socket && canonicalGeneratorConfigFor(socket.materia)?.output === "workItems");
}
