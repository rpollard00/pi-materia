import { describe, expect, test } from "bun:test";
import { parseToolBackedHandoffExperimentArguments } from "../src/prototype/toolBackedHandoffExperimentCli.js";

describe("tool-backed handoff experiment CLI", () => {
  test("accepts max as a Pi thinking level without running a provider", () => {
    const options = parseToolBackedHandoffExperimentArguments([
      "--output", "evidence.json",
      "--thinking", "max",
    ]);

    expect(options.thinking).toBe("max");
    expect(options.output).toBe("evidence.json");
  });

  test("rejects unknown thinking levels with usage guidance", () => {
    expect(() => parseToolBackedHandoffExperimentArguments([
      "--output", "evidence.json",
      "--thinking", "turbo",
    ])).toThrow(/Unsupported thinking level "turbo"\.\nUsage: npm run experiment:tool-handoff/);
  });
});
