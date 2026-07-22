import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { extendSameSocketRecoveryAllowanceForRevive } from "../src/castRuntime.js";
import { buildSyntheticCastContext } from "../src/application/promptAssembly.js";
import { FakePiHarness } from "./fakePi.js";

async function makeHarness(config: unknown): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-recovery-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(config, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

async function readEvents(harness: FakePiHarness): Promise<any[]> {
  const castRoot = path.join(harness.cwd, ".pi", "pi-materia");
  const castDir = path.join(castRoot, (await readdir(castRoot))[0]);
  return (await readFile(path.join(castDir, "events.jsonl"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

const CODEX_SERVER_ERROR_SAMPLE = 'Error: Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 06c12916-6464-4199-b4b7-53055ee0111a in your message.","param":null},"sequence_number":2}';
const CODEX_CONTEXT_LENGTH_SAMPLE = 'Error: WebSocket closed 1000 Error: Codex error: {"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window of this model. Please adjust your input and try again.","param":"input"},"sequence_number":2}';

function singleAgentConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: { Test: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Build", edges: [{ when: 'always', to: 'end' }] } } } },
    materia: { Build: { tools: "coding", prompt: "Build materia" } },
  };
}

function multiTurnConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: { Test: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Plan", parse: "json", assign: { tasks: "$.tasks" }, edges: [{ when: 'always', to: 'end' }] } } } },
    materia: { Plan: { tools: "readOnly", prompt: "Collaborative planner", multiTurn: true } },
  };
}

function jsonAgentConfig(target: string = "end") {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: { Test: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Build", parse: "json", assign: { result: "$.context" }, edges: [{ when: "always", to: target }] } } } },
    materia: { Build: { tools: "coding", prompt: "Build materia" } },
  };
}

function budgetFailingAgentConfig() {
  return {
    ...jsonAgentConfig(),
    budget: { maxTokens: 0 },
  };
}

function utilityJsonConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: { Test: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Broken-Json", edges: [{ when: 'always', to: 'end' }] } } } },
    materia: { "Broken-Json": { type: "utility", utility: "echo", parse: "json", params: { output: "not json" } }, Build: { tools: "coding", prompt: "Build materia" } },
  };
}

function utilityHandoffValidationConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: { Test: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Broken-Handoff", edges: [{ when: "always", to: "end" }] } } } },
    materia: { "Broken-Handoff": { type: "utility", utility: "echo", parse: "json", params: { output: { satisfied: "yes", result: "utility-invalid" } } } },
  };
}

function jsonAgentWithDownstreamConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "Socket-1",
        sockets: {
          "Socket-1": { materia: "Build", parse: "json", assign: { result: "$.context" }, edges: [{ when: "always", to: "Socket-2" }] },
          "Socket-2": { materia: "Downstream", edges: [{ when: "always", to: "end" }] },
        },
      },
    },
    materia: {
      Build: { tools: "coding", prompt: "Build materia" },
      Downstream: { type: "utility", utility: "echo", parse: "json", params: { output: { downstream: "ran" } }, assign: { downstream: "$.downstream" } },
    },
  };
}

function satisfiedRouteAgentConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "Socket-1",
        sockets: {
          "Socket-1": {
            materia: "Build",
            parse: "json",
            assign: { result: "$.context" },
            edges: [{ when: "satisfied", to: "Socket-2" }, { when: "not_satisfied", to: "end" }],
          },
          "Socket-2": { materia: "Downstream", edges: [{ when: "always", to: "end" }] },
        },
      },
    },
    materia: {
      Build: { tools: "coding", prompt: "Build materia" },
      Downstream: { type: "utility", utility: "echo", parse: "json", params: { output: { downstream: "ran" } }, assign: { downstream: "$.downstream" } },
    },
  };
}

function foreachConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "Socket-1",
        sockets: {
          "Socket-1": {
            materia: "Seed-Items",
            edges: [{ when: 'always', to: 'Socket-2' }],
          },
          "Socket-2": {
            materia: "Build",
            parse: "json",
            foreach: { items: "state.items", as: "workItem", cursor: "itemCursor", done: "end" },
            advance: { cursor: "itemCursor", items: "state.items", when: "satisfied", done: "end" },
            edges: [{ when: 'always', to: 'Socket-2' }],
            limits: { maxVisits: 5 },
          },
        },
      },
    },
    materia: { "Seed-Items": { type: "utility", utility: "echo", parse: "json", params: { output: { items: [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta" }] } }, assign: { items: "$.items" } }, Build: { tools: "coding", prompt: "Build materia" } },
  };
}

function promptMessages(harness: FakePiHarness): any[] {
  return harness.sentMessages.map(({ message }) => message as any).filter((message) => message.customType === "pi-materia-prompt");
}

function latestCastState(harness: FakePiHarness): any {
  return harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
}

function expectJsonRepairRetryPrompt(prompt: string | undefined, expected: { error: string; excerpt: string; omitted?: string }) {
  expect(typeof prompt).toBe("string");
  const promptText = prompt ?? "";
  expect(promptText).toMatch(/previous (final )?(JSON|handoff).*invalid|invalid (JSON|handoff|envelope)/i);
  expect(promptText).toContain(expected.error);
  expect(promptText).toMatch(/return only corrected JSON|return only JSON/i);
  expect(promptText).toContain(expected.excerpt);
  if (expected.omitted) expect(promptText).not.toContain(expected.omitted);
}

describe("native same-socket recovery", () => {
  test("context-window assistant errors retry the same active socket without a new socket start", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast recover me");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "context window exceeded" });
    await harness.emit("agent_end", { messages: [] });

    const triggerTurnsAfter = harness.operationLog.filter((op) => op === "triggerTurn").length;
    expect(triggerTurnsAfter).toBe(triggerTurnsBefore + 1);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.currentSocketId).toBe("Socket-1");
    expect(latestState.visits).toEqual({ "Socket-1": 1 });
    expect(latestState.recoveryAttempts).toBeDefined();

    const events = await readEvents(harness);
    expect(events.filter((event) => event.type === "socket_start")).toHaveLength(1);
    expect(events.some((event) => event.type === "same_socket_recovery_start" && event.data.reason === "context_window" && event.data.mode === "normal")).toBe(true);
    expect(events.some((event) => event.type === "same_socket_recovery_retry")).toBe(true);
  });

  test("Codex context_length_exceeded websocket errors retry the same active socket", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast codex websocket context length");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    const errorMessage = CODEX_CONTEXT_LENGTH_SAMPLE;
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage });
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog.filter((op) => op === "triggerTurn").length).toBe(triggerTurnsBefore + 1);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage });
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog.filter((op) => op === "triggerTurn").length).toBe(triggerTurnsBefore + 2);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(1);
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.currentSocketId).toBe("Socket-1");
    expect(latestState.visits).toEqual({ "Socket-1": 1 });

    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "same_socket_recovery_start" && event.data.reason === "context_window" && event.data.error.includes(errorMessage))).toBe(true);
    expect(events.some((event) => event.type === "same_socket_recovery_retry")).toBe(true);
  });

  test("Codex server_error assistant errors never trigger compaction or context-window recovery", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast codex server error");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: CODEX_SERVER_ERROR_SAMPLE });
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog.filter((op) => op === "triggerTurn").length).toBe(triggerTurnsBefore);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    const latestState = latestCastState(harness);
    expect(latestState.active).toBe(false);
    expect(latestState.failedReason).toContain("server_error");

    const events = await readEvents(harness);
    expect(events.filter((event) => event.type === "context_window_recovery_decision")).toHaveLength(0);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
  });

  test("agent_end failures without assistant output retry the same active socket", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast no assistant");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    await harness.emit("agent_end", { errorMessage: "maximum tokens exceeded before response" });

    expect(harness.operationLog.filter((op) => op === "triggerTurn").length).toBe(triggerTurnsBefore + 1);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.visits).toEqual({ "Socket-1": 1 });
  });

  test("plain WebSocket agent_end failures preserve awaiting state without retrying", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast websocket blip");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    await harness.emit("agent_end", { errorMessage: "WebSocket error" });

    expect(harness.operationLog.filter((op) => op === "triggerTurn").length).toBe(triggerTurnsBefore);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.socketState).toBe("awaiting_agent_response");
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.visits).toEqual({ "Socket-1": 1 });
    expect(harness.notifications.some((notification) => notification.type === "warning" && notification.message.includes("Transient transport failure"))).toBe(true);

    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "transient_transport_turn_failure" && event.data.warning === true && event.data.error.includes("WebSocket error"))).toBe(true);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
    expect(events.filter((event) => event.type === "cast_end")).toHaveLength(0);
  });

  test("plain WebSocket assistant error entries are ignored and later success completes the same socket", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast websocket assistant blip");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    const transientEntry = harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "WebSocket error" });
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog.filter((op) => op === "triggerTurn").length).toBe(triggerTurnsBefore);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    let latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.socketState).toBe("awaiting_agent_response");
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.lastProcessedEntryId).toBe(transientEntry.id);

    const successEntry = harness.appendAssistantMessage("done after websocket blip");
    await harness.emit("agent_end", { messages: [] });

    latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(false);
    expect(latestState.awaitingResponse).toBe(false);
    expect(latestState.socketState).toBe("complete");
    expect(latestState.lastProcessedEntryId).toBe(successEntry.id);
    expect(latestState.lastAssistantText).toBe("done after websocket blip");
    expect(latestState.failedReason).toBeUndefined();

    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "transient_transport_turn_failure" && event.data.entryId === transientEntry.id)).toBe(true);
    expect(events.some((event) => event.type === "socket_complete" && event.data.entryId === successEntry.id && event.data.socket === "Socket-1")).toBe(true);
    expect(events.some((event) => event.type === "cast_end" && event.data.ok === true && event.data.entryId === successEntry.id)).toBe(true);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
  });

  test("stream-ended agent_end failures preserve awaiting state without retrying", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast stream ended blip");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    await harness.emit("agent_end", { errorMessage: "Stream ended without finish_reason" });

    expect(harness.operationLog.filter((op) => op === "triggerTurn").length).toBe(triggerTurnsBefore);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.socketState).toBe("awaiting_agent_response");
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.visits).toEqual({ "Socket-1": 1 });
    expect(harness.notifications.some((notification) => notification.type === "warning" && notification.message.includes("Transient transport failure"))).toBe(true);

    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "transient_transport_turn_failure" && event.data.warning === true && event.data.error.includes("Stream ended without finish_reason"))).toBe(true);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
    expect(events.filter((event) => event.type === "cast_end")).toHaveLength(0);
  });

  test("stream-ended agent_end failure preserves state and later success completes normally", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast stream ended agent end success");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    // First agent_end fails with stream-ended error (no assistant message produced)
    await harness.emit("agent_end", { errorMessage: "Stream ended without finish_reason" });

    // No retry or compaction — the failure is transient transport
    expect(harness.operationLog.filter((op) => op === "triggerTurn").length).toBe(triggerTurnsBefore);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    let latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.socketState).toBe("awaiting_agent_response");
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.runState.endedAt).toBeUndefined();
    expect(latestState.visits).toEqual({ "Socket-1": 1 });
    expect(harness.notifications.some((notification) => notification.type === "warning" && notification.message.includes("Transient transport failure"))).toBe(true);

    // Later Pi retries and the assistant responds successfully
    const successEntry = harness.appendAssistantMessage("done after stream ended agent-end blip");
    await harness.emit("agent_end", { messages: [] });

    // Cast completes normally — no failed state leaked
    latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(false);
    expect(latestState.awaitingResponse).toBe(false);
    expect(latestState.socketState).toBe("complete");
    expect(latestState.phase).toBe("complete");
    expect(latestState.lastProcessedEntryId).toBe(successEntry.id);
    expect(latestState.lastAssistantText).toBe("done after stream ended agent-end blip");
    expect(latestState.failedReason).toBeUndefined();

    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "transient_transport_turn_failure" && event.data.warning === true && event.data.error.includes("Stream ended without finish_reason"))).toBe(true);
    expect(events.some((event) => event.type === "socket_complete" && event.data.entryId === successEntry.id && event.data.socket === "Socket-1")).toBe(true);
    expect(events.some((event) => event.type === "cast_end" && event.data.ok === true && event.data.entryId === successEntry.id)).toBe(true);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
    // No failed cast_end leaked through
    expect(events.filter((event) => event.type === "cast_end" && event.data.ok === false)).toHaveLength(0);
  });

  test("stream-ended assistant error entries are ignored and later success completes normally", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast stream ended assistant blip");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    const transientEntry = harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "Stream ended without finish_reason" });
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog.filter((op) => op === "triggerTurn").length).toBe(triggerTurnsBefore);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    let latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.socketState).toBe("awaiting_agent_response");
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.lastProcessedEntryId).toBe(transientEntry.id);
    expect(latestState.runState.endedAt).toBeUndefined();

    // Later assistant success completes normally — no failed cast state leaked
    const successEntry = harness.appendAssistantMessage("done after stream blip");
    await harness.emit("agent_end", { messages: [] });

    latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(false);
    expect(latestState.awaitingResponse).toBe(false);
    expect(latestState.socketState).toBe("complete");
    expect(latestState.phase).toBe("complete");
    expect(latestState.lastProcessedEntryId).toBe(successEntry.id);
    expect(latestState.lastAssistantText).toBe("done after stream blip");
    expect(latestState.failedReason).toBeUndefined();

    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "transient_transport_turn_failure" && event.data.entryId === transientEntry.id)).toBe(true);
    expect(events.some((event) => event.type === "socket_complete" && event.data.entryId === successEntry.id && event.data.socket === "Socket-1")).toBe(true);
    expect(events.some((event) => event.type === "cast_end" && event.data.ok === true && event.data.entryId === successEntry.id)).toBe(true);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
    // No failed manifest entries leaked through
    expect(events.filter((event) => event.type === "cast_end" && event.data.ok === false)).toHaveLength(0);
  });

  test("provider-ish assistant errors retry once without compaction and can then succeed", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast provider blip");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "provider auth failed" });
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog.filter((op) => op === "triggerTurn").length).toBe(triggerTurnsBefore + 1);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    let latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.visits).toEqual({ "Socket-1": 1 });

    harness.appendAssistantMessage("done after provider blip");
    await harness.emit("agent_end", { messages: [] });

    latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(false);
    expect(latestState.socketState).toBe("complete");
    expect(latestState.lastAssistantText).toBe("done after provider blip");
    const events = await readEvents(harness);
    expect(events.filter((event) => event.type === "socket_start")).toHaveLength(1);
    expect(events.some((event) => event.type === "same_socket_recovery_start" && event.data.reason === "turn_failure")).toBe(true);
    expect(events.some((event) => event.type === "same_socket_recovery_retry" && event.data.reason === "turn_failure")).toBe(true);
  });

  test("agent_end failures without assistant output retry once without compaction and can then succeed", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast invalid request retry");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    await harness.emit("agent_end", { errorMessage: "invalid_request_error: provider rejected request" });

    expect(harness.operationLog.filter((op) => op === "triggerTurn").length).toBe(triggerTurnsBefore + 1);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    let latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.visits).toEqual({ "Socket-1": 1 });

    harness.appendAssistantMessage("done after no-output failure");
    await harness.emit("agent_end", { messages: [] });

    latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(false);
    expect(latestState.socketState).toBe("complete");
    const events = await readEvents(harness);
    expect(events.filter((event) => event.type === "socket_start")).toHaveLength(1);
    expect(events.some((event) => event.type === "same_socket_recovery_start" && event.data.reason === "turn_failure")).toBe(true);
  });

  test("invalid JSON from an agent retries before graph advancement and can then succeed", async () => {
    const harness = await makeHarness(jsonAgentWithDownstreamConfig());
    await harness.runCommand("materia", "cast invalid json retry");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;
    const invalidOutput = `{ not json ${"x".repeat(700)} OMITTED_TAIL`;

    harness.appendAssistantMessage(invalidOutput);
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog.filter((op) => op === "triggerTurn").length).toBe(triggerTurnsBefore + 1);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    let latestState = latestCastState(harness);
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.currentSocketId).toBe("Socket-1");
    expect(latestState.data.result).toBeUndefined();
    expect(latestState.data.downstream).toBeUndefined();
    expect(latestState.lastJson).toBeUndefined();
    expect(latestState.visits).toEqual({ "Socket-1": 1 });

    let events = await readEvents(harness);
    expect(events.filter((event) => event.type === "socket_complete")).toHaveLength(0);
    expect(events.filter((event) => event.type === "socket_start" && event.data.socket === "Socket-2")).toHaveLength(0);
    const recoveryStart = events.find((event) => event.type === "same_socket_recovery_start");
    expect(recoveryStart?.data).toMatchObject({ recoveryKind: "json_output_repair", validationKind: "json_parse", failureCategory: "malformed_syntax", strategy: "direct_json", finalizationAttempt: 1, excerptLength: 630, excerptTruncated: true, attempt: 1, maxAttempts: 1, socket: "Socket-1" });
    expect(recoveryStart?.data).not.toHaveProperty("invalidOutputExcerpt");
    expect(recoveryStart?.data).not.toHaveProperty("error");
    expect(latestState.runState.lastMessage).toContain("previous JSON output was invalid");
    expect(harness.notifications.some((notification) => notification.type === "warning" && notification.message.includes("previous JSON output was invalid"))).toBe(true);
    expectJsonRepairRetryPrompt(promptMessages(harness).at(-1)?.content, {
      error: "Malformed JSON syntax at $.",
      excerpt: "{ not json",
      omitted: "OMITTED_TAIL",
    });

    harness.appendAssistantMessage('{"context":"ok"}');
    await harness.emit("agent_end", { messages: [] });

    latestState = latestCastState(harness);
    expect(latestState.active).toBe(false);
    expect(latestState.data.result).toBe("ok");
    expect(latestState.data.downstream).toBe("ran");
    expect(latestState.visits).toEqual({ "Socket-1": 1, "Socket-2": 1 });
    events = await readEvents(harness);
    expect(events.filter((event) => event.type === "socket_start" && event.data.socket === "Socket-1")).toHaveLength(1);
    expect(events.filter((event) => event.type === "socket_start" && event.data.socket === "Socket-2")).toHaveLength(1);
    expect(events.filter((event) => event.type === "socket_complete" && event.data.socket === "Socket-1")).toHaveLength(1);
    expect(events.filter((event) => event.type === "socket_complete" && event.data.socket === "Socket-2")).toHaveLength(1);
    expect(events.some((event) => event.type === "same_socket_recovery_start" && event.data.failureCategory === "malformed_syntax" && event.data.strategy === "direct_json")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("{ not json");
    expect(events.some((event) => event.type === "same_socket_recovery_retry" && event.data.recoveryKind === "json_output_repair" && event.data.validationKind === "json_parse" && event.data.excerptLength === 630)).toBe(true);
  });

  test("handoff validation failures from an agent retry before graph advancement", async () => {
    const harness = await makeHarness(satisfiedRouteAgentConfig());
    await harness.runCommand("materia", "cast handoff validation retry");

    harness.appendAssistantMessage('{"satisfied":"yes","result":"invalid control"}');
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(2);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    let latestState = latestCastState(harness);
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.currentSocketId).toBe("Socket-1");
    expect(latestState.data.result).toBeUndefined();
    expect(latestState.data.downstream).toBeUndefined();
    expect(latestState.lastJson).toBeUndefined();
    expect(latestState.visits).toEqual({ "Socket-1": 1 });
    let events = await readEvents(harness);
    expect(events.filter((event) => event.type === "socket_complete")).toHaveLength(0);
    expect(events.filter((event) => event.type === "socket_start" && event.data.socket === "Socket-2")).toHaveLength(0);
    const recoveryStart = events.find((event) => event.type === "same_socket_recovery_start");
    expect(recoveryStart?.data).toMatchObject({
      strategy: "direct_json",
      failureCategory: "contract_violation",
      validationKind: "handoff_validation",
      attempt: 1,
      finalizationAttempt: 1,
    });
    expect(recoveryStart?.data).not.toHaveProperty("error");
    expectJsonRepairRetryPrompt(promptMessages(harness).at(-1)?.content, {
      error: "Reserved field \"satisfied\" at $.satisfied must be a boolean",
      excerpt: '{"satisfied":"yes"',
    });

    harness.appendAssistantMessage('{"satisfied":true,"context":"ok"}');
    await harness.emit("agent_end", { messages: [] });

    latestState = latestCastState(harness);
    expect(latestState.active).toBe(false);
    expect(latestState.data.result).toBe("ok");
    expect(latestState.data.downstream).toBe("ran");
    expect(latestState.visits).toEqual({ "Socket-1": 1, "Socket-2": 1 });
    events = await readEvents(harness);
    expect(events.filter((event) => event.type === "socket_start" && event.data.socket === "Socket-1")).toHaveLength(1);
    expect(events.filter((event) => event.type === "socket_start" && event.data.socket === "Socket-2")).toHaveLength(1);
    expect(events.filter((event) => event.type === "socket_complete" && event.data.socket === "Socket-1")).toHaveLength(1);
  });

  test("missing required satisfied handoff field retries without advancing satisfied/not_satisfied routes", async () => {
    const harness = await makeHarness(satisfiedRouteAgentConfig());
    await harness.runCommand("materia", "cast missing satisfied retry");

    harness.appendAssistantMessage('{"result":"missing control"}');
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(2);
    const latestState = latestCastState(harness);
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.currentSocketId).toBe("Socket-1");
    expect(latestState.data.result).toBeUndefined();
    expect(latestState.data.downstream).toBeUndefined();
    expect(latestState.lastJson).toBeUndefined();
    expect(latestState.visits).toEqual({ "Socket-1": 1 });
    const events = await readEvents(harness);
    expect(events.filter((event) => event.type === "socket_complete")).toHaveLength(0);
    expect(events.filter((event) => event.type === "socket_start" && event.data.socket === "Socket-2")).toHaveLength(0);
    expectJsonRepairRetryPrompt(promptMessages(harness).at(-1)?.content, {
      error: "Missing required reserved field \"satisfied\" at $.satisfied",
      excerpt: '{"result":"missing control"}',
    });
  });

  test("utility socket output validation failures fail fast without generic retry", async () => {
    const harness = await makeHarness(utilityJsonConfig());
    await harness.runCommand("materia", "cast utility json fail");

    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(0);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    let latestState = latestCastState(harness);
    expect(latestState.active).toBe(false);
    expect(latestState.socketState).toBe("failed");
    expect(latestState.failedReason).toContain("Pre-commit output validation failed");
    let events = await readEvents(harness);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);

    const handoffHarness = await makeHarness(utilityHandoffValidationConfig());
    await handoffHarness.runCommand("materia", "cast utility handoff fail");

    expect(handoffHarness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(0);
    expect(handoffHarness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    latestState = latestCastState(handoffHarness);
    expect(latestState.active).toBe(false);
    expect(latestState.socketState).toBe("failed");
    expect(latestState.failedReason).toContain("Reserved field \"satisfied\" at $.satisfied must be a boolean");
    events = await readEvents(handoffHarness);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
  });

  test("post-advance lifecycle failures are not retried after assignments apply", async () => {
    const harness = await makeHarness(budgetFailingAgentConfig());
    await harness.runCommand("materia", "cast unsafe post advance");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    harness.appendAssistantMessage('{"context":"applied"}');
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog.filter((op) => op === "triggerTurn").length).toBe(triggerTurnsBefore);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(false);
    expect(latestState.socketState).toBe("failed");
    expect(latestState.data.result).toBe("applied");
    expect(latestState.failedReason).toContain("pi-materia budget limit reached");
    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "socket_complete" && event.data.socket === "Socket-1")).toBe(true);
    expect(events.some((event) => event.type === "budget_limit")).toBe(true);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
  });

  test("forced compaction failure is recorded and fails clearly", async () => {
    const harness = await makeHarness(singleAgentConfig());
    harness.contextUsage = { tokens: 900, contextWindow: 1000, percent: 90 };
    harness.compactError = new Error("compaction provider unavailable");
    await harness.runCommand("materia", "cast compact fail");

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "context window exceeded" });
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog).toContain("compact");
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(1);
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(false);
    expect(latestState.failedReason).toContain("Same-socket recovery action compact failed");
    expect(latestState.failedReason).toContain("compaction provider unavailable");
    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "same_socket_recovery_action_failed" && event.data.action === "compact")).toBe(true);
  });

  test("proactive compaction failures are warnings and later context-window recovery still retries", async () => {
    const harness = await makeHarness(singleAgentConfig());
    harness.contextUsage = { tokens: 900, contextWindow: 1000, percent: 90 };
    harness.compactError = new Error("proactive summarizer unavailable");

    await harness.runCommand("materia", "cast proactive warning");

    expect(harness.operationLog).toContain("compact");
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(1);
    let latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.currentSocketId).toBe("Socket-1");
    expect(latestState.visits).toEqual({ "Socket-1": 1 });
    expect(harness.notifications.some((notification) => notification.type === "warning" && notification.message.includes("Proactive compaction failed"))).toBe(true);

    harness.contextUsage = { tokens: 900, contextWindow: 1000, percent: 90 };
    harness.compactError = undefined;
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "context window exceeded" });
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(2);
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(2);
    latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.visits).toEqual({ "Socket-1": 1 });

    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "proactive_compaction_start" && event.data.action === "compact" && event.data.reason === "context_pressure")).toBe(true);
    expect(events.some((event) => event.type === "proactive_compaction_failed" && event.data.warning === true)).toBe(true);
    expect(events.some((event) => event.type === "same_socket_recovery_action_start" && event.data.action === "compact" && event.data.reason === "context_window")).toBe(true);
    expect(events.some((event) => event.type === "same_socket_recovery_action_complete" && event.data.action === "compact" && event.data.reason === "context_window")).toBe(true);
  });

  test("generic assistant error recovery exhausts deterministically with structured metadata", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast generic exhaust");

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "provider auth failed" });
    await harness.emit("agent_end", { messages: [] });
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "different provider failure" });
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(2);
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(false);
    expect(latestState.failedReason).toContain("Same-socket recovery exhausted");
    expect(latestState.recoveryExhaustion).toMatchObject({ kind: "same_socket_recovery_exhausted", reason: "turn_failure", socket: "Socket-1", attempts: 1, originalMaxAttempts: 1, effectiveMaxAttempts: 1, reviveCount: 0 });
    const events = await readEvents(harness);
    expect(events.filter((event) => event.type === "socket_start")).toHaveLength(1);
    expect(events.some((event) => event.type === "same_socket_recovery_exhausted" && event.data.reason === "turn_failure")).toBe(true);
  });

  test("recovery attempts are bounded and exhaustion fails clearly", async () => {
    const harness = await makeHarness(singleAgentConfig());
    harness.contextUsage = { tokens: 900, contextWindow: 1000, percent: 90 };
    await harness.runCommand("materia", "cast exhaust me");

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "context length exceeded" });
    await harness.emit("agent_end", { messages: [] });
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "context length exceeded again" });
    await harness.emit("agent_end", { messages: [] });

    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(false);
    expect(latestState.failedReason).toContain("Same-socket recovery exhausted");
    expect(latestState.visits).toEqual({ "Socket-1": 1 });
    expect(latestState.recoveryExhaustion).toMatchObject({ kind: "same_socket_recovery_exhausted", reason: "context_window", socket: "Socket-1", attempts: 1, originalMaxAttempts: 1, effectiveMaxAttempts: 1, reviveCount: 0 });
    expect(latestState.recoveryAllowances[latestState.recoveryExhaustion.key]).toEqual({ originalMaxAttempts: 1, effectiveMaxAttempts: 1, reviveCount: 0 });
    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "same_socket_recovery_exhausted" && event.data.originalMaxAttempts === 1 && event.data.effectiveMaxAttempts === 1)).toBe(true);
  });

  test("revive allowance extension is scoped and grows linearly", async () => {
    const harness = await makeHarness(singleAgentConfig());
    harness.contextUsage = { tokens: 900, contextWindow: 1000, percent: 90 };
    await harness.runCommand("materia", "cast revive math");

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "context length exceeded" });
    await harness.emit("agent_end", { messages: [] });
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "context length exceeded again" });
    await harness.emit("agent_end", { messages: [] });

    const state = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    const exhaustedKey = state.recoveryExhaustion.key;
    state.recoveryAllowances.other = { originalMaxAttempts: 3, effectiveMaxAttempts: 3, reviveCount: 0 };

    expect(extendSameSocketRecoveryAllowanceForRevive(state)).toMatchObject({ key: exhaustedKey, priorEffectiveMaxAttempts: 1, increment: 1, newEffectiveMaxAttempts: 2, reviveCount: 1 });
    expect(extendSameSocketRecoveryAllowanceForRevive(state)).toMatchObject({ key: exhaustedKey, priorEffectiveMaxAttempts: 2, increment: 1, newEffectiveMaxAttempts: 3, reviveCount: 2 });
    expect(state.recoveryAllowances[exhaustedKey]).toEqual({ originalMaxAttempts: 1, effectiveMaxAttempts: 3, reviveCount: 2 });
    expect(state.recoveryAllowances.other).toEqual({ originalMaxAttempts: 3, effectiveMaxAttempts: 3, reviveCount: 0 });
  });

  test("revive allowance extension rejects stale exhaustion metadata after a later non-exhaustion failure", async () => {
    const harness = await makeHarness(singleAgentConfig());
    harness.contextUsage = { tokens: 900, contextWindow: 1000, percent: 90 };
    await harness.runCommand("materia", "cast revive stale guard");

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "context length exceeded" });
    await harness.emit("agent_end", { messages: [] });
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "context length exceeded again" });
    await harness.emit("agent_end", { messages: [] });

    const state = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    const staleExhaustion = { ...state.recoveryExhaustion };
    expect(extendSameSocketRecoveryAllowanceForRevive(state).newEffectiveMaxAttempts).toBe(2);

    state.recoveryExhaustion = staleExhaustion;
    state.failedReason = "Non-recoverable turn failure for normal turn for socket \\\"Socket-1\\\": provider auth failed";
    expect(() => extendSameSocketRecoveryAllowanceForRevive(state)).toThrow(/does not match the current terminal failure/);
  });

  test("tool timeout revive grants budget-sized increment using originalMaxAttempts", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast timeout revive budget");

    // Exhaust the 3-attempt timeout budget
    for (let i = 0; i < 4; i++) {
      harness.appendAssistantMessage("", { stopReason: "error", errorMessage: `bash command timed out ${i}` });
      await harness.emit("agent_end", { messages: [] });
    }

    const state = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(state.active).toBe(false);
    expect(state.recoveryExhaustion.reason).toBe("tool_timeout");
    expect(state.recoveryExhaustion.originalMaxAttempts).toBe(3);
    const exhaustedKey = state.recoveryExhaustion.key;

    // Revive should add originalMaxAttempts (3) more attempts
    expect(extendSameSocketRecoveryAllowanceForRevive(state)).toMatchObject({
      key: exhaustedKey,
      priorEffectiveMaxAttempts: 3,
      increment: 3,
      newEffectiveMaxAttempts: 6,
      reviveCount: 1,
    });
    expect(state.recoveryAllowances[exhaustedKey]).toEqual({ originalMaxAttempts: 3, effectiveMaxAttempts: 6, reviveCount: 1 });
  });

  test("revive allowance extension rejects legacy or non-exhaustion failures", async () => {
    const harness = await makeHarness(utilityJsonConfig());
    await harness.runCommand("materia", "cast non exhaustion revive reject");

    const state = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(state.failedReason).toContain("Pre-commit output validation failed");
    expect(() => extendSameSocketRecoveryAllowanceForRevive(state)).toThrow(/missing structured same-socket recovery exhaustion metadata/);

    const legacy = { ...state, failedReason: "Same-socket recovery exhausted for socket", recoveryExhaustion: undefined };
    expect(() => extendSameSocketRecoveryAllowanceForRevive(legacy)).toThrow(/missing structured same-socket recovery exhaustion metadata/);
  });

  test("multi-turn refinement context-window failures compact and regenerate a refinement retry prompt", async () => {
    const harness = await makeHarness(multiTurnConfig());
    await harness.runCommand("materia", "cast refine recovery");
    harness.appendAssistantMessage("Draft plan; please clarify scope.");
    await harness.emit("agent_end", { messages: [] });
    harness.appendUserMessage("Include tests and docs.");
    await harness.emit("before_agent_start", { systemPrompt: "Base system" });
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;
    harness.contextUsage = { tokens: 900, contextWindow: 1000, percent: 90 };

    harness.appendAssistantMessage("partial stale output", { stopReason: "error", errorMessage: "maximum context length exceeded" });
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(1);
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(triggerTurnsBefore + 1);
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.socketState).toBe("awaiting_agent_response");
    expect(latestState.currentSocketId).toBe("Socket-1");
    expect(latestState.multiTurnFinalizing).toBe(false);
    expect(latestState.multiTurnRefinements).toEqual({ '["Socket-1","__singleton__",1]': 1 });
    expect(latestState.visits).toEqual({ "Socket-1": 1 });
    const retryPrompt = promptMessages(harness).at(-1)?.content;
    expect(retryPrompt).toContain("Current multi-turn mode: refinement conversation");
    expect(retryPrompt).toContain("Previous output:\nDraft plan; please clarify scope.");
    expect(retryPrompt).not.toContain("partial stale output");
    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "same_socket_recovery_start" && event.data.mode === "refinement" && event.data.reason === "context_window")).toBe(true);
  });

  test("multi-turn finalization context-window failures compact and retry finalization without advancing", async () => {
    const harness = await makeHarness(multiTurnConfig());
    await harness.runCommand("materia", "cast finalize recovery");
    harness.appendAssistantMessage("Draft plan; ready to finalize.");
    await harness.emit("agent_end", { messages: [] });
    await harness.runCommand("materia", "continue");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;
    harness.contextUsage = { tokens: 900, contextWindow: 1000, percent: 90 };

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "context window exceeded during final JSON" });
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(1);
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(triggerTurnsBefore + 1);
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.currentSocketId).toBe("Socket-1");
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.multiTurnFinalizing).toBe(true);
    expect(latestState.data.tasks).toBeUndefined();
    expect(latestState.visits).toEqual({ "Socket-1": 1 });
    const retryPrompt = promptMessages(harness).at(-1)?.content;
    expect(retryPrompt).toContain("Command-triggered finalization");
    expect(retryPrompt).toContain("Return only one top-level JSON object");
    // The synthetic cast context is prepended by buildIsolatedMateriaContext on
    // every isolated turn, not embedded in the raw repair prompt for multi-turn
    // finalization. "Previous output" is absent from the synthetic context in
    // this recovery path because the error response overwrites lastAssistantText
    // before recovery runs, so the state no longer carries the prior turn's text.
    // Verify the synthetic context structure is otherwise correct.
    const syntheticContext = buildSyntheticCastContext(latestState);
    expect(syntheticContext).toContain("Canonical handoff contract context:");
    expect(syntheticContext).toContain("Cast id:");
    expect(syntheticContext).toContain("Current socket: Socket-1");
    expect(syntheticContext).toContain("Current materia: Plan");
    expect(syntheticContext).not.toContain("Previous output:");
    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "same_socket_recovery_start" && event.data.mode === "finalization" && event.data.reason === "context_window")).toBe(true);
  });

  test("foreach context-window recovery preserves cursor and avoids duplicate socket start", async () => {
    const harness = await makeHarness(foreachConfig());
    harness.contextUsage = { tokens: 900, contextWindow: 1000, percent: 90 };
    await harness.runCommand("materia", "cast foreach recovery");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "token limit exceeded" });
    await harness.emit("agent_end", { messages: [] });

    let latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(triggerTurnsBefore + 1);
    expect(harness.operationLog).toContain("compact");
    expect(latestState.active).toBe(true);
    expect(latestState.currentSocketId).toBe("Socket-2");
    expect(latestState.currentItemKey).toBe("WI-1");
    expect(latestState.currentItemLabel).toBe("Alpha");
    expect(latestState.cursors).toEqual({ itemCursor: 0 });
    expect(latestState.visits).toEqual({ "Socket-1": 1, "Socket-2": 1 });
    expect(latestState.taskAttempts).toEqual({ '["Socket-1","__singleton__"]': 1, '["Socket-2","WI-1"]': 1 });
    expect(latestState.recoveryAttempts).toBeDefined();
    const socketStartsBeforeCompletion = (await readEvents(harness)).filter((event) => event.type === "socket_start" && event.data.socket === "Socket-2");
    expect(socketStartsBeforeCompletion).toHaveLength(1);

    harness.appendAssistantMessage('{"satisfied":true}');
    await harness.emit("agent_end", { messages: [] });
    latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.currentSocketId).toBe("Socket-2");
    expect(latestState.currentItemKey).toBe("WI-2");
    expect(latestState.currentItemLabel).toBe("Beta");
    expect(latestState.cursors).toEqual({ itemCursor: 1 });
    expect(latestState.visits).toEqual({ "Socket-1": 1, "Socket-2": 2 });
  });

  test("tool timeout assistant errors retry the same active socket as tool_timeout", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast tool timeout recovery");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "bash command timed out after 120 seconds" });
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog.filter((op) => op === "triggerTurn").length).toBe(triggerTurnsBefore + 1);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.currentSocketId).toBe("Socket-1");
    expect(latestState.visits).toEqual({ "Socket-1": 1 });
    expect(latestState.recoveryAttempts).toBeDefined();

    const events = await readEvents(harness);
    expect(events.filter((event) => event.type === "socket_start")).toHaveLength(1);
    expect(events.some((event) => event.type === "same_socket_recovery_start" && event.data.reason === "tool_timeout" && event.data.mode === "normal")).toBe(true);
    expect(events.some((event) => event.type === "same_socket_recovery_retry" && event.data.reason === "tool_timeout")).toBe(true);
    expect(harness.notifications.some((notification) => notification.type === "warning" && notification.message.includes("tool timeout"))).toBe(true);
  });

  test("tool timeout agent_end failures retry and can succeed", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast tool timeout retry");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    await harness.emit("agent_end", { errorMessage: "Command timed out after 180 seconds" });

    expect(harness.operationLog.filter((op) => op === "triggerTurn").length).toBe(triggerTurnsBefore + 1);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    let latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.visits).toEqual({ "Socket-1": 1 });

    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "same_socket_recovery_start" && event.data.reason === "tool_timeout")).toBe(true);

    // Can succeed on retry
    harness.appendAssistantMessage("done after timeout");
    await harness.emit("agent_end", { messages: [] });

    latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(false);
    expect(latestState.socketState).toBe("complete");
    expect(latestState.lastAssistantText).toBe("done after timeout");
  });

  test("tool timeout recovery exhausts with structured metadata after timeout-specific budget", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast tool timeout exhaust");

    // Budget is 3 for tool_timeout; need 3 retries before exhaustion
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "bash command timed out" });
    await harness.emit("agent_end", { messages: [] });
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "tool call timed out again" });
    await harness.emit("agent_end", { messages: [] });
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "command timed out third" });
    await harness.emit("agent_end", { messages: [] });
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "command timed out fourth" });
    await harness.emit("agent_end", { messages: [] });

    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(false);
    expect(latestState.failedReason).toContain("Same-socket recovery exhausted");
    expect(latestState.recoveryExhaustion).toMatchObject({ kind: "same_socket_recovery_exhausted", reason: "tool_timeout", socket: "Socket-1", attempts: 3, originalMaxAttempts: 3, effectiveMaxAttempts: 3, reviveCount: 0 });

    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "same_socket_recovery_exhausted" && event.data.reason === "tool_timeout" && event.data.originalMaxAttempts === 3 && event.data.effectiveMaxAttempts === 3)).toBe(true);
    expect(events.filter((event) => event.type === "same_socket_recovery_start" && event.data.reason === "tool_timeout")).toHaveLength(3);
  });

  test("tool timeout recovery prompt includes persistent timeout hint with duration", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast timeout hint persistence");

    // First timeout triggers recovery with hint
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "bash command timed out after 180 seconds" });
    await harness.emit("agent_end", { messages: [] });

    let prompt = promptMessages(harness).at(-1)?.content;
    expect(prompt).toContain("TIMEOUT RECOVERY HINT");
    expect(prompt).toContain("after 180s");
    expect(prompt).toContain("Do NOT repeat");
    expect(prompt).toContain("one-shot commands");

    // Second timeout retry preserves the hint with original duration
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "command timed out again" });
    await harness.emit("agent_end", { messages: [] });

    prompt = promptMessages(harness).at(-1)?.content;
    expect(prompt).toContain("TIMEOUT RECOVERY HINT");
    expect(prompt).toContain("after 180s"); // original duration preserved
    expect(prompt).toContain("retry #2");

    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.recoveryReasons).toBeDefined();
    expect(latestState.recoveryErrorMessages).toBeDefined();
  });

  test("non-timeout recovery prompts do not include timeout hint", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast context no timeout hint");

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "context window exceeded" });
    await harness.emit("agent_end", { messages: [] });

    const prompt = promptMessages(harness).at(-1)?.content;
    expect(prompt).not.toContain("TIMEOUT RECOVERY HINT");
  });

  test("timeout revive preserves metadata and injects hint on subsequent retries", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast timeout revive hint");

    // Exhaust the 3-attempt timeout budget
    for (let i = 0; i < 4; i++) {
      harness.appendAssistantMessage("", { stopReason: "error", errorMessage: `bash command timed out after 180 seconds (${i + 1})` });
      await harness.emit("agent_end", { messages: [] });
    }

    const exhausted = latestCastState(harness);
    expect(exhausted.active).toBe(false);
    expect(exhausted.recoveryExhaustion.reason).toBe("tool_timeout");
    const key = exhausted.recoveryExhaustion.key;

    // Verify metadata before revive
    expect(exhausted.recoveryReasons[key]).toBe("tool_timeout");
    expect(exhausted.recoveryErrorMessages[key]).toContain("timed out after 180 seconds");

    // Revive
    const reviveResult = extendSameSocketRecoveryAllowanceForRevive(exhausted);
    expect(reviveResult).toMatchObject({
      key,
      priorEffectiveMaxAttempts: 3,
      increment: 3,
      newEffectiveMaxAttempts: 6,
      reviveCount: 1,
    });

    // Metadata must survive revive
    expect(exhausted.recoveryReasons[key]).toBe("tool_timeout");
    expect(exhausted.recoveryErrorMessages[key]).toContain("timed out after 180 seconds");
    expect(exhausted.recoveryAllowances[key]).toEqual({ originalMaxAttempts: 3, effectiveMaxAttempts: 6, reviveCount: 1 });
  });

  test("timeout revive followed by additional timeout failure carries hint with original duration", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast timeout revive retry flow");

    // Exhaust the 3-attempt timeout budget
    for (let i = 0; i < 4; i++) {
      harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "bash command timed out after 120 seconds" });
      await harness.emit("agent_end", { messages: [] });
    }

    const exhausted = latestCastState(harness);
    expect(exhausted.active).toBe(false);
    const key = exhausted.recoveryExhaustion.key;

    // Revive to get 3 more attempts
    extendSameSocketRecoveryAllowanceForRevive(exhausted);

    // Simulate resume: reactivate the cast like resumeValidatedNativeCast does
    exhausted.recoveryExhaustion = undefined;
    exhausted.active = true;
    exhausted.failedReason = undefined;
    exhausted.awaitingResponse = true;
    exhausted.socketState = "awaiting_agent_response";
    harness.pi.appendEntry("pi-materia-cast-state", exhausted);

    // Trigger another timeout failure — should retry with preserved hint
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "bash command timed out again" });
    await harness.emit("agent_end", { messages: [] });

    const retried = latestCastState(harness);
    expect(retried.active).toBe(true);
    expect(retried.recoveryAttempts[key]).toBe(4); // 3 original + 1 new
    expect(retried.recoveryReasons[key]).toBe("tool_timeout");
    expect(retried.recoveryErrorMessages[key]).toContain("timed out after 120 seconds"); // original preserved

    const retryPrompt = promptMessages(harness).at(-1)?.content;
    expect(retryPrompt).toContain("TIMEOUT RECOVERY HINT");
    expect(retryPrompt).toContain("after 120s"); // original duration preserved
  });

  test("context-window revive uses originalMaxAttempts of 1 (regression guard)", async () => {
    const harness = await makeHarness(singleAgentConfig());
    harness.contextUsage = { tokens: 900, contextWindow: 1000, percent: 90 };
    await harness.runCommand("materia", "cast context-window revive regression");

    // Exhaust the 1-attempt context-window budget
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" });
    await harness.emit("agent_end", { messages: [] });
    // Compaction triggers but retry still fails
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "context window exceeded again" });
    await harness.emit("agent_end", { messages: [] });

    const state = latestCastState(harness);
    expect(state.active).toBe(false);
    const key = state.recoveryExhaustion.key;
    expect(state.recoveryAllowances[key].originalMaxAttempts).toBe(1);

    // Revive adds 1 more for context-window (not 3 like timeout)
    const result = extendSameSocketRecoveryAllowanceForRevive(state);
    expect(result).toMatchObject({
      key,
      priorEffectiveMaxAttempts: 1,
      increment: 1,
      newEffectiveMaxAttempts: 2,
      reviveCount: 1,
    });
  });
});
