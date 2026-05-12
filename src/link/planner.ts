import type { DomainResult } from "../domain/result.js";
import type { LinkCommandInvocation, LinkLineage, LinkPlan, ResolvedLinkTarget } from "./types.js";

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
