import type { DomainResult } from "../domain/result.js";
import type { LinkPlan, VirtualLoadoutSpec } from "./types.js";

export interface LinkCompilationInput {
  /** Serializable plan metadata from the planner. */
  plan: LinkPlan;
}

export interface LinkCompilationResult {
  /** Ephemeral executable virtual loadout plus separately persisted metadata. */
  virtualLoadout: VirtualLoadoutSpec;
}

/**
 * Compiler boundary for `/materia link`.
 *
 * Responsibility: expand materia/loadout targets into one virtual loadout,
 * remap ids, and deterministically stitch adjacent graph fragments. It returns
 * an ephemeral executable graph and metadata; it must not save the virtual
 * loadout as an active/default/named loadout or launch a cast.
 */
export interface LinkGraphCompiler {
  compile(input: LinkCompilationInput): Promise<DomainResult<LinkCompilationResult>> | DomainResult<LinkCompilationResult>;
}

export type CompileLinkPlan = LinkGraphCompiler["compile"];
