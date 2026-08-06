import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";

describe("bundled Parallel-Plan-Interactive materia", () => {
  test("ships a locked, model-agnostic interactive parallel generator", async () => {
    const rawDefault = JSON.parse(await readFile(path.resolve("config", "default.json"), "utf8")) as {
      materia?: Record<string, Record<string, unknown>>;
    };
    const planner = rawDefault.materia?.["Parallel-Plan-Interactive"];

    expect(planner).toMatchObject({
      type: "agent",
      tools: "readOnly",
      parse: "json",
      multiTurn: true,
      generator: true,
      parallel: true,
      lockState: "locked",
    });
    expect(planner).not.toHaveProperty("model");
    expect(planner).not.toHaveProperty("thinking");

    const prompt = String(planner?.prompt ?? "");
    expect(prompt).toContain("Create a pragmatic implementation plan");
    expect(prompt).toContain("Collaborate with the user over multiple turns");
    expect(prompt).toContain("normal conversation");
    expect(prompt).toContain("Do not emit the structured workItems JSON during refinement");
    expect(prompt).toContain("Only after the user runs /materia continue");
    expect(prompt).toContain("Treat all normal user messages as refinement input");
    expect(prompt).toContain("workItems");
  });
});
