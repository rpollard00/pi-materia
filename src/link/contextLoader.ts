import type { DomainResult } from "../domain/result.js";
import type { PreviousCastContext } from "./types.js";

export interface PreviousCastContextLoadInput {
  fromCastId: string;
  /** Artifact root for this project/session; loaders must not read arbitrary paths outside known cast roots. */
  artifactRoot: string;
  /** Maximum bytes/characters to retain per loaded artifact preview. */
  maxArtifactBytes: number;
}

/**
 * Previous-cast context loader boundary for `/materia link --from`.
 *
 * Responsibility: validate/load bounded structured previous-cast state. The
 * returned context is transient runtime state for opt-in materia/loadouts; it is
 * not automatic prompt injection and is not persisted wholesale in lineage.
 */
export interface PreviousCastContextLoader {
  load(input: PreviousCastContextLoadInput): Promise<DomainResult<PreviousCastContext>> | DomainResult<PreviousCastContext>;
}

export type LoadPreviousCastContext = PreviousCastContextLoader["load"];
