import { describe, expect, test } from "bun:test";
import {
  resolveParallelMaxConcurrency,
  validateMateriaLoopParallelConfig,
  validateParallelismConfig,
} from "../src/domain/parallelLoop.js";

describe("parallelism configuration", () => {
  test("uses the app-level bound unless the consuming loop overrides it", () => {
    expect(resolveParallelMaxConcurrency({ maxConcurrency: 4 })).toBe(4);
    expect(resolveParallelMaxConcurrency({ maxConcurrency: 4 }, {})).toBe(4);
    expect(resolveParallelMaxConcurrency({ maxConcurrency: 4 }, { maxConcurrency: 2 })).toBe(2);
  });

  test("requires positive safe integer app and loop bounds", () => {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
      expect(validateParallelismConfig({ maxConcurrency: value })).not.toEqual([]);
    }
    expect(validateParallelismConfig({ maxConcurrency: 1 })).toEqual([]);
    expect(validateMateriaLoopParallelConfig({})).toEqual([]);
    expect(validateMateriaLoopParallelConfig({ maxConcurrency: 3 })).toEqual([]);
    expect(validateMateriaLoopParallelConfig({ maxConcurrency: 0 })).not.toEqual([]);
  });
});
