import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { activeMateriaSystemPrompt, buildIsolatedMateriaContext, buildJsonOutputRepairPrompt, buildJsonOutputRepairRetryPrompt, buildMultiTurnFinalizationPrompt, buildSocketPrompt, buildSyntheticCastContext, buildTimeoutRecoveryHint, findActiveMateriaPromptIndex, isLegacyMateriaDisplayMessage, projectMateriaContext, sanitizePreviousOutput, syntheticEventEmissionContext } from "../src/application/promptAssembly.js";
import { HANDOFF_CONTRACT_PROMPT_TEXT, HANDOFF_RESERVED_FIELD_TYPE_PROMPT_TEXT } from "../src/handoff/handoffContract.js";
import type { MateriaCastState, ResolvedMateriaAgentSocket } from "../src/types.js";

function agentSocket(overrides: Partial<ResolvedMateriaAgentSocket> = {}): ResolvedMateriaAgentSocket {
  return {
    id: "Socket-1",
    socket: { materia: "Build", parse: "text" },
    materia: { tools: "readOnly", prompt: "Build {{ item.title }} for {{ request }}." },
    edges: [],
    ...overrides,
  } as ResolvedMateriaAgentSocket;
}

const REDUNDANT_SOCKET_CONTRACT_SNIPPETS = [
  "pi-materia canonical handoff JSON contract",
  "generic handoff envelope when applicable",
  "legacy placement terminology",
  "Reserved evaluator/route fields are owned",
  "Legacy names such as \"passed\"",
  "\"satisfied\" is the canonical boolean control field",
];

function expectSocketPromptOmitsRedundantContractBoilerplate(prompt: string): void {
  expect(prompt).not.toContain(HANDOFF_CONTRACT_PROMPT_TEXT);
  for (const snippet of REDUNDANT_SOCKET_CONTRACT_SNIPPETS) {
    expect(prompt).not.toContain(snippet);
  }
}

function defaultMateriaPrompt(name: string): string {
  const raw = JSON.parse(readFileSync(path.resolve("config", "default.json"), "utf8")) as { materia?: Record<string, { prompt?: string }> };
  const prompt = raw.materia?.[name]?.prompt;
  if (!prompt) throw new Error(`missing bundled materia prompt: ${name}`);
  return prompt;
}

function state(socket: ResolvedMateriaAgentSocket, overrides: Partial<MateriaCastState> = {}): MateriaCastState {
  return {
    version: 1,
    active: true,
    castId: "cast-1",
    request: "original request",
    configSource: "test",
    configHash: "hash",
    cwd: "/repo",
    runDir: "/repo/.pi/pi-materia/cast-1",
    artifactRoot: "/repo/.pi/pi-materia",
    phase: socket.id,
    currentSocketId: socket.id,
    currentMateria: "Build",
    awaitingResponse: true,
    socketState: "awaiting_agent_response",
    startedAt: 1,
    updatedAt: 1,
    data: {
      item: { title: "Item 1", context: "Implement item 1." },
      workItems: [{ title: "Item 1", context: "Implement item 1." }],
      guidance: { next: "keep it small" },
    },
    cursors: { item: 0 },
    visits: { [socket.id]: 1 },
    multiTurnRefinements: {},
    taskAttempts: {},
    edgeTraversals: {},
    runState: { castId: "cast-1", runDir: "/repo/.pi/pi-materia/cast-1", startedAt: 1, model: "test", usage: {}, currentSocketId: socket.id, currentMateria: "Build" },
    pipeline: { entry: socket, sockets: { [socket.id]: socket } },
    currentItemKey: "WI-1",
    currentItemLabel: "Item 1",
    ...overrides,
  } as MateriaCastState;
}

