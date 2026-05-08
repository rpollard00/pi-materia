import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  HANDOFF_CONTRACT_PROMPT_TEXT,
  HANDOFF_EDGE_CONDITIONS,
  HANDOFF_ENVELOPE_FIELDS,
  HANDOFF_RESERVED_CONTROL_FIELDS,
  HANDOFF_RESERVED_EVALUATOR_FIELDS,
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

  test("bundled default config references the central handoff contract instead of inline schema blocks", async () => {
    const rawDefault = JSON.parse(await readFile(path.resolve("config", "default.json"), "utf8"));
    const prompt = String(rawDefault.materia?.["Auto-Eval"]?.prompt ?? "");

    expect(prompt).toContain("runtime-provided canonical handoff JSON contract");
    expect(prompt).toContain("Set satisfied, feedback, and missing");
    expect(prompt).toContain("do not emit tasks");
    expect(prompt).not.toContain('"passed": boolean');

    const plannerPrompt = String(rawDefault.materia?.planner?.prompt ?? "");
    const interactivePrompt = String(rawDefault.materia?.interactivePlan?.prompt ?? "");
    expect(plannerPrompt).toContain("runtime-provided canonical handoff JSON");
    expect(plannerPrompt).toContain("workItems");
    expect(plannerPrompt).not.toContain('"tasks"');

    const maintainPrompt = String(rawDefault.materia?.Maintain?.prompt ?? "");
    const gitMaintainPrompt = String(rawDefault.materia?.GitMaintain?.prompt ?? "");
    expect(maintainPrompt).toContain("runtime-provided canonical handoff JSON contract");
    expect(gitMaintainPrompt).toContain("runtime-provided canonical handoff JSON contract");
    expect(maintainPrompt).not.toContain("return JSON with shape");
    expect(gitMaintainPrompt).not.toContain("return JSON with shape");

    const bundledPromptText = [plannerPrompt, interactivePrompt, prompt, maintainPrompt, gitMaintainPrompt].join("\n");
    expect(bundledPromptText).not.toContain('"summary": string');
    expect(bundledPromptText).not.toContain('"workItems": []');
    expect(bundledPromptText).not.toContain('"satisfied": boolean');
    expect(bundledPromptText).not.toContain("generic envelope shape");

    const inlineSchemaClues = [
      ...HANDOFF_ENVELOPE_FIELDS.map((field) => new RegExp(`${JSON.stringify(field).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(?:\\[\\]|\\{\\}|\"(?:string|boolean)\"|string|boolean)`)),
      /return JSON with shape/i,
    ];
    for (const [index, clue] of inlineSchemaClues.entries()) {
      expect(clue.test(bundledPromptText), `inline schema clue ${index} should stay centralized`).toBe(false);
    }
    for (const field of HANDOFF_RESERVED_EVALUATOR_FIELDS) {
      expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain(JSON.stringify(field));
    }

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
