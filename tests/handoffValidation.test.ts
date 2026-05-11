import { describe, expect, test } from "bun:test";
import { validateHandoffJsonOutput } from "../src/handoff/handoffValidation.js";
import type { MateriaPipelineSocketConfig } from "../src/types.js";

function socket(overrides: Partial<MateriaPipelineSocketConfig> = {}): MateriaPipelineSocketConfig {
  return { type: "utility", utility: "echo", parse: "json", ...overrides };
}

describe("handoff JSON runtime validation", () => {
  test("accepts JSON objects with generic work item payload fields", () => {
    const value = { workItems: [{ title: "Build" }], feedback: "ok", missing: [] };
    expect(validateHandoffJsonOutput(value, { socketId: "Plan", socket: socket() })).toBe(value);
  });

  test("accepts canonical satisfied booleans for satisfied routing", () => {
    const value = { satisfied: false, feedback: "retry" };
    expect(validateHandoffJsonOutput(value, { socketId: "Check", socket: socket({ edges: [{ when: "not_satisfied", to: "Build" }] }) })).toBe(value);
  });

  test("rejects non-object JSON handoff outputs", () => {
    expect(() => validateHandoffJsonOutput(["task"], { socketId: "Plan", socket: socket() })).toThrow(/expected a JSON object at the top level/);
    expect(() => validateHandoffJsonOutput(null, { socketId: "Plan", socket: socket() })).toThrow(/expected a JSON object at the top level/);
  });

  test("rejects malformed reserved evaluator/route fields", () => {
    expect(() => validateHandoffJsonOutput({ satisfied: "true" }, { socketId: "Check", socket: socket() })).toThrow(/reserved control field "satisfied" must be a boolean/);
    expect(() => validateHandoffJsonOutput({ feedback: ["retry"] }, { socketId: "Check", socket: socket() })).toThrow(/reserved evaluator field "feedback" must be a string/);
    expect(() => validateHandoffJsonOutput({ missing: "retry" }, { socketId: "Check", socket: socket() })).toThrow(/reserved evaluator field "missing" must be an array/);
  });

  test("requires satisfied when satisfied\/not_satisfied control flow consumes it", () => {
    expect(() => validateHandoffJsonOutput({ feedback: "missing" }, { socketId: "Check", socket: socket({ edges: [{ when: "satisfied", to: "Maintain" }] }) })).toThrow(/must include reserved boolean field "satisfied"/);
    expect(() => validateHandoffJsonOutput({ feedback: "missing" }, { socketId: "Maintain", socket: socket({ advance: { cursor: "workItemIndex", items: "state.workItems", when: "satisfied" } }) })).toThrow(/must include reserved boolean field "satisfied"/);
  });

  test("does not accept legacy passed as a canonical satisfied substitute", () => {
    expect(() => validateHandoffJsonOutput({ passed: true, feedback: "legacy" }, { socketId: "Auto-Eval", socket: socket({ edges: [{ when: "satisfied", to: "Maintain" }] }) })).toThrow(/Legacy field "passed" is not canonical/);
  });
});
