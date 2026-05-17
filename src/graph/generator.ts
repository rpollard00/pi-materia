import type { MateriaGeneratorConfig } from "../types.js";

export interface GeneratorMateriaLike {
  type?: "agent" | "utility" | string;
  generator?: boolean;
  generates?: MateriaGeneratorConfig;
}

export interface MateriaCapabilities {
  generator: boolean;
  generatorConfig?: MateriaGeneratorConfig;
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
  return getMateriaCapabilities(definition).generatorConfig;
}

export function getMateriaCapabilities(definition: GeneratorMateriaLike | undefined): MateriaCapabilities {
  if (definition?.generator === true) {
    return { generator: true, generatorConfig: { ...CANONICAL_WORK_ITEMS_GENERATOR_CONFIG } };
  }
  return { generator: false };
}
