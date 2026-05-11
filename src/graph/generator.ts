import type { MateriaGeneratorConfig } from "../types.js";

export interface GeneratorMateriaLike {
  generator?: boolean;
  generates?: MateriaGeneratorConfig;
}

export const CANONICAL_WORK_ITEMS_GENERATOR_CONFIG: MateriaGeneratorConfig = {
  output: "workItems",
  listType: "array",
  itemType: "workItem",
  as: "workItem",
  cursor: "workItemIndex",
  done: "end",
};

/**
 * Canonical authored generator marker. Legacy `generates` metadata is
 * migration-only and must not activate runtime generator semantics.
 */
export function isGeneratorMateria(definition: GeneratorMateriaLike | undefined): boolean {
  return definition?.generator === true;
}

/**
 * Resolve authored generator marker into the runtime loop-consumable workItems
 * contract. Runtime generator output is always the canonical handoff envelope's
 * workItems list; legacy `generates.output` aliases are intentionally ignored.
 */
export function canonicalGeneratorConfigFor(definition: GeneratorMateriaLike | undefined): MateriaGeneratorConfig | undefined {
  if (definition?.generator === true) return { ...CANONICAL_WORK_ITEMS_GENERATOR_CONFIG };
  return undefined;
}
