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
    pipeline: { entry: "work", nodes: { work: { type: "agent", role: "Build", next: "end" } } },
    roles: { Build: { tools: "coding", systemPrompt: "Build role" } },
  };
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

  test("non-recoverable assistant errors fail without retry", async () => {
    const harness = await makeHarness(singleAgentConfig());
    await harness.runCommand("materia", "cast fail me");
    const triggerTurnsBefore = harness.operationLog.filter((op) => op === "triggerTurn").length;

    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "provider auth failed" });
    await harness.emit("agent_end", { messages: [] });

    expect(harness.operationLog.filter((op) => op === "triggerTurn").length).toBe(triggerTurnsBefore);
    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(false);
    expect(latestState.nodeState).toBe("failed");
    expect(latestState.failedReason).toContain("provider auth failed");
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

    const latestState = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as any;
    expect(latestState.active).toBe(false);
    expect(latestState.failedReason).toContain("Non-recoverable turn failure");
    expect(latestState.failedReason).toContain("provider auth failed");
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
});