describe("application prompt assembly", () => {
  test("buildJsonOutputRepairRetryPrompt for multi-turn finalization omits synthetic cast context (no duplication with isolation prepend)", () => {
    const socket = agentSocket({
      id: "Socket-MT",
      socket: { materia: "Plan", parse: "json" },
      materia: { tools: "readOnly", prompt: "Plan collaboratively.", multiTurn: true },
    });
    const castState = state(socket, {
      currentSocketId: "Socket-MT",
      currentMateria: "Plan",
      multiTurnFinalizing: true,
      jsonOutputRepair: {
        validationKind: "handoff_validation",
        errorMessage: "Missing required reserved field \"satisfied\" at $.satisfied; expected a boolean.",
        validationIssues: [{ path: "$.satisfied", message: "Missing required reserved field \"satisfied\" at $.satisfied; expected a boolean.", reason: "Current socket control flow uses satisfied/not_satisfied routing or advancement." }],
        invalidOutputExcerpt: '{"satisfied":"yes"}',
      },
    });

    const prompt = buildJsonOutputRepairRetryPrompt(castState, socket);
    expect(prompt).toBeDefined();
    const promptText = prompt ?? "";

    // The synthetic cast context must NOT be embedded (isolation prepends it).
    expect(promptText).not.toContain("Materia isolated context.");
    expect(promptText).not.toContain("Canonical handoff contract context:");
    expect(promptText).not.toContain("Synthetic context exposure policy");

    // The repair instructions must still be present.
    expect(promptText).toContain("socket JSON payload validation");
    expect(promptText).toContain("Failure category: handoff contract violation");
    expect(promptText).toContain("$.satisfied");
    // The original final output instructions are still included.
    expect(promptText).toContain("Final output format: Return only one top-level JSON object");
    expect(promptText).toContain("do not emit a top-level text field");
  });

  test("buildJsonOutputRepairRetryPrompt for single-turn repair still embeds synthetic cast context (isolation does not run)", () => {
    const socket = agentSocket({
      id: "Socket-1",
      socket: { materia: "Check", parse: "json" },
      materia: { tools: "readOnly", prompt: "Evaluate." },
    });
    const castState = state(socket, {
      currentSocketId: "Socket-1",
      currentMateria: "Check",
      jsonOutputRepair: {
        validationKind: "json_parse",
        errorMessage: "SyntaxError: Unexpected token",
        validationIssues: [],
        invalidOutputExcerpt: '{satisfied: true}',
      },
    });

    const prompt = buildJsonOutputRepairRetryPrompt(castState, socket);
    expect(prompt).toBeDefined();
    const promptText = prompt ?? "";

    // Single-turn repair: isolation does not run, so the synthetic context
    // is still embedded in the repair prompt.
    expect(promptText).toContain("Materia isolated context.");
    expect(promptText).toContain("Cast id: cast-1");
    expect(promptText).toContain("Original request: original request");
    // Repair instruction still present.
    expect(promptText).toContain("malformed JSON syntax");
    expect(promptText).toContain("Return only corrected JSON");
  });

  test("JSON repair prompts describe socket payload validation without requesting a full envelope", () => {
    const prompt = buildJsonOutputRepairPrompt({
      validationKind: "handoff_validation",
      errorMessage: "Invalid handoff JSON output for socket \"Check\": Missing required reserved field \"satisfied\" at $.satisfied; expected a boolean.",
      validationIssues: [{ path: "$.satisfied", message: "Missing required reserved field \"satisfied\" at $.satisfied; expected a boolean.", reason: "Current socket control flow uses satisfied/not_satisfied routing or advancement." }],
      invalidOutputExcerpt: "{\"feedback\":\"retry\"}",
      originalFinalOutputInstructions: "Final output format: Return only one top-level JSON object\nRequired payload fields:\n- \"satisfied\" at $.satisfied: boolean.",
    });

    expect(prompt).toContain("socket JSON payload validation");
    expect(prompt).toContain("Failure category: handoff contract violation");
    expect(prompt).toContain("Correct these fields for the current socket requirements");
    expect(prompt).toContain("$.satisfied");
    expect(prompt).not.toContain("Current socket control flow uses satisfied/not_satisfied routing");
    expect(prompt).not.toContain("canonical handoff envelope validation");
    expect(prompt).not.toContain("full canonical handoff envelope");
  });

  test("injects adapter context and rendered current item into text socket prompts", () => {
    const socket = agentSocket();
    const prompt = buildSocketPrompt(state(socket), socket);

    expect(prompt).toContain("<materia-instructions>");
    expect(prompt).toContain("Build Item 1 for original request.");
    expect(prompt).toContain("Socket adapter context");
    expect(prompt).toContain("Current workItem:");
    expect(prompt).toContain("Title: Item 1");
    expect(prompt).toContain("Context:\nImplement item 1.");
    expect(prompt).not.toContain("Current workItem JSON");
    expect(prompt).not.toContain('"id": "item-1"');
    expect(prompt).toContain("Global guidance JSON");
  });

  test("renders runtime-owned follow-up context for matching not_satisfied rework", () => {
    const socket = agentSocket({ id: "Socket-4" });
    const prompt = buildSocketPrompt(state(socket, {
      currentSocketId: "Socket-4",
      phase: "Socket-4",
      currentItemKey: "WI-1",
      reworkFeedback: [{
        sourceSocketId: "Socket-5",
        sourceMateria: "Auto-Eval",
        sourceMateriaLabel: "Auto-Eval",
        targetSocketId: "Socket-4",
        condition: "not_satisfied",
        itemKey: "WI-1",
        itemLabel: "Validate behavior",
        reason: "Tests failed: expected inspect output to include socket provenance.",
        createdAt: 1,
      }],
    }), socket);

    expect(prompt).toContain("Runtime follow-up context");
    expect(prompt).toContain("reached by prior not_satisfied routing");
    expect(prompt).toContain("Socket-5 Auto-Eval");
    expect(prompt).toContain("Tests failed: expected inspect output to include socket provenance.");
  });

  test("rebuild prompts in build/eval rework loops include actionable feedback for vague items without widening the handoff contract", () => {
    const buildSocket = agentSocket({
      id: "Socket-Build",
      socket: { materia: "Build", parse: "text" },
      materia: { tools: "readWrite", prompt: "Build-style implementation step for {{ item.title }}.\n{{ item.context }}" },
    });
    const workItem = { title: "Validate behavior/inspect", context: "Inspect the behavior and update what is needed." };
    const buildPrompt = buildSocketPrompt(state(buildSocket, {
      currentSocketId: "Socket-Build",
      phase: "Socket-Build",
      currentItemKey: "WI-vague",
      currentItemLabel: workItem.title,
      data: {
        item: workItem,
        workItems: [workItem],
        guidance: {},
      },
      reworkFeedback: [{
        sourceSocketId: "Socket-AutoEval",
        sourceMateria: "Auto-Eval",
        sourceMateriaLabel: "Auto-Eval",
        targetSocketId: "Socket-Build",
        condition: "not_satisfied",
        itemKey: "WI-vague",
        itemLabel: workItem.title,
        reason: "Tests failed: expected inspect output to include socket provenance after the previous build.",
        createdAt: 1,
      }],
    }), buildSocket);

    expect(buildPrompt).toContain("Runtime follow-up context");
    expect(buildPrompt).toContain("follow-up/rework for the current item");
    expect(buildPrompt).toContain("not_satisfied routing");
    expect(buildPrompt).toContain("Socket-AutoEval Auto-Eval");
    expect(buildPrompt).toContain("Tests failed: expected inspect output to include socket provenance after the previous build.");
    expect(buildPrompt).toContain("Title: Validate behavior/inspect");

    const evalSocket = agentSocket({
      id: "Socket-AutoEval",
      socket: { materia: "Auto-Eval", parse: "json", edges: [{ when: "satisfied", to: "Socket-Maintain" }, { when: "not_satisfied", to: "Socket-Build" }] },
      materia: { tools: "readOnly", prompt: "Evaluate the build result." },
    });
    const evalPrompt = buildSocketPrompt(state(evalSocket), evalSocket);

    expect(evalPrompt).toContain("Agent handoff fields are limited to workItems, satisfied, and context");
    expect(evalPrompt).toContain("do not emit a top-level text field");
    expect(evalPrompt).not.toContain("reworkFeedback");
    expect(evalPrompt).not.toContain("lastFeedback");
  });

  test("does not render rework context for unrelated target sockets or items", () => {
    const socket = agentSocket({ id: "Socket-4" });
    const prompt = buildSocketPrompt(state(socket, {
      currentSocketId: "Socket-4",
      phase: "Socket-4",
      currentItemKey: "WI-2",
      reworkFeedback: [{
        sourceSocketId: "Socket-5",
        sourceMateria: "Auto-Eval",
        targetSocketId: "Socket-4",
        condition: "not_satisfied",
        itemKey: "WI-1",
        itemLabel: "Old item",
        reason: "Old failure.",
        createdAt: 1,
      }],
    }), socket);

    expect(prompt).not.toContain("Runtime follow-up context");
    expect(prompt).not.toContain("Old failure.");
  });

  test("generator JSON sockets receive concise canonical workItems placement instructions", () => {
    const socket = agentSocket({
      socket: { materia: "Plan", parse: "json" },
      materia: { tools: "readOnly", prompt: "Plan work.", generator: true },
    });
    const prompt = buildSocketPrompt(state(socket), socket);

    expect(prompt).toContain("Generator socket adapter context");
    expect(prompt).toContain("expose generated output as workItems");
    expect(prompt).toContain("Emit top-level workItems");
    expect(prompt).toContain("Generated output assignment");
    expect(prompt).toContain("Final output format: Return only one top-level JSON object");
    expect(prompt).toContain("Required payload fields:");
    expect(prompt).toContain('"workItems" at $.workItems: array');
    expect(prompt).toContain("Each generated work item must contain only title:string and context:string");
    expect(prompt).toContain("put all item-specific guidance in the workItem.context text string");
    expect(prompt).toContain("array of objects with \"title\" and \"context\" strings");
    expect(prompt).not.toContain("architectureGuidance");
    expect(prompt).not.toContain("top-level architecture");
    expect(prompt).not.toContain(HANDOFF_RESERVED_FIELD_TYPE_PROMPT_TEXT);
    expectSocketPromptOmitsRedundantContractBoilerplate(prompt);
  });

  test("parallel generator guidance is synthesized from capability metadata, not the reusable planner prompt", () => {
    const socket = agentSocket({
      socket: { materia: "Parallel-Plan", parse: "json" },
      materia: { tools: "readOnly", prompt: defaultMateriaPrompt("Parallel-Plan"), generator: true, parallel: true },
    });
    const reusablePrompt = defaultMateriaPrompt("Parallel-Plan");
    const prompt = buildSocketPrompt(state(socket), socket);

    expect(reusablePrompt).not.toContain("parallelSchedule");
    expect(reusablePrompt).not.toContain("stream");
    expect(reusablePrompt).not.toContain("lane");
    expect(prompt).toContain("Intrinsic parallel planning is enabled for this generator");
    expect(prompt).toContain("small number of balanced, ordered streams");
    expect(prompt).toContain("Keep dependent or order-sensitive items in the same stream");
    expect(prompt).toContain("Emit the required top-level parallelSchedule sidecar");
    expect(prompt).toContain('"parallelSchedule" at $.parallelSchedule: object');
  });

  test("ordinary generators do not receive parallel scheduling guidance", () => {
    const socket = agentSocket({
      socket: { materia: "Plan", parse: "json" },
      materia: { tools: "readOnly", prompt: "Plan work.", generator: true },
    });
    const prompt = buildSocketPrompt(state(socket), socket);

    expect(prompt).not.toContain("Intrinsic parallel planning");
    expect(prompt).not.toContain("parallelSchedule");
    expect(prompt).not.toContain("ordered streams");
  });

  test("tool-backed parallel generators receive schedule tool guidance instead of textual sidecar instructions", () => {
    const socket = agentSocket({
      socket: { materia: "Parallel-Plan", parse: "json" },
      materia: { tools: "readOnly", prompt: defaultMateriaPrompt("Parallel-Plan"), generator: true, parallel: true },
    });
    const castState = state(socket, {
      agentFinalization: {
        strategy: "tool_backed",
        configuredStrategy: "tool_backed",
        reason: "qualified_tool_model",
        phase: "active",
        socketId: socket.id,
        socketVisit: 1,
        finalizationAttempt: 1,
      },
    });
    const prompt = buildSocketPrompt(castState, socket);
    const synthetic = buildSyntheticCastContext(castState);

    for (const text of [prompt, synthetic]) {
      expect(text).toContain("materia_handoff_set_parallel_schedule");
      expect(text).toContain("Cover every final work-item index exactly once");
      expect(text).not.toContain("Emit the required top-level parallelSchedule sidecar");
    }
    expect(prompt).toContain("tool-backed materia handoff submission is active");
  });

  test("parallel guidance remains hidden during multi-turn refinement and appears on finalization", () => {
    const socket = agentSocket({
      socket: { materia: "Parallel-Plan", parse: "json" },
      materia: { tools: "readOnly", prompt: defaultMateriaPrompt("Parallel-Plan"), generator: true, parallel: true, multiTurn: true },
    });
    const refinement = buildSocketPrompt(state(socket), socket);
    const finalization = buildMultiTurnFinalizationPrompt(state(socket, { multiTurnFinalizing: true }), socket);
    const syntheticFinalization = buildSyntheticCastContext(state(socket, { multiTurnFinalizing: true }));

    expect(refinement).not.toContain("parallelSchedule");
    expect(refinement).not.toContain("Intrinsic parallel planning");
    expect(finalization).toContain("parallelSchedule");
    expect(finalization).toContain("Intrinsic parallel planning");
    expect(syntheticFinalization).toContain("Intrinsic parallel planning");
  });

  test("supplies bounded conflict context to the coding agent in an integrated scope", () => {
    const socket = agentSocket({
      socket: { materia: "Integration-Review", parse: "json" },
      materia: { type: "agent", tools: "coding", prompt: defaultMateriaPrompt("Integration-Review") },
    });
    const longPath = `src/${"x".repeat(700)}.ts`;
    const castState = state(socket, {
      activeScope: {
        id: "cast:cast-1:integration",
        cwd: "/tmp/integration-workspace",
        exports: {},
        state: {
          jjWorkspaceIntegration: {
            version: 1,
            outcome: "conflict",
            sourceCount: 3,
            effectiveBase: { commitId: "base123", changeId: "base-change" },
            orderedWorkstreams: [
              { laneId: "lane-a", streamIndex: 0, changeIds: ["change-1"] },
              { laneId: "lane-b", streamIndex: 1, changeIds: ["change-2"] },
              { laneId: "lane-c", streamIndex: 2, changeIds: [] },
            ],
            finalTip: { commitId: "abc123", changeId: "change-2" },
            totalWorkstreamCount: 3,
            totalChangeCount: 2,
            conflictedPaths: ["src/a.ts", longPath],
            conflictDetails: [{ path: "src/a.ts", message: "both branches changed this function" }],
          },
        },
      },
      data: {
        jjWorkspaceIntegration: { outcome: "conflict", secretUnboundedField: "must-not-leak" },
      },
    } as Partial<MateriaCastState>);

    const synthetic = buildSyntheticCastContext(castState);
    expect(synthetic).toContain("Integrated workspace review context:");
    expect(synthetic).toContain('"cast:cast-1:integration"');
    expect(synthetic).toContain('"/tmp/integration-workspace"');
    expect(synthetic).toContain("materialized conflict workspace integration");
    expect(synthetic).toContain("src/a.ts: both branches changed this function");
    expect(synthetic).toContain('Effective linear base: "base-change"');
    expect(synthetic).toContain('"lane-a" [stream 0]: "change-1"');
    expect(synthetic).toContain('Final stable change: "change-2"');
    expect(synthetic).toContain("complete effective-base-to-final-tip linear range");
    expect(synthetic).toContain("Resolve all integration conflicts from earliest to latest");
    expect(synthetic).toContain("return to the rewritten final tip");
    expect(synthetic).toContain("one final working change");
    expect(synthetic).toContain("satisfied:false");
    expect(synthetic).not.toContain("secretUnboundedField");
    expect(synthetic).not.toContain(longPath);
  });

  test("supplies clean integration spot-check guidance without conflict instructions", () => {
    const socket = agentSocket({ socket: { materia: "Integration-Review", parse: "json" } });
    const synthetic = buildSyntheticCastContext(state(socket, {
      activeScope: {
        id: "integration-clean",
        cwd: "/tmp/clean",
        exports: {},
        state: {
          jjWorkspaceIntegration: {
            outcome: "clean",
            sourceCount: 1,
            effectiveBase: { commitId: "base", changeId: "base-change" },
            orderedWorkstreams: [{ laneId: "only", streamIndex: 0, changeIds: [] }],
            finalTip: { commitId: "base", changeId: "base-change" },
            totalWorkstreamCount: 1,
            totalChangeCount: 0,
            conflictedPaths: [],
          },
        },
      },
    } as Partial<MateriaCastState>));

    expect(synthetic).toContain("reports no conflicts");
    expect(synthetic).toContain("Spot-check the combined work");
    expect(synthetic).toContain('"only" [stream 0]: no meaningful changes');
    expect(synthetic).toContain("All ordered workstreams are no-op");
    expect(synthetic).not.toContain("Bounded conflict context");
  });

  test("bounds linear integration review provenance", () => {
    const socket = agentSocket({ socket: { materia: "Integration-Review", parse: "json" } });
    const orderedWorkstreams = Array.from({ length: 70 }, (_, index) => ({
      laneId: `lane-${index}`,
      streamIndex: index,
      changeIds: [`change-${index}`],
    }));
    const synthetic = buildSyntheticCastContext(state(socket, {
      activeScope: {
        id: "integration-bounded",
        cwd: "/tmp/bounded",
        exports: {},
        state: {
          jjWorkspaceIntegration: {
            outcome: "clean",
            orderedWorkstreams,
            totalWorkstreamCount: 70,
            totalChangeCount: 70,
            provenanceTruncated: true,
            conflictedPaths: [],
          },
        },
      },
    } as Partial<MateriaCastState>));

    expect(synthetic).toContain("Review provenance is bounded");
    expect(synthetic).toContain('"lane-63"');
    expect(synthetic).not.toContain('"lane-64"');
  });

  test("non-generator JSON sockets keep only concise JSON-only final output guidance", () => {
    const socket = agentSocket({
      socket: { materia: "Check", parse: "json" },
      materia: { tools: "readOnly", prompt: "Evaluate the current result." },
    });
    const prompt = buildSocketPrompt(state(socket), socket);

    expect(prompt).toContain("Final output format: Return only one top-level JSON object");
    expect(prompt).toContain("Emit only the fields relevant to this socket's configured placement, routing, and assignments");
    expect(prompt).not.toContain(HANDOFF_RESERVED_FIELD_TYPE_PROMPT_TEXT);
    expect(prompt).not.toContain("Generator socket adapter context");
    expect(prompt).not.toContain("Emit top-level workItems");
    expect(prompt).not.toContain("workItem.context.architecture");
    expect(prompt).not.toContain("architectureGuidance");
    expect(prompt).not.toContain("top-level architecture");
    expect(prompt).not.toContain("Required payload fields:");
    expectSocketPromptOmitsRedundantContractBoilerplate(prompt);
  });

  test("control JSON sockets require satisfied only when routing consumes it", () => {
    const socket = agentSocket({
      socket: { materia: "Check", parse: "json", edges: [{ when: "satisfied", to: "Socket-2" }] },
      materia: { tools: "readOnly", prompt: "Evaluate the current result." },
    });
    const prompt = buildSocketPrompt(state(socket), socket);

    expect(prompt).toContain('"satisfied" at $.satisfied: boolean');
    expect(prompt).toContain("Required reserved field types:");
    expect(prompt).toContain('"satisfied" must be a boolean');
    expect(prompt).not.toContain('"feedback"');
    expect(prompt).not.toContain('"missing"');
    expect(prompt).not.toContain('"workItems" at $.workItems');
  });

  test("custom assign JSON sockets name only consumed payload paths", () => {
    const socket = agentSocket({
      socket: { materia: "Maintain", parse: "json", assign: { checkpointCreated: "$.checkpointCreated", vcs: "$.vcs", commands: "$.commands" } },
      materia: { tools: "readWrite", prompt: "Create a checkpoint." },
    });
    const prompt = buildSocketPrompt(state(socket), socket);

    expect(prompt).toContain("Payload paths consumed by this socket:");
    expect(prompt).toContain("$.checkpointCreated for assignment to checkpointCreated");
    expect(prompt).toContain("$.vcs for assignment to vcs");
    expect(prompt).toContain("$.commands for assignment to commands");
    expect(prompt).not.toContain('"summary"');
    expect(prompt).not.toContain('"workItems"');
    expect(prompt).not.toContain('"satisfied"');
  });

  test("explicit $.text assignment sockets instruct models to emit a top-level string text field without extra handoff fields", () => {
    const socket = agentSocket({
      socket: { materia: "Narrate", parse: "json", assign: { prNotes: "$.text" } },
      materia: { tools: "readOnly", prompt: "Narrate the result." },
    });
    const prompt = buildSocketPrompt(state(socket), socket);

    expect(prompt).toContain("Payload paths consumed by this socket:");
    expect(prompt).toContain("$.text for assignment to prNotes");
    expect(prompt).toContain('top-level "text" string');
    expect(prompt).toContain("primary user-facing text");
    // The text assignment does not require the control or work-generating fields.
    expect(prompt).not.toContain('"workItems" at $.workItems');
    expect(prompt).not.toContain('"satisfied" at $.satisfied');
    expect(prompt).not.toContain("Required payload fields:");
  });

  test("nested custom assign JSON sockets render nested payload paths without full-envelope fields", () => {
    const socket = agentSocket({
      socket: { materia: "Review", parse: "json", assign: { "review.route": "$.review.route", "review.label": "$.artifacts.0.label" } },
      materia: { tools: "readOnly", prompt: "Review the output." },
    });
    const prompt = buildSocketPrompt(state(socket), socket);

    expect(prompt).toContain("$.review.route for assignment to review.route");
    expect(prompt).toContain("$.artifacts.0.label for assignment to review.label");
    expect(prompt).not.toContain("Required payload fields:");
    expect(prompt).not.toContain('"summary"');
    expect(prompt).not.toContain('"guidance"');
    expect(prompt).not.toContain('"decisions"');
    expect(prompt).not.toContain('"risks"');
    expect(prompt).not.toContain('"workItems" at $.workItems');
    expect(prompt).not.toContain('"satisfied" at $.satisfied');
  });

  test("multi-turn refinement stays conversational until continue finalization", () => {
    const socket = agentSocket({
      socket: { materia: "Plan", parse: "json" },
      materia: { tools: "readOnly", prompt: "Plan collaboratively.", multiTurn: true },
    });
    const prompt = buildSocketPrompt(state(socket), socket);

    expect(prompt).toContain("Current multi-turn mode: refinement conversation");
    expect(prompt).toContain("/materia continue is the only way to finalize");
    expect(prompt).not.toContain("Final output format: Return only JSON");
    expectSocketPromptOmitsRedundantContractBoilerplate(prompt);
  });

  test("/materia continue finalization includes canonical JSON contract (synthetic context is prepended by isolation, not embedded)", () => {
    const socket = agentSocket({
      socket: { materia: "Plan", parse: "json" },
      materia: { tools: "readOnly", prompt: "Plan collaboratively.", multiTurn: true },
    });
    const prompt = buildMultiTurnFinalizationPrompt(state(socket, { multiTurnFinalizing: true, lastOutput: "previous refinement" }), socket);

    // The synthetic cast context is NOT embedded in the finalization prompt;
    // buildIsolatedMateriaContext prepends it on every isolated turn.
    expect(prompt).not.toContain("Materia isolated context.");
    expect(prompt).toContain("Command-triggered finalization");
    // Socket-scoped handoff guidance from finalFormatInstruction is still present:
    expect(prompt).toContain("do not emit a top-level text field");
    expect(prompt).toContain("Final output format: Return only one top-level JSON object");
  });

  test("Chain-Context prompt renders useful structured previous-cast context when available", () => {
    const socket = agentSocket({
      socket: { materia: "Chain-Context", parse: "json" },
      materia: { tools: "readOnly", prompt: defaultMateriaPrompt("Chain-Context"), parse: "json" },
    });
    const prompt = buildSocketPrompt(state(socket, {
      request: "continue implementation",
      data: {
        previousCastContext: {
          castId: "cast-prev",
          request: "original feature request",
          handoff: { summary: "implemented parser", workItems: [{ id: "WI-2", title: "Next" }], decisions: ["Use /materia link"], risks: ["Ambiguous stitching"], satisfied: true, feedback: "ready", missing: [] },
          artifacts: [{ path: "sockets/Socket-1/1.md", kind: "socket_output", content: "bounded preview", maxBytes: 100, truncated: false }],
          loadedAt: 1,
        },
      },
    }), socket);

    expect(prompt).toContain("Transform structured previous-cast state");
    expect(prompt).toContain("Consume generic previous-cast state");
    expect(prompt).toContain("prior request and cast id");
    expect(prompt).toContain("workItems");
    expect(prompt).toContain("state.previousCastContext is unavailable");
  });

  test("Chain-Context prompt gives clear behavior when previous-cast context is missing", () => {
    const socket = agentSocket({
      socket: { materia: "Chain-Context", parse: "json" },
      materia: { tools: "readOnly", prompt: defaultMateriaPrompt("Chain-Context"), parse: "json" },
    });
    const prompt = buildSocketPrompt(state(socket, { data: {} }), socket);

    expect(prompt).toContain("If state.previousCastContext is missing or empty");
    expect(prompt).toContain("satisfied false");
    expect(prompt).toContain("context explaining that state.previousCastContext is unavailable");
    expect(prompt).toContain("Do not invent lineage");
    expect(prompt).toContain("Do not invent lineage");
  });

  test("active system prompts and synthetic context use explicit state inputs", () => {
    const socket = agentSocket();
    const castState = state(socket, { lastAssistantText: "previous answer" });

    expect(activeMateriaSystemPrompt(castState, socket.materia)).toContain("Build Item 1 for original request.");
    const synthetic = buildSyntheticCastContext(castState);
    expect(synthetic).toContain("Cast id: cast-1");
    expect(synthetic).toContain("Original request: original request");
    expect(synthetic).toContain("Previous output:\nprevious answer");
  });
});

