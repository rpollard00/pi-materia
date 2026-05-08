import { describe, expect, test } from "vitest";
import { canonicalGeneratorConfigFor, isGeneratorMateria } from "../src/generator.js";

import type { MateriaConfig } from "../src/types.js";

describe("generator helpers", () => {
  test("detects semantic generator materia and resolves canonical workItems config", () => {
    const materia: MateriaConfig = { tools: "readOnly", prompt: "Plan", generator: true };

    expect(isGeneratorMateria(materia)).toBe(true);
    expect(canonicalGeneratorConfigFor(materia)).toEqual({
      output: "workItems",
      listType: "array",
      itemType: "workItem",
      as: "workItem",
      cursor: "workItemIndex",
      done: "end",
    });
  });

  test("treats legacy generates as migration-only compatibility", () => {
    const materia: MateriaConfig = { tools: "readOnly", prompt: "Plan", generates: { output: "oldItems", listType: "array", itemType: "oldItem" } };

    expect(isGeneratorMateria(materia)).toBe(true);
    expect(canonicalGeneratorConfigFor(materia)?.output).toBe("oldItems");
  });
});
