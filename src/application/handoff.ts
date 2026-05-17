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
  if (Array.isArray(workItems) && workItems.length > 0 && shouldAdoptEnvelopeWorkItems(state, socket)) {
    state.data.workItems = workItems;
  }
  const guidance = parsed[HANDOFF_GUIDANCE_FIELD];
  if (isPlainObject(guidance)) {
    const existing = isPlainObject(state.data.guidance) ? state.data.guidance : {};
    state.data.guidance = { ...existing, ...guidance };
  }
  const summary = parsed[HANDOFF_SUMMARY_FIELD];
  if (typeof summary === "string" && summary.trim()) state.data.summary = summary;
  const decisions = parsed[HANDOFF_DECISIONS_FIELD];
  if (Array.isArray(decisions) && decisions.length > 0) state.data.decisions = decisions;
  const risks = parsed[HANDOFF_RISKS_FIELD];
  if (Array.isArray(risks) && risks.length > 0) state.data.risks = risks;
}

function shouldAdoptEnvelopeWorkItems(state: MateriaCastState, socket?: ResolvedMateriaSocket): boolean {
  if (!Array.isArray(state.data.workItems) || state.data.workItems.length === 0) return true;
  return Boolean(socket && canonicalGeneratorConfigFor(socket.materia)?.output === "workItems");
}
