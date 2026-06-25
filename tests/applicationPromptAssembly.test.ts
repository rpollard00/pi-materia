import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { activeMateriaSystemPrompt, buildIsolatedMateriaContext, buildJsonOutputRepairPrompt, buildMultiTurnFinalizationPrompt, buildSocketPrompt, buildSyntheticCastContext, buildTimeoutRecoveryHint, isOrchestrationOnlyMessage, sanitizePreviousOutput, syntheticEventEmissionContext } from "../src/application/promptAssembly.js";
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
  test("JSON repair prompts describe socket payload validation without requesting a full envelope", () => {
    const prompt = buildJsonOutputRepairPrompt({
      validationKind: "handoff_validation",
      errorMessage: "Invalid handoff JSON output for socket \"Check\": Missing required reserved field \"satisfied\" at $.satisfied; expected a boolean.",
      validationIssues: [{ path: "$.satisfied", message: "Missing required reserved field \"satisfied\" at $.satisfied; expected a boolean.", reason: "Current socket control flow uses satisfied/not_satisfied routing or advancement." }],
      invalidOutputExcerpt: "{\"feedback\":\"retry\"}",
      originalFinalOutputInstructions: "Final output format: Return only one top-level JSON object\nRequired payload fields:\n- \"satisfied\" at $.satisfied: boolean.",
    });

    expect(prompt).toContain("socket JSON payload validation");
    expect(prompt).toContain("Structured validation issues for the current socket requirements");
    expect(prompt).toContain("$.satisfied");
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

    expect(evalPrompt).toContain("Agent handoff fields are limited to workItems, satisfied, context, and text");
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

  test("/materia continue finalization includes synthetic context and canonical JSON contract", () => {
    const socket = agentSocket({
      socket: { materia: "Plan", parse: "json" },
      materia: { tools: "readOnly", prompt: "Plan collaboratively.", multiTurn: true },
    });
    const prompt = buildMultiTurnFinalizationPrompt(state(socket, { multiTurnFinalizing: true, lastOutput: "previous refinement" }), socket);

    expect(prompt).toContain("Materia isolated context.");
    expect(prompt).toContain("Command-triggered finalization");
    expect(prompt).toContain("Canonical handoff contract context:");
    expect(prompt).toContain("Agent-authored JSON handoffs are limited to top-level workItems, satisfied, context, and text");
    expect(prompt).toContain(HANDOFF_RESERVED_FIELD_TYPE_PROMPT_TEXT);
    expect(prompt).not.toContain(HANDOFF_CONTRACT_PROMPT_TEXT);
    expect(prompt).not.toContain("pi-materia canonical handoff JSON contract");
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

describe("buildIsolatedMateriaContext", () => {
  function materiaPromptMessage(prompt: string): unknown {
    return { role: "custom", customType: "pi-materia-prompt", content: prompt, display: false, details: { phase: "Socket-1", socketId: "Socket-1", materiaName: "Build" }, timestamp: 3 };
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
    // Non-quest custom display cards are out of scope and remain untouched.
    expect(serialized).toContain("status card");
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

  test("returns messages unchanged when no active materia prompt is present", () => {
    const socket = agentSocket();
    const castState = state(socket);
    const messages = [
      { role: "user", content: [{ type: "text", text: "plain conversation" }] },
      questOrchestrationCard(QUEST_RUNNER_CARD),
    ];

    expect(buildIsolatedMateriaContext(messages, castState)).toBe(messages);
  });
});

describe("isOrchestrationOnlyMessage", () => {
  test("flags custom messages marked orchestration or with a quest/materia transition signature", () => {
    // Explicit orchestration flag (covers quest runner and materia cards alike).
    expect(isOrchestrationOnlyMessage({ role: "custom", customType: "pi-materia", content: "x", details: { prefix: "quest", orchestration: true } })).toBe(true);
    expect(isOrchestrationOnlyMessage({ role: "custom", customType: "pi-materia", content: "x", details: { orchestration: true } })).toBe(true);
    // Defense-in-depth: quest-prefix cards without the explicit flag.
    expect(isOrchestrationOnlyMessage({ role: "custom", customType: "pi-materia", content: "x", details: { prefix: "quest" } })).toBe(true);
    // Defense-in-depth: materia transition cards (prefix "materia" and/or
    // eventType "materia_prompt") without the explicit orchestration flag.
    expect(isOrchestrationOnlyMessage({ role: "custom", customType: "pi-materia", content: "Casting Narrata", details: { prefix: "materia", eventType: "materia_prompt" } })).toBe(true);
    expect(isOrchestrationOnlyMessage({ role: "custom", customType: "pi-materia", content: "Casting Narrata", details: { prefix: "materia" } })).toBe(true);
    expect(isOrchestrationOnlyMessage({ role: "custom", customType: "pi-materia", content: "Casting Narrata", details: { eventType: "materia_prompt" } })).toBe(true);
  });

  test("preserves the hidden materia prompt and non-quest custom cards", () => {
    // The hidden pi-materia-prompt carries socket/materia details but none of
    // the display-card signatures, so it is never mistaken for a transition card.
    expect(isOrchestrationOnlyMessage({ role: "custom", customType: "pi-materia-prompt", content: "<materia-instructions>", details: { phase: "Socket-7", socketId: "Socket-7", materiaName: "Narrata" } })).toBe(false);
    expect(isOrchestrationOnlyMessage({ role: "custom", customType: "pi-materia", content: "status", details: { prefix: "status" } })).toBe(false);
    expect(isOrchestrationOnlyMessage({ role: "custom", customType: "pi-materia", content: "orphan", details: {} })).toBe(false);
  });

  test("never treats user, assistant, tool, or toolResult messages as orchestration", () => {
    expect(isOrchestrationOnlyMessage({ role: "user", content: [{ type: "text", text: "Started continuous quest runner" }] })).toBe(false);
    expect(isOrchestrationOnlyMessage({ role: "assistant", content: [{ type: "text", text: "ack" }] })).toBe(false);
    expect(isOrchestrationOnlyMessage({ role: "toolResult", content: [] })).toBe(false);
    expect(isOrchestrationOnlyMessage({ role: "tool", content: [] })).toBe(false);
  });

  test("handles malformed inputs defensively", () => {
    expect(isOrchestrationOnlyMessage(null)).toBe(false);
    expect(isOrchestrationOnlyMessage(undefined)).toBe(false);
    expect(isOrchestrationOnlyMessage("text")).toBe(false);
    expect(isOrchestrationOnlyMessage({ role: "custom" })).toBe(false);
    expect(isOrchestrationOnlyMessage({ role: "custom", details: "not-an-object" })).toBe(false);
    expect(isOrchestrationOnlyMessage({ role: "custom", details: null })).toBe(false);
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

  test("event emission context is included in multi-turn finalization prompt", () => {
    const socket = agentSocket({
      id: "Socket-MT",
      socket: { materia: "Plan", parse: "json" },
      materia: { tools: "readOnly", prompt: "Plan work.", multiTurn: true },
    });
    const castState = state(socket, { multiTurnFinalizing: true });

    const prompt = buildMultiTurnFinalizationPrompt(castState, socket);

    expect(prompt).toContain("## Event Emission (Optional)");
    expect(prompt).toContain('result.pr_created');
    expect(prompt).toContain('status.progress');
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
