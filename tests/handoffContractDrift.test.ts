import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  HANDOFF_CONTRACT_PROMPT_TEXT,
  HANDOFF_EDGE_CONDITIONS,
  HANDOFF_RESERVED_CONTROL_FIELDS,
  HANDOFF_SATISFIED_FIELD,
} from "../src/handoffContract.js";
import { buildRoleGenerationPrompt } from "../src/roleGeneration.js";

describe("handoff contract drift regressions", () => {
  test("central exports remain the canonical source consumed by prompt generation", () => {
    expect(HANDOFF_SATISFIED_FIELD).toBe("satisfied");
    expect(HANDOFF_RESERVED_CONTROL_FIELDS).toEqual([HANDOFF_SATISFIED_FIELD]);
    expect(HANDOFF_EDGE_CONDITIONS).toEqual(["always", "satisfied", "not_satisfied"]);

    const generated = buildRoleGenerationPrompt("write a JSON evaluator role");
    expect(generated).toContain(HANDOFF_CONTRACT_PROMPT_TEXT);
    expect(generated).toContain("generic handoff envelope");
    expect(generated).toContain('"satisfied" is the canonical boolean control field');
  });

  test("canonical docs and README examples do not resurrect legacy passed routing syntax", async () => {
    const docs = await readFile(path.resolve("docs", "handoff-contract.md"), "utf8");
    const readme = await readFile(path.resolve("README.md"), "utf8");
    const checkedDocs = `${docs}\n${readme}`;

    expect(docs).toContain("`satisfied` is the canonical routing field");
    expect(docs).toContain("`workItems`, not `tasks`");
    expect(docs).toContain('{ "when": "satisfied", "to": "Maintain" }');
    expect(docs).toContain('{ "when": "not_satisfied", "to": "Build"');
    expect(checkedDocs).not.toMatch(/\$\.passed\s*==/);
    expect(checkedDocs).not.toContain('"passed": boolean');
    expect(checkedDocs).not.toMatch(/when["`:\s]+passed/);
  });

  test("bundled default config keeps evaluator prompts and edges aligned with satisfied", async () => {
    const rawDefault = JSON.parse(await readFile(path.resolve("config", "default.json"), "utf8"));
    const prompt = String(rawDefault.materia?.["Auto-Eval"]?.prompt ?? "");

    expect(prompt).toContain('"satisfied": boolean');
    expect(prompt).toContain('"workItems": []');
    expect(prompt).toContain("generic envelope shape");
    expect(prompt).toContain("do not emit tasks");
    expect(prompt).not.toContain('"passed": boolean');

    const plannerPrompt = String(rawDefault.materia?.planner?.prompt ?? "");
    expect(plannerPrompt).toContain('"workItems"');
    expect(plannerPrompt).not.toContain('"tasks"');

    for (const [loadoutName, loadout] of Object.entries(rawDefault.loadouts ?? {}) as Array<[string, { nodes?: Record<string, { edges?: Array<{ when?: unknown }> }> }]>) {
      for (const [nodeName, node] of Object.entries(loadout.nodes ?? {})) {
        for (const [index, edge] of (node.edges ?? []).entries()) {
          expect(HANDOFF_EDGE_CONDITIONS.includes(edge.when as never), `${loadoutName}.${nodeName}.edges[${index}].when`).toBe(true);
          expect(edge.when).not.toBe("passed");
        }
      }
    }
  });
});
