import { describe, expect, test } from "bun:test";
import { handoffValidationIssues, validateHandoffJsonOutput } from "../src/handoff/handoffValidation.js";
import type { MateriaPipelineSocketConfig } from "../src/types.js";

function socket(overrides: Partial<MateriaPipelineSocketConfig> = {}): MateriaPipelineSocketConfig {
  return { type: "utility", utility: "echo", parse: "json", ...overrides };
}

describe("handoff JSON runtime validation", () => {
  test("accepts sparse utility JSON objects without unrelated canonical fields", () => {
    const value = { summary: "planned" };
    expect(validateHandoffJsonOutput(value, { socketId: "Plan", socket: socket() })).toBe(value);
  });

  test("rejects obsolete top-level fields in agent JSON handoffs", () => {
    for (const field of ["summary", "guidance", "decisions", "risks", "feedback", "missing", "state"]) {
      expect(() => validateHandoffJsonOutput({ [field]: "legacy" }, { socketId: "Agent", socket: socket(), agentOutput: true })).toThrow(/Unexpected top-level agent handoff field/);
    }
  });

  test("enforces optional agent handoff field types when present", () => {
    expect(() => validateHandoffJsonOutput({ context: { nested: true } }, { socketId: "Agent", socket: socket(), agentOutput: true })).toThrow(/context" must be a string/);
    expect(() => validateHandoffJsonOutput({ satisfied: "yes" }, { socketId: "Agent", socket: socket(), agentOutput: true })).toThrow(/satisfied" must be a boolean/);
    expect(() => validateHandoffJsonOutput({ workItems: {} }, { socketId: "Agent", socket: socket(), agentOutput: true })).toThrow(/workItems" must be an array/);
    expect(() => validateHandoffJsonOutput({ text: { prose: true } }, { socketId: "Agent", socket: socket(), agentOutput: true })).toThrow(/text" must be a string/);
    expect(() => validateHandoffJsonOutput({ text: ["narration"] }, { socketId: "Agent", socket: socket(), agentOutput: true })).toThrow(/text" must be a string/);
  });

  test("accepts renderable text payloads as canonical agent handoff output", () => {
    const value = { text: "## Summary\n\nImplemented the toggle and added tests." };
    expect(validateHandoffJsonOutput(value, { socketId: "Narrate", socket: socket({ assign: { narration: "$.text" } }), agentOutput: true })).toBe(value);
    // A text-enabled socket may combine renderable text with other canonical
    // fields (here satisfied routing + handoff context).
    const combined = { text: "narration prose", satisfied: true, context: "handoff notes" };
    expect(validateHandoffJsonOutput(combined, { socketId: "Narrate", socket: socket({ assign: { narration: "$.text" }, edges: [{ when: "satisfied", to: "Next" }] }), agentOutput: true })).toBe(combined);
  });

  test("repairs a duplicate top-level text payload on a non-text Auto-Eval-style socket to context-only", () => {
    let caught: unknown;
    try {
      validateHandoffJsonOutput({ satisfied: true, context: "Verified wiring matches the requested parameters.", text: "The runtime is correctly wired in both configuration and implementation." }, { socketId: "Auto-Eval", socket: socket({ edges: [{ when: "satisfied", to: "Maintain" }] }), agentOutput: true });
    } catch (error) {
      caught = error;
    }
    const issues = handoffValidationIssues(caught);
    expect(issues?.map((issue) => issue.path)).toContain("$.text");
    const textIssue = issues?.find((issue) => issue.path === "$.text");
    expect(textIssue?.message).toContain("Duplicate");
    expect(textIssue?.message).toContain("not configured for renderable text output");
    // Repair guidance tells the model to drop text and keep context.
    expect(textIssue?.reason).toContain("Drop \"text\"");
    expect(textIssue?.reason).toContain("keep your explanation in \"context\"");
  });

  test("repairs a lone top-level text payload on a non-text socket by moving prose into context", () => {
    let caught: unknown;
    try {
      validateHandoffJsonOutput({ satisfied: true, text: "Stray narration prose without context." }, { socketId: "Auto-Eval", socket: socket({ edges: [{ when: "satisfied", to: "Maintain" }] }), agentOutput: true });
    } catch (error) {
      caught = error;
    }
    const issues = handoffValidationIssues(caught);
    const textIssue = issues?.find((issue) => issue.path === "$.text");
    expect(textIssue?.message).toContain("Unexpected");
    expect(textIssue?.message).toContain("not configured for renderable text output");
    // Repair guidance tells the model to move prose into context.
    expect(textIssue?.reason).toContain("Move your explanatory prose into \"context\"");
  });

  test("does not flag misplaced text when socket requirements are unknown", () => {
    // Without socket/requirements metadata, intent cannot be derived, so the
    // misplaced-text repair stays permissive (type checks still apply).
    const value = { satisfied: true, text: "prose" };
    expect(validateHandoffJsonOutput(value, { socketId: "Auto-Eval", agentOutput: true })).toBe(value);
  });

  test("keeps the text type issue and does not double-report misplaced text for non-string text", () => {
    let caught: unknown;
    try {
      validateHandoffJsonOutput({ satisfied: true, text: { prose: true } }, { socketId: "Auto-Eval", socket: socket({ edges: [{ when: "satisfied", to: "Maintain" }] }), agentOutput: true });
    } catch (error) {
      caught = error;
    }
    const issues = handoffValidationIssues(caught);
    expect(issues?.filter((issue) => issue.path === "$.text")).toHaveLength(1);
    expect(issues?.find((issue) => issue.path === "$.text")?.expected).toBe("string");
  });

  test("does not flag misplaced text for utility (non-agent) JSON outputs", () => {
    const value = { satisfied: true, context: "ok", text: "renderable prose" };
    expect(validateHandoffJsonOutput(value, { socketId: "Echo", socket: socket({ edges: [{ when: "satisfied", to: "Maintain" }] }), agentOutput: false })).toBe(value);
  });

  test("accepts canonical satisfied booleans for satisfied routing", () => {
    const value = { satisfied: false, feedback: "retry" };
    expect(validateHandoffJsonOutput(value, { socketId: "Check", socket: socket({ edges: [{ when: "not_satisfied", to: "Build" }] }) })).toBe(value);
  });

  test("rejects non-object JSON handoff outputs", () => {
    expect(() => validateHandoffJsonOutput(["task"], { socketId: "Plan", socket: socket() })).toThrow(/expected a JSON object at the top level/);
    expect(() => validateHandoffJsonOutput(null, { socketId: "Plan", socket: socket() })).toThrow(/expected a JSON object at the top level/);
  });

  test("rejects malformed reserved route fields when present", () => {
    expect(() => validateHandoffJsonOutput({ satisfied: "true" }, { socketId: "Check", socket: socket() })).toThrow(/Reserved field "satisfied" .* must be a boolean/);
  });

  test("requires satisfied when satisfied/not_satisfied control flow consumes it", () => {
    expect(() => validateHandoffJsonOutput({ feedback: "missing" }, { socketId: "Check", socket: socket({ edges: [{ when: "satisfied", to: "Maintain" }] }) })).toThrow(/Missing required reserved field "satisfied"/);
    expect(() => validateHandoffJsonOutput({ feedback: "missing" }, { socketId: "Maintain", socket: socket({ advance: { cursor: "workItemIndex", items: "state.workItems", when: "satisfied" } }) })).toThrow(/Missing required reserved field "satisfied"/);
  });

  test("does not require satisfied when control flow does not consume it", () => {
    expect(validateHandoffJsonOutput({ feedback: "ok" }, { socketId: "Report", socket: socket({ edges: [{ to: "Next" }] }) })).toEqual({ feedback: "ok" });
  });

  test("requires workItems array for generator/planner outputs and assignment", () => {
    expect(() => validateHandoffJsonOutput({ summary: "none" }, { socketId: "Plan", socket: socket(), agentOutput: true, workItemsProducer: true })).toThrow(/Missing required field "workItems"/);
    expect(() => validateHandoffJsonOutput({ workItems: {} }, { socketId: "Plan", socket: socket(), agentOutput: true, workItemsProducer: true })).toThrow(/workItems" must be an array/);
    expect(() => validateHandoffJsonOutput({ summary: "none" }, { socketId: "Plan", socket: socket({ assign: { workItems: "$.workItems" } }) })).toThrow(/Missing required field "workItems"/);
    const value = { workItems: [{ title: "Build", context: "Keep it simple." }] };
    expect(validateHandoffJsonOutput(value, { socketId: "Plan", socket: socket(), agentOutput: true, workItemsProducer: true })).toBe(value);
  });

  test("validates generator workItem shape with path-specific repair guidance", () => {
    let caught: unknown;
    try {
      validateHandoffJsonOutput({ workItems: [{ id: "WI-1", title: "Build", description: "Build it", acceptance: ["Done"], priority: "high", context: { architecture: ["wrong"], constraints: "fast", dependencies: [], risks: ["low"] } }] }, { socketId: "Plan", socket: socket(), agentOutput: true, workItemsProducer: true });
    } catch (error) {
      caught = error;
    }
    const issues = handoffValidationIssues(caught);
    expect(issues?.map((issue) => issue.path)).toContain("$.workItems.0.description");
    expect(issues?.map((issue) => issue.path)).toContain("$.workItems.0.acceptance");
    expect(issues?.map((issue) => issue.path)).toContain("$.workItems.0.priority");
    expect(issues?.map((issue) => issue.path)).toContain("$.workItems.0.context");
    expect(issues?.find((issue) => issue.path === "$.workItems.0.context")?.reason).toContain("title:string and context:string");
  });

  test("utility workItems assignments require the path without applying agent item shape", () => {
    const value = { workItems: [{ id: "legacy-utility", title: "Build", context: { nested: true } }], custom: true };
    expect(validateHandoffJsonOutput(value, { socketId: "Plan", socket: socket({ assign: { workItems: "$.workItems", custom: "$.custom" } }) })).toBe(value);
  });

  test("utility generator output with workItemsProducer:true and agentOutput:false requires $.workItems", () => {
    // Simulates a utility generator socket like Commit-Sigil: generator:true makes
    // workItemsProducer:true but agentOutput:false because it's a script, not a model.
    expect(() => validateHandoffJsonOutput({ satisfied: true, context: "ok" }, { socketId: "Commit-Sigil", socket: socket({ parse: "json", edges: [{ when: "satisfied", to: "Architect" }] }), agentOutput: false, workItemsProducer: true })).toThrow(/Missing required field "workItems"/);
  });

  test("utility generator output with workItemsProducer:true and agentOutput:false rejects malformed work item shapes", () => {
    let caught: unknown;
    try {
      validateHandoffJsonOutput({ workItems: [{ title: "feat: ok", context: { nested: true } }], satisfied: true }, { socketId: "Commit-Sigil", socket: socket({ parse: "json", edges: [{ when: "satisfied", to: "Architect" }] }), agentOutput: false, workItemsProducer: true });
    } catch (error) {
      caught = error;
    }
    const issues = handoffValidationIssues(caught);
    // workItem.context must be a string, not an object
    expect(issues?.map((issue) => issue.path)).toContain("$.workItems.0.context");
    expect(issues?.find((issue) => issue.path === "$.workItems.0.context")?.reason).toContain("title:string and context:string");
  });

  test("utility generator output accepts canonical workItems with valid title/context strings", () => {
    const value = { workItems: [{ title: "feat: add login", context: "Implement login flow" }], satisfied: true, context: "all good" };
    expect(validateHandoffJsonOutput(value, { socketId: "Commit-Sigil", socket: socket({ parse: "json", edges: [{ when: "satisfied", to: "Architect" }] }), agentOutput: false, workItemsProducer: true })).toBe(value);
  });

  test("non-generator utility workItems assignment stays permissive with extra fields and nested context", () => {
    // Non-generator utilities that assign workItems from $.workItems should not
    // enforce the strict title/context-only work item shape.
    const value = { workItems: [{ id: "legacy", title: "Build", description: "Build it", acceptance: ["Done"], priority: "high", context: { architecture: ["wrong"], constraints: "fast", dependencies: [], risks: ["low"] } }], satisfied: true };
    expect(validateHandoffJsonOutput(value, { socketId: "Plan", socket: socket({ assign: { workItems: "$.workItems" } }), agentOutput: false })).toBe(value);
  });

  test("adds architecture alias repair hints for invalid generator workItems payloads", () => {
    let caught: unknown;
    try {
      validateHandoffJsonOutput({ architectureGuidance: "global", architecture: "global", workItems: [{ title: "Build", architectureGuidance: "item", context: { constraints: [], dependencies: [], risks: [] } }] }, { socketId: "Plan", socket: socket(), agentOutput: true, workItemsProducer: true });
    } catch (error) {
      caught = error;
    }
    const issues = handoffValidationIssues(caught);
    expect(issues?.some((issue) => issue.path.includes("$.architectureGuidance") && issue.reason?.includes("title:string and context:string"))).toBe(true);
    expect(issues?.some((issue) => issue.path.includes("$.architecture") && issue.message.includes("workItems[].context string"))).toBe(true);
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

  // Regression for the automated loop-control handoff failure: a JSON-parsing
  // utility socket (Mime-Maintain) whose loop advancement consumes `satisfied`
  // via advance.when:"satisfied" rejected the utility's state-only output with
  // "Missing required reserved field \"satisfied\"". Mime-Maintain now emits
  // top-level satisfied/context; this test proves the handoff validator accepts
  // that canonical output for the loop-control case that failed in production.
  describe("mime-maintain output accepted by advance.when:satisfied loop-control sockets", () => {
    // Socket shape mirrors the production Socket-6 Mime-Maintain config: a JSON
    // utility socket that advances the work-item cursor when satisfied. advance
    // consumes `satisfied` but no `assign` maps payload paths, so only the
    // reserved satisfied field is required.
    const loopControlSocket = socket({
      type: "utility",
      utility: "mime-maintain",
      parse: "json",
      advance: { cursor: "workItemIndex", items: "state.workItems", when: "satisfied", done: "Complete" },
    });

    test("accepts the canonical mime-maintain commit-success output", () => {
      const mimeMaintainOutput = {
        satisfied: true,
        context: "Mime-Maintain: committed \"feat: add ruby to ThemeId type union\" to mime/crystal-casts-abc123def0.",
        state: {
          mimeMaintain: {
            ok: true,
            committed: true,
            noop: false,
            branchName: "mime/crystal-casts-abc123def0",
            message: "feat: add ruby to ThemeId type union",
          },
        },
      };
      expect(validateHandoffJsonOutput(mimeMaintainOutput, { socketId: "Socket-6", socket: loopControlSocket })).toBe(mimeMaintainOutput);
    });

    test("accepts the canonical mime-maintain clean no-op output", () => {
      const mimeMaintainOutput = {
        satisfied: true,
        context: "Mime-Maintain: working tree clean — nothing to commit.",
        state: {
          mimeMaintain: {
            ok: true,
            committed: false,
            noop: true,
            branchName: "mime/crystal-casts-abc123def0",
            message: "Mime-Maintain: working tree clean — nothing to commit.",
          },
        },
      };
      expect(validateHandoffJsonOutput(mimeMaintainOutput, { socketId: "Socket-6", socket: loopControlSocket })).toBe(mimeMaintainOutput);
    });

    test("accepts the canonical mime-maintain handled-failure output (routable satisfied:false)", () => {
      const mimeMaintainOutput = {
        satisfied: false,
        context: "Mime-Maintain: git command failed: fatal: commit failed (exit: 1)",
        state: {
          mimeMaintain: {
            ok: false,
            error: "Mime-Maintain: git command failed: fatal: commit failed (exit: 1)",
            available: { git: true },
            hasGitRepo: true,
            gitError: "fatal: commit failed (exit: 1)",
          },
        },
      };
      expect(validateHandoffJsonOutput(mimeMaintainOutput, { socketId: "Socket-6", socket: loopControlSocket })).toBe(mimeMaintainOutput);
    });

    test("rejects the pre-fix state-only mime-maintain output with the exact production failure", () => {
      // Pre-fix Mime-Maintain emitted deterministic details under state only,
      // omitting the top-level satisfied field consumed by advance.when.
      const preFixOutput = {
        state: {
          mimeMaintain: {
            ok: true,
            committed: true,
            noop: false,
            message: "feat: add ruby to ThemeId type union",
          },
        },
      };
      let caught: unknown;
      try {
        validateHandoffJsonOutput(preFixOutput, { socketId: "Socket-6", socket: loopControlSocket });
      } catch (error) {
        caught = error;
      }
      const issues = handoffValidationIssues(caught);
      expect(issues?.map((issue) => issue.path)).toContain("$.satisfied");
      expect(issues?.find((issue) => issue.path === "$.satisfied")?.message).toContain("Missing required reserved field \"satisfied\"");
      expect(issues?.find((issue) => issue.path === "$.satisfied")?.expected).toBe("boolean");
    });
  });
});