describe("socket-specific renderable text suppression", () => {
  // The opt-in renderable-text model keeps `context` as the default
  // cross-socket explanatory field. Non-text JSON sockets (planner/evaluator/
  // maintainer/chain-context) receive required JSON instructions but no generic
  // top-level `text` guidance; only sockets that consume `$.text` (or carry
  // explicit renderable-text intent) emit renderable prose. This is what stops
  // ordinary evaluator/maintainer/planner sockets from emitting misplaced
  // top-level `text` payloads alongside `context`.

  function expectRequiredJsonFinalInstructions(prompt: string): void {
    expect(prompt).toContain("Final output format: Return only one top-level JSON object");
    expect(prompt).toContain("Emit only the fields relevant to this socket's configured placement, routing, and assignments");
  }

  function expectNoGenericRenderableTextGuidance(prompt: string): void {
    // Field list scoped to workItems/satisfied/context; never the text-enabled list.
    expect(prompt).not.toContain("Agent handoff fields are limited to workItems, satisfied, context, and text");
    // No renderable-prose emit instruction.
    expect(prompt).not.toContain('top-level "text" string');
    expect(prompt).not.toContain("primary user-facing text");
  }

  test("Auto-Plan generator prompt includes required JSON instructions without generic text guidance", () => {
    const socket = agentSocket({
      socket: { materia: "Auto-Plan", parse: "json" },
      materia: { tools: "readOnly", prompt: defaultMateriaPrompt("Auto-Plan"), generator: true },
    });
    const prompt = buildSocketPrompt(state(socket), socket);

    expectRequiredJsonFinalInstructions(prompt);
    // Generator output requirement and placement guidance present.
    expect(prompt).toContain('"workItems" at $.workItems: array');
    expect(prompt).toContain("Emit top-level workItems");
    // Non-text field list with explicit no-text guidance.
    expect(prompt).toContain("Agent handoff fields are limited to workItems, satisfied, and context");
    expect(prompt).toContain("do not emit a top-level text field");
    expectNoGenericRenderableTextGuidance(prompt);
  });

  test("Auto-Eval satisfied-routing prompt includes required JSON instructions without generic text guidance", () => {
    const socket = agentSocket({
      socket: {
        materia: "Auto-Eval",
        parse: "json",
        assign: { lastFeedback: "$.context", lastCheck: "$" },
        edges: [{ when: "satisfied", to: "Socket-Maintain" }, { when: "not_satisfied", to: "Socket-Build" }],
      },
      materia: { tools: "readOnly", prompt: defaultMateriaPrompt("Auto-Eval") },
    });
    const prompt = buildSocketPrompt(state(socket), socket);

    expectRequiredJsonFinalInstructions(prompt);
    // Control field requirement and consumed context path present.
    expect(prompt).toContain('"satisfied" at $.satisfied: boolean');
    expect(prompt).toContain("$.context for assignment to lastFeedback");
    // Non-text field list with explicit no-text guidance.
    expect(prompt).toContain("Agent handoff fields are limited to workItems, satisfied, and context");
    expect(prompt).toContain("do not emit a top-level text field");
    expectNoGenericRenderableTextGuidance(prompt);
  });

  test("explicit $.text assignment prompt opts into top-level renderable text guidance", () => {
    const socket = agentSocket({
      socket: { materia: "Narrate", parse: "json", assign: { prNotes: "$.text" } },
      materia: { tools: "readOnly", prompt: "Narrate the result as renderable prose." },
    });
    const prompt = buildSocketPrompt(state(socket), socket);

    expectRequiredJsonFinalInstructions(prompt);
    expect(prompt).toContain("$.text for assignment to prNotes");
    // Text-enabled field list and renderable-prose emit instruction.
    expect(prompt).toContain("Agent handoff fields are limited to workItems, satisfied, context, and text");
    expect(prompt).toContain('top-level "text" string');
    expect(prompt).toContain("primary user-facing text");
    // Renderable-prose sockets are told not to duplicate prose into context.
    expect(prompt).toContain('do not duplicate it into "context"');
  });

  test("non-text JSON synthetic handoff contract and event wording omit renderable text", () => {
    const socket = agentSocket({
      socket: {
        materia: "Auto-Eval",
        parse: "json",
        assign: { lastFeedback: "$.context", lastCheck: "$" },
        edges: [{ when: "satisfied", to: "Socket-Maintain" }, { when: "not_satisfied", to: "Socket-Build" }],
      },
      materia: { tools: "readOnly", prompt: defaultMateriaPrompt("Auto-Eval") },
    });
    const synthetic = buildSyntheticCastContext(state(socket));

    // Synthetic handoff contract context scopes fields to
    // workItems/satisfied/context and explicitly reserves `text` for
    // renderable-prose sockets.
    expect(synthetic).toContain("Canonical handoff contract context:");
    expect(synthetic).toContain("Agent-authored JSON handoffs are limited to top-level workItems, satisfied, and context");
    expect(synthetic).toContain("do not emit a top-level text field");
    // The generic renderable-prose field description is absent for non-text sockets.
    expect(synthetic).not.toContain("primary user-facing text output");
    // Event side-channel wording is field-neutral for non-text sockets.
    expect(synthetic).toContain("workItems/satisfied/context)");
    expect(synthetic).not.toContain("workItems/satisfied/context/text)");
  });

  test("multi-turn refinement hides the final JSON contract and all text guidance until /materia continue", () => {
    const socket = agentSocket({
      socket: { materia: "Plan", parse: "json", assign: { workItems: "$.workItems" } },
      materia: { tools: "readOnly", prompt: "Plan collaboratively into work items.", multiTurn: true },
    });

    // Refinement turn: conversational; no final JSON contract or text guidance.
    const refinementPrompt = buildSocketPrompt(state(socket), socket);
    expect(refinementPrompt).toContain("Current multi-turn mode: refinement conversation");
    expect(refinementPrompt).toContain("/materia continue is the only way to finalize");
    expect(refinementPrompt).not.toContain("Final output format: Return only one top-level JSON object");
    expect(refinementPrompt).not.toContain("Agent handoff fields are limited");
    expectNoGenericRenderableTextGuidance(refinementPrompt);

    // Finalization turn: required JSON instructions return, but the non-text
    // Plan socket still suppresses renderable-text guidance.
    const finalizationPrompt = buildMultiTurnFinalizationPrompt(state(socket, { multiTurnFinalizing: true }), socket);
    expect(finalizationPrompt).toContain("Command-triggered finalization");
    expect(finalizationPrompt).toContain("Final output format: Return only one top-level JSON object");
    expect(finalizationPrompt).toContain('"workItems" at $.workItems: array');
    expect(finalizationPrompt).toContain("Agent handoff fields are limited to workItems, satisfied, and context");
    expectNoGenericRenderableTextGuidance(finalizationPrompt);
  });
});

