import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
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
    loadouts: { Test: { entry: "work", nodes: { work: { type: "agent", materia: "Build", next: "end" } } } },
    materia: { Build: { tools: "coding", prompt: "Build materia" } },
  };
}

function multiTurnConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: { Test: { entry: "plan", nodes: { plan: { type: "agent", materia: "Plan", parse: "json", assign: { tasks: "$.tasks" }, next: "end" } } } },
    materia: { Plan: { tools: "readOnly", prompt: "Collaborative planner", multiTurn: true } },
  };
}

function foreachConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "seed",
        nodes: {
          seed: {
            type: "utility",
            utility: "echo",
            parse: "json",
            params: { output: { items: [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta" }] } },
            assign: { items: "$.items" },
            next: "work",
          },
          work: {
            type: "agent",
            materia: "Build",
            parse: "json",
            foreach: { items: "state.items", as: "workItem", cursor: "itemCursor", done: "end" },
            advance: { cursor: "itemCursor", items: "state.items", when: "$.done == true", done: "end" },
            next: "work",
            limits: { maxVisits: 5 },
          },
        },
      },
    },
    materia: { Build: { tools: "coding", prompt: "Build materia" } },
  };
}

function promptMessages(harness: FakePiHarness): any[] {
  return harness.sentMessages.map(({ message }) => message as any).filter((message) => message.customType === "pi-materia-prompt");
}

