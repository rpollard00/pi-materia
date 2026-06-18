import { describe, expect, test } from "bun:test";
import {
  HANDOFF_CONTRACT_DOC_TEXT,
  HANDOFF_CONTRACT_PROMPT_TEXT,
  HANDOFF_EDGE_CONDITIONS,
  HANDOFF_ENVELOPE_FIELDS,
  HANDOFF_TEXT_FIELD,
  createDeterministicHandoffOutput,
  createHandoffEnvelope,
  createPartialHandoffEnvelope,
  HANDOFF_LEGACY_NON_CANONICAL_ALIASES,
  HANDOFF_RESERVED_CONTROL_FIELDS,
  HANDOFF_RESERVED_EVALUATOR_FIELDS,
  HANDOFF_RESERVED_FIELD_TYPE_PROMPT_TEXT,
  HANDOFF_SATISFIED_FIELD,
  formatHandoffEnvelopeShape,
  formatHandoffJsonFinalInstruction,
} from "../src/handoff/handoffContract.js";
import { CANONICAL_EDGE_CONDITIONS } from "../src/graph/graphValidation.js";

describe("canonical handoff contract", () => {
  test("exports satisfied as the reserved runtime control field", () => {
    expect(HANDOFF_SATISFIED_FIELD).toBe("satisfied");
    expect(HANDOFF_RESERVED_CONTROL_FIELDS).toEqual(["satisfied"]);
    expect(HANDOFF_RESERVED_EVALUATOR_FIELDS).toEqual(["satisfied"]);
  });

  test("keeps graph edge conditions aligned with the central handoff contract", () => {
    expect(HANDOFF_EDGE_CONDITIONS).toEqual(["always", "satisfied", "not_satisfied"]);
    expect(CANONICAL_EDGE_CONDITIONS).toBe(HANDOFF_EDGE_CONDITIONS);
  });

  test("documents the small agent handoff contract", () => {
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain("agent handoff JSON contract");
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain('"workItems"');
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain('"satisfied"');
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain('"context"');
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain("title");
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain("nested context objects");
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain("Utility/script materia");
  });

  test("exposes text as the canonical renderable text payload field", () => {
    expect(HANDOFF_TEXT_FIELD).toBe("text");
    expect(HANDOFF_ENVELOPE_FIELDS).toContain(HANDOFF_TEXT_FIELD);
    expect(formatHandoffEnvelopeShape()).toContain('"text":"string"');
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain('"text"');
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain("renderable prose");
    expect(HANDOFF_CONTRACT_DOC_TEXT).toContain("text is optional top-level renderable prose");
    expect(HANDOFF_CONTRACT_DOC_TEXT).toContain("one-way presentation layer");
    // Full deterministic envelopes include text so utility/agent outputs normalize consistently.
    expect(createHandoffEnvelope({ satisfied: true })).toMatchObject({ text: "" });
    expect(createPartialHandoffEnvelope({ text: "narration", summary: "ignored" })).toEqual({ text: "narration" });
  });

  test("uses reserved field type guidance in final JSON instructions and synthetic context prose", () => {
    expect(HANDOFF_RESERVED_FIELD_TYPE_PROMPT_TEXT).toContain('"satisfied" is a boolean when present');
    expect(formatHandoffJsonFinalInstruction()).toContain("workItems, satisfied, context, and text");
    expect(formatHandoffJsonFinalInstruction()).not.toContain(HANDOFF_RESERVED_FIELD_TYPE_PROMPT_TEXT);
    expect(HANDOFF_CONTRACT_DOC_TEXT).toContain(HANDOFF_RESERVED_FIELD_TYPE_PROMPT_TEXT);
    expect(HANDOFF_CONTRACT_DOC_TEXT).toContain("title:string and context:string");
    expect(HANDOFF_CONTRACT_DOC_TEXT).toContain("Utility/script materia");
  });

  test("normalizes partial deterministic handoff outputs without dropping local extensions", () => {
    expect(createPartialHandoffEnvelope({ satisfied: false, feedback: "retry", value: 7 })).toEqual({ satisfied: false });
    expect(createDeterministicHandoffOutput({ satisfied: true, value: 7 })).toEqual({ satisfied: true, value: 7 });
  });

  test("does not document legacy aliases as canonical routing fields", () => {
    expect(HANDOFF_LEGACY_NON_CANONICAL_ALIASES).toEqual(["passed"]);
    expect(HANDOFF_RESERVED_CONTROL_FIELDS).not.toContain("passed");
    expect(HANDOFF_EDGE_CONDITIONS).not.toContain("passed" as never);
    expect(HANDOFF_CONTRACT_DOC_TEXT).toContain("not canonical handoff fields");
  });
});
