import { canonicalGeneratorConfigFor } from "../graph/generator.js";
import {
  HANDOFF_DECISIONS_FIELD,
  HANDOFF_GUIDANCE_FIELD,
  HANDOFF_RISKS_FIELD,
  HANDOFF_SUMMARY_FIELD,
  HANDOFF_WORK_ITEMS_FIELD,
  pickHandoffEnvelopeFields,
} from "../handoff/handoffContract.js";
import type { MateriaCastState, ResolvedMateriaSocket } from "../types.js";
import { isPlainObject } from "./workflowTransitions.js";

export function applyGenericHandoffEnvelope(state: MateriaCastState, parsed: unknown, socket?: ResolvedMateriaSocket): void {
  if (!isPlainObject(parsed)) return;

  const envelope = isPlainObject(state.data.envelope)
    ? { ...(state.data.envelope as Record<string, unknown>) }
    : {};
  Object.assign(envelope, pickHandoffEnvelopeFields(parsed));
  if (Object.keys(envelope).length > 0) state.data.envelope = envelope;

  const workItems = parsed[HANDOFF_WORK_ITEMS_FIELD];
  if (hasOwn(parsed, HANDOFF_WORK_ITEMS_FIELD) && Array.isArray(workItems) && shouldAdoptEnvelopeWorkItems(state, socket)) {
    state.data.workItems = workItems;
  }
  const guidance = parsed[HANDOFF_GUIDANCE_FIELD];
  if (hasOwn(parsed, HANDOFF_GUIDANCE_FIELD) && isPlainObject(guidance)) {
    const existing = isPlainObject(state.data.guidance) ? state.data.guidance : {};
    state.data.guidance = { ...existing, ...guidance };
  }
  const summary = parsed[HANDOFF_SUMMARY_FIELD];
  if (hasOwn(parsed, HANDOFF_SUMMARY_FIELD) && typeof summary === "string") state.data.summary = summary;
  const decisions = parsed[HANDOFF_DECISIONS_FIELD];
  if (hasOwn(parsed, HANDOFF_DECISIONS_FIELD) && Array.isArray(decisions)) state.data.decisions = decisions;
  const risks = parsed[HANDOFF_RISKS_FIELD];
  if (hasOwn(parsed, HANDOFF_RISKS_FIELD) && Array.isArray(risks)) state.data.risks = risks;
}

function hasOwn(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function shouldAdoptEnvelopeWorkItems(state: MateriaCastState, socket?: ResolvedMateriaSocket): boolean {
  if (!Array.isArray(state.data.workItems) || state.data.workItems.length === 0) return true;
  return Boolean(socket && canonicalGeneratorConfigFor(socket.materia)?.output === "workItems");
}
