import { describe, expect, test } from "bun:test";
import { activeMateriaSystemPrompt, buildMultiTurnFinalizationPrompt, buildSocketPrompt, buildSyntheticCastContext } from "../src/application/promptAssembly.js";
import { HANDOFF_CONTRACT_PROMPT_TEXT } from "../src/handoffContract.js";
import type { MateriaCastState, ResolvedMateriaAgentSocket } from "../src/types.js";

function agentSocket(overrides: Partial<ResolvedMateriaAgentSocket> = {}): ResolvedMateriaAgentSocket {
  return {
    id: "Socket-1",
    socket: { type: "agent", materia: "Build", parse: "text" },
    materia: { tools: "readOnly", prompt: "Build {{ item.id }} for {{ request }}." },
    edges: [],
    ...overrides,
  } as ResolvedMateriaAgentSocket;
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

  test("generator JSON sockets receive canonical workItems and evaluator route-field instructions", () => {
    const socket = agentSocket({
      socket: { type: "agent", materia: "Plan", parse: "json" },
      materia: { tools: "readOnly", prompt: "Plan work.", generator: true },
    });
    const prompt = buildSocketPrompt(state(socket), socket);

    expect(prompt).toContain("Generator socket adapter context");
    expect(prompt).toContain("expose generated output as workItems");
    expect(prompt).toContain("Reserved evaluator/route fields");
    expect(prompt).toContain('"satisfied"');
    expect(prompt).toContain(HANDOFF_CONTRACT_PROMPT_TEXT);
  });

  test("multi-turn refinement stays conversational until continue finalization", () => {
    const socket = agentSocket({
      socket: { type: "agent", materia: "Plan", parse: "json" },
      materia: { tools: "readOnly", prompt: "Plan collaboratively.", multiTurn: true },
    });
    const prompt = buildSocketPrompt(state(socket), socket);

    expect(prompt).toContain("Current multi-turn mode: refinement conversation");
    expect(prompt).toContain("/materia continue is the only way to finalize");
    expect(prompt).not.toContain(HANDOFF_CONTRACT_PROMPT_TEXT);
  });

  test("/materia continue finalization includes synthetic context and canonical JSON contract", () => {
    const socket = agentSocket({
      socket: { type: "agent", materia: "Plan", parse: "json" },
      materia: { tools: "readOnly", prompt: "Plan collaboratively.", multiTurn: true },
    });
    const prompt = buildMultiTurnFinalizationPrompt(state(socket, { multiTurnFinalizing: true, lastOutput: "previous refinement" }), socket);

    expect(prompt).toContain("Materia isolated context.");
    expect(prompt).toContain("Command-triggered finalization");
    expect(prompt).toContain("Canonical handoff contract context:");
    expect(prompt).toContain(HANDOFF_CONTRACT_PROMPT_TEXT);
    expect(prompt).toContain("Final output format: Return only JSON for this socket");
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
