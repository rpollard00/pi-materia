import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { extendSameSocketRecoveryAllowanceForRevive } from "../src/castRuntime.js";
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
    loadouts: { Test: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Build", parse: "json", assign: { result: "$.result" }, edges: [{ when: "always", to: target }] } } } },
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
            advance: { cursor: "itemCursor", items: "state.items", when: "$.done == true", done: "end" },
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

describe("native same-socket recovery", () => {
  test("context-window assistant errors retry the same active socket without a new socket start", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast recover me");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "context window exceeded" });
    await harness.emit("agent_end", { messages: [] });

    const triggerTurnsAfter = harness.operationLog.filter((op) => op === "triggerTurn").length;
    expect(triggerTurnsAfter).toBe(triggerTurnsBefore + 1);
    expect(harness.operationLog).toContain("compact");
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

    const errorMessage = 'Error: WebSocket closed 1000 Error: Codex error: {"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window of this model. Please adjust your input and try again.","param":"input"},"sequence_number":2}';
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage });
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog.filter((op) => op === "triggerTurn").length).toBe(triggerTurnsBefore + 1);
    expect(harness.operationLog).toContain("compact");
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.currentSocketId).toBe("Socket-1");
    expect(latestState.visits).toEqual({ "Socket-1": 1 });

    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "same_socket_recovery_start" && event.data.reason === "context_window" && event.data.error.includes(errorMessage))).toBe(true);
    expect(events.some((event) => event.type === "same_socket_recovery_retry")).toBe(true);
  });

  test("agent_end failures without assistant output retry the same active socket", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast no assistant");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    await harness.emit("agent_end", { errorMessage: "maximum tokens exceeded before response" });

    expect(harness.operationLog.filter((op) => op === "triggerTurn").length).toBe(triggerTurnsBefore + 1);
    expect(harness.operationLog).toContain("compact");
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
    const harness = await makeHarness(jsonAgentConfig());
    await harness.runCommand("materia", "cast invalid json retry");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    harness.appendAssistantMessage("{ not json");
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog.filter((op) => op === "triggerTurn").length).toBe(triggerTurnsBefore + 1);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    let latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.data.result).toBeUndefined();
    expect(latestState.lastJson).toBeUndefined();
    expect(latestState.visits).toEqual({ "Socket-1": 1 });

    harness.appendAssistantMessage('{"result":"ok"}');
    await harness.emit("agent_end", { messages: [] });

    latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(false);
    expect(latestState.data.result).toBe("ok");
    const events = await readEvents(harness);
    expect(events.filter((event) => event.type === "socket_start")).toHaveLength(1);
    expect(events.some((event) => event.type === "same_socket_recovery_start" && event.data.reason === "turn_failure" && String(event.data.error).includes("Pre-commit output validation failed"))).toBe(true);
  });

  test("handoff validation failures from an agent retry before graph advancement", async () => {
    const harness = await makeHarness(jsonAgentConfig());
    await harness.runCommand("materia", "cast handoff validation retry");

    harness.appendAssistantMessage('{"satisfied":"yes","result":"invalid control"}');
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(2);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.data.result).toBeUndefined();
    expect(latestState.lastJson).toBeUndefined();
    const events = await readEvents(harness);
    expect(events.filter((event) => event.type === "socket_complete")).toHaveLength(0);
    expect(events.some((event) => event.type === "same_socket_recovery_start" && event.data.reason === "turn_failure" && String(event.data.error).includes("Pre-commit output validation failed"))).toBe(true);
  });

  test("utility socket output validation failures fail fast without generic retry", async () => {
    const harness = await makeHarness(utilityJsonConfig());
    await harness.runCommand("materia", "cast utility json fail");

    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(0);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(false);
    expect(latestState.socketState).toBe("failed");
    expect(latestState.failedReason).toContain("Pre-commit output validation failed");
    const events = await readEvents(harness);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
  });

  test("post-advance lifecycle failures are not retried after assignments apply", async () => {
    const harness = await makeHarness(budgetFailingAgentConfig());
    await harness.runCommand("materia", "cast unsafe post advance");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    harness.appendAssistantMessage('{"result":"applied"}');
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

    harness.contextUsage = undefined;
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
    expect(retryPrompt).toContain("Return only JSON");
    expect(retryPrompt).toContain("Previous output:\nDraft plan; ready to finalize.");
    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "same_socket_recovery_start" && event.data.mode === "finalization" && event.data.reason === "context_window")).toBe(true);
  });

  test("foreach context-window recovery preserves cursor and avoids duplicate socket start", async () => {
    const harness = await makeHarness(foreachConfig());
    await harness.runCommand("materia", "cast foreach recovery");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "token limit exceeded" });
    await harness.emit("agent_end", { messages: [] });

    let latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(triggerTurnsBefore + 1);
    expect(harness.operationLog).toContain("compact");
    expect(latestState.active).toBe(true);
    expect(latestState.currentSocketId).toBe("Socket-2");
    expect(latestState.currentItemKey).toBe("a");
    expect(latestState.currentItemLabel).toBe("Alpha");
    expect(latestState.cursors).toEqual({ itemCursor: 0 });
    expect(latestState.visits).toEqual({ "Socket-1": 1, "Socket-2": 1 });
    expect(latestState.taskAttempts).toEqual({ '["Socket-1","__singleton__"]': 1, '["Socket-2","a"]': 1 });
    expect(latestState.recoveryAttempts).toBeDefined();
    const socketStartsBeforeCompletion = (await readEvents(harness)).filter((event) => event.type === "socket_start" && event.data.socket === "Socket-2");
    expect(socketStartsBeforeCompletion).toHaveLength(1);

    harness.appendAssistantMessage('{"done":true}');
    await harness.emit("agent_end", { messages: [] });
    latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.currentSocketId).toBe("Socket-2");
    expect(latestState.currentItemKey).toBe("b");
    expect(latestState.currentItemLabel).toBe("Beta");
    expect(latestState.cursors).toEqual({ itemCursor: 1 });
    expect(latestState.visits).toEqual({ "Socket-1": 1, "Socket-2": 2 });
  });
});
