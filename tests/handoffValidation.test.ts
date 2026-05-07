import { describe, expect, test } from "bun:test";
import { validateHandoffJsonOutput } from "../src/handoffValidation.js";
import type { MateriaPipelineNodeConfig } from "../src/types.js";

function node(overrides: Partial<MateriaPipelineNodeConfig> = {}): MateriaPipelineNodeConfig {
  return { type: "utility", utility: "echo", parse: "json", ...overrides };
}

describe("handoff JSON runtime validation", () => {
  test("accepts JSON objects with arbitrary payload fields", () => {
    const value = { tasks: [{ title: "Build" }], feedback: "ok" };
    expect(validateHandoffJsonOutput(value, { nodeId: "Plan", node: node() })).toBe(value);
  });

  test("accepts canonical satisfied booleans for satisfied routing", () => {
    const value = { satisfied: false, feedback: "retry" };
    expect(validateHandoffJsonOutput(value, { nodeId: "Check", node: node({ edges: [{ when: "not_satisfied", to: "Build" }] }) })).toBe(value);
  });

  test("rejects non-object JSON handoff outputs", () => {
    expect(() => validateHandoffJsonOutput(["task"], { nodeId: "Plan", node: node() })).toThrow(/expected a JSON object at the top level/);
    expect(() => validateHandoffJsonOutput(null, { nodeId: "Plan", node: node() })).toThrow(/expected a JSON object at the top level/);
  });

  test("rejects malformed reserved satisfied fields", () => {
    expect(() => validateHandoffJsonOutput({ satisfied: "true" }, { nodeId: "Check", node: node() })).toThrow(/reserved control field "satisfied" must be a boolean/);
  });

  test("requires satisfied when satisfied\/not_satisfied control flow consumes it", () => {
    expect(() => validateHandoffJsonOutput({ feedback: "missing" }, { nodeId: "Check", node: node({ edges: [{ when: "satisfied", to: "Maintain" }] }) })).toThrow(/must include reserved boolean field "satisfied"/);
    expect(() => validateHandoffJsonOutput({ feedback: "missing" }, { nodeId: "Maintain", node: node({ advance: { cursor: "taskIndex", items: "state.tasks", when: "satisfied" } }) })).toThrow(/must include reserved boolean field "satisfied"/);
  });

  test("does not accept legacy passed as a canonical satisfied substitute", () => {
    expect(() => validateHandoffJsonOutput({ passed: true, feedback: "legacy" }, { nodeId: "Auto-Eval", node: node({ edges: [{ when: "satisfied", to: "Maintain" }] }) })).toThrow(/Legacy field "passed" is not canonical/);
  });
});
