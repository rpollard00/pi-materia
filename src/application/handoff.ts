import { canonicalGeneratorConfigFor } from "../graph/generator.js";
import {
  HANDOFF_CONTEXT_FIELD,
  HANDOFF_SATISFIED_FIELD,
  HANDOFF_TEXTS_STATE_KEY,
  HANDOFF_TEXT_FIELD,
  HANDOFF_WORK_ITEMS_FIELD,
  type PriorTextPayload,
  pickHandoffEnvelopeFields,
} from "../domain/handoff.js";
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
  const text = parsed[HANDOFF_TEXT_FIELD];
  if (hasOwn(parsed, HANDOFF_TEXT_FIELD) && typeof text === "string") state.data[HANDOFF_TEXTS_STATE_KEY] = appendAgentText(state.data[HANDOFF_TEXTS_STATE_KEY], text, socket);
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

/**
 * Append a renderable text payload to the accumulating prior-texts collection.
 *
 * Mirrors {@link appendAgentContext} but keeps each payload as a discrete,
 * source-labeled entry so following materia can consume prior prose even when
 * intervening sockets have overwritten `state.data.envelope`. Empty/whitespace
 * text is ignored. Existing non-array state is replaced rather than merged.
 */
function appendAgentText(existing: unknown, text: string, socket?: ResolvedMateriaSocket): PriorTextPayload[] {
  const trimmed = text.trim();
  const base = Array.isArray(existing) ? [...existing] : [];
  if (!trimmed) return base;
  const materia = materiaLabel(socket);
  const entry: PriorTextPayload = {
    socket: socket?.id ?? "handoff",
    ...(materia !== undefined ? { materia } : {}),
    text: trimmed,
  };
  return [...base, entry];
}

function contextLabel(socket?: ResolvedMateriaSocket): string {
  if (!socket) return "handoff context";
  return `${socket.id} ${materiaLabel(socket) ?? "materia"}`;
}

/** Resolve a display label for the materia backing a socket, when available. */
function materiaLabel(socket?: ResolvedMateriaSocket): string | undefined {
  if (!socket) return undefined;
  return socket.materia.label ?? (isUtilitySocket(socket) ? socket.materiaId : socket.socket.materia);
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
