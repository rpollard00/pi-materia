import { canonicalGeneratorConfigFor, isParallelPlannerMateria } from "../graph/generator.js";
import { recordParallelFinalization } from "../domain/parallelRun.js";
import type { MateriaParallelFinalizationProvenance, MateriaParallelRevisionIdentity } from "../domain/parallelRunTypes.js";
import {
  HANDOFF_CONTEXT_FIELD,
  HANDOFF_SATISFIED_FIELD,
  HANDOFF_TEXT_FIELD,
  HANDOFF_WORK_ITEMS_FIELD,
  pickHandoffEnvelopeFields,
} from "../domain/handoff.js";
import { PARALLEL_SCHEDULE_FIELD, cloneParallelSchedule, isParallelSchedule } from "../handoff/parallelSchedule.js";
import type { MateriaCastState, ResolvedMateriaSocket } from "../types.js";
import { isPlainObject } from "./workflowTransitions.js";

export function applyGenericHandoffEnvelope(state: MateriaCastState, parsed: unknown, socket?: ResolvedMateriaSocket): void {
  if (!isPlainObject(parsed)) return;

  const finalization = extractParallelFinalization(parsed, socket);
  applyUtilityStatePatch(state, parsed, socket);
  if (finalization) applyParallelFinalization(state, finalization);

  // `text` is a renderable current-output payload, not durable shared state.
  // Exclude it from the implicit `state.data.envelope` mirror so prose is not
  // handed off unless a socket explicitly assigns it (e.g.
  // `assign: { "prNotes": "$.text" }`). The authoritative raw value remains in
  // `state.lastJson` for debugging/replay and drives TUI rendering directly.
  const picked = pickHandoffEnvelopeFields(parsed);
  delete picked[HANDOFF_TEXT_FIELD];
  const envelope = isPlainObject(state.data.envelope)
    ? { ...(state.data.envelope as Record<string, unknown>) }
    : {};
  Object.assign(envelope, picked);
  if (Object.keys(envelope).length > 0) state.data.envelope = envelope;

  const workItems = parsed[HANDOFF_WORK_ITEMS_FIELD];
  if (hasOwn(parsed, HANDOFF_WORK_ITEMS_FIELD) && Array.isArray(workItems) && shouldAdoptEnvelopeWorkItems(state, socket)) {
    state.data.workItems = workItems;
  }
  const context = parsed[HANDOFF_CONTEXT_FIELD];
  if (hasOwn(parsed, HANDOFF_CONTEXT_FIELD) && typeof context === "string") state.data.context = appendAgentContext(state.data.context, context, socket);

  // The sidecar is runtime-owned planner state for the deterministic
  // normalizer. Keep it in an explicit state slot, never in the generic
  // handoff envelope/context mirror; prompt assembly redacts this slot from
  // ordinary downstream agent context.
  if (isParallelPlannerMateria(socket?.materia) && isParallelSchedule(parsed[PARALLEL_SCHEDULE_FIELD])) {
    state.data[PARALLEL_SCHEDULE_FIELD] = cloneParallelSchedule(parsed[PARALLEL_SCHEDULE_FIELD]);
  }
}

function applyUtilityStatePatch(state: MateriaCastState, parsed: Record<string, unknown>, socket?: ResolvedMateriaSocket): void {
  if (!socket || socket.materia.type !== "utility") return;
  const patch = parsed.state;
  if (!isPlainObject(patch)) return;
  const filteredPatch = { ...patch };
  delete filteredPatch[HANDOFF_WORK_ITEMS_FIELD];
  delete filteredPatch[HANDOFF_SATISFIED_FIELD];
  delete filteredPatch.parallelFinalization;
  state.data = { ...state.data, ...filteredPatch };
}

/**
 * Finalization is a runtime-owned control record, not ordinary utility state.
 * Accept it only from a utility socket and require the persisted run identity
 * before it can close a coordinator.
 */
function extractParallelFinalization(parsed: Record<string, unknown>, socket?: ResolvedMateriaSocket): MateriaParallelFinalizationProvenance | undefined {
  if (!socket || socket.materia.type !== "utility" || !isPlainObject(parsed.state)) return undefined;
  const raw = parsed.state.parallelFinalization;
  if (!isPlainObject(raw) || raw.version !== 1 || typeof raw.parentCastId !== "string" || typeof raw.loopId !== "string" || typeof raw.runId !== "string" || typeof raw.evaluationAccepted !== "boolean" || typeof raw.conflictFree !== "boolean" || (raw.status !== "completed" && raw.status !== "preserved") || (raw.status === "completed" && (!raw.evaluationAccepted || !raw.conflictFree)) || !Array.isArray(raw.cleanedLaneIds) || !raw.cleanedLaneIds.every((laneId) => typeof laneId === "string")) return undefined;
  const integrationRevision = revisionFromValue(raw.integrationRevision);
  const parentWorkingRevision = revisionFromValue(raw.parentWorkingRevision);
  return {
    version: 1,
    parentCastId: raw.parentCastId,
    loopId: raw.loopId,
    runId: raw.runId,
    evaluationAccepted: raw.evaluationAccepted,
    conflictFree: raw.conflictFree,
    ...(integrationRevision ? { integrationRevision } : {}),
    ...(typeof raw.bookmarkName === "string" ? { bookmarkName: raw.bookmarkName } : {}),
    ...(parentWorkingRevision ? { parentWorkingRevision } : {}),
    cleanedLaneIds: [...raw.cleanedLaneIds],
    status: raw.status,
    ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    finalizedAt: typeof raw.finalizedAt === "number" && Number.isFinite(raw.finalizedAt) ? raw.finalizedAt : Date.now(),
  };
}

function applyParallelFinalization(state: MateriaCastState, provenance: MateriaParallelFinalizationProvenance): void {
  const run = state.parallelRuns?.[provenance.loopId];
  if (!run || run.parentCastId !== state.castId || run.runId !== provenance.runId || provenance.parentCastId !== state.castId) return;
  const result = recordParallelFinalization(run, { parentCastId: state.castId, loopId: provenance.loopId, runId: provenance.runId, provenance, timestamp: provenance.finalizedAt });
  if (!result.applied) return;
  state.parallelRuns = { ...(state.parallelRuns ?? {}), [provenance.loopId]: result.state };
  state.awaitingResponse = false;
  state.updatedAt = Math.max(state.updatedAt, result.state.updatedAt);
}

function revisionFromValue(value: unknown): MateriaParallelRevisionIdentity | undefined {
  if (!isPlainObject(value) || typeof value.commitId !== "string" || !value.commitId.trim() || typeof value.changeId !== "string" || !value.changeId.trim()) return undefined;
  return { commitId: value.commitId, changeId: value.changeId };
}

function appendAgentContext(existing: unknown, context: string, socket?: ResolvedMateriaSocket): string {
  const trimmed = context.trim();
  if (!trimmed) return typeof existing === "string" ? existing : "";
  const labeled = `[${contextLabel(socket)}] ${context}`;
  return typeof existing === "string" && existing.trim().length > 0 ? `${existing}\n\n${labeled}` : labeled;
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
  return Boolean(socket && (canonicalGeneratorConfigFor(socket.materia)?.output === "workItems" || isParallelPlannerMateria(socket.materia)));
}
