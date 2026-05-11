import { describe, expect, test } from "bun:test";
import { handleSameSocketRecoverableTurnFailureWorkflow, runSameSocketRecoveryActionWorkflow, type SameSocketRecoveryWorkflowDeps } from "../src/application/recoveryWorkflow.js";
import type { MateriaCastState } from "../src/types.js";

function makeState(): MateriaCastState {
  return {
    version: 1,
    active: true,
    castId: "cast-1",
    request: "request",
    configSource: "test",
    configHash: "hash",
    cwd: "/tmp",
    runDir: "/tmp/run",
    artifactRoot: "/tmp/artifacts",
    phase: "Socket-1",
    currentNode: "Socket-1",
    currentMateria: "Build",
    awaitingResponse: true,
    nodeState: "awaiting_agent_response",
    startedAt: 1,
    updatedAt: 1,
    data: {},
    cursors: {},
    visits: { "Socket-1": 1 },
    multiTurnRefinements: {},
    taskAttempts: {},
    edgeTraversals: {},
    runState: { castId: "cast-1", runDir: "/tmp/run", model: {}, currentNode: "Socket-1", currentMateria: "Build", lastMessage: "", usage: { totals: {} }, events: [] } as any,
    pipeline: { entry: { id: "Socket-1", socket: { type: "agent", materia: "Build" }, materia: { tools: "coding", prompt: "Build" } }, sockets: { "Socket-1": { id: "Socket-1", socket: { type: "agent", materia: "Build" }, materia: { tools: "coding", prompt: "Build" } } } } as any,
  } as MateriaCastState;
}

function makeDeps(events: Array<{ type: string; data: Record<string, unknown> }>, calls: string[] = []): SameSocketRecoveryWorkflowDeps {
  return {
    appendEvent: async (_runState, type, data) => { events.push({ type, data }); },
    writeUsage: async () => { calls.push("writeUsage"); },
    saveState: () => { calls.push("saveState"); },
    failCast: async (state, error, _entryId, options) => { calls.push(`failCast:${options?.preserveRecoveryExhaustion === true}`); state.active = false; state.failedReason = error instanceof Error ? error.message : String(error); },
    updateToolScope: () => { calls.push("updateToolScope"); },
    sendMateriaTurn: async (_state, prompt, options) => { calls.push(`sendMateriaTurn:${prompt}:${options?.skipProactiveCompaction === true}`); },
    buildRecoveryPrompt: () => "retry prompt",
    updateWidget: () => { calls.push("updateWidget"); },
    notifyWarning: (message) => { calls.push(`notify:${message}`); },
    setCurrentSocketState: (state, socketState) => { state.nodeState = socketState; },
    currentSocketId: (state) => state.currentNode,
    currentSocketVisit: (state, fallback = 0) => state.currentNode ? state.visits[state.currentNode] ?? fallback : fallback,
    shortMetadataLabel: (value) => value,
    currentMateria: () => ({ tools: "coding", prompt: "Build" } as any),
    runRecoveryAction: async () => { calls.push("runRecoveryAction"); },
  };
}

describe("same-socket recovery workflow", () => {
  test("returns false for non-recoverable failures without edge calls", async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const calls: string[] = [];
    const recovered = await handleSameSocketRecoverableTurnFailureWorkflow(makeState(), new Error("provider auth failed"), makeDeps(events, calls));

    expect(recovered).toBe(false);
    expect(events).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("records an attempt, runs compaction action, and resends the same prompt", async () => {
    const state = makeState();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const calls: string[] = [];

    const recovered = await handleSameSocketRecoverableTurnFailureWorkflow(state, new Error("context window exceeded"), makeDeps(events, calls), { entryId: "entry-1" });

    expect(recovered).toBe(true);
    expect(state.awaitingResponse).toBe(true);
    expect(state.nodeState).toBe("awaiting_agent_response");
    expect(Object.values(state.recoveryAttempts ?? {})).toEqual([1]);
    expect(events.map((event) => event.type)).toEqual(["same_node_recovery_start", "same_node_recovery_retry"]);
    expect(events[0].data).toMatchObject({ reason: "context_window", attempt: 1, maxAttempts: 1, entryId: "entry-1", node: "Socket-1", mode: "normal" });
    expect(calls).toContain("runRecoveryAction");
    expect(calls).toContain("sendMateriaTurn:retry prompt:true");
  });

  test("exhausts allowance and delegates terminal failure with structured metadata", async () => {
    const state = makeState();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const calls: string[] = [];
    const deps = makeDeps(events, calls);

    await handleSameSocketRecoverableTurnFailureWorkflow(state, new Error("context window exceeded"), deps);
    const recovered = await handleSameSocketRecoverableTurnFailureWorkflow(state, new Error("context window exceeded again"), deps, { entryId: "entry-2" });

    expect(recovered).toBe(true);
    expect(state.active).toBe(false);
    expect(state.recoveryExhaustion).toMatchObject({ kind: "same_node_recovery_exhausted", reason: "context_window", attempts: 1, effectiveMaxAttempts: 1, node: "Socket-1", mode: "normal" });
    expect(events.at(-1)).toMatchObject({ type: "same_node_recovery_exhausted", data: { attempts: 1, entryId: "entry-2" } });
    expect(calls).toContain("failCast:true");
  });

  test("records retry failure and delegates failed cast", async () => {
    const state = makeState();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const calls: string[] = [];
    const deps = { ...makeDeps(events, calls), sendMateriaTurn: async () => { throw new Error("retry send failed"); } };

    const recovered = await handleSameSocketRecoverableTurnFailureWorkflow(state, new Error("context window exceeded"), deps);

    expect(recovered).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["same_node_recovery_start", "same_node_recovery_retry_failed"]);
    expect(events[1].data.error).toBe("retry send failed");
    expect(calls).toContain("failCast:false");
  });
});

describe("same-socket recovery action workflow", () => {
  test("wraps compaction with start and complete events", async () => {
    const state = makeState();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const saves: string[] = [];

    await runSameSocketRecoveryActionWorkflow(state, { action: "compact", reason: "context_window", key: "key", attempt: 1, maxAttempts: 1, entryId: "entry-1" }, {
      appendEvent: async (_runState, type, data) => { events.push({ type, data }); },
      saveState: () => { saves.push("save"); },
      runCompaction: async () => ({ tokensBefore: 100, tokensAfter: 50, ignored: true }),
      currentSocketId: (nextState) => nextState.currentNode,
    });

    expect(events.map((event) => event.type)).toEqual(["same_node_recovery_action_start", "same_node_recovery_action_complete"]);
    expect(events[1].data.result).toEqual({ tokensBefore: 100, tokensAfter: 50 });
    expect(saves).toHaveLength(2);
  });

  test("records failed compaction before throwing wrapped recovery action error", async () => {
    const state = makeState();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];

    await expect(runSameSocketRecoveryActionWorkflow(state, { action: "compact", reason: "context_window", key: "key", attempt: 1, maxAttempts: 1 }, {
      appendEvent: async (_runState, type, data) => { events.push({ type, data }); },
      saveState: () => {},
      runCompaction: async () => { throw new Error("compact failed"); },
      currentSocketId: (nextState) => nextState.currentNode,
    })).rejects.toThrow("Same-socket recovery action compact failed");

    expect(events.map((event) => event.type)).toEqual(["same_node_recovery_action_start", "same_node_recovery_action_failed"]);
    expect(events[1].data.error).toBe("compact failed");
  });
});
