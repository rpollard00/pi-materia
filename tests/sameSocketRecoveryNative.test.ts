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
  test("context-window assistant errors record inference interruption without retry or terminalization", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast recover me");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "context window exceeded" });
    await harness.emit("agent_end", { messages: [] });

    // No recovery retry — inference interruption preserves the socket
    const triggerTurnsAfter = harness.operationLog.filter((op) => op === "triggerTurn").length;
    expect(triggerTurnsAfter).toBe(triggerTurnsBefore);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.socketState).toBe("awaiting_agent_response");
    expect(latestState.currentSocketId).toBe("Socket-1");
    expect(latestState.visits).toEqual({ "Socket-1": 1 });
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.recoveryExhaustion).toBeUndefined();
    expect(latestState.inferenceInterruption).toBeDefined();
    expect(latestState.inferenceInterruption.error).toContain("context window exceeded");
    expect(latestState.inferenceInterruption.socket).toBe("Socket-1");

    const events = await readEvents(harness);
    expect(events.filter((event) => event.type === "socket_start")).toHaveLength(1);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
    expect(events.some((event) => event.type === "inference_interruption" && event.data.error.includes("context window exceeded"))).toBe(true);
  });

  test("Codex context_length_exceeded websocket errors record inference interruption", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast codex websocket context length");

    const errorMessage = CODEX_CONTEXT_LENGTH_SAMPLE;
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage });
    await harness.emit("agent_end", { messages: [] });

    // First error: inference interruption, socket stays alive
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(1);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    let latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.currentSocketId).toBe("Socket-1");
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.recoveryExhaustion).toBeUndefined();
    expect(latestState.inferenceInterruption).toBeDefined();
    expect(latestState.inferenceInterruption.error).toContain(errorMessage);

    // Second error overwrites interruption metadata (still not terminal)
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage });
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(1);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.recoveryExhaustion).toBeUndefined();

    const events = await readEvents(harness);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
    expect(events.filter((event) => event.type === "inference_interruption")).toHaveLength(2);
  });

  test("Codex server_error assistant errors record inference interruption without terminalization", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast codex server error");

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: CODEX_SERVER_ERROR_SAMPLE });
    await harness.emit("agent_end", { messages: [] });

    // No recovery, no terminalization — cast stays active
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(1);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    const latestState = latestCastState(harness);
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.socketState).toBe("awaiting_agent_response");
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.recoveryExhaustion).toBeUndefined();
    expect(latestState.inferenceInterruption).toBeDefined();
    expect(latestState.inferenceInterruption.error).toContain("server_error");

    const events = await readEvents(harness);
    expect(events.filter((event) => event.type === "context_window_recovery_decision")).toHaveLength(0);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
    expect(events.some((event) => event.type === "inference_interruption" && event.data.error.includes("server_error"))).toBe(true);
  });

  test("agent_end failures without assistant output record inference interruption without retry", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast no assistant");

    await harness.emit("agent_end", { errorMessage: "maximum tokens exceeded before response" });

    // No recovery retry — inference interruption preserves the socket
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(1);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.socketState).toBe("awaiting_agent_response");
    expect(latestState.visits).toEqual({ "Socket-1": 1 });
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.recoveryExhaustion).toBeUndefined();
    expect(latestState.inferenceInterruption).toBeDefined();
    expect(latestState.inferenceInterruption.error).toContain("maximum tokens exceeded before response");
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

  test("provider-ish assistant errors record inference interruption and later success completes", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast provider blip");

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "provider auth failed" });
    await harness.emit("agent_end", { messages: [] });

    // Inference interruption — no recovery retry
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(1);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    let latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.socketState).toBe("awaiting_agent_response");
    expect(latestState.visits).toEqual({ "Socket-1": 1 });
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.recoveryExhaustion).toBeUndefined();
    expect(latestState.inferenceInterruption).toBeDefined();
    expect(latestState.inferenceInterruption.error).toContain("provider auth failed");

    // Later success completes the socket normally
    harness.appendAssistantMessage("done after provider blip");
    await harness.emit("agent_end", { messages: [] });

    latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(false);
    expect(latestState.socketState).toBe("complete");
    expect(latestState.lastAssistantText).toBe("done after provider blip");
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.inferenceInterruption).toBeUndefined(); // cleared on success
    const events = await readEvents(harness);
    expect(events.filter((event) => event.type === "socket_start")).toHaveLength(1);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
    expect(events.some((event) => event.type === "inference_interruption" && event.data.error.includes("provider auth failed"))).toBe(true);
  });

  test("agent_end failures without assistant output record inference interruption and later success completes", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast invalid request retry");

    await harness.emit("agent_end", { errorMessage: "invalid_request_error: provider rejected request" });

    // Inference interruption — no recovery retry
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(1);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    let latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.socketState).toBe("awaiting_agent_response");
    expect(latestState.visits).toEqual({ "Socket-1": 1 });
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.recoveryExhaustion).toBeUndefined();
    expect(latestState.inferenceInterruption).toBeDefined();
    expect(latestState.inferenceInterruption.error).toContain("invalid_request_error");

    // Later success completes the socket normally
    harness.appendAssistantMessage("done after no-output failure");
    await harness.emit("agent_end", { messages: [] });

    latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(false);
    expect(latestState.socketState).toBe("complete");
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.inferenceInterruption).toBeUndefined(); // cleared on success
    const events = await readEvents(harness);
    expect(events.filter((event) => event.type === "socket_start")).toHaveLength(1);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
    expect(events.some((event) => event.type === "inference_interruption" && event.data.error.includes("invalid_request_error"))).toBe(true);
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

  test("forced compaction failure records inference interruption (not recovery attempt)", async () => {
    const harness = await makeHarness(singleAgentConfig());
    harness.contextUsage = { tokens: 900, contextWindow: 1000, percent: 90 };
    harness.compactError = new Error("compaction provider unavailable");
    await harness.runCommand("materia", "cast compact fail");

    // Proactive compaction fires at cast start (high context pressure)
    const compactionsBefore = harness.operationLog.filter((op) => op === "compact").length;
    expect(compactionsBefore).toBeGreaterThanOrEqual(1);

    // stopReason error → inference interruption, not recovery
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "context window exceeded" });
    await harness.emit("agent_end", { messages: [] });

    // No additional compaction from the recovery path (no recovery)
    expect(harness.operationLog.filter((op) => op === "compact").length).toBe(compactionsBefore);
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(1);
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.socketState).toBe("awaiting_agent_response");
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.inferenceInterruption).toBeDefined();
    expect(latestState.inferenceInterruption.error).toContain("context window exceeded");
    const events = await readEvents(harness);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
    expect(events.some((event) => event.type === "inference_interruption")).toBe(true);
  });

  test("proactive compaction warnings fire independently and inference interruption does not retry", async () => {
    const harness = await makeHarness(singleAgentConfig());
    harness.contextUsage = { tokens: 900, contextWindow: 1000, percent: 90 };
    harness.compactError = new Error("proactive summarizer unavailable");

    await harness.runCommand("materia", "cast proactive warning");

    // Proactive compaction fires at cast start
    expect(harness.operationLog).toContain("compact");
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(1);
    let latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.currentSocketId).toBe("Socket-1");
    expect(latestState.visits).toEqual({ "Socket-1": 1 });
    expect(harness.notifications.some((notification) => notification.type === "warning" && notification.message.includes("Proactive compaction failed"))).toBe(true);

    // Later stopReason error → inference interruption (not recovery)
    harness.contextUsage = { tokens: 900, contextWindow: 1000, percent: 90 };
    harness.compactError = undefined;
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "context window exceeded" });
    await harness.emit("agent_end", { messages: [] });

    // No additional compaction or recovery — just inference interruption
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(1); // still 1 (only the proactive one)
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(1); // no retry
    latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.inferenceInterruption).toBeDefined();

    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "proactive_compaction_start" && event.data.action === "compact" && event.data.reason === "context_pressure")).toBe(true);
    expect(events.some((event) => event.type === "proactive_compaction_failed" && event.data.warning === true)).toBe(true);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
    expect(events.some((event) => event.type === "inference_interruption")).toBe(true);
  });

  test("multiple stopReason errors record inference interruptions without exhaustion", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast generic exhaust");

    // Two successive provider inference failures
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "provider auth failed" });
    await harness.emit("agent_end", { messages: [] });
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "different provider failure" });
    await harness.emit("agent_end", { messages: [] });

    // No recovery or exhaustion — cast stays active
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(1);
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.socketState).toBe("awaiting_agent_response");
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.recoveryExhaustion).toBeUndefined();
    expect(latestState.recoveryAttempts).toBeUndefined();
    expect(latestState.inferenceInterruption).toBeDefined();
    expect(latestState.inferenceInterruption.error).toContain("different provider failure");
    const events = await readEvents(harness);
    expect(events.filter((event) => event.type === "socket_start")).toHaveLength(1);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
    expect(events.filter((event) => event.type === "inference_interruption")).toHaveLength(2);
  });

  test("multiple context-length errors record inference interruptions without exhaustion", async () => {
    const harness = await makeHarness(singleAgentConfig());
    harness.contextUsage = { tokens: 900, contextWindow: 1000, percent: 90 };
    await harness.runCommand("materia", "cast exhaust me");

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "context length exceeded" });
    await harness.emit("agent_end", { messages: [] });
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "context length exceeded again" });
    await harness.emit("agent_end", { messages: [] });

    // No recovery exhaustion — cast stays active
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.socketState).toBe("awaiting_agent_response");
    expect(latestState.visits).toEqual({ "Socket-1": 1 });
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.recoveryExhaustion).toBeUndefined();
    expect(latestState.recoveryAttempts).toBeUndefined();
    expect(latestState.recoveryAllowances).toBeUndefined();
    expect(latestState.inferenceInterruption).toBeDefined();
    expect(latestState.inferenceInterruption.error).toContain("context length exceeded again");
    const events = await readEvents(harness);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
    expect(events.filter((event) => event.type === "inference_interruption")).toHaveLength(2);
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

  test("multi-turn refinement context-window failures record inference interruption", async () => {
    const harness = await makeHarness(multiTurnConfig());
    await harness.runCommand("materia", "cast refine recovery");
    harness.appendAssistantMessage("Draft plan; please clarify scope.");
    await harness.emit("agent_end", { messages: [] });
    harness.appendUserMessage("Include tests and docs.");
    await harness.emit("before_agent_start", { systemPrompt: "Base system" });
    harness.contextUsage = { tokens: 900, contextWindow: 1000, percent: 90 };

    // stopReason error → inference interruption, not recovery
    harness.appendAssistantMessage("partial stale output", { stopReason: "error", errorMessage: "maximum context length exceeded" });
    await harness.emit("agent_end", { messages: [] });

    // No compaction or recovery — just inference interruption
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(1);
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.socketState).toBe("awaiting_agent_response");
    expect(latestState.currentSocketId).toBe("Socket-1");
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.recoveryExhaustion).toBeUndefined();
    expect(latestState.recoveryAttempts).toBeUndefined();
    expect(latestState.inferenceInterruption).toBeDefined();
    expect(latestState.inferenceInterruption.error).toContain("maximum context length exceeded");

    // Multi-turn state is preserved
    expect(latestState.multiTurnFinalizing).toBe(false);
    expect(latestState.multiTurnRefinements).toEqual({ '["Socket-1","__singleton__",1]': 1 });
    expect(latestState.visits).toEqual({ "Socket-1": 1 });

    const events = await readEvents(harness);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
    expect(events.some((event) => event.type === "inference_interruption" && event.data.mode === "refinement")).toBe(true);
  });

  
  test("multi-turn finalization context-window failures record inference interruption", async () => {
    const harness = await makeHarness(multiTurnConfig());
    await harness.runCommand("materia", "cast finalize recovery");
    harness.appendAssistantMessage("Draft plan; ready to finalize.");
    await harness.emit("agent_end", { messages: [] });
    await harness.runCommand("materia", "continue");
    harness.contextUsage = { tokens: 900, contextWindow: 1000, percent: 90 };

    // stopReason error → inference interruption, not recovery
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "context window exceeded during final JSON" });
    await harness.emit("agent_end", { messages: [] });

    // No compaction or recovery — just inference interruption
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    expect(harness.operationLog.filter((op) => op === "triggerTurn").length).toBeGreaterThanOrEqual(1);
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.socketState).toBe("awaiting_agent_response");
    expect(latestState.currentSocketId).toBe("Socket-1");
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.recoveryExhaustion).toBeUndefined();
    expect(latestState.inferenceInterruption).toBeDefined();
    expect(latestState.inferenceInterruption.error).toContain("context window exceeded during final JSON");

    // Finalization state is preserved
    expect(latestState.multiTurnFinalizing).toBe(true);
    expect(latestState.data.tasks).toBeUndefined();
    expect(latestState.visits).toEqual({ "Socket-1": 1 });

    const events = await readEvents(harness);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
    expect(events.some((event) => event.type === "inference_interruption" && event.data.mode === "finalization")).toBe(true);
  });

  test("foreach inference interruption preserves cursor and socket state", async () => {
    const harness = await makeHarness(foreachConfig());
    harness.contextUsage = { tokens: 900, contextWindow: 1000, percent: 90 };
    await harness.runCommand("materia", "cast foreach recovery");

    // stopReason error → inference interruption (no recovery/compaction)
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "token limit exceeded" });
    await harness.emit("agent_end", { messages: [] });

    // No compaction triggered aside from possible proactive compaction at cast start
    expect(harness.operationLog.filter((op) => op === "compact").length).toBeLessThanOrEqual(1);
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(1);
    let latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.socketState).toBe("awaiting_agent_response");
    expect(latestState.currentSocketId).toBe("Socket-2");
    expect(latestState.currentItemKey).toBe("WI-1");
    expect(latestState.currentItemLabel).toBe("Alpha");
    expect(latestState.cursors).toEqual({ itemCursor: 0 });
    expect(latestState.visits).toEqual({ "Socket-1": 1, "Socket-2": 1 });
    expect(latestState.taskAttempts).toEqual({ '["Socket-1","__singleton__"]': 1, '["Socket-2","WI-1"]': 1 });
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.recoveryExhaustion).toBeUndefined();
    expect(latestState.recoveryAttempts).toBeUndefined();
    expect(latestState.inferenceInterruption).toBeDefined();

    // Later success advances cursor normally
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

  test("tool timeout assistant errors record inference interruption without timeout recovery", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast tool timeout recovery");

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "bash command timed out after 120 seconds" });
    await harness.emit("agent_end", { messages: [] });

    // Inference interruption — no timeout recovery
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(1);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.socketState).toBe("awaiting_agent_response");
    expect(latestState.currentSocketId).toBe("Socket-1");
    expect(latestState.visits).toEqual({ "Socket-1": 1 });
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.recoveryExhaustion).toBeUndefined();
    expect(latestState.recoveryAttempts).toBeUndefined();
    expect(latestState.inferenceInterruption).toBeDefined();
    expect(latestState.inferenceInterruption.error).toContain("timed out");

    const events = await readEvents(harness);
    expect(events.filter((event) => event.type === "socket_start")).toHaveLength(1);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
    expect(events.some((event) => event.type === "inference_interruption")).toBe(true);
    expect(harness.notifications.some((notification) => notification.type === "warning" && notification.message.includes("Inference interruption"))).toBe(true);
  });

  test("tool timeout event-level failure records inference interruption and later success completes", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast tool timeout retry");

    await harness.emit("agent_end", { errorMessage: "Command timed out after 180 seconds" });

    // Inference interruption — no timeout recovery retry
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(1);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    let latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.socketState).toBe("awaiting_agent_response");
    expect(latestState.visits).toEqual({ "Socket-1": 1 });
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.recoveryExhaustion).toBeUndefined();
    expect(latestState.inferenceInterruption).toBeDefined();
    expect(latestState.inferenceInterruption.error).toContain("Command timed out");

    const events = await readEvents(harness);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
    expect(events.some((event) => event.type === "inference_interruption")).toBe(true);

    // Later success completes the socket normally
    harness.appendAssistantMessage("done after timeout");
    await harness.emit("agent_end", { messages: [] });

    latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(false);
    expect(latestState.socketState).toBe("complete");
    expect(latestState.lastAssistantText).toBe("done after timeout");
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.inferenceInterruption).toBeUndefined(); // cleared on success
  });

  test("multiple tool timeout errors record inference interruptions without exhaustion", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast tool timeout exhaust");

    // Multiple timeout errors — each records an inference interruption
    for (let i = 0; i < 4; i++) {
      harness.appendAssistantMessage("", { stopReason: "error", errorMessage: `bash command timed out ${i}` });
      await harness.emit("agent_end", { messages: [] });
    }

    // No recovery exhaustion — cast stays active
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.socketState).toBe("awaiting_agent_response");
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.recoveryExhaustion).toBeUndefined();
    expect(latestState.recoveryAttempts).toBeUndefined();
    expect(latestState.inferenceInterruption).toBeDefined();
    expect(latestState.inferenceInterruption.error).toContain("bash command timed out 3");

    const events = await readEvents(harness);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
    expect(events.filter((event) => event.type === "inference_interruption")).toHaveLength(4);
  });

  test("tool timeout inference interruption does not generate timeout hint", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast timeout hint persistence");

    // stopReason error → inference interruption, no recovery prompt
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "bash command timed out after 180 seconds" });
    await harness.emit("agent_end", { messages: [] });

    const prompt = promptMessages(harness).at(-1)?.content;
    expect(prompt).not.toContain("TIMEOUT RECOVERY HINT");
    expect(prompt).not.toContain("after 180s");

    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.recoveryReasons).toBeUndefined();
    expect(latestState.recoveryErrorMessages).toBeUndefined();
    expect(latestState.inferenceInterruption).toBeDefined();
  });

  test("inference interruption does not generate any recovery prompt", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast context no timeout hint");

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "context window exceeded" });
    await harness.emit("agent_end", { messages: [] });

    // No same-socket recovery retry prompt — only inference interruption
    const prompt = promptMessages(harness).at(-1)?.content;
    expect(prompt).not.toContain("TIMEOUT RECOVERY HINT");
    expect(prompt).not.toContain("previous output was invalid");
  });

  test("inference interruption followed by tool-using retry completes without failing", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast tool retry after inference blip");

    // First turn: stopReason error → provisional inference interruption
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "server_error: upstream timeout" });
    await harness.emit("agent_end", { messages: [] });

    // Cast is preserved active and awaiting — no failure or recovery
    let state = latestCastState(harness);
    expect(state.active).toBe(true);
    expect(state.awaitingResponse).toBe(true);
    expect(state.socketState).toBe("awaiting_agent_response");
    expect(state.failedReason).toBeUndefined();
    expect(state.recoveryExhaustion).toBeUndefined();
    expect(state.recoveryAttempts).toBeUndefined();
    expect(state.inferenceInterruption).toBeDefined();
    expect(state.inferenceInterruption.error).toContain("server_error: upstream timeout");

    // Second turn: Pi retries natively — this retry simulates tool activity
    // (assistant issues tool calls, results come back, then final response)
    // The intermediate tool-call assistant message is not the latest entry.    
    harness.appendAssistantMessage("Let me check the build configuration", {
      toolCallRequests: [{ id: "call-1", function: { name: "read", arguments: '{"path":"test.txt"}' } }],
    });
    harness.sessionManager.appendMessage({
      role: "tool",
      content: [{ type: "text", text: "build file contents: OK" }],
      toolCallId: "call-1",
    });
    const finalEntry = harness.appendAssistantMessage("Configuration looks correct; build will proceed.");
    await harness.emit("agent_end", { messages: [] });

    // Cast completes successfully — never entered failed state
    state = latestCastState(harness);
    expect(state.active).toBe(false);
    expect(state.socketState).toBe("complete");
    expect(state.phase).toBe("complete");
    expect(state.lastProcessedEntryId).toBe(finalEntry.id);
    expect(state.lastAssistantText).toBe("Configuration looks correct; build will proceed.");
    expect(state.failedReason).toBeUndefined();
    expect(state.recoveryExhaustion).toBeUndefined();
    expect(state.recoveryAttempts).toBeUndefined();
    expect(state.inferenceInterruption).toBeUndefined();

    // Event assertions: no same-socket recovery, no failed cast_end
    const events = await readEvents(harness);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
    expect(events.some((event) => event.type === "inference_interruption")).toBe(true);
    expect(events.some((event) => event.type === "socket_complete")).toBe(true);
    expect(events.some((event) => event.type === "cast_end" && event.data.ok === true)).toBe(true);
    expect(events.filter((event) => event.type === "cast_end" && event.data.ok === false)).toHaveLength(0);
  });

  test("extendSameSocketRecoveryAllowanceForRevive preserves timeout recovery metadata", () => {
    // Direct unit test of the revive function (exhaustion path via stopReason
    // errors is no longer reachable, but revive is still valid for other
    // recovery sources such as JSON output repair exhaustion).
    const key = JSON.stringify(["normal", "Socket-1", "__singleton__", 1, 0]);
    const state: any = {
      active: false,
      phase: "failed",
      socketState: "failed",
      castId: "test",
      failedReason: 'Same-socket recovery exhausted for normal turn for socket "Socket-1": bash command timed out',
      recoveryExhaustion: {
        kind: "same_socket_recovery_exhausted",
        reason: "tool_timeout",
        key,
        attempts: 3,
        originalMaxAttempts: 3,
        effectiveMaxAttempts: 3,
        reviveCount: 0,
        failedReason: 'Same-socket recovery exhausted for normal turn for socket "Socket-1": bash command timed out',
        socket: "Socket-1",
        mode: "normal",
        exhaustedAt: Date.now(),
      },
      recoveryReasons: { [key]: "tool_timeout" },
      recoveryErrorMessages: { [key]: "bash command timed out after 180 seconds" },
      recoveryAllowances: { [key]: { originalMaxAttempts: 3, effectiveMaxAttempts: 3, reviveCount: 0 } },
      pipeline: { entry: { id: "Socket-1" }, sockets: {} },
      updatedAt: Date.now(),
    };

    // Verify metadata before revive
    expect(state.recoveryReasons[key]).toBe("tool_timeout");
    expect(state.recoveryErrorMessages[key]).toContain("timed out");

    // Revive adds originalMaxAttempts (3) more attempts
    const reviveResult = extendSameSocketRecoveryAllowanceForRevive(state);
    expect(reviveResult).toMatchObject({
      key,
      priorEffectiveMaxAttempts: 3,
      increment: 3,
      newEffectiveMaxAttempts: 6,
      reviveCount: 1,
    });

    // Metadata must survive revive
    expect(state.recoveryReasons[key]).toBe("tool_timeout");
    expect(state.recoveryErrorMessages[key]).toContain("timed out after 180 seconds");
    expect(state.recoveryAllowances[key]).toEqual({ originalMaxAttempts: 3, effectiveMaxAttempts: 6, reviveCount: 1 });
  });

  test("extendSameSocketRecoveryAllowanceForRevive with context-window uses originalMaxAttempts of 1", () => {
    const key = JSON.stringify(["normal", "Socket-1", "__singleton__", 1, 0]);
    const state: any = {
      active: false,
      phase: "failed",
      socketState: "failed",
      castId: "test-cw",
      failedReason: 'Same-socket recovery exhausted for normal turn for socket "Socket-1": context length exceeded',
      recoveryExhaustion: {
        kind: "same_socket_recovery_exhausted",
        reason: "context_window",
        key,
        attempts: 1,
        originalMaxAttempts: 1,
        effectiveMaxAttempts: 1,
        reviveCount: 0,
        failedReason: 'Same-socket recovery exhausted for normal turn for socket "Socket-1": context length exceeded',
        socket: "Socket-1",
        mode: "normal",
        exhaustedAt: Date.now(),
      },
      recoveryAllowances: { [key]: { originalMaxAttempts: 1, effectiveMaxAttempts: 1, reviveCount: 0 } },
      pipeline: { entry: { id: "Socket-1" }, sockets: {} },
      updatedAt: Date.now(),
    };

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
    expect(state.recoveryAllowances[key]).toEqual({ originalMaxAttempts: 1, effectiveMaxAttempts: 2, reviveCount: 1 });
  });

  test("extendSameSocketRecoveryAllowanceForRevive rejects non-exhaustion failures", () => {
    const state: any = {
      active: false,
      phase: "failed",
      socketState: "failed",
      castId: "test-non-exhausted",
      failedReason: "Pre-commit output validation failed",
      recoveryExhaustion: undefined,
      pipeline: { entry: { id: "Socket-1" }, sockets: {} },
      updatedAt: Date.now(),
    };
    expect(() => extendSameSocketRecoveryAllowanceForRevive(state)).toThrow(
      /missing structured same-socket recovery exhaustion metadata/,
    );

    const legacy = { ...state, failedReason: "Same-socket recovery exhausted for socket", recoveryExhaustion: undefined };
    expect(() => extendSameSocketRecoveryAllowanceForRevive(legacy)).toThrow(
      /missing structured same-socket recovery exhaustion metadata/,
    );
  });

  test("extendSameSocketRecoveryAllowanceForRevive rejects stale exhaustion metadata", () => {
    const key = JSON.stringify(["normal", "Socket-1", "__singleton__", 1, 0]);
    const state: any = {
      active: false,
      phase: "failed",
      socketState: "failed",
      castId: "test-stale",
      failedReason: "Non-recoverable turn failure: provider auth failed",
      recoveryExhaustion: {
        kind: "same_socket_recovery_exhausted",
        reason: "tool_timeout",
        key,
        attempts: 3,
        originalMaxAttempts: 3,
        effectiveMaxAttempts: 3,
        reviveCount: 0,
        failedReason: 'Same-socket recovery exhausted for normal turn for socket "Socket-1": bash timed out',
        socket: "Socket-1",
        mode: "normal",
        exhaustedAt: Date.now(),
      },
      recoveryAllowances: { [key]: { originalMaxAttempts: 3, effectiveMaxAttempts: 3, reviveCount: 0 } },
      pipeline: { entry: { id: "Socket-1" }, sockets: {} },
      updatedAt: Date.now(),
    };
    // stale exhaustion metadata does not match current failedReason
    expect(() => extendSameSocketRecoveryAllowanceForRevive(state)).toThrow(
      /does not match the current terminal failure/,
    );
  });

  test("extendSameSocketRecoveryAllowanceForRevive scales linearly", () => {
    const key = JSON.stringify(["normal", "Socket-1", "__singleton__", 1, 0]);
    const state: any = {
      active: false,
      phase: "failed",
      socketState: "failed",
      castId: "test-linear",
      failedReason: 'Same-socket recovery exhausted for normal turn for socket "Socket-1": context length exceeded',
      recoveryExhaustion: {
        kind: "same_socket_recovery_exhausted",
        reason: "context_window",
        key,
        attempts: 1,
        originalMaxAttempts: 1,
        effectiveMaxAttempts: 1,
        reviveCount: 0,
        failedReason: 'Same-socket recovery exhausted for normal turn for socket "Socket-1": context length exceeded',
        socket: "Socket-1",
        mode: "normal",
        exhaustedAt: Date.now(),
      },
      recoveryAllowances: { [key]: { originalMaxAttempts: 1, effectiveMaxAttempts: 1, reviveCount: 0 }, other: { originalMaxAttempts: 3, effectiveMaxAttempts: 3, reviveCount: 0 } },
      pipeline: { entry: { id: "Socket-1" }, sockets: {} },
      updatedAt: Date.now(),
    };

    expect(extendSameSocketRecoveryAllowanceForRevive(state)).toMatchObject({
      key,
      priorEffectiveMaxAttempts: 1,
      increment: 1,
      newEffectiveMaxAttempts: 2,
      reviveCount: 1,
    });
    expect(extendSameSocketRecoveryAllowanceForRevive(state)).toMatchObject({
      key,
      priorEffectiveMaxAttempts: 2,
      increment: 1,
      newEffectiveMaxAttempts: 3,
      reviveCount: 2,
    });
    expect(state.recoveryAllowances[key]).toEqual({ originalMaxAttempts: 1, effectiveMaxAttempts: 3, reviveCount: 2 });
    expect(state.recoveryAllowances.other).toEqual({ originalMaxAttempts: 3, effectiveMaxAttempts: 3, reviveCount: 0 });
  });
});
