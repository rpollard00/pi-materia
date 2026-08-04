import { describe, expect, test } from "bun:test";
import { readModelCatalogResponse } from "../src/central/client/responseValidation.js";

describe("central model catalog response validation", () => {
  test("accepts max as a supported thinking level", () => {
    expect(readModelCatalogResponse({
      ok: true,
      catalog: { entries: [{ value: "openai/gpt-test", supportedThinkingLevels: ["xhigh", "max"] }] },
    })?.entries[0]?.supportedThinkingLevels).toEqual(["xhigh", "max"]);
  });

  test("continues to reject unknown thinking levels", () => {
    expect(() => readModelCatalogResponse({
      ok: true,
      catalog: { entries: [{ value: "openai/gpt-test", supportedThinkingLevels: ["turbo"] }] },
    })).toThrow("must contain known thinking levels");
  });
});
