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

function collectObjectKeys(
  value: unknown,
  keys = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectObjectKeys(item, keys);
    return keys;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
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
    expect(HANDOFF_EDGE_CONDITIONS).toEqual([
      "always",
      "satisfied",
      "not_satisfied",
    ]);

    const generated = buildRoleGenerationPrompt("write a JSON evaluator role");
    expect(generated).toContain(
      "describe only socket-relevant fields from the small contract. The default explanatory handoff fields are workItems, satisfied, and context",
    );
    expect(generated).toContain("reserve explanatory notes for context");
    expect(generated).not.toContain("entire canonical envelope");
    expect(generated).not.toContain(HANDOFF_CONTRACT_PROMPT_TEXT);
    expect(generated).not.toContain(
      '"satisfied" is the canonical boolean control field',
    );
  });

  test("canonical docs and README examples do not resurrect legacy passed routing syntax", async () => {
    const docs = await readFile(
      path.resolve("docs", "handoff-contract.md"),
      "utf8",
    );
    const readme = await readFile(path.resolve("README.md"), "utf8");
    const checkedDocs = `${docs}\n${readme}`;

    expect(docs).toContain("`satisfied` is the canonical routing field");
    expect(docs).toContain(
      "When present, `satisfied` must be a JSON boolean (`true` or `false`).",
    );
    expect(docs).toContain(
      "Obsolete broad-envelope fields such as `summary`, `guidance`, `decisions`, `risks`, `feedback`, `missing`, or `state` are not part of the agent handoff contract.",
    );
    expect(docs).toContain(
      "Utility and script materia are deterministic producers, not model-authored agent handoffs.",
    );
    expect(docs).toContain(
      "utility `state` patch is separate from agent handoff fields",
    );
    expect(docs).toContain(
      "Displays should label generated work from `workItems[].title`",
    );
    expect(`$${checkedDocs}`).not.toContain('"artifactIgnore": "$"');
    expect(`$${checkedDocs}`).not.toContain('"vcs": "$"');
    expect(docs).toContain("`workItems`, not `tasks`");
    expect(docs).toContain('{ "when": "satisfied", "to": "Maintain" }');
    expect(docs).toContain('{ "when": "not_satisfied", "to": "Build"');
    expect(checkedDocs).not.toMatch(/\$\.passed\s*==/);
    expect(checkedDocs).not.toContain('"passed": boolean');
    expect(checkedDocs).not.toMatch(/when["`:\s]+passed/);
  });

  test("canonical Generator docs and examples stay generator true and workItems-based", async () => {
    const readme = await readFile(path.resolve("README.md"), "utf8");
    const graphSemantics = await readFile(
      path.resolve("docs", "graph-semantics.md"),
      "utf8",
    );
    const handoffContract = await readFile(
      path.resolve("docs", "handoff-contract.md"),
      "utf8",
    );
    const exampleLoadout = await readFile(
      path.resolve("examples", "graph-semantics-loadout.json"),
      "utf8",
    );
    const canonicalDocs = `${readme}\n${graphSemantics}\n${handoffContract}`;

    expect(canonicalDocs).toContain("generator: true");
    expect(canonicalDocs).toContain("workItems");
    expect(canonicalDocs).toContain(
      "Generated units of work use `workItems`, not `tasks`",
    );
    expect(canonicalDocs).not.toMatch(
      /generates[^.\n]*obsolete compatibility/i,
    );
    expect(canonicalDocs).not.toContain("not as the canonical schema");
    expect(canonicalDocs).not.toContain("Generated List");

    const parsedExample = JSON.parse(exampleLoadout) as {
      materia?: Record<string, unknown>;
    };
    expect(parsedExample.materia?.["Auto-Plan"]).toMatchObject({
      generator: true,
    });
    expect(exampleLoadout).toContain('"workItems"');
    expect(exampleLoadout).toContain(
      "each item has only title and context strings",
    );
    expect(exampleLoadout).not.toContain('"tasks"');
    expect(exampleLoadout).not.toContain('"generates"');
  });

  test("examples avoid invented architecture aliases while showing canonical per-item placement", async () => {
    const exampleLoadout = await readFile(
      path.resolve("examples", "graph-semantics-loadout.json"),
      "utf8",
    );
    const parsedExample = JSON.parse(exampleLoadout);
    const keys = collectObjectKeys(parsedExample);

    expect(exampleLoadout).toContain("title and context strings");
    expect(exampleLoadout).not.toContain("context.architecture");
    expect(exampleLoadout).not.toContain("architectureGuidance");
    expect(exampleLoadout).not.toContain("top-level architecture");
    expect(keys.has("architectureGuidance")).toBe(false);
    expect(keys.has("tasks")).toBe(false);
    expect(keys.has("generates")).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(parsedExample, "architecture"),
    ).toBe(false);
  });

  test("bundled default config references the central handoff contract instead of inline schema blocks", async () => {
    const rawDefault = JSON.parse(
      await readFile(path.resolve("config", "default.json"), "utf8"),
    );
    const prompt = String(rawDefault.materia?.["Auto-Eval"]?.prompt ?? "");

    expect(prompt).toContain(
      "Verify whether the work satisfies",
    );
    expect(prompt).toContain(
      "Bash is available for evaluation commands",
    );
    expect(prompt).toContain("Run relevant tests and ensure they pass");
    expect(prompt).not.toContain('"passed": boolean');

    const plannerPrompt = String(
      rawDefault.materia?.["Auto-Plan"]?.prompt ?? "",
    );
    const interactivePrompt = String(
      rawDefault.materia?.["Interactive-Plan"]?.prompt ?? "",
    );
    expect(plannerPrompt).toContain(
      "Create an implementation plan for this request",
    );
    expect(plannerPrompt).toContain("workItems");
    expect(plannerPrompt).not.toContain('"tasks"');
    expect(interactivePrompt).toContain(
      "Do not emit final workItems JSON during refinement",
    );
    expect(interactivePrompt).toContain(
      "return compact JSON with workItems and optional socket-relevant context",
    );
    expect(interactivePrompt).toContain(
      "Each workItem must contain only title:string and context:string",
    );

    const maintainPrompt = String(rawDefault.materia?.Maintain?.prompt ?? "");
    const gitMaintainPrompt = String(
      rawDefault.materia?.GitMaintain?.prompt ?? "",
    );
    expect(maintainPrompt).toContain(
      "return compact JSON with only satisfied and explanatory context",
    );
    expect(gitMaintainPrompt).toContain(
      "return compact JSON with only satisfied and explanatory context",
    );
    expect(maintainPrompt).toContain(
      "Always inspect repository state before checkpointing",
    );
    expect(gitMaintainPrompt).toContain(
      "Do not emit checkpointCreated, commands, commitMessage",
    );
    expect(maintainPrompt).not.toContain("return JSON with shape");
    expect(gitMaintainPrompt).not.toContain("return JSON with shape");

    const chainContextPrompt = String(
      rawDefault.materia?.["Chain-Context"]?.prompt ?? "",
    );
    expect(chainContextPrompt).toContain(
      "context explaining that state.previousCastContext is unavailable",
    );
    expect(chainContextPrompt).toContain(
      "prior request and cast id",
    );

    const bundledPromptText = [
      plannerPrompt,
      interactivePrompt,
      prompt,
      maintainPrompt,
      gitMaintainPrompt,
    ].join("\n");
    expect(bundledPromptText).not.toContain("workItems[].context.architecture");
    expect(bundledPromptText).not.toContain(
      "top-level guidance, decisions, or risks",
    );
    expect(bundledPromptText).not.toContain("feedback, and missing");
    expect(bundledPromptText).not.toContain(
      "Return only the runtime-provided canonical handoff JSON object",
    );
    expect(bundledPromptText).not.toContain(
      "return only JSON using the runtime-provided canonical handoff contract",
    );
    expect(bundledPromptText).not.toMatch(
      /(?:include|place|put|emit)\s+(?:generated\s+)?work items\s+in\s+tasks/i,
    );
    expect(bundledPromptText).not.toContain('"summary": string');
    expect(bundledPromptText).not.toContain('"workItems": []');
    expect(bundledPromptText).not.toContain('"satisfied": boolean');
    expect(bundledPromptText).not.toContain("generic envelope shape");

    const inlineSchemaClues = [
      ...HANDOFF_ENVELOPE_FIELDS.map(
        (field) =>
          new RegExp(
            `${JSON.stringify(field).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(?:\\[\\]|\\{\\}|\"(?:string|boolean)\"|string|boolean)`,
          ),
      ),
      /return JSON with shape/i,
    ];
    for (const [index, clue] of inlineSchemaClues.entries()) {
      expect(
        clue.test(bundledPromptText),
        `inline schema clue ${index} should stay centralized`,
      ).toBe(false);
    }
    for (const field of HANDOFF_RESERVED_EVALUATOR_FIELDS) {
      expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain(JSON.stringify(field));
    }

    const feedbackTypePromptText = [bundledPromptText, chainContextPrompt].join(
      "\n",
    );
    expect(feedbackTypePromptText).not.toMatch(
      /feedback\s+(?:as|must be|should be|is)\s+(?:an?\s+)?(?:array|list|\[\]|concise string|concise diagnostic)/i,
    );
    expect(feedbackTypePromptText).not.toMatch(
      /missing\s+(?:as|must be|should be|is)\s+(?:a\s+)?(?:string|concise diagnostic|array|list)/i,
    );

    for (const [loadoutName, loadout] of Object.entries(
      rawDefault.loadouts ?? {},
    ) as Array<
      [
        string,
        { sockets?: Record<string, { edges?: Array<{ when?: unknown }> }> },
      ]
    >) {
      for (const [socketName, socket] of Object.entries(
        loadout.sockets ?? {},
      )) {
        for (const [index, edge] of (socket.edges ?? []).entries()) {
          expect(
            HANDOFF_EDGE_CONDITIONS.includes(edge.when as never),
            `${loadoutName}.${socketName}.edges[${index}].when`,
          ).toBe(true);
          expect(edge.when).not.toBe("passed");
        }
      }
    }
  });

  test("bundled default JSON materia prompts reserve context and do not invite top-level text leakage", async () => {
    const rawDefault = JSON.parse(
      await readFile(path.resolve("config", "default.json"), "utf8"),
    ) as { materia?: Record<string, { prompt?: string; parse?: string }> };

    // Ordinary evaluator/maintainer/planner/architect/chain-context JSON
    // sockets must reserve explanatory notes for `context` and explicitly tell
    // the model not to emit a top-level `text` field, so default prompts never
    // imply generic JSON sockets emit renderable text.
    const nonTextJsonRoles = [
      "Auto-Eval",
      "Maintain",
      "GitMaintain",
      "Auto-Plan",
      "Interactive-Plan",
      "Auto-Architect",
      "Chain-Context",
    ];
    for (const role of nonTextJsonRoles) {
      const prompt = String(rawDefault.materia?.[role]?.prompt ?? "");
      expect(
        prompt,
        `${role} should reserve explanatory notes for context`,
      ).toMatch(/context/i);
      expect(
        prompt,
        `${role} should tell the model not to emit a top-level text field`,
      ).toMatch(/do not emit a top-level text field/i);
      expect(rawDefault.materia?.[role]?.parse).toBe("json");
    }

    // Renderable-prose (parse:text) sockets remain the canonical opt-in text
    // example and must not carry the non-text no-text-field disclaimer.
    const narratePrompt = String(rawDefault.materia?.Narrate?.prompt ?? "");
    expect(rawDefault.materia?.Narrate?.parse).toBe("text");
    expect(narratePrompt).toContain("Return markdown text only");
    expect(narratePrompt).not.toMatch(/do not emit a top-level text field/i);
  });
});
