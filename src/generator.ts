import type { MateriaGeneratorConfig } from "./types.js";

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
 * Canonical authored generator marker. Legacy `generates` metadata is accepted
 * only as migration compatibility for existing saved configs.
 */
export function isGeneratorMateria(definition: GeneratorMateriaLike | undefined): boolean {
  return definition?.generator === true || Boolean(definition?.generates);
}

/**
 * Resolve authored generator marker into the runtime loop-consumable workItems
 * contract. Existing `generates` declarations are migration-only fallbacks.
 */
export function canonicalGeneratorConfigFor(definition: GeneratorMateriaLike | undefined): MateriaGeneratorConfig | undefined {
  if (definition?.generator === true) return { ...CANONICAL_WORK_ITEMS_GENERATOR_CONFIG };
  return definition?.generates;
}
