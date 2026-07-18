import { createHash } from "node:crypto";
import type { HandoffWorkItem } from "../domain/handoff.js";
import { TOOL_BACKED_HANDOFF_NAMES } from "./toolBackedHandoffTools.js";

export const TOOL_HANDOFF_EXPERIMENT_CASE_ID = "escaping-heavy-v1";

export interface ToolHandoffExperimentEnvelope {
  workItems: HandoffWorkItem[];
  satisfied: boolean;
  context: string;
}

/** Fixed semantic payload used by both cohorts. */
export const TOOL_HANDOFF_EXPERIMENT_ENVELOPE: ToolHandoffExperimentEnvelope = {
  workItems: [
    {
      title: "feat: preserve \"quoted\" paths 🧪",
      context: [
        "Run `npm test -- --filter=\"handoff\"` from C:\\Users\\materia\\repo.",
        "Alpha",
        "Beta\tkeeps a tab; keep the two-character sequence \\n literal.",
        "Regex: ^workItems\\[\\d+\\]\\.context$; UNC: \\\\server\\share\\casts.",
        "Unicode: café, 東京, Ελληνικά, مرحبا, हिंदी, emoji 🚀, and combining é.",
        "Long guidance: parse first, validate every consumed path second, and commit only after validation succeeds; do not silently normalize punctuation, slash direction, whitespace, or code-like fragments while carrying this item downstream.",
      ].join("\n"),
    },
    {
      title: "test: retain mixed punctuation and multiline context",
      context: [
        "Round-trip `code`, **markdown**, braces {}, brackets [], parentheses (), arrows -> and =>, semicolon; colon: comma, slash /, backslash \\, and quote \".",
        "URL: https://example.test/a?x=\"one\"&y=two; JSONPath: $.workItems.0.context.",
        "First physical line.",
        "Second physical line with literal \\r\\n and a snow character 雪.",
        "Long guidance: retain ordered work items and exact string values so the controlled comparison can separate malformed serialization from schema, contract, missing-commit, and semantic-copy failures.",
      ].join("\n"),
    },
  ],
  satisfied: true,
  context: "Final summary: preserve \"quotes\", C:\\repo, regex ^foo\\s+bar$, literal \\n, Unicode 東京 🧪, and this physical newline:\nfinished.",
};

export function cloneExperimentEnvelope(envelope: ToolHandoffExperimentEnvelope): ToolHandoffExperimentEnvelope {
  return {
    workItems: envelope.workItems.map((item) => ({ ...item })),
    satisfied: envelope.satisfied,
    context: envelope.context,
  };
}

export function experimentPayloadHash(envelope: ToolHandoffExperimentEnvelope): string {
  return createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
}

export function commonExperimentPayloadPrompt(envelope: ToolHandoffExperimentEnvelope): string {
  const sections = envelope.workItems.flatMap((item, index) => [
    `WORK ITEM ${index + 1} TITLE BEGIN\n${item.title}\nWORK ITEM ${index + 1} TITLE END`,
    `WORK ITEM ${index + 1} CONTEXT BEGIN\n${item.context}\nWORK ITEM ${index + 1} CONTEXT END`,
  ]);
  return [
    "Controlled semantic payload follows. Marker lines are delimiters and are not part of any value. Copy every value exactly, including physical newlines, tabs, quotes, backslashes, literal backslash-letter sequences, combining characters, and work-item order.",
    ...sections,
    `SATISFIED BOOLEAN: ${envelope.satisfied ? "true" : "false"}`,
    `FINAL CONTEXT BEGIN\n${envelope.context}\nFINAL CONTEXT END`,
  ].join("\n\n");
}

export function directExperimentPrompt(common: string): string {
  return [
    common,
    "Output strategy: return exactly one bare canonical JSON object with top-level fields workItems, satisfied, and context. Each work item may contain only title and context. Author all JSON syntax and escaping yourself. Do not use markdown fences or commentary.",
  ].join("\n\n");
}

export function toolExperimentPrompt(common: string): string {
  return [
    common,
    `Output strategy: do not write the handoff as text. Use ${TOOL_BACKED_HANDOFF_NAMES.addWorkItem} once for each item in order, ${TOOL_BACKED_HANDOFF_NAMES.setSatisfied} once, and ${TOOL_BACKED_HANDOFF_NAMES.setContext} once. Then call ${TOOL_BACKED_HANDOFF_NAMES.commit} alone as the final action. Tool arguments must carry the exact supplied values.`,
  ].join("\n\n");
}

export function directExperimentRecoveryPrompt(outcome: string): string {
  const reason = outcome === "json_syntax" || outcome === "empty_output"
    ? "The previous submission was empty or malformed JSON."
    : outcome === "contract_rejection"
      ? "The previous submission violated the canonical handoff field contract."
      : outcome === "semantic_mismatch"
        ? "The previous submission changed one or more supplied semantic values."
        : "The previous provider response was not usable.";
  return `${reason} Retry once: return only one bare canonical JSON object, preserving the previously supplied values exactly. Do not add commentary or markdown fences.`;
}

export function toolExperimentRecoveryPrompt(): string {
  return `The handoff has not been committed. Use only the available materia_handoff tools to submit any still-missing canonical fields, then call ${TOOL_BACKED_HANDOFF_NAMES.commit} alone. Do not emit textual JSON.`;
}
