import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { activeMateriaSystemPrompt, buildJsonOutputRepairPrompt, buildMultiTurnFinalizationPrompt, buildSocketPrompt, buildSyntheticCastContext } from "../src/application/promptAssembly.js";
import { HANDOFF_CONTRACT_PROMPT_TEXT, HANDOFF_RESERVED_FIELD_TYPE_PROMPT_TEXT } from "../src/handoff/handoffContract.js";
import type { MateriaCastState, ResolvedMateriaAgentSocket } from "../src/types.js";

function agentSocket(overrides: Partial<ResolvedMateriaAgentSocket> = {}): ResolvedMateriaAgentSocket {
  return {
    id: "Socket-1",
    socket: { materia: "Build", parse: "text" },
    materia: { tools: "readOnly", prompt: "Build {{ item.id }} for {{ request }}." },
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
      item: { id: "item-1", title: "Item 1" },
      workItems: [{ id: "item-1", title: "Item 1" }],
      guidance: { next: "keep it small" },
    },
    cursors: { item: 0 },
    visits: { [socket.id]: 1 },
    multiTurnRefinements: {},
    taskAttempts: {},
    edgeTraversals: {},
    runState: { castId: "cast-1", runDir: "/repo/.pi/pi-materia/cast-1", startedAt: 1, model: "test", usage: {}, currentSocketId: socket.id, currentMateria: "Build" },
    pipeline: { entry: socket, sockets: { [socket.id]: socket } },
    currentItemKey: "item-1",
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
    expect(prompt).toContain("Build item-1 for original request.");
    expect(prompt).toContain("Socket adapter context");
    expect(prompt).toContain("Current workItem JSON");
    expect(prompt).toContain('"id": "item-1"');
    expect(prompt).toContain("Global guidance JSON");
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
    expect(prompt).toContain("Agent-authored JSON handoffs are limited to top-level workItems, satisfied, and context");
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
    expect(prompt).toContain('"castId": "cast-prev"');
    expect(prompt).toContain("original feature request");
    expect(prompt).toContain("implemented parser");
    expect(prompt).toContain("bounded preview");
    expect(prompt).toContain("workItems");
    expect(prompt).toContain("never use tasks");
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

    expect(activeMateriaSystemPrompt(castState, socket.materia)).toContain("Build item-1 for original request.");
    const synthetic = buildSyntheticCastContext(castState);
    expect(synthetic).toContain("Cast id: cast-1");
    expect(synthetic).toContain("Original request: original request");
    expect(synthetic).toContain("Previous output:\nprevious answer");
  });
});