describe("buildIsolatedMateriaContext", () => {
  function materiaPromptMessage(prompt: string): unknown {
    return { role: "custom", customType: "pi-materia-prompt", content: prompt, display: false, details: { phase: "Socket-1", socketId: "Socket-1", materiaName: "Build" }, timestamp: 3 };
  }

  // Flexible hidden pi-materia-prompt builder so tests can stage prompts from
  // different sockets/materia (mirrors sendMateriaTurn details).
  function materiaPromptMessageFor(prompt: string, socketId: string, materiaName: string, details: Record<string, unknown> = {}): unknown {
    return { role: "custom", customType: "pi-materia-prompt", content: prompt, display: false, details: { phase: socketId, socketId, materiaName, ...details }, timestamp: 3 };
  }

  function questOrchestrationCard(content: string, details: Record<string, unknown> = {}): unknown {
    return {
      role: "custom",
      customType: "pi-materia",
      content,
      display: true,
      details: { prefix: "quest", materiaName: "orchestrator", eventType: "run", orchestration: true, ...details },
      timestamp: 4,
    };
  }

  // Mirrors the visible transition card emitted by sendMateriaTurn in
  // src/runtime/nativeLifecycle.ts: customType "pi-materia", display true,
  // details.prefix "materia" + details.eventType "materia_prompt".
  function materiaTransitionCard(content: string, details: Record<string, unknown> = {}): unknown {
    return {
      role: "custom",
      customType: "pi-materia",
      content,
      display: true,
      details: { prefix: "materia", materiaName: "Narrata", socketId: "Socket-7", socketOrdinal: 7, itemLabel: "fix: filter transition cards", eventType: "materia_prompt", orchestration: true, ...details },
      timestamp: 4,
    };
  }

  const QUEST_RUNNER_CARD = [
    "Started continuous quest runner and launched quest quest-zllugjpp: filter the palette",
    "Cast: 2026-06-18T05-07-25-666Z",
    "Runner: enabled",
    "Mode: continuous run; auto-advances while enabled until /materia quest stop",
    "Loadout: Rude (user:reno-copy:b73f1393-eaec-45b1-9b4a-d7deb2048920)",
  ].join("\n");

  test("globally filters legacy cards without cast state while preserving inference and turn messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "genuine refinement" }] },
      { role: "custom", customType: "pi-materia", content: "legacy status card", details: { prefix: "status" } },
      { role: "custom", customType: "pi-materia-prompt", content: "hidden materia prompt", display: false },
      { role: "assistant", content: [{ type: "text", text: "assistant turn" }] },
      { role: "toolResult", content: [{ type: "text", text: "tool result" }] },
      // Defensive coverage for an adapter that incorrectly replayed an entry as
      // a message: presentation cards must not be reconstructed into context.
      { role: "custom", customType: "pi-materia-presentation", content: "presentation card" },
    ];

    const projected = projectMateriaContext(messages);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("legacy status card");
    expect(serialized).not.toContain("presentation card");
    expect(serialized).toContain("genuine refinement");
    expect(serialized).toContain("hidden materia prompt");
    expect(serialized).toContain("assistant turn");
    expect(serialized).toContain("tool result");
  });

  test("filters legacy cards for a completed cast as well as an idle session", () => {
    const socket = agentSocket();
    const completed = state(socket, { active: false, phase: "complete", socketState: "complete", awaitingResponse: false });
    const messages = [
      { role: "user", content: [{ type: "text", text: "native conversation" }] },
      { role: "custom", customType: "pi-materia", content: "completed cast card", details: { prefix: "status" } },
    ];

    expect(JSON.stringify(projectMateriaContext(messages, completed))).not.toContain("completed cast card");
    expect(JSON.stringify(projectMateriaContext(messages))).not.toContain("completed cast card");
  });

  test("filters quest runner orchestration cards appended after the hidden materia prompt", () => {
    const socket = agentSocket();
    const castState = state(socket);
    const messages = [
      { role: "user", content: [{ type: "text", text: "unrelated earlier transcript" }], timestamp: 1 },
      materiaPromptMessage("<materia-instructions>\nBuild it.\n</materia-instructions>"),
      // Runtime appends the user-facing quest card after the triggerTurn materia prompt.
      questOrchestrationCard(QUEST_RUNNER_CARD),
    ];

    const isolated = buildIsolatedMateriaContext(messages, castState);
    const serialized = JSON.stringify(isolated);

    // Synthetic cast context replaces the earlier transcript and remains present.
    expect(isolated[0]).toMatchObject({ role: "user" });
    expect((isolated[0] as { content: string }).content).toContain("Materia isolated context.");
    expect(serialized).not.toContain("unrelated earlier transcript");
    // The hidden materia prompt must survive isolation.
    expect(serialized).toContain("<materia-instructions>");
    expect(serialized).toContain("Build it.");
    // The quest runner orchestration card must be fully removed.
    expect(serialized).not.toContain("Started continuous quest runner");
    expect(serialized).not.toContain("Runner: enabled");
    expect(serialized).not.toContain("Mode: continuous run");
    expect(serialized).not.toContain("Loadout: Rude");
  });

  test("also filters quest runner cards that precede the materia prompt", () => {
    const socket = agentSocket();
    const castState = state(socket);
    const messages = [
      questOrchestrationCard(QUEST_RUNNER_CARD),
      materiaPromptMessage("<materia-instructions>\nBuild it.\n</materia-instructions>"),
    ];

    const isolated = buildIsolatedMateriaContext(messages, castState);
    const serialized = JSON.stringify(isolated);
    expect(serialized).toContain("<materia-instructions>");
    expect(serialized).not.toContain("Started continuous quest runner");
    expect(serialized).not.toContain("Loadout: Rude");
  });

  test("filters quest-prefix cards even without the explicit orchestration flag", () => {
    const socket = agentSocket();
    const castState = state(socket);
    const messages = [
      materiaPromptMessage("<materia-instructions>\nBuild it.\n</materia-instructions>"),
      questOrchestrationCard("Quest runner stopped.", { eventType: "stop", orchestration: undefined }),
    ];
    delete (messages[1] as { details?: { orchestration?: unknown } }).details!.orchestration;

    const isolated = buildIsolatedMateriaContext(messages, castState);
    expect(JSON.stringify(isolated)).not.toContain("Quest runner stopped.");
  });

  test("preserves assistant, toolResult, ordinary user refinement, and non-quest custom messages", () => {
    const socket = agentSocket();
    const castState = state(socket);
    const messages = [
      materiaPromptMessage("<materia-instructions>\nBuild it.\n</materia-instructions>"),
      { role: "assistant", content: [{ type: "text", text: "I will read the file." }], timestamp: 5 },
      { role: "toolResult", content: [{ type: "text", text: "file contents" }], timestamp: 6 },
      { role: "user", content: [{ type: "text", text: "please focus on the palette filter" }], timestamp: 7 },
      { role: "custom", customType: "pi-materia", content: "status card", display: true, details: { prefix: "status", materiaName: "orchestrator", eventType: "status" }, timestamp: 8 },
    ];

    const isolated = buildIsolatedMateriaContext(messages, castState);
    const serialized = JSON.stringify(isolated);
    expect(serialized).toContain("I will read the file.");
    expect(serialized).toContain("file contents");
    expect(serialized).toContain("please focus on the palette filter");
    // Legacy pi-materia custom display cards are filtered by the central
    // projection regardless of their card-specific details.
    expect(serialized).not.toContain("status card");
  });

  test("filters displayed materia transition cards that follow the hidden prompt (Narrata)", () => {
    const socket = agentSocket();
    const castState = state(socket);
    // Mirrors sendMateriaTurn: a hidden pi-materia-prompt followed by the
    // visible "◆ Materia: Narrata (7)" / "Casting Narrata (7)" transition card.
    const transitionContent = "Casting **Narrata (7)**\n\nfix: filter transition cards";
    const messages = [
      { role: "user", content: [{ type: "text", text: "earlier visible transcript noise" }], timestamp: 1 },
      materiaPromptMessage("<materia-instructions>\nBuild the isolated-context transition filter.\n</materia-instructions>"),
      materiaTransitionCard(transitionContent),
    ];

    const isolated = buildIsolatedMateriaContext(messages, castState);
    const serialized = JSON.stringify(isolated);

    // Synthetic cast context replaces the earlier transcript and remains present.
    expect(isolated[0]).toMatchObject({ role: "user" });
    expect((isolated[0] as { content: string }).content).toContain("Materia isolated context.");
    expect(serialized).not.toContain("earlier visible transcript noise");
    // The hidden materia prompt must survive isolation.
    expect(serialized).toContain("<materia-instructions>");
    expect(serialized).toContain("Build the isolated-context transition filter.");
    // The displayed Narrata transition card prose must be fully removed.
    expect(serialized).not.toContain("Casting");
    expect(serialized).not.toContain("Narrata");
    expect(serialized).not.toContain("◆ Materia");
  });

  test("filters materia transition cards even without the explicit orchestration flag", () => {
    const socket = agentSocket();
    const castState = state(socket);
    const messages = [
      materiaPromptMessage("<materia-instructions>\nBuild it.\n</materia-instructions>"),
      materiaTransitionCard("Casting **Narrata (7)**", { orchestration: undefined }),
    ];
    delete (messages[1] as { details?: { orchestration?: unknown } }).details!.orchestration;

    const isolated = buildIsolatedMateriaContext(messages, castState);
    expect(JSON.stringify(isolated)).not.toContain("Casting");
    expect(JSON.stringify(isolated)).not.toContain("Narrata");
    expect(JSON.stringify(isolated)).toContain("<materia-instructions>");
  });

  test("anchors on the current socket prompt and excludes prior socket prompts with <materia-instructions>", () => {
    const socket = agentSocket({ id: "Socket-4" });
    const castState = state(socket, { currentSocketId: "Socket-4", phase: "Socket-4", currentMateria: "Buildga" });
    const messages = [
      { role: "user", content: [{ type: "text", text: "earlier transcript noise" }], timestamp: 1 },
      // Prior socket prompt: also contains <materia-instructions> but belongs to Socket-3.
      materiaPromptMessageFor("<materia-instructions>\nPlan the work.\n</materia-instructions>", "Socket-3", "Auto-Plan"),
      // Current socket prompt: Socket-4 / Buildga.
      materiaPromptMessageFor("<materia-instructions>\nBuildga builds the fix.\n</materia-instructions>", "Socket-4", "Buildga"),
    ];

    const isolated = buildIsolatedMateriaContext(messages, castState);
    const serialized = JSON.stringify(isolated);

    // Synthetic cast context replaces the earlier transcript.
    expect(isolated[0]).toMatchObject({ role: "user" });
    expect((isolated[0] as { content: string }).content).toContain("Materia isolated context.");
    expect(serialized).not.toContain("earlier transcript noise");
    // Prior socket prompt must be fully excluded even though it carries <materia-instructions>.
    expect(serialized).not.toContain("Plan the work.");
    expect(serialized).not.toContain("Auto-Plan");
    // Current socket prompt is anchored and preserved.
    expect(serialized).toContain("<materia-instructions>");
    expect(serialized).toContain("Buildga builds the fix.");
  });

  test("returns transcript unchanged when only a prior socket prompt is present (no content fallback leak)", () => {
    const socket = agentSocket({ id: "Socket-4" });
    const castState = state(socket, { currentSocketId: "Socket-4", phase: "Socket-4", currentMateria: "Buildga" });
    // Only a prior socket prompt is present; the current socket's prompt has not
    // been emitted yet. Isolation must not fall back to content-only discovery
    // and leak the prior socket prompt as the anchor.
    const messages = [
      materiaPromptMessageFor("<materia-instructions>\nPlan the work.\n</materia-instructions>", "Socket-3", "Auto-Plan"),
    ];

    expect(buildIsolatedMateriaContext(messages, castState)).toBe(messages);
  });

  test("defensively falls back to content-only discovery when prompts lack metadata", () => {
    const socket = agentSocket({ id: "Socket-4" });
    const castState = state(socket, { currentSocketId: "Socket-4", phase: "Socket-4", currentMateria: "Buildga" });
    // Lookup carries criteria, but the only pi-materia-prompt message has no
    // socketId/materiaName details (older runtime/test fixture). Discovery must
    // fall back to content-only and still anchor on the <materia-instructions> block.
    const messages = [
      { role: "user", content: [{ type: "text", text: "earlier transcript noise" }], timestamp: 1 },
      { role: "custom", customType: "pi-materia-prompt", content: "<materia-instructions>\nBuild it.\n</materia-instructions>", display: false, details: {}, timestamp: 2 },
    ];

    const isolated = buildIsolatedMateriaContext(messages, castState);
    const serialized = JSON.stringify(isolated);
    expect(isolated[0]).toMatchObject({ role: "user" });
    expect((isolated[0] as { content: string }).content).toContain("Materia isolated context.");
    expect(serialized).not.toContain("earlier transcript noise");
    expect(serialized).toContain("<materia-instructions>");
    expect(serialized).toContain("Build it.");
  });

  test("filters legacy cards even when no active materia prompt is present", () => {
    const socket = agentSocket();
    const castState = state(socket);
    const messages = [
      { role: "user", content: [{ type: "text", text: "plain conversation" }] },
      questOrchestrationCard(QUEST_RUNNER_CARD),
    ];

    const projected = buildIsolatedMateriaContext(messages, castState);
    expect(projected).not.toBe(messages);
    expect(JSON.stringify(projected)).toContain("plain conversation");
    expect(JSON.stringify(projected)).not.toContain("Started continuous quest runner");
  });

  test("preserves full refinement transcript when a finalization prompt follows refinement turns (regression test for context-clearing bug)", () => {
    // Core regression: on /materia continue, the finalization prompt was
    // becoming the isolation anchor, truncating everything before it. With
    // the finalization exclusion fix, the anchor stays at the initial prompt
    // and ALL messages from the initial prompt onward are preserved.
    const socket = agentSocket({
      id: "Socket-MT",
      socket: { materia: "Plan", parse: "json" },
      materia: { tools: "readOnly", prompt: "Plan collaboratively.", multiTurn: true },
    });
    const castState = state(socket, {
      currentSocketId: "Socket-MT",
      currentMateria: "Plan",
      multiTurnFinalizing: true,
    });
    const messages: unknown[] = [
      // Initial hidden prompt (the anchor)
      { role: "custom", customType: "pi-materia-prompt", content: "<materia-instructions>\nPlan collaboratively.\n</materia-instructions>", display: false, details: { socketId: "Socket-MT", materiaName: "Plan" }, timestamp: 1 },
      // Refinement turn: user feedback
      { role: "user", content: [{ type: "text", text: "make the plan more detailed" }], timestamp: 2 },
      // Refinement turn: assistant response
      { role: "assistant", content: [{ type: "text", text: "I have expanded the plan." }], timestamp: 3 },
      // Second refinement turn: user feedback
      { role: "user", content: [{ type: "text", text: "add a timeline" }], timestamp: 4 },
      // Finalization hidden prompt (details.finalization === true)
      { role: "custom", customType: "pi-materia-prompt", content: "<materia-instructions>\nFinalize now.\n</materia-instructions>", display: false, details: { socketId: "Socket-MT", materiaName: "Plan", finalization: true }, timestamp: 5 },
    ];

    const isolated = buildIsolatedMateriaContext(messages, castState);
    const serialized = JSON.stringify(isolated);

    // Synthetic cast context is prepended.
    expect(isolated[0]).toMatchObject({ role: "user" });
    expect((isolated[0] as { content: string }).content).toContain("Materia isolated context.");
    // All messages from the initial hidden prompt onward are preserved:
    // the initial prompt itself, both refinement user messages, the assistant
    // message, and the finalization prompt.
    expect(serialized).toContain("Plan collaboratively.");
    expect(serialized).toContain("make the plan more detailed");
    expect(serialized).toContain("I have expanded the plan.");
    expect(serialized).toContain("add a timeline");
    expect(serialized).toContain("Finalize now.");
  });

  test("preserves the finalization-marked prompt in isolated context even though it is not the anchor", () => {
    // The finalization flag excludes the message from anchor discovery, but
    // the message itself must still be present in the returned context since
    // it appears at/after the anchor index.
    const socket = agentSocket({
      id: "Socket-MT",
      socket: { materia: "Plan", parse: "json" },
      materia: { tools: "readOnly", prompt: "Plan collaboratively.", multiTurn: true },
    });
    const castState = state(socket, {
      currentSocketId: "Socket-MT",
      currentMateria: "Plan",
      multiTurnFinalizing: true,
    });
    const messages: unknown[] = [
      // Initial prompt — the anchor
      { role: "custom", customType: "pi-materia-prompt", content: "<materia-instructions>\nPlan collaboratively.\n</materia-instructions>", display: false, details: { socketId: "Socket-MT", materiaName: "Plan" }, timestamp: 1 },
      { role: "user", content: [{ type: "text", text: "refinement" }], timestamp: 2 },
      // Finalization prompt — excluded from anchor, but must survive isolation
      { role: "custom", customType: "pi-materia-prompt", content: "<materia-instructions>\nFinalize now.\n</materia-instructions>", display: false, details: { socketId: "Socket-MT", materiaName: "Plan", finalization: true }, timestamp: 3 },
    ];

    const isolated = buildIsolatedMateriaContext(messages, castState);
    const serialized = JSON.stringify(isolated);

    // Synthetic cast context prepended.
    expect(isolated[0]).toMatchObject({ role: "user" });
    expect((isolated[0] as { content: string }).content).toContain("Materia isolated context.");
    // Initial prompt preserved (the anchor)
    expect(serialized).toContain("Plan collaboratively.");
    // Refinement message preserved
    expect(serialized).toContain("refinement");
    // Finalization prompt preserved even though it was excluded from anchor discovery
    expect(serialized).toContain("Finalize now.");
    // Confirm finalization flag is still on the message
    const finalizationMsg = isolated.find((m: unknown) => {
      const record = m as { customType?: unknown; details?: { finalization?: unknown } };
      return record.customType === "pi-materia-prompt" && record.details?.finalization === true;
    });
    expect(finalizationMsg).toBeDefined();
    expect((finalizationMsg as { content?: string }).content).toContain("Finalize now.");
  });

  test("returns messages unchanged when only a finalization-marked prompt exists (no earlier anchor)", () => {
    // When the only pi-materia-prompt is finalization-marked, anchor discovery
    // returns -1, and buildIsolatedMateriaContext returns the messages unchanged.
    const socket = agentSocket({
      id: "Socket-MT",
      socket: { materia: "Plan", parse: "json" },
      materia: { tools: "readOnly", prompt: "Plan collaboratively.", multiTurn: true },
    });
    const castState = state(socket, {
      currentSocketId: "Socket-MT",
      currentMateria: "Plan",
      multiTurnFinalizing: true,
    });
    const messages: unknown[] = [
      // Only a finalization-marked prompt, no initial prompt.
      { role: "custom", customType: "pi-materia-prompt", content: "<materia-instructions>\nFinalize now.\n</materia-instructions>", display: false, details: { socketId: "Socket-MT", materiaName: "Plan", finalization: true }, timestamp: 1 },
    ];

    // When no anchor is found, the messages are returned unchanged.
    expect(buildIsolatedMateriaContext(messages, castState)).toBe(messages);
  });
});

