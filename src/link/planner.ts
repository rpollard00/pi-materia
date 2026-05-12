import { ok, type DomainIssue, type DomainResult } from "../domain/result.js";
import { LINK_CAST_STATE_KEY, LINK_METADATA_VERSION, PREVIOUS_CAST_CONTEXT_STATE_KEY, type LinkCastStateData, type LinkCommandInvocation, type LinkLineage, type LinkPlan, type LinkRuntimeState, type PreviousCastContext, type ResolvedLinkTarget, type VirtualLoadoutSpec } from "./types.js";

export interface CreateLinkPlanInput {
  invocation: LinkCommandInvocation;
  prompt: string;
  fromCastId?: string;
  /** Ordered resolved target sequence from the resolver. */
  targets: ResolvedLinkTarget[];
}

/**
 * Planner boundary for `/materia link`.
 *
 * Responsibility: produce serializable plan/lineage metadata from parser and
 * resolver output. It does not expand graphs, load previous casts, or run casts.
 */
export interface LinkPlanner {
  createPlan(input: CreateLinkPlanInput): DomainResult<LinkPlan>;
  createLineage(input: CreateLinkPlanInput): LinkLineage;
}

export type CreateLinkPlan = LinkPlanner["createPlan"];

export function createLinkPlanner(): LinkPlanner {
  return { createPlan: createLinkPlan, createLineage };
}

export function createLinkPlan(input: CreateLinkPlanInput): DomainResult<LinkPlan> {
  const issues = validatePlanInput(input);
  if (issues.length > 0) return { ok: false, issues };
  const lineage = createLineage(input);
  return ok({
    version: LINK_METADATA_VERSION,
    invocation: input.invocation,
    prompt: input.prompt,
    ...(input.fromCastId ? { fromCastId: input.fromCastId } : {}),
    targets: input.targets,
    lineage,
  });
}

export function createLineage(input: CreateLinkPlanInput): LinkLineage {
  return {
    ...(input.fromCastId ? { fromCastId: input.fromCastId } : {}),
    targetSequence: input.targets,
    invocation: input.invocation,
  };
}

export function createLinkCastStateData(plan: LinkPlan, virtualLoadout: VirtualLoadoutSpec, castId?: string): LinkCastStateData {
  if (castId) plan.lineage.castId = castId;
  plan.lineage.virtualLoadout = virtualLoadout.metadata;
  return {
    version: LINK_METADATA_VERSION,
    plan,
    virtualLoadout: virtualLoadout.metadata,
    ...(plan.fromCastId ? { fromCastId: plan.fromCastId } : {}),
  };
}

export function createLinkRuntimeState(virtualLoadout: VirtualLoadoutSpec, previousCastContext?: PreviousCastContext): LinkRuntimeState {
  return { virtualLoadout, ...(previousCastContext ? { previousCastContext } : {}) };
}

/**
 * Attaches only inspectable link metadata plus bounded previous-cast context to
 * shared cast data. This makes previous context available to opt-in
 * materia/loadouts without prepending or injecting it into every prompt.
 */
export function attachLinkStateData(state: { data: Record<string, unknown>; castId?: string }, plan: LinkPlan, runtime: LinkRuntimeState): LinkCastStateData {
  const link = createLinkCastStateData(plan, runtime.virtualLoadout, state.castId);
  state.data[LINK_CAST_STATE_KEY] = link;
  if (runtime.previousCastContext) state.data[PREVIOUS_CAST_CONTEXT_STATE_KEY] = runtime.previousCastContext;
  return link;
}

function validatePlanInput(input: CreateLinkPlanInput): DomainIssue[] {
  const issues: DomainIssue[] = [];
  if (input.invocation.command !== "/materia link") issues.push({ path: "link.invocation.command", message: "link plan invocation command must be /materia link" });
  if (!input.prompt.trim()) issues.push({ path: "link.prompt", message: "link plan prompt is required" });
  if (input.fromCastId !== undefined && !input.fromCastId.trim()) issues.push({ path: "link.fromCastId", message: "previous cast id must be non-empty when provided" });
  if (input.targets.length === 0) issues.push({ path: "link.targets", message: "link plan requires at least one resolved target" });
  input.targets.forEach((target, index) => {
    if (target.order !== index) issues.push({ path: `link.targets.${index}.order`, message: `target order must match target position ${index}` });
  });
  return issues;
}
