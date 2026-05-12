import type { DomainResult } from "../domain/result.js";
import type { LinkTargetRef, ResolvedLinkTarget } from "./types.js";

export interface LinkTargetResolutionInput {
  /** Ordered target refs from the parser. */
  targets: LinkTargetRef[];
}

export interface LinkTargetResolutionResult {
  /** Resolved targets in the same order as the requested refs. */
  targets: ResolvedLinkTarget[];
}

/**
 * Resolver boundary for `/materia link`.
 *
 * Responsibility: map parsed target refs to materia/loadout identities without
 * mutating the active/default loadout or touching runtime cast state.
 */
export interface LinkTargetResolver {
  resolve(input: LinkTargetResolutionInput): Promise<DomainResult<LinkTargetResolutionResult>> | DomainResult<LinkTargetResolutionResult>;
}

export type ResolveLinkTargets = LinkTargetResolver["resolve"];