describe("native same-node recovery", () => {
  test("context-window assistant errors retry the same active node without a new node start", async () => {
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
    expect(latestState.currentNode).toBe("work");
    expect(latestState.visits).toEqual({ work: 1 });
    expect(latestState.recoveryAttempts).toBeDefined();

    const events = await readEvents(harness);
    expect(events.filter((event) => event.type === "node_start")).toHaveLength(1);
    expect(events.some((event) => event.type === "same_node_recovery_start" && event.data.reason === "context_window" && event.data.mode === "normal")).toBe(true);
    expect(events.some((event) => event.type === "same_node_recovery_retry")).toBe(true);
  });

  test("Codex context_length_exceeded websocket errors retry the same active node", async () => {
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
    expect(latestState.currentNode).toBe("work");
    expect(latestState.visits).toEqual({ work: 1 });

    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "same_node_recovery_start" && event.data.reason === "context_window" && event.data.error.includes(errorMessage))).toBe(true);
    expect(events.some((event) => event.type === "same_node_recovery_retry")).toBe(true);
  });

  test("agent_end failures without assistant output retry the same active node", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast no assistant");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    await harness.emit("agent_end", { errorMessage: "maximum tokens exceeded before response" });

    expect(harness.operationLog.filter((op) => op === "triggerTurn").length).toBe(triggerTurnsBefore + 1);
    expect(harness.operationLog).toContain("compact");
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.visits).toEqual({ work: 1 });
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
    expect(latestState.nodeState).toBe("awaiting_agent_response");
    expect(latestState.failedReason).toBeUndefined();
    expect(latestState.visits).toEqual({ work: 1 });
    expect(harness.notifications.some((notification) => notification.type === "warning" && notification.message.includes("Transient transport failure"))).toBe(true);

    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "transient_transport_turn_failure" && event.data.warning === true && event.data.error.includes("WebSocket error"))).toBe(true);
    expect(events.filter((event) => event.type.startsWith("same_node_recovery"))).toHaveLength(0);
    expect(events.filter((event) => event.type === "cast_end")).toHaveLength(0);
  });

  test("non-recoverable assistant errors fail without retry", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast fail me");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "provider auth failed" });
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog.filter((op) => op === "triggerTurn").length).toBe(triggerTurnsBefore);
    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(false);
    expect(latestState.nodeState).toBe("failed");
    expect(latestState.failedReason).toContain("provider auth failed");
    const events = await readEvents(harness);
    expect(events.filter((event) => event.type.startsWith("same_node_recovery"))).toHaveLength(0);
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
    expect(latestState.failedReason).toContain("Same-node recovery action compact failed");
    expect(latestState.failedReason).toContain("compaction provider unavailable");
    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "same_node_recovery_action_failed" && event.data.action === "compact")).toBe(true);
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
    expect(latestState.currentNode).toBe("work");
    expect(latestState.visits).toEqual({ work: 1 });
    expect(harness.notifications.some((notification) => notification.type === "warning" && notification.message.includes("Proactive compaction failed"))).toBe(true);

    harness.contextUsage = undefined;
    harness.compactError = undefined;
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "context window exceeded" });
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(2);
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(2);
    latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.visits).toEqual({ work: 1 });

    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "proactive_compaction_start" && event.data.action === "compact" && event.data.reason === "context_pressure")).toBe(true);
    expect(events.some((event) => event.type === "proactive_compaction_failed" && event.data.warning === true)).toBe(true);
    expect(events.some((event) => event.type === "same_node_recovery_action_start" && event.data.action === "compact" && event.data.reason === "context_window")).toBe(true);
    expect(events.some((event) => event.type === "same_node_recovery_action_complete" && event.data.action === "compact" && event.data.reason === "context_window")).toBe(true);
  });

  test("non-recoverable assistant errors fail with non-recoverable diagnostics", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast fail diagnostic");

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "provider auth failed" });
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog.filter((op) => op === "compact")).toHaveLength(0);
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(false);
    expect(latestState.failedReason).toContain("Non-recoverable turn failure");
    expect(latestState.failedReason).toContain("provider auth failed");
    const events = await readEvents(harness);
    expect(events.filter((event) => event.type.startsWith("same_node_recovery"))).toHaveLength(0);
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
    expect(latestState.failedReason).toContain("Same-node recovery exhausted");
    expect(latestState.visits).toEqual({ work: 1 });
    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "same_node_recovery_exhausted")).toBe(true);
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
    expect(latestState.nodeState).toBe("awaiting_agent_response");
    expect(latestState.currentNode).toBe("plan");
    expect(latestState.multiTurnFinalizing).toBe(false);
    expect(latestState.multiTurnRefinements).toEqual({ '["plan","__singleton__",1]': 1 });
    expect(latestState.visits).toEqual({ plan: 1 });
    const retryPrompt = promptMessages(harness).at(-1)?.content;
    expect(retryPrompt).toContain("Current multi-turn mode: refinement conversation");
    expect(retryPrompt).toContain("Previous output:\nDraft plan; please clarify scope.");
    expect(retryPrompt).not.toContain("partial stale output");
    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "same_node_recovery_start" && event.data.mode === "refinement" && event.data.reason === "context_window")).toBe(true);
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
    expect(latestState.currentNode).toBe("plan");
    expect(latestState.awaitingResponse).toBe(true);
    expect(latestState.multiTurnFinalizing).toBe(true);
    expect(latestState.data.tasks).toBeUndefined();
    expect(latestState.visits).toEqual({ plan: 1 });
    const retryPrompt = promptMessages(harness).at(-1)?.content;
    expect(retryPrompt).toContain("Command-triggered finalization");
    expect(retryPrompt).toContain("Return only JSON");
    expect(retryPrompt).toContain("Previous output:\nDraft plan; ready to finalize.");
    const events = await readEvents(harness);
    expect(events.some((event) => event.type === "same_node_recovery_start" && event.data.mode === "finalization" && event.data.reason === "context_window")).toBe(true);
  });

  test("foreach context-window recovery preserves cursor and avoids duplicate node start", async () => {
    const harness = await makeHarness(foreachConfig());
    await harness.runCommand("materia", "cast foreach recovery");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "token limit exceeded" });
    await harness.emit("agent_end", { messages: [] });

    let latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(harness.operationLog.filter((op) => op === "triggerTurn")).toHaveLength(triggerTurnsBefore + 1);
    expect(harness.operationLog).toContain("compact");
    expect(latestState.active).toBe(true);
    expect(latestState.currentNode).toBe("work");
    expect(latestState.currentItemKey).toBe("a");
    expect(latestState.currentItemLabel).toBe("Alpha");
    expect(latestState.cursors).toEqual({ itemCursor: 0 });
    expect(latestState.visits).toEqual({ seed: 1, work: 1 });
    expect(latestState.taskAttempts).toEqual({ '["seed","__singleton__"]': 1, '["work","a"]': 1 });
    expect(latestState.recoveryAttempts).toBeDefined();
    const nodeStartsBeforeCompletion = (await readEvents(harness)).filter((event) => event.type === "node_start" && event.data.node === "work");
    expect(nodeStartsBeforeCompletion).toHaveLength(1);

    harness.appendAssistantMessage('{"done":true}');
    await harness.emit("agent_end", { messages: [] });
    latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(true);
    expect(latestState.currentNode).toBe("work");
    expect(latestState.currentItemKey).toBe("b");
    expect(latestState.currentItemLabel).toBe("Beta");
    expect(latestState.cursors).toEqual({ itemCursor: 1 });
    expect(latestState.visits).toEqual({ seed: 1, work: 2 });
  });
});
