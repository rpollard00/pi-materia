import { describe, expect, test } from "bun:test";
import { handoffValidationIssues, validateHandoffJsonOutput } from "../src/handoff/handoffValidation.js";
import type { MateriaPipelineSocketConfig } from "../src/types.js";

function socket(overrides: Partial<MateriaPipelineSocketConfig> = {}): MateriaPipelineSocketConfig {
  return { type: "utility", utility: "echo", parse: "json", ...overrides };
}

describe("handoff JSON runtime validation", () => {
  test("accepts sparse JSON objects without unrelated canonical fields", () => {
    const value = { summary: "planned" };
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

  test("rejects malformed reserved evaluator/route fields when present", () => {
    expect(() => validateHandoffJsonOutput({ satisfied: "true" }, { socketId: "Check", socket: socket() })).toThrow(/Reserved field "satisfied" .* must be a boolean/);
    expect(() => validateHandoffJsonOutput({ feedback: ["retry"] }, { socketId: "Check", socket: socket() })).toThrow(/Reserved field "feedback" .* must be a string/);
    expect(() => validateHandoffJsonOutput({ missing: "retry" }, { socketId: "Check", socket: socket() })).toThrow(/Reserved field "missing" .* must be an array/);
  });

  test("requires satisfied when satisfied/not_satisfied control flow consumes it", () => {
    expect(() => validateHandoffJsonOutput({ feedback: "missing" }, { socketId: "Check", socket: socket({ edges: [{ when: "satisfied", to: "Maintain" }] }) })).toThrow(/Missing required reserved field "satisfied"/);
    expect(() => validateHandoffJsonOutput({ feedback: "missing" }, { socketId: "Maintain", socket: socket({ advance: { cursor: "workItemIndex", items: "state.workItems", when: "satisfied" } }) })).toThrow(/Missing required reserved field "satisfied"/);
  });

  test("does not require satisfied when control flow does not consume it", () => {
    expect(validateHandoffJsonOutput({ feedback: "ok" }, { socketId: "Report", socket: socket({ edges: [{ to: "Next" }] }) })).toEqual({ feedback: "ok" });
  });

  test("requires workItems array for generator/planner outputs and assignment", () => {
    expect(() => validateHandoffJsonOutput({ summary: "none" }, { socketId: "Plan", socket: socket(), workItemsProducer: true })).toThrow(/Missing required field "workItems"/);
    expect(() => validateHandoffJsonOutput({ workItems: {} }, { socketId: "Plan", socket: socket(), workItemsProducer: true })).toThrow(/Field "workItems" .* must be an array/);
    expect(() => validateHandoffJsonOutput({ summary: "none" }, { socketId: "Plan", socket: socket({ assign: { workItems: "$.workItems" } }) })).toThrow(/Missing required field "workItems"/);
    const value = { workItems: [{ id: "WI-1", title: "Build", description: "Build it", acceptance: ["Done"], context: { architecture: "Keep it simple", constraints: [], dependencies: [], risks: [] } }] };
    expect(validateHandoffJsonOutput(value, { socketId: "Plan", socket: socket(), workItemsProducer: true })).toBe(value);
  });

  test("validates generator workItem shape with path-specific repair guidance", () => {
    let caught: unknown;
    try {
      validateHandoffJsonOutput({ workItems: [{ id: "WI-1", title: "Build", description: "Build it", acceptance: ["Done"], context: { architecture: ["wrong"], constraints: "fast", dependencies: [], risks: ["low"] } }] }, { socketId: "Plan", socket: socket(), workItemsProducer: true });
    } catch (error) {
      caught = error;
    }
    const issues = handoffValidationIssues(caught);
    expect(issues?.map((issue) => issue.path)).toContain("$.workItems.0.context.architecture");
    expect(issues?.map((issue) => issue.path)).toContain("$.workItems.0.context.constraints");
    expect(issues?.find((issue) => issue.path === "$.workItems.0.context.architecture")?.reason).toContain("workItems[].context.architecture");
  });

  test("validates workItems assigned by non-generator sockets without forcing unrelated fields", () => {
    expect(() => validateHandoffJsonOutput({ workItems: [{ id: "WI-1", title: "Build", description: "Build it", acceptance: [], context: { constraints: [], dependencies: [], risks: "nope" } }] }, { socketId: "Plan", socket: socket({ assign: { workItems: "$.workItems" } }) })).toThrow(/\$\.workItems\.0\.context\.risks/);
    const value = { workItems: [{ id: "WI-1", title: "Build", description: "Build it", acceptance: [], context: { constraints: [], dependencies: [], risks: [] } }], custom: true };
    expect(validateHandoffJsonOutput(value, { socketId: "Plan", socket: socket({ assign: { workItems: "$.workItems", custom: "$.custom" } }) })).toBe(value);
  });

  test("adds architecture alias repair hints for invalid generator workItems payloads", () => {
    let caught: unknown;
    try {
      validateHandoffJsonOutput({ architectureGuidance: "global", architecture: "global", workItems: [{ title: "Build", architectureGuidance: "item", context: { constraints: [], dependencies: [], risks: [] } }] }, { socketId: "Plan", socket: socket(), workItemsProducer: true });
    } catch (error) {
      caught = error;
    }
    const issues = handoffValidationIssues(caught);
    expect(issues?.some((issue) => issue.path.includes("$.architectureGuidance") && issue.reason?.includes("workItems[].context.architecture"))).toBe(true);
    expect(issues?.some((issue) => issue.path.includes("$.architecture") && issue.message.includes("workItems[].context.architecture"))).toBe(true);
  });

  test("validates reserved fields when assignment explicitly consumes them", () => {
    expect(() => validateHandoffJsonOutput({}, { socketId: "Evaluate", socket: socket({ assign: { feedback: "$.feedback" } }) })).toThrow(/Missing required reserved field "feedback"/);
    expect(() => validateHandoffJsonOutput({}, { socketId: "Evaluate", socket: socket({ assign: { missing: "$.missing" } }) })).toThrow(/Missing required reserved field "missing"/);
  });

  test("requires custom consumed assignment paths without inferring unrelated canonical fields", () => {
    expect(() => validateHandoffJsonOutput({ checkpointCreated: true }, { socketId: "Maintain", socket: socket({ assign: { vcs: "$.vcs", commands: "$.details.commands" } }) })).toThrow(/Missing payload path \$\.vcs consumed by assignment/);
    const value = { vcs: "jj", details: { commands: ["jj status"] } };
    expect(validateHandoffJsonOutput(value, { socketId: "Maintain", socket: socket({ assign: { vcs: "$.vcs", commands: "$.details.commands" } }) })).toBe(value);
  });

  test("accepts sparse payloads with optional context fields while enforcing only consumed paths", () => {
    const value = { summary: "Checkpoint created.", guidance: { next: "ship" }, decisions: ["Use jj"], risks: [], checkpointCreated: true };

    expect(validateHandoffJsonOutput(value, { socketId: "Maintain", socket: socket({ assign: { checkpointCreated: "$.checkpointCreated" } }) })).toBe(value);
    const missingCheckpoint = { summary: value.summary, guidance: value.guidance, decisions: value.decisions, risks: value.risks };
    expect(() => validateHandoffJsonOutput(missingCheckpoint, { socketId: "Maintain", socket: socket({ assign: { checkpointCreated: "$.checkpointCreated" } }) })).toThrow(/Missing payload path \$\.checkpointCreated consumed by assignment/);
  });

  test("validates custom consumed assignment paths with runtime-compatible array indexes", () => {
    const value = { list: [{ label: "ready" }] };
    expect(validateHandoffJsonOutput(value, { socketId: "Maintain", socket: socket({ assign: { label: "$.list.0.label" } }) })).toBe(value);
    expect(() => validateHandoffJsonOutput({ list: [] }, { socketId: "Maintain", socket: socket({ assign: { label: "$.list.0.label" } }) })).toThrow(/Missing payload path \$\.list\.0\.label consumed by assignment/);
  });

  test("exposes structured validation issues for repair prompts", () => {
    let caught: unknown;
    try {
      validateHandoffJsonOutput({ passed: true }, { socketId: "Auto-Eval", socket: socket({ edges: [{ when: "satisfied", to: "Maintain" }] }) });
    } catch (error) {
      caught = error;
    }
    const issues = handoffValidationIssues(caught);
    expect(issues?.map((issue) => issue.path)).toContain("$.satisfied");
    expect(issues?.some((issue) => issue.message.includes("Legacy field \"passed\" is not canonical"))).toBe(true);
  });
});
