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
    currentSocketId: "Socket-1",
    currentMateria: "Build",
    awaitingResponse: true,
    socketState: "awaiting_agent_response",
    startedAt: 1,
    updatedAt: 1,
    data: {},
    cursors: {},
    visits: { "Socket-1": 1 },
    multiTurnRefinements: {},
    taskAttempts: {},
    edgeTraversals: {},
    runState: { castId: "cast-1", runDir: "/tmp/run", model: {}, currentSocketId: "Socket-1", currentMateria: "Build", lastMessage: "", usage: { totals: {} }, events: [] } as any,
    pipeline: { entry: { id: "Socket-1", socket: { materia: "Build" }, materia: { tools: "coding", prompt: "Build" } }, sockets: { "Socket-1": { id: "Socket-1", socket: { materia: "Build" }, materia: { tools: "coding", prompt: "Build" } } } } as any,
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
    setCurrentSocketState: (state, socketState) => { state.socketState = socketState; },
    currentSocketId: (state) => state.currentSocketId,
    currentSocketVisit: (state, fallback = 0) => state.currentSocketId ? state.visits[state.currentSocketId] ?? fallback : fallback,
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
    expect(state.socketState).toBe("awaiting_agent_response");
    expect(Object.values(state.recoveryAttempts ?? {})).toEqual([1]);
    expect(events.map((event) => event.type)).toEqual(["same_socket_recovery_start", "same_socket_recovery_retry"]);
    expect(events[0].data).toMatchObject({ reason: "context_window", attempt: 1, maxAttempts: 1, entryId: "entry-1", socket: "Socket-1", mode: "normal" });
    expect(calls).toContain("runRecoveryAction");
    expect(calls).toContain("sendMateriaTurn:retry prompt:true");
  });

  test("json output repair recovery records bounded telemetry and user-facing status", async () => {
    const state = makeState();
    state.jsonOutputRepair = {
      validationKind: "json_parse",
      errorMessage: "Invalid JSON output",
      invalidOutputExcerpt: "{ not json }",
      excerptLength: 12,
      truncated: true,
    };
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const calls: string[] = [];

    const recovered = await handleSameSocketRecoverableTurnFailureWorkflow(state, new Error("Pre-commit output validation failed"), makeDeps(events, calls), { entryId: "entry-json", allowGenericTurnFailure: true });

    expect(recovered).toBe(true);
    expect(state.runState.lastMessage).toContain("previous JSON output was invalid");
    expect(events.map((event) => event.type)).toEqual(["same_socket_recovery_start", "same_socket_recovery_retry"]);
    expect(events[0].data).toMatchObject({ reason: "turn_failure", recoveryKind: "json_output_repair", validationKind: "json_parse", excerptLength: 12, excerptTruncated: true, attempt: 1, maxAttempts: 1, socket: "Socket-1" });
    expect(events[0].data).not.toHaveProperty("invalidOutputExcerpt");
    expect(events[1].data).toMatchObject({ reason: "turn_failure", recoveryKind: "json_output_repair", validationKind: "json_parse", excerptLength: 12, excerptTruncated: true, attempt: 1, maxAttempts: 1, socket: "Socket-1" });
    expect(calls.some((call) => call.startsWith("notify:") && call.includes("previous JSON output was invalid"))).toBe(true);
  });

  test("generic turn failures require opt-in and resend directly without recovery actions", async () => {
    const state = makeState();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const calls: string[] = [];

    const recovered = await handleSameSocketRecoverableTurnFailureWorkflow(state, new Error("provider interrupted turn"), makeDeps(events, calls), { entryId: "entry-generic", allowGenericTurnFailure: true });

    expect(recovered).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["same_socket_recovery_start", "same_socket_recovery_retry"]);
    expect(events[0].data).toMatchObject({ reason: "turn_failure", entryId: "entry-generic", socket: "Socket-1", mode: "normal" });
    expect(events.some((event) => event.type.startsWith("same_socket_recovery_action_"))).toBe(false);
    expect(calls).not.toContain("runRecoveryAction");
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
    expect(state.recoveryExhaustion).toMatchObject({ kind: "same_socket_recovery_exhausted", reason: "context_window", attempts: 1, effectiveMaxAttempts: 1, socket: "Socket-1", mode: "normal" });
    expect(events.at(-1)).toMatchObject({ type: "same_socket_recovery_exhausted", data: { reason: "context_window", attempts: 1, entryId: "entry-2" } });
    expect(calls).toContain("failCast:true");
  });

  test("json output repair exhaustion preserves revivable metadata and specific failure message", async () => {
    const state = makeState();
    state.jsonOutputRepair = {
      validationKind: "handoff_validation",
      errorMessage: "reserved control field failed",
      invalidOutputExcerpt: "{\"satisfied\":\"yes\"}",
      excerptLength: 19,
      truncated: false,
    };
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const calls: string[] = [];
    const deps = makeDeps(events, calls);

    await handleSameSocketRecoverableTurnFailureWorkflow(state, new Error("first invalid envelope"), deps, { allowGenericTurnFailure: true });
    const recovered = await handleSameSocketRecoverableTurnFailureWorkflow(state, new Error("second invalid envelope"), deps, { entryId: "entry-json-2", allowGenericTurnFailure: true });

    expect(recovered).toBe(true);
    expect(state.active).toBe(false);
    expect(state.failedReason).toContain("JSON output repair retry exhausted");
    expect(state.recoveryExhaustion).toMatchObject({ kind: "same_socket_recovery_exhausted", reason: "turn_failure", recoveryKind: "json_output_repair", validationKind: "handoff_validation", excerptLength: 19, socket: "Socket-1" });
    expect(state.recoveryExhaustion?.failedReason).toBe(state.failedReason);
    expect(events.at(-1)).toMatchObject({ type: "same_socket_recovery_exhausted", data: { reason: "turn_failure", recoveryKind: "json_output_repair", validationKind: "handoff_validation", excerptLength: 19, entryId: "entry-json-2" } });
    expect(events.at(-1)?.data).not.toHaveProperty("invalidOutputExcerpt");
    expect(calls).toContain("failCast:true");
  });

  test("generic turn failures share the logical turn recovery budget across error strings", async () => {
    const state = makeState();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const calls: string[] = [];
    const deps = makeDeps(events, calls);

    await handleSameSocketRecoverableTurnFailureWorkflow(state, new Error("first provider interruption"), deps, { allowGenericTurnFailure: true });
    const firstKey = events[0].data.key;
    const recovered = await handleSameSocketRecoverableTurnFailureWorkflow(state, new Error("different provider interruption"), deps, { entryId: "entry-generic-2", allowGenericTurnFailure: true });

    expect(recovered).toBe(true);
    expect(state.active).toBe(false);
    expect(state.recoveryAttempts).toEqual({ [String(firstKey)]: 1 });
    expect(state.recoveryExhaustion).toMatchObject({ kind: "same_socket_recovery_exhausted", reason: "turn_failure", key: firstKey, attempts: 1, effectiveMaxAttempts: 1, socket: "Socket-1", mode: "normal" });
    expect(events.at(-1)).toMatchObject({ type: "same_socket_recovery_exhausted", data: { reason: "turn_failure", key: firstKey, attempts: 1, entryId: "entry-generic-2" } });
    expect(calls.filter((call) => call === "runRecoveryAction")).toHaveLength(0);
    expect(calls).toContain("failCast:true");
  });

  test("records retry failure and delegates failed cast", async () => {
    const state = makeState();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const calls: string[] = [];
    const deps = { ...makeDeps(events, calls), sendMateriaTurn: async () => { throw new Error("retry send failed"); } };

    const recovered = await handleSameSocketRecoverableTurnFailureWorkflow(state, new Error("context window exceeded"), deps);

    expect(recovered).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["same_socket_recovery_start", "same_socket_recovery_retry_failed"]);
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
      currentSocketId: (nextState) => nextState.currentSocketId,
    });

    expect(events.map((event) => event.type)).toEqual(["same_socket_recovery_action_start", "same_socket_recovery_action_complete"]);
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
      currentSocketId: (nextState) => nextState.currentSocketId,
    })).rejects.toThrow("Same-socket recovery action compact failed");

    expect(events.map((event) => event.type)).toEqual(["same_socket_recovery_action_start", "same_socket_recovery_action_failed"]);
    expect(events[1].data.error).toBe("compact failed");
  });
});
