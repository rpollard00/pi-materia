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
} from "../src/handoff/handoffContract.js";
import { buildRoleGenerationPrompt } from "../src/handoff/roleGeneration.js";

function collectObjectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectObjectKeys(item, keys);
    return keys;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      keys.add(key);
      collectObjectKeys(child, keys);
    }
  }
  return keys;
}

describe("handoff contract drift regressions", () => {
  test("central exports remain the canonical source consumed by prompt generation", () => {
    expect(HANDOFF_SATISFIED_FIELD).toBe("satisfied");
    expect(HANDOFF_RESERVED_CONTROL_FIELDS).toEqual([HANDOFF_SATISFIED_FIELD]);
    expect(HANDOFF_EDGE_CONDITIONS).toEqual(["always", "satisfied", "not_satisfied"]);

    const generated = buildRoleGenerationPrompt("write a JSON evaluator role");
    expect(generated).toContain("describe only socket-relevant payload fields");
    expect(generated).toContain("never ask for the entire canonical envelope");
    expect(generated).not.toContain(HANDOFF_CONTRACT_PROMPT_TEXT);
    expect(generated).not.toContain('"satisfied" is the canonical boolean control field');
  });

  test("canonical docs and README examples do not resurrect legacy passed routing syntax", async () => {
    const docs = await readFile(path.resolve("docs", "handoff-contract.md"), "utf8");
    const readme = await readFile(path.resolve("README.md"), "utf8");
    const checkedDocs = `${docs}\n${readme}`;

    expect(docs).toContain("`satisfied` is the canonical routing field");
    expect(docs).toContain("When present, `satisfied` must be a JSON boolean (`true` or `false`).");
    expect(docs).toContain("When present, `feedback` must be a JSON string.");
    expect(docs).toContain("When present, `missing` must be a JSON array of missing items.");
    expect(docs).toContain("`workItems`, not `tasks`");
    expect(docs).toContain('{ "when": "satisfied", "to": "Maintain" }');
    expect(docs).toContain('{ "when": "not_satisfied", "to": "Build"');
    expect(checkedDocs).not.toMatch(/\$\.passed\s*==/);
    expect(checkedDocs).not.toContain('"passed": boolean');
    expect(checkedDocs).not.toMatch(/when["`:\s]+passed/);
  });

  test("canonical Generator docs and examples stay generator true and workItems-based", async () => {
    const readme = await readFile(path.resolve("README.md"), "utf8");
    const graphSemantics = await readFile(path.resolve("docs", "graph-semantics.md"), "utf8");
    const handoffContract = await readFile(path.resolve("docs", "handoff-contract.md"), "utf8");
    const exampleLoadout = await readFile(path.resolve("examples", "graph-semantics-loadout.json"), "utf8");
    const canonicalDocs = `${readme}\n${graphSemantics}\n${handoffContract}`;

    expect(canonicalDocs).toContain("generator: true");
    expect(canonicalDocs).toContain("workItems");
    expect(canonicalDocs).toContain("Generated units of work use `workItems`, not `tasks`");
    expect(canonicalDocs).not.toMatch(/generates[^.\n]*obsolete compatibility/i);
    expect(canonicalDocs).not.toContain("not as the canonical schema");
    expect(canonicalDocs).not.toContain("Generated List");

    const parsedExample = JSON.parse(exampleLoadout) as { materia?: Record<string, unknown> };
    expect(parsedExample.materia?.["Auto-Plan"]).toMatchObject({ generator: true });
    expect(exampleLoadout).toContain('"workItems"');
    expect(exampleLoadout).toContain("workItems[].context.architecture");
    expect(exampleLoadout).not.toContain('"tasks"');
    expect(exampleLoadout).not.toContain('"generates"');
  });

  test("examples avoid invented architecture aliases while showing canonical per-item placement", async () => {
    const exampleLoadout = await readFile(path.resolve("examples", "graph-semantics-loadout.json"), "utf8");
    const parsedExample = JSON.parse(exampleLoadout);
    const keys = collectObjectKeys(parsedExample);

    expect(exampleLoadout).toContain("workItems[].context.architecture");
    expect(exampleLoadout).not.toContain("architectureGuidance");
    expect(exampleLoadout).not.toContain("top-level architecture");
    expect(keys.has("architectureGuidance")).toBe(false);
    expect(keys.has("tasks")).toBe(false);
    expect(keys.has("generates")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsedExample, "architecture")).toBe(false);
  });

  test("bundled default config references the central handoff contract instead of inline schema blocks", async () => {
    const rawDefault = JSON.parse(await readFile(path.resolve("config", "default.json"), "utf8"));
    const prompt = String(rawDefault.materia?.["Auto-Eval"]?.prompt ?? "");

    expect(prompt).toContain("compact JSON with evaluator fields relevant to this socket");
    expect(prompt).toContain("Set satisfied as a boolean, feedback as one concise string, and missing as an array of missing items");
    expect(prompt).toContain("do not emit tasks");
    expect(prompt).not.toContain('"passed": boolean');

    const plannerPrompt = String(rawDefault.materia?.["Auto-Plan"]?.prompt ?? "");
    const interactivePrompt = String(rawDefault.materia?.["Interactive-Plan"]?.prompt ?? "");
    expect(plannerPrompt).toContain("compact JSON containing only plan fields relevant to the socket");
    expect(plannerPrompt).toContain("workItems");
    expect(plannerPrompt).not.toContain('"tasks"');
    expect(interactivePrompt).toContain("Do not emit final workItems JSON during refinement");
    expect(interactivePrompt).toContain("return compact JSON with workItems and any socket-relevant summary");
    expect(interactivePrompt).toContain("workItems[].context.architecture");

    const maintainPrompt = String(rawDefault.materia?.Maintain?.prompt ?? "");
    const gitMaintainPrompt = String(rawDefault.materia?.GitMaintain?.prompt ?? "");
    expect(maintainPrompt).toContain("return compact JSON with satisfied, feedback, and maintenance payload fields");
    expect(gitMaintainPrompt).toContain("return compact JSON with satisfied, feedback, and socket-specific maintenance payload fields");
    expect(maintainPrompt).not.toContain("return JSON with shape");
    expect(gitMaintainPrompt).not.toContain("return JSON with shape");

    const chainContextPrompt = String(rawDefault.materia?.["Chain-Context"]?.prompt ?? "");
    expect(chainContextPrompt).toContain("feedback as one concise diagnostic string");
    expect(chainContextPrompt).toContain("missing as an array containing");

    const bundledPromptText = [plannerPrompt, interactivePrompt, prompt, maintainPrompt, gitMaintainPrompt].join("\n");
    expect(bundledPromptText).not.toContain("Return only the runtime-provided canonical handoff JSON object");
    expect(bundledPromptText).not.toContain("return only JSON using the runtime-provided canonical handoff contract");
    expect(bundledPromptText).not.toMatch(/(?:include|place|put|emit)\s+(?:generated\s+)?work items\s+in\s+tasks/i);
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

    const feedbackTypePromptText = [bundledPromptText, chainContextPrompt].join("\n");
    expect(feedbackTypePromptText).not.toMatch(/feedback\s+(?:as|must be|should be|is)\s+(?:an?\s+)?(?:array|list|\[\])/i);
    expect(feedbackTypePromptText).not.toMatch(/missing\s+(?:as|must be|should be|is)\s+(?:a\s+)?(?:string|concise diagnostic)/i);

    for (const [loadoutName, loadout] of Object.entries(rawDefault.loadouts ?? {}) as Array<[string, { sockets?: Record<string, { edges?: Array<{ when?: unknown }> }> }]>) {
      for (const [socketName, socket] of Object.entries(loadout.sockets ?? {})) {
        for (const [index, edge] of (socket.edges ?? []).entries()) {
          expect(HANDOFF_EDGE_CONDITIONS.includes(edge.when as never), `${loadoutName}.${socketName}.edges[${index}].when`).toBe(true);
          expect(edge.when).not.toBe("passed");
        }
      }
    }
  });
});
