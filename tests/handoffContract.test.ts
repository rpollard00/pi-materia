import { describe, expect, test } from "bun:test";
import {
  HANDOFF_CONTRACT_DOC_TEXT,
  HANDOFF_CONTRACT_PROMPT_TEXT,
  HANDOFF_EDGE_CONDITIONS,
  HANDOFF_LEGACY_NON_CANONICAL_ALIASES,
  HANDOFF_RESERVED_CONTROL_FIELDS,
  HANDOFF_SATISFIED_FIELD,
} from "../src/handoffContract.js";
import { CANONICAL_EDGE_CONDITIONS } from "../src/graphValidation.js";

describe("canonical handoff contract", () => {
  test("exports satisfied as the reserved runtime control field", () => {
    expect(HANDOFF_SATISFIED_FIELD).toBe("satisfied");
    expect(HANDOFF_RESERVED_CONTROL_FIELDS).toEqual(["satisfied"]);
  });

  test("keeps graph edge conditions aligned with the central handoff contract", () => {
    expect(HANDOFF_EDGE_CONDITIONS).toEqual(["always", "satisfied", "not_satisfied"]);
    expect(CANONICAL_EDGE_CONDITIONS).toBe(HANDOFF_EDGE_CONDITIONS);
  });

  test("provides prompt guidance that separates reserved controls from payload fields", () => {
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain("flat handoff message object");
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain('"satisfied" is the canonical boolean control field');
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain("arbitrary additional payload fields");
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain("must not redefine or alias reserved control semantics");
  });

  test("does not document legacy aliases as canonical routing fields", () => {
    expect(HANDOFF_LEGACY_NON_CANONICAL_ALIASES).toEqual(["passed"]);
    expect(HANDOFF_RESERVED_CONTROL_FIELDS).not.toContain("passed");
    expect(HANDOFF_EDGE_CONDITIONS).not.toContain("passed" as never);
    expect(HANDOFF_CONTRACT_DOC_TEXT).toContain("not canonical handoff fields");
  });
});