describe("findActiveMateriaPromptIndex", () => {
  function promptMessage(prompt: string, socketId: string, materiaName: string, details: Record<string, unknown> = {}): unknown {
    return { role: "custom", customType: "pi-materia-prompt", content: prompt, display: false, details: { phase: socketId, socketId, materiaName, ...details } };
  }

  test("prefers the latest metadata-matched prompt for the active socket", () => {
    const messages = [
      promptMessage("<materia-instructions>\nfirst turn\n</materia-instructions>", "Socket-4", "Buildga"),
      promptMessage("<materia-instructions>\nsecond turn\n</materia-instructions>", "Socket-4", "Buildga"),
    ];

    // Latest Socket-4 prompt wins over the earlier one for the same socket.
    const idx = findActiveMateriaPromptIndex(messages, { socketId: "Socket-4", materiaName: "Buildga" });
    expect(idx).toBe(1);
    expect((messages[idx] as { content: string }).content).toContain("second turn");
  });

  test("excludes a prior socket prompt even when it carries <materia-instructions>", () => {
    const messages = [
      promptMessage("<materia-instructions>\nplan\n</materia-instructions>", "Socket-3", "Auto-Plan"),
      promptMessage("<materia-instructions>\nbuild\n</materia-instructions>", "Socket-4", "Buildga"),
    ];

    expect(findActiveMateriaPromptIndex(messages, { socketId: "Socket-4", materiaName: "Buildga" })).toBe(1);
  });

  test("returns -1 when only a prior socket prompt is present (no content fallback leak)", () => {
    const messages = [promptMessage("<materia-instructions>\nplan\n</materia-instructions>", "Socket-3", "Auto-Plan")];

    expect(findActiveMateriaPromptIndex(messages, { socketId: "Socket-4", materiaName: "Buildga" })).toBe(-1);
  });

  test("anchors on socketId alone when materiaName is unknown", () => {
    const messages = [
      promptMessage("<materia-instructions>\nplan\n</materia-instructions>", "Socket-3", "Auto-Plan"),
      promptMessage("<materia-instructions>\nbuild\n</materia-instructions>", "Socket-4", "Buildga"),
    ];

    expect(findActiveMateriaPromptIndex(messages, { socketId: "Socket-4" })).toBe(1);
  });

  test("keeps current-socket prompt isolation stable across multi-turn refinement", () => {
    const messages = [
      promptMessage("<materia-instructions>\nprior socket\n</materia-instructions>", "Socket-2", "Rude"),
      promptMessage("<materia-instructions>\nrefine the palette\n</materia-instructions>", "Socket-2", "Rude"),
      { role: "assistant", content: [{ type: "text", text: "first draft" }] },
      { role: "user", content: [{ type: "text", text: "make it darker" }] },
    ];

    // A second isolation pass for the same socket re-anchors on the same
    // Socket-2 prompt regardless of intervening assistant/user messages.
    const first = findActiveMateriaPromptIndex(messages, { socketId: "Socket-2", materiaName: "Rude" });
    const second = findActiveMateriaPromptIndex(messages, { socketId: "Socket-2", materiaName: "Rude" });
    expect(first).toBe(second);
    expect(first).toBe(1);
    expect((messages[first] as { content: string }).content).toContain("refine the palette");
  });

  test("falls back to content-only discovery when a prompt lacks metadata", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "noise" }] },
      { role: "custom", customType: "pi-materia-prompt", content: "<materia-instructions>\nbuild\n</materia-instructions>", display: false, details: {} },
    ];

    // Lookup has criteria but the candidate carries no metadata: fall back.
    expect(findActiveMateriaPromptIndex(messages, { socketId: "Socket-4", materiaName: "Buildga" })).toBe(1);
  });

  test("falls back to content-only discovery when no lookup criteria are provided", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "noise" }] },
      promptMessage("<materia-instructions>\nbuild\n</materia-instructions>", "Socket-4", "Buildga"),
    ];

    expect(findActiveMateriaPromptIndex(messages)).toBe(1);
    expect(findActiveMateriaPromptIndex(messages, {})).toBe(1);
  });

  test("returns -1 when no materia prompt is present", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "plain conversation" }] },
      { role: "custom", customType: "pi-materia", content: "status", details: { prefix: "status" } },
    ];

    expect(findActiveMateriaPromptIndex(messages, { socketId: "Socket-4", materiaName: "Buildga" })).toBe(-1);
    expect(findActiveMateriaPromptIndex(messages)).toBe(-1);
  });

  test("skips a finalization-marked prompt and anchors on the earlier same-socket/same-materia prompt (regression test for context-clearing bug)", () => {
    // The finalization prompt (details.finalization === true) must be excluded
    // from anchor discovery so the anchor resolves to the visit's initial
    // hidden prompt, preserving the full refinement transcript.
    const messages = [
      promptMessage("<materia-instructions>\nrefine collaboratively\n</materia-instructions>", "Socket-4", "Plan", { multiTurn: true }),
      { role: "user", content: [{ type: "text", text: "make it simpler" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      // The finalization prompt carries the finalization flag.
      promptMessage("<materia-instructions>\nfinalize now\n</materia-instructions>", "Socket-4", "Plan", { multiTurn: true, finalization: true }),
    ];

    // Anchor must land on the initial prompt, not the finalization prompt.
    const idx = findActiveMateriaPromptIndex(messages, { socketId: "Socket-4", materiaName: "Plan" });
    expect(idx).toBe(0);
    expect((messages[idx] as { content: string }).content).toContain("refine collaboratively");
  });

  test("returns -1 when the only same-socket prompt is finalization-marked (falls back to -1, not content leak)", () => {
    const messages = [
      promptMessage("<materia-instructions>\nfinalize now\n</materia-instructions>", "Socket-4", "Plan", { multiTurn: true, finalization: true }),
    ];

    // With metadata matching, no non-finalization prompt matches, and at least
    // one prompt carried metadata, so the function returns -1.
    expect(findActiveMateriaPromptIndex(messages, { socketId: "Socket-4", materiaName: "Plan" })).toBe(-1);
  });

  test("content-only fallback skips finalization-marked prompts", () => {
    // When prompts lack metadata (fallback path), finalization-marked
    // prompts must also be excluded from anchor discovery.
    const messages = [
      { role: "user", content: [{ type: "text", text: "noise" }] },
      { role: "custom", customType: "pi-materia-prompt", content: "<materia-instructions>\nrefine\n</materia-instructions>", display: false, details: { finalization: true } },
    ];

    expect(findActiveMateriaPromptIndex(messages)).toBe(-1);
  });

  test("content-only fallback selects non-finalization prompt over finalization-marked one", () => {
    const messages = [
      { role: "custom", customType: "pi-materia-prompt", content: "<materia-instructions>\nrefine\n</materia-instructions>", display: false, details: {} },
      { role: "user", content: [{ type: "text", text: "feedback" }] },
      { role: "custom", customType: "pi-materia-prompt", content: "<materia-instructions>\nfinalize\n</materia-instructions>", display: false, details: { finalization: true } },
    ];

    // Even though the non-finalization prompt is earlier, content-only
    // fallback should skip the finalization-marked prompt and select the
    // earliest one that has <materia-instructions>.
    const idx = findActiveMateriaPromptIndex(messages);
    expect(idx).toBe(0);
    expect((messages[idx] as { content: string }).content).toContain("refine");
  });
});

describe("isLegacyMateriaDisplayMessage", () => {
  test("matches every legacy card regardless of per-card details", () => {
    expect(isLegacyMateriaDisplayMessage({ role: "custom", customType: "pi-materia", content: "quest card", details: { prefix: "quest" } })).toBe(true);
    expect(isLegacyMateriaDisplayMessage({ role: "custom", customType: "pi-materia", content: "status card", details: {} })).toBe(true);
    expect(isLegacyMateriaDisplayMessage({ role: "custom", customType: "pi-materia-presentation", content: "replayed entry" })).toBe(true);
  });

  test("preserves the hidden materia prompt and ordinary message roles", () => {
    expect(isLegacyMateriaDisplayMessage({ role: "custom", customType: "pi-materia-prompt", content: "<materia-instructions>" })).toBe(false);
    expect(isLegacyMateriaDisplayMessage({ role: "user", customType: "pi-materia", content: "user refinement" })).toBe(false);
    expect(isLegacyMateriaDisplayMessage({ role: "assistant", customType: "pi-materia", content: "assistant turn" })).toBe(false);
    expect(isLegacyMateriaDisplayMessage({ role: "toolResult", customType: "pi-materia", content: "tool result" })).toBe(false);
  });

  test("handles malformed inputs defensively", () => {
    expect(isLegacyMateriaDisplayMessage(null)).toBe(false);
    expect(isLegacyMateriaDisplayMessage(undefined)).toBe(false);
    expect(isLegacyMateriaDisplayMessage("text")).toBe(false);
    expect(isLegacyMateriaDisplayMessage({ role: "custom" })).toBe(false);
    expect(isLegacyMateriaDisplayMessage({ role: "custom", customType: "other" })).toBe(false);
  });
});

describe("syntheticEventEmissionContext", () => {
  function makeJsonSocket(): ResolvedMateriaAgentSocket {
    return agentSocket({
      id: "Socket-1",
      socket: { materia: "Build", parse: "json" },
      materia: { tools: "readOnly", prompt: "Build feature." },
    });
  }

  function makeTextSocket(): ResolvedMateriaAgentSocket {
    return agentSocket({
      id: "Socket-1",
      socket: { materia: "Build", parse: "text" },
      materia: { tools: "readWrite", prompt: "Build feature." },
    });
  }

  test("returns event emission instructions for single-turn JSON sockets", () => {
    const socket = makeJsonSocket();
    const castState = state(socket);

    const context = syntheticEventEmissionContext(castState);
    expect(context).toBeDefined();
    expect(context).toBeString();

    // Title and general instructions
    expect(context).toContain("## Event Emission (Optional)");
    expect(context).toContain("does not affect routing, assignment, or downstream state");

    // Text socket disclaimer
    expect(context).toContain("Text output sockets cannot emit JSON side-channel events");

    // Not part of handoff contract
    expect(context).toContain("never part of the agent handoff contract");

    // Type requirement
    expect(context).toContain('"type"');
    expect(context).toContain('"result.pr_created"');
    expect(context).toContain('"status.progress"');

    // Severity
    expect(context).toContain('"severity"');
    expect(context).toContain('"info"');
    expect(context).toContain('debug, info, warning, error, critical');

    // Result event examples
    expect(context).toContain("### Result Events");
    expect(context).toContain('result.pr_created');
    expect(context).toContain('result.branch_pushed');
    expect(context).toContain('result.no_changes_needed');
    expect(context).toContain('result.needs_human');

    // Status event examples
    expect(context).toContain("### Status and Progress Events");
    expect(context).toContain('status.progress');
    expect(context).toContain('status.info');

    // Combined output example
    expect(context).toContain('Example combined output');
    expect(context).toContain('"workItems"');
    expect(context).toContain('"satisfied"');
    expect(context).toContain('"context"');
    expect(context).toContain('"event"');

    // Non-text JSON socket: event wording is field-neutral and must not invite
    // a top-level renderable `text` payload alongside the event side-channel.
    expect(context).toContain("workItems/satisfied/context)");
    expect(context).toContain("alongside workItems, satisfied, and context");
    expect(context).not.toMatch(/context\/text\)/);
    expect(context).not.toMatch(/alongside workItems, satisfied, context, and text/);
  });

  test("scopes event wording to renderable-text intent for $.text sockets", () => {
    const socket = agentSocket({
      socket: { materia: "Narrate", parse: "json", assign: { prNotes: "$.text" } },
      materia: { tools: "readOnly", prompt: "Narrate the result." },
    });
    const context = syntheticEventEmissionContext(state(socket));

    expect(context).toBeDefined();
    // Text-enabled sockets keep the full field list including `text`.
    expect(context).toContain("workItems/satisfied/context/text)");
    expect(context).toContain("alongside workItems, satisfied, context, and text");
  });

  test("returns undefined for text sockets", () => {
    const socket = makeTextSocket();
    const castState = state(socket);

    expect(syntheticEventEmissionContext(castState)).toBeUndefined();
  });

  test("returns event emission instructions for multi-turn finalization", () => {
    const socket = agentSocket({
      id: "Socket-MT",
      socket: { materia: "Plan", parse: "json" },
      materia: { tools: "readOnly", prompt: "Plan work.", multiTurn: true },
    });
    const castState = state(socket, { multiTurnFinalizing: true });

    const context = syntheticEventEmissionContext(castState);
    expect(context).toBeDefined();
    expect(context).toContain("## Event Emission (Optional)");
    expect(context).toContain('result.pr_created');
  });

  test("returns undefined during multi-turn refinement (conversational mode)", () => {
    const socket = agentSocket({
      id: "Socket-MT",
      socket: { materia: "Plan", parse: "json" },
      materia: { tools: "readOnly", prompt: "Plan work.", multiTurn: true },
    });
    const castState = state(socket, { multiTurnFinalizing: false });

    expect(syntheticEventEmissionContext(castState)).toBeUndefined();
  });

  test("event emission context is included in buildSyntheticCastContext for JSON sockets", () => {
    const socket = makeJsonSocket();
    const castState = state(socket, { lastOutput: "previous work output" });

    const synthetic = buildSyntheticCastContext(castState);

    expect(synthetic).toContain("## Event Emission (Optional)");
    expect(synthetic).toContain('result.pr_created');
    expect(synthetic).toContain('result.branch_pushed');
    expect(synthetic).toContain('result.no_changes_needed');
    expect(synthetic).toContain('result.needs_human');
    expect(synthetic).toContain('status.progress');
    expect(synthetic).toContain('status.info');

    // Event context should come after handoff contract context
    const eventIdx = synthetic.indexOf("## Event Emission (Optional)");
    const handoffIdx = synthetic.indexOf("Agent-authored JSON handoffs are limited");
    expect(handoffIdx).toBeGreaterThan(-1);
    expect(eventIdx).toBeGreaterThan(handoffIdx);
  });

  test("event emission context is NOT included for text sockets in buildSyntheticCastContext", () => {
    const socket = makeTextSocket();
    const castState = state(socket, { lastOutput: "text output" });

    const synthetic = buildSyntheticCastContext(castState);

    expect(synthetic).not.toContain("## Event Emission (Optional)");
    expect(synthetic).not.toContain('result.pr_created');
    expect(synthetic).not.toContain('status.progress');
  });

  test("event emission context is carried by buildSyntheticCastContext for multi-turn finalization, not embedded in finalization prompt", () => {
    const socket = agentSocket({
      id: "Socket-MT",
      socket: { materia: "Plan", parse: "json" },
      materia: { tools: "readOnly", prompt: "Plan work.", multiTurn: true },
    });
    const castState = state(socket, { multiTurnFinalizing: true });

    // The synthetic cast context is prepended by buildIsolatedMateriaContext on
    // every isolated turn, so it carries the event emission instructions.
    const synthetic = buildSyntheticCastContext(castState);
    expect(synthetic).toContain("## Event Emission (Optional)");
    expect(synthetic).toContain('result.pr_created');
    expect(synthetic).toContain('status.progress');

    // But the finalization prompt itself does NOT embed the synthetic context.
    const prompt = buildMultiTurnFinalizationPrompt(castState, socket);
    expect(prompt).not.toContain("## Event Emission (Optional)");
    expect(prompt).not.toContain('result.pr_created');
  });

  test("event emission context is NOT included during multi-turn refinement", () => {
    const socket = agentSocket({
      id: "Socket-MT",
      socket: { materia: "Plan", parse: "json" },
      materia: { tools: "readOnly", prompt: "Plan work.", multiTurn: true },
    });
    const castState = state(socket, { multiTurnFinalizing: false });

    const prompt = buildSocketPrompt(castState, socket);

    expect(prompt).not.toContain("## Event Emission (Optional)");
    expect(prompt).not.toContain('result.pr_created');
    expect(prompt).not.toContain('status.progress');
  });
});

