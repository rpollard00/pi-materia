import { describe, expect, test } from "bun:test";
import {
  HANDOFF_CONTRACT_DOC_TEXT,
  HANDOFF_CONTRACT_PROMPT_TEXT,
  HANDOFF_EDGE_CONDITIONS,
  createDeterministicHandoffOutput,
  createPartialHandoffEnvelope,
  HANDOFF_LEGACY_NON_CANONICAL_ALIASES,
  HANDOFF_RESERVED_CONTROL_FIELDS,
  HANDOFF_RESERVED_EVALUATOR_FIELDS,
  HANDOFF_RESERVED_FIELD_TYPE_PROMPT_TEXT,
  HANDOFF_SATISFIED_FIELD,
  formatHandoffJsonFinalInstruction,
} from "../src/handoff/handoffContract.js";
import { CANONICAL_EDGE_CONDITIONS } from "../src/graph/graphValidation.js";

describe("canonical handoff contract", () => {
  test("exports satisfied as the reserved runtime control field and evaluator fields", () => {
    expect(HANDOFF_SATISFIED_FIELD).toBe("satisfied");
    expect(HANDOFF_RESERVED_CONTROL_FIELDS).toEqual(["satisfied"]);
    expect(HANDOFF_RESERVED_EVALUATOR_FIELDS).toEqual(["satisfied", "feedback", "missing"]);
  });

  test("keeps graph edge conditions aligned with the central handoff contract", () => {
    expect(HANDOFF_EDGE_CONDITIONS).toEqual(["always", "satisfied", "not_satisfied"]);
    expect(CANONICAL_EDGE_CONDITIONS).toBe(HANDOFF_EDGE_CONDITIONS);
  });

  test("provides prompt guidance for the generic envelope and reserved evaluator fields", () => {
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain("generic handoff envelope");
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain('"workItems"');
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain("never tasks");
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain('"satisfied" is the canonical boolean control field');
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain('"feedback" is a string when present');
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain('"missing" is an array when present');
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain("Do not format \"feedback\" as a list or array");
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain("must not redefine or alias reserved evaluator/route semantics");
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain("legacy placement terminology");
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain("Preserve useful existing summary, workItems, guidance, decisions, risks, feedback, and missing context");
  });

  test("uses reserved field type guidance in final JSON instructions and synthetic context prose", () => {
    expect(HANDOFF_RESERVED_FIELD_TYPE_PROMPT_TEXT).toContain('"satisfied" is a boolean when present');
    expect(HANDOFF_RESERVED_FIELD_TYPE_PROMPT_TEXT).toContain('"feedback" is a string when present');
    expect(HANDOFF_RESERVED_FIELD_TYPE_PROMPT_TEXT).toContain('"missing" is an array when present');
    expect(formatHandoffJsonFinalInstruction()).toContain(HANDOFF_RESERVED_FIELD_TYPE_PROMPT_TEXT);
    expect(HANDOFF_CONTRACT_DOC_TEXT).toContain(HANDOFF_RESERVED_FIELD_TYPE_PROMPT_TEXT);
  });

  test("normalizes partial deterministic handoff outputs without dropping local extensions", () => {
    expect(createPartialHandoffEnvelope({ satisfied: false, feedback: "retry", value: 7 })).toEqual({ satisfied: false, feedback: "retry" });
    expect(createDeterministicHandoffOutput({ satisfied: true, value: 7 })).toEqual({ satisfied: true, value: 7 });
  });

  test("does not document legacy aliases as canonical routing fields", () => {
    expect(HANDOFF_LEGACY_NON_CANONICAL_ALIASES).toEqual(["passed"]);
    expect(HANDOFF_RESERVED_CONTROL_FIELDS).not.toContain("passed");
    expect(HANDOFF_EDGE_CONDITIONS).not.toContain("passed" as never);
    expect(HANDOFF_CONTRACT_DOC_TEXT).toContain("not canonical handoff fields");
  });
});
