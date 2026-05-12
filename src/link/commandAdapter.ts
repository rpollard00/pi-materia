import type { DomainResult } from "../domain/result.js";
import type { LinkRuntimeState } from "./types.js";

export interface LinkCommandRunInput {
  /** Arguments after the `link` subcommand. */
  argumentsText: string;
  /** Original command text when available for persisted lineage. */
  rawCommand?: string;
}

export interface LinkCommandRunResult {
  /** Linked cast id once the normal cast runtime starts. */
  castId: string;
  /** Transient runtime state handed to the normal cast launcher. */
  runtime: LinkRuntimeState;
}

/**
 * Command adapter boundary for `/materia link`.
 *
 * Responsibility: orchestrate parser, resolver, planner, compiler,
 * previous-cast loading, and the existing cast runtime. Implementations should
 * keep this thin and abort before creating/running a cast on any validation or
 * compilation failure.
 */
export interface LinkCommandAdapter {
  run(input: LinkCommandRunInput): Promise<DomainResult<LinkCommandRunResult>>;
}

export type RunLinkCommand = LinkCommandAdapter["run"];
