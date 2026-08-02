import { describe, expect, test } from "vitest";
import { canonicalGeneratorConfigFor, isGeneratorMateria, isParallelGeneratorMateria } from "../src/graph/generator.js";

import type { MateriaConfig } from "../src/types.js";

describe("generator helpers", () => {
  test("detects semantic generator materia and resolves canonical workItems config", () => {
    const materia: MateriaConfig = { tools: "readOnly", prompt: "Plan", generator: true };

    expect(isGeneratorMateria(materia)).toBe(true);
    expect(isParallelGeneratorMateria(materia)).toBe(false);
    expect(canonicalGeneratorConfigFor(materia)).toEqual({
      output: "workItems",
      listType: "array",
      itemType: "workItem",
      as: "workItem",
      cursor: "workItemIndex",
      done: "end",
    });
  });

  test("only enables parallel generation when both canonical capabilities are true", () => {
    expect(isParallelGeneratorMateria({ generator: true, parallel: true })).toBe(true);
    expect(isParallelGeneratorMateria({ generator: true })).toBe(false);
    expect(isParallelGeneratorMateria({ parallel: true })).toBe(false);
  });

  test("does not activate legacy generates as runtime generator semantics", () => {
    const materia: MateriaConfig = { tools: "readOnly", prompt: "Plan", generates: { output: "oldItems", listType: "array", itemType: "oldItem" } };

    expect(isGeneratorMateria(materia)).toBe(false);
    expect(canonicalGeneratorConfigFor(materia)).toBeUndefined();
  });
});
