import type { DomainResult } from "../domain/result.js";
import type { LinkCommandParseResult } from "./types.js";

/**
 * Parser boundary for `/materia link`.
 *
 * Responsibility: tokenize and validate command grammar only. It must not look up
 * materia/loadout names, load previous casts, compile graphs, or launch casts.
 */
export interface LinkCommandParser {
  parse(argumentsText: string, rawCommand?: string): DomainResult<LinkCommandParseResult>;
}

export type ParseLinkCommand = LinkCommandParser["parse"];
