import { canonicalGeneratorConfigFor, isParallelGeneratorMateria } from "../graph/generator.js";
import { normalizeParallelPlan, type NormalizedParallelPlan } from "../handoff/parallelPlan.js";
import {
  HANDOFF_CONTEXT_FIELD,
  HANDOFF_SATISFIED_FIELD,
  HANDOFF_TEXT_FIELD,
  HANDOFF_WORK_ITEMS_FIELD,
  pickHandoffEnvelopeFields,
} from "../domain/handoff.js";
import { PARALLEL_SCHEDULE_FIELD } from "../handoff/parallelSchedule.js";
import type { MateriaCastState, ResolvedMateriaSocket } from "../types.js";
import { isPlainObject } from "./workflowTransitions.js";

export function applyGenericHandoffEnvelope(state: MateriaCastState, parsed: unknown, socket?: ResolvedMateriaSocket): void {
  if (!isPlainObject(parsed)) return;

  // Compute the complete intrinsic planner commit before touching cast state.
  // The ordinary socket path already validated this output; keeping this guard
  // here prevents direct/replay callers from partially adopting a bad plan.
  const parallelCommit = prepareParallelGeneratorCommit(parsed, socket);
  applyUtilityStatePatch(state, parsed, socket);

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
  if (parallelCommit) {
    const { parallelSchedule: _obsoleteSchedule, ...retainedData } = state.data;
    state.data = {
      ...retainedData,
      workItems: parallelCommit.workItems,
      parallelPlan: parallelCommit.plan,
    };
  } else if (hasOwn(parsed, HANDOFF_WORK_ITEMS_FIELD) && Array.isArray(workItems) && shouldAdoptEnvelopeWorkItems(state, socket)) {
    state.data.workItems = workItems;
  }
  const context = parsed[HANDOFF_CONTEXT_FIELD];
  if (hasOwn(parsed, HANDOFF_CONTEXT_FIELD) && typeof context === "string") state.data.context = appendAgentContext(state.data.context, context, socket);
}

interface ParallelGeneratorCommit {
  workItems: Array<{ title: string; context: string }>;
  plan: NormalizedParallelPlan;
}

function prepareParallelGeneratorCommit(parsed: Record<string, unknown>, socket?: ResolvedMateriaSocket): ParallelGeneratorCommit | undefined {
  if (!isParallelGeneratorMateria(socket?.materia)) return undefined;
  const rawWorkItems = parsed[HANDOFF_WORK_ITEMS_FIELD];
  if (!Array.isArray(rawWorkItems)) throw new Error("Parallel generator handoff requires canonical workItems before commit.");
  const workItems = rawWorkItems.map((item) => {
    if (!isPlainObject(item) || typeof item.title !== "string" || typeof item.context !== "string") {
      throw new Error("Parallel generator handoff contains a malformed work item before commit.");
    }
    return { title: item.title, context: item.context };
  });
  const normalized = normalizeParallelPlan(workItems, parsed[PARALLEL_SCHEDULE_FIELD]);
  if (!normalized.ok) {
    throw new Error(`Parallel generator handoff could not be normalized: ${normalized.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
  }
  return { workItems, plan: normalized.value };
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
  return Boolean(socket && (canonicalGeneratorConfigFor(socket.materia)?.output === "workItems" || isParallelGeneratorMateria(socket.materia)));
}