describe("sanitizePreviousOutput", () => {
  function makeState(overrides: Partial<Pick<MateriaCastState, "lastAssistantText" | "lastOutput" | "lastJson">> = {}): MateriaCastState {
    return state(agentSocket(), overrides);
  }

  test("returns undefined when there is no previous output", () => {
    expect(sanitizePreviousOutput(makeState({ lastAssistantText: undefined, lastOutput: undefined }))).toBeUndefined();
  });

  test("returns free-text previous output unchanged", () => {
    expect(sanitizePreviousOutput(makeState({ lastOutput: "build complete", lastJson: undefined }))).toBe("build complete");
  });

  test("returns JSON previous output unchanged when it has no text field", () => {
    const json = { "satisfied": true };
    expect(sanitizePreviousOutput(makeState({ lastOutput: JSON.stringify(json), lastJson: json }))).toBe(JSON.stringify(json));
  });

  test("strips renderable text from JSON previous output", () => {
    const json = { "satisfied": true, "text": "## Summary\n\nNarration prose." };
    const result = sanitizePreviousOutput(makeState({ lastOutput: JSON.stringify(json), lastJson: json }));
    expect(result).toBeDefined();
    expect(result).not.toContain("Narration prose");
    expect(result).toContain("satisfied");
  });

  test("returns undefined when text was the only field in JSON previous output", () => {
    const json = { "text": "narration only" };
    expect(sanitizePreviousOutput(makeState({ lastOutput: JSON.stringify(json), lastJson: json }))).toBeUndefined();
  });

  test("does not sanitize when lastJson is not the parsed form of the output", () => {
    const staleJson = { "satisfied": true };
    const result = sanitizePreviousOutput(makeState({ lastOutput: "plain text output", lastJson: staleJson }));
    expect(result).toBe("plain text output");
  });

  test("strips text from previous output in buildSyntheticCastContext", () => {
    const json = { "satisfied": true, "text": "renderable narration prose" };
    const castState = state(agentSocket(), { lastOutput: JSON.stringify(json), lastJson: json });
    const synthetic = buildSyntheticCastContext(castState);
    expect(synthetic).toContain("Previous output:");
    expect(synthetic).toContain("satisfied");
    expect(synthetic).not.toContain("renderable narration prose");
  });

  test("omits Previous output section entirely when text was the only field", () => {
    const json = { "text": "narration only" };
    const castState = state(agentSocket(), { lastOutput: JSON.stringify(json), lastJson: json });
    const synthetic = buildSyntheticCastContext(castState);
    expect(synthetic).not.toContain("Previous output:");
    expect(synthetic).not.toContain("narration only");
  });

  test("preserves text in lastJson for debugging and replay", () => {
    const json = { "satisfied": true, "text": "renderable narration prose" };
    const castState = state(agentSocket(), { lastOutput: JSON.stringify(json), lastJson: json });
    sanitizePreviousOutput(castState);
    expect(castState.lastJson).toEqual(json);
  });

  test("suppresses 'Casting **<name>**' transition card noise", () => {
    const castState = state(agentSocket(), { lastAssistantText: "Casting **Narrata (7)**" });
    expect(sanitizePreviousOutput(castState)).toBeUndefined();
  });

  test("suppresses plain 'Casting <name> (n)' transition card noise", () => {
    const castState = state(agentSocket(), { lastOutput: "Casting Narrata (7)" });
    expect(sanitizePreviousOutput(castState)).toBeUndefined();
  });

  test("suppresses 'Casting <name> Socket-n' transition card noise", () => {
    const castState = state(agentSocket(), { lastOutput: "Casting Buildga Socket-4" });
    expect(sanitizePreviousOutput(castState)).toBeUndefined();
  });

  test("suppresses '◆ Materia' renderer-label noise", () => {
    const castState = state(agentSocket(), { lastAssistantText: "◆ Materia: Narrata (7) materia materia prompt" });
    expect(sanitizePreviousOutput(castState)).toBeUndefined();
  });

  test("suppresses prompt-banner eventType noise", () => {
    const castState = state(agentSocket(), { lastOutput: "Casting Narrata (7) materia materia prompt" });
    expect(sanitizePreviousOutput(castState)).toBeUndefined();
  });

  test("suppresses materia_prompt eventType token noise", () => {
    const castState = state(agentSocket(), { lastOutput: "materia_prompt dispatched for Socket-7" });
    expect(sanitizePreviousOutput(castState)).toBeUndefined();
  });

  test("does not suppress legitimate text that happens to contain 'casting'", () => {
    // Lowercase 'casting' without card markers must pass through unchanged.
    const castState = state(agentSocket(), { lastOutput: "I am casting a wide net across the module." });
    expect(sanitizePreviousOutput(castState)).toBe("I am casting a wide net across the module.");
  });

  test("defensively strips event side-channel from JSON previous output", () => {
    // Defensive case: lastJson still carries event (e.g. stale/unexpected),
    // and lastOutput is its raw serialization. Event must not leak.
    const json = { "satisfied": true, "event": [{ "type": "result.pr_created", "message": "PR #99", "payload": { "branchName": "agent/fix" } }] };
    const castState = state(agentSocket(), { lastOutput: JSON.stringify(json), lastJson: json });
    const result = sanitizePreviousOutput(castState);
    expect(result).toBe(JSON.stringify({ "satisfied": true }));
    expect(result).not.toContain("result.pr_created");
    expect(result).not.toContain("PR #99");
    expect(result).not.toContain("agent/fix");
    expect(result).not.toContain("event");
  });

  test("defensively strips event side-channel when lastOutput is the clean form", () => {
    // Normal case mirrored defensively: lastJson carries event but lastOutput
    // is the event-stripped serialization. Event still stripped, satisfied kept.
    const json = { "satisfied": true, "event": [{ "type": "result.pr_created", "message": "leak" }] };
    const clean = JSON.stringify({ "satisfied": true });
    const castState = state(agentSocket(), { lastOutput: clean, lastJson: json });
    const result = sanitizePreviousOutput(castState);
    expect(result).toBe(clean);
    expect(result).not.toContain("event");
    expect(result).not.toContain("leak");
  });

  test("preserves legitimate canonical JSON handoff for routing-aware downstream", () => {
    const json = { "satisfied": true };
    const castState = state(agentSocket(), { lastOutput: JSON.stringify(json), lastJson: json });
    expect(sanitizePreviousOutput(castState)).toBe(JSON.stringify({ "satisfied": true }));
  });

  test("display noise is omitted from buildSyntheticCastContext Previous output", () => {
    const castState = state(agentSocket(), { lastAssistantText: "Casting **Narrata (7)**\n\nfix: some work item" });
    const synthetic = buildSyntheticCastContext(castState);
    expect(synthetic).not.toContain("Previous output:");
    expect(synthetic).not.toContain("Casting");
    expect(synthetic).not.toContain("Narrata");
  });

  test("◆ Materia banner noise is omitted from buildSyntheticCastContext", () => {
    const castState = state(agentSocket(), { lastOutput: "◆ Materia: Narrata (7) materia materia prompt" });
    const synthetic = buildSyntheticCastContext(castState);
    expect(synthetic).not.toContain("Previous output:");
    expect(synthetic).not.toContain("◆ Materia");
    expect(synthetic).not.toContain("materia_prompt");
  });

  test("event side-channel does not leak into buildSyntheticCastContext when lastJson carries it", () => {
    const json = { "satisfied": true, "event": [{ "type": "result.pr_created", "message": "PR #99", "payload": { "branchName": "agent/fix" } }] };
    const castState = state(agentSocket(), { lastOutput: JSON.stringify(json), lastJson: json });
    const synthetic = buildSyntheticCastContext(castState);
    expect(synthetic).toContain("Previous output:");
    expect(synthetic).toContain("satisfied");
    expect(synthetic).not.toContain("result.pr_created");
    expect(synthetic).not.toContain("PR #99");
    expect(synthetic).not.toContain("agent/fix");
  });
});

describe("buildTimeoutRecoveryHint", () => {
  function makeHintState(overrides: Partial<Pick<import("../src/types.js").MateriaCastState, "recoveryReasons" | "recoveryErrorMessages" | "recoveryAttempts" | "recoveryHintSuppressed">> = {}): Partial<import("../src/types.js").MateriaCastState> {
    return overrides;
  }

  test("returns undefined for non-timeout recovery reason", () => {
    const state = makeHintState({ recoveryReasons: { "key-1": "context_window" } });
    expect(buildTimeoutRecoveryHint(state as any, "key-1")).toBeUndefined();
  });

  test("returns undefined when no recovery reason is recorded", () => {
    const state = makeHintState();
    expect(buildTimeoutRecoveryHint(state as any, "key-1")).toBeUndefined();
  });

  test("returns undefined when hint is suppressed", () => {
    const state = makeHintState({ recoveryReasons: { "key-1": "tool_timeout" }, recoveryHintSuppressed: true });
    expect(buildTimeoutRecoveryHint(state as any, "key-1")).toBeUndefined();
  });

  test("returns hint with duration extracted from error message", () => {
    const state = makeHintState({
      recoveryReasons: { "key-1": "tool_timeout" },
      recoveryErrorMessages: { "key-1": "bash command timed out after 180 seconds" },
      recoveryAttempts: { "key-1": 2 },
    });
    const hint = buildTimeoutRecoveryHint(state as any, "key-1");
    expect(hint).toBeDefined();
    expect(hint).toContain("TIMEOUT RECOVERY HINT");
    expect(hint).toContain("after 180s");
    expect(hint).toContain("retry #2");
    expect(hint).toContain("Do NOT repeat");
    expect(hint).toContain("one-shot commands");
    expect(hint).toContain("--run flags instead of --watch");
  });

  test("returns hint without duration when error message has no duration", () => {
    const state = makeHintState({
      recoveryReasons: { "key-1": "tool_timeout" },
      recoveryErrorMessages: { "key-1": "bash command timed out" },
      recoveryAttempts: { "key-1": 0 },
    });
    const hint = buildTimeoutRecoveryHint(state as any, "key-1");
    expect(hint).toBeDefined();
    expect(hint).toContain("The previous bash command timed out");
    expect(hint).not.toContain("after");
    expect(hint).not.toContain("retry #");
  });

  test("hint is stable across multiple calls (persists)", () => {
    const state = makeHintState({
      recoveryReasons: { "key-1": "tool_timeout" },
      recoveryErrorMessages: { "key-1": "Command timed out after 300 seconds" },
      recoveryAttempts: { "key-1": 1 },
    });
    const hint1 = buildTimeoutRecoveryHint(state as any, "key-1");
    const hint2 = buildTimeoutRecoveryHint(state as any, "key-1");
    expect(hint1).toBe(hint2);
    expect(hint1).toContain("after 300s");
  });
});
