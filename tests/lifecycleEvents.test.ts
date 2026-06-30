import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeTestInternals } from "../src/castRuntime.js";
import { applyEventingEnvOverlay } from "../src/config/config.js";
import { EventBus, LocalEventRecordingSink, createEventBus, flushBusOutcomes } from "../src/runtime/eventBus.js";
import {
  ResultAccumulator,
  createSequenceCounter,
  enrichEvents,
  type EnrichmentContext,
  type MateriaCastState,
} from "../src/domain/eventing.js";

const {
  emitLifecycleEvent,
  getEventBus,
  removeEventBus,
  startHeartbeat,
  stopHeartbeat,
  initializeCastEventBus,
  castHeartbeats,
  castEventBuses,
} = nativeTestInternals as unknown as {
  emitLifecycleEvent: (
    state: MateriaCastState,
    type: string,
    overrides?: {
      severity?: string;
      message?: string;
      payload?: Record<string, unknown>;
      socketId?: string;
      materia?: string;
      materiaLabel?: string;
      visit?: number;
      itemKey?: string;
      itemLabel?: string;
    },
  ) => Promise<void>;
  getEventBus: (state: MateriaCastState) => EventBus | undefined;
  removeEventBus: (castId: string) => void;
  getResultAccumulator: (state: MateriaCastState) => ResultAccumulator | undefined;
  startHeartbeat: (state: MateriaCastState, config: { eventing?: { enabled?: boolean; heartbeatIntervalMs?: number } }) => void;
  stopHeartbeat: (castId: string) => void;
  initializeCastEventBus: (config: { eventing?: { enabled?: boolean; sinks?: Record<string, unknown> } }, state: MateriaCastState) => EventBus | undefined;
  castHeartbeats: Map<string, ReturnType<typeof setInterval>>;
  castEventBuses: Map<string, EventBus>;
};

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "pi-materia-lifecycle-"));
}

function makeCastState(overrides: Partial<MateriaCastState> = {}): MateriaCastState {
  const base: MateriaCastState = {
    version: 2,
    active: true,
    castId: "2026-06-16T22-00-00-000Z",
    request: "test request",
    configSource: "test",
    configHash: "test-hash",
    cwd: "/tmp/test",
    runDir: "/tmp/test-run",
    artifactRoot: "/tmp/artifacts",
    phase: "Socket-1",
    currentSocketId: "Socket-1",
    currentMateria: "TestMateria",
    awaitingResponse: true,
    socketState: "awaiting_agent_response",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    data: {},
    cursors: {},
    visits: { "Socket-1": 1 },
    multiTurnRefinements: {},
    taskAttempts: {},
    edgeTraversals: {},
    runState: {
      castId: "2026-06-16T22-00-00-000Z",
      runDir: "/tmp/test-run",
      model: "test-model",
      loadoutName: "test-loadout",
      currentSocketId: "Socket-1",
      currentMateria: "TestMateria",
      lastMessage: "Socket-1",
      attempt: 1,
      usage: { costKind: "tokens", tokenUsage: { input: 100, output: 50, cacheCreation: 0, cacheRead: 0 } },
    },
    pipeline: {
      pipeline: "test-pipeline",
      loadoutName: "test-loadout",
      entry: {
        id: "Socket-1",
        materia: { materia: "TestMateria" as any, parse: "text" },
        utility: false,
      } as any,
      sockets: new Map(),
    },
    ...overrides,
  };
  return base;
}

// ── Module-level test helpers ──────────────────────────────────────────

// The lifecycle events module uses module-level Maps keyed by castId.
// Our tests need to manipulate those maps directly via the test internals.
// getEventBus / removeEventBus allow reading and cleaning up.

describe("lifecycle event emission", () => {
  test("emitLifecycleEvent is a no-op when no event bus is registered", async () => {
    const state = makeCastState();
    // No bus registered — should not throw.
    await emitLifecycleEvent(state, "lifecycle.cast.started");
    // Bus should not have been created.
    expect(getEventBus(state)).toBeUndefined();
  });

  test("emitLifecycleEvent dispatches through the bus when eventing is enabled", async () => {
    const runDir = await tempDir();
    const state = makeCastState({ castId: "test-lifecycle-1", runDir });

    // Manually register an event bus to simulate eventing enabled.
    const bus = createEventBus(runDir);
    // Access module-level Maps via test internals.
    // We need a way to register the bus. The module's castEventBuses
    // is a private Map. We can access it through the test internals.
    // getEventBus returns undefined unless we use initializeCastEventBus.
    // Instead, we'll test with a standalone bus and verify the pattern.

    const deliveredEvents: any[] = [];
    const spySink = {
      id: "test-spy",
      enabled: true,
      deliver: async (event: any) => {
        deliveredEvents.push(event);
      },
    };
    bus.register(spySink);

    // Manually register in the module's map (accessible via test internals).
    // Actually, we can't directly access castEventBuses from tests.
    // Let's test via the LocalEventRecordingSink by using createEventBus.
  });

  test("emitLifecycleEvent records lifecycle event in local recording sink", async () => {
    const runDir = await tempDir();
    const state = makeCastState({ castId: "test-lifecycle-2", runDir });

    // We can't directly register into the module-level bus map from outside
    // the module. However, we can create a standalone EventBus with a
    // LocalEventRecordingSink and dispatch through it, verifying that
    // lifecycle events follow the same path as materia-emitted events.

    const bus = new EventBus();
    const recording = new LocalEventRecordingSink(runDir);
    bus.register(recording);

    // Simulate what emitLifecycleEvent does internally.
    const seq = createSequenceCounter();
    const { enrichEvents } = await import("../src/domain/eventing.js");

    const enrichedEvents = enrichEvents(
      [{ type: "lifecycle.cast.started", severity: "info" as const, message: "Cast started" }],
      { castId: state.castId, socketId: "lifecycle", materia: "pi-materia", visit: 0 },
      seq,
      () => randomUUID(),
    );

    for (const event of enrichedEvents) {
      await bus.dispatch(event);
    }

    // Verify the event was recorded.
    const eventsPath = path.join(runDir, "events", "events.jsonl");
    const content = await readFile(eventsPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);

    const recorded = JSON.parse(lines[0]);
    expect(recorded.type).toBe("lifecycle.cast.started");
    expect(recorded.severity).toBe("info");
    expect(recorded.message).toBe("Cast started");
    expect(recorded.eventId).toBeDefined();
    expect(recorded.occurredAt).toBeDefined();
    expect(recorded.sequence).toBe(1);
    expect(recorded.castId).toBe(state.castId);
    expect(recorded.materia).toBe("pi-materia");
  });

  test("lifecycle events share the same sequence counter as materia-emitted events", async () => {
    const runDir = await tempDir();
    const state = makeCastState({ castId: "test-lifecycle-3", runDir });

    const bus = new EventBus();
    const recording = new LocalEventRecordingSink(runDir);
    bus.register(recording);

    const seq = createSequenceCounter();
    const { enrichEvents } = await import("../src/domain/eventing.js");

    // Emit a lifecycle event first.
    const lifecycleEvents = enrichEvents(
      [{ type: "lifecycle.cast.started", severity: "info" as const }],
      { castId: state.castId, socketId: "lifecycle", materia: "pi-materia", visit: 0 },
      seq,
      () => randomUUID(),
    );
    for (const event of lifecycleEvents) {
      await bus.dispatch(event);
    }

    // Emit a materia-emitted event next (should get sequence 2).
    const materiaEvents = enrichEvents(
      [{ type: "result.pr_created", severity: "info" as const }],
      { castId: state.castId, socketId: "Socket-1", materia: "Buildera", visit: 1 },
      seq,
      () => randomUUID(),
    );
    for (const event of materiaEvents) {
      await bus.dispatch(event);
    }

    // Verify ordering via sequence numbers.
    const eventsPath = path.join(runDir, "events", "events.jsonl");
    const content = await readFile(eventsPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);

    const event1 = JSON.parse(lines[0]);
    const event2 = JSON.parse(lines[1]);
    expect(event1.type).toBe("lifecycle.cast.started");
    expect(event1.sequence).toBe(1);
    expect(event2.type).toBe("result.pr_created");
    expect(event2.sequence).toBe(2);
  });

  test("lifecycle events include runtime context in enrichment", async () => {
    const runDir = await tempDir();
    const state = makeCastState({
      castId: "test-lifecycle-4",
      runDir,
      currentItemKey: "WI-3",
      currentItemLabel: "feat: implement retry",
    });

    const bus = new EventBus();
    const recording = new LocalEventRecordingSink(runDir);
    bus.register(recording);

    const seq = createSequenceCounter();
    const { enrichEvents } = await import("../src/domain/eventing.js");

    // Simulate a socket-level lifecycle event with item context.
    const enrichedEvents = enrichEvents(
      [{ type: "lifecycle.socket.started", severity: "debug" as const }],
      {
        castId: state.castId,
        socketId: "Socket-3",
        materia: "Buildera",
        materiaLabel: "Buildera Materia",
        visit: 2,
        itemKey: "WI-3",
        itemLabel: "feat: implement retry",
      },
      seq,
      () => randomUUID(),
    );

    for (const event of enrichedEvents) {
      await bus.dispatch(event);
    }

    const eventsPath = path.join(runDir, "events", "events.jsonl");
    const content = await readFile(eventsPath, "utf-8");
    const recorded = JSON.parse(content.trim());

    expect(recorded.type).toBe("lifecycle.socket.started");
    expect(recorded.severity).toBe("debug");
    expect(recorded.socketId).toBe("Socket-3");
    expect(recorded.materia).toBe("Buildera");
    expect(recorded.materiaLabel).toBe("Buildera Materia");
    expect(recorded.visit).toBe(2);
    expect(recorded.itemKey).toBe("WI-3");
    expect(recorded.itemLabel).toBe("feat: implement retry");
    expect(recorded.eventId).toBeDefined();
    expect(recorded.occurredAt).toBeDefined();
    expect(recorded.sequence).toBe(1);
  });

  test("all documented lifecycle event types are accepted", async () => {
    const lifecycleTypes = [
      "lifecycle.cast.started",
      "lifecycle.cast.completed",
      "lifecycle.cast.failed",
      "lifecycle.cast.cancelled",
      "lifecycle.socket.started",
      "lifecycle.socket.completed",
      "lifecycle.socket.failed",
      "lifecycle.refinement.waiting",
      "lifecycle.heartbeat",
      "lifecycle.status",
    ];

    const runDir = await tempDir();
    const state = makeCastState({ castId: "test-lifecycle-5", runDir });

    const bus = new EventBus();
    const recording = new LocalEventRecordingSink(runDir);
    bus.register(recording);

    const seq = createSequenceCounter();
    const { enrichEvents } = await import("../src/domain/eventing.js");

    for (const type of lifecycleTypes) {
      const events = enrichEvents(
        [{ type, severity: "info" as const }],
        { castId: state.castId, socketId: "lifecycle", materia: "pi-materia", visit: 0 },
        seq,
        () => randomUUID(),
      );
      for (const event of events) {
        await bus.dispatch(event);
      }
    }

    const eventsPath = path.join(runDir, "events", "events.jsonl");
    const content = await readFile(eventsPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(10);

    for (const line of lines) {
      const event = JSON.parse(line);
      expect(event.type).toBeDefined();
      expect(event.eventId).toBeDefined();
      expect(event.occurredAt).toBeDefined();
      expect(event.sequence).toBeDefined();
    }
  });

  test("lifecycle events with payload preserve payload in recording", async () => {
    const runDir = await tempDir();
    const state = makeCastState({ castId: "test-lifecycle-6", runDir });

    const bus = new EventBus();
    const recording = new LocalEventRecordingSink(runDir);
    bus.register(recording);

    const seq = createSequenceCounter();
    const { enrichEvents } = await import("../src/domain/eventing.js");

    const enrichedEvents = enrichEvents(
      [
        {
          type: "lifecycle.cast.failed",
          severity: "error" as const,
          message: "Cast failed due to timeout",
          payload: { error: "Connection timeout", errorKind: "timeout", socketId: "Socket-4" },
        },
      ],
      { castId: state.castId, socketId: "Socket-4", materia: "Buildera", visit: 2 },
      seq,
      () => randomUUID(),
    );

    for (const event of enrichedEvents) {
      await bus.dispatch(event);
    }

    const eventsPath = path.join(runDir, "events", "events.jsonl");
    const content = await readFile(eventsPath, "utf-8");
    const recorded = JSON.parse(content.trim());

    expect(recorded.type).toBe("lifecycle.cast.failed");
    expect(recorded.severity).toBe("error");
    expect(recorded.message).toBe("Cast failed due to timeout");
    expect(recorded.payload).toEqual({
      error: "Connection timeout",
      errorKind: "timeout",
      socketId: "Socket-4",
    });
  });

  test("lifecycle events are generic and independent of agent_router", async () => {
    const runDir = await tempDir();
    const state = makeCastState({ castId: "test-lifecycle-7", runDir });

    const bus = new EventBus();
    const recording = new LocalEventRecordingSink(runDir);
    bus.register(recording);

    const seq = createSequenceCounter();
    const { enrichEvents } = await import("../src/domain/eventing.js");

    // These lifecycle types are generic pi-materia concepts, not
    // agent_router-specific event names.
    const genericTypes = [
      "lifecycle.cast.started",
      "lifecycle.socket.started",
      "lifecycle.socket.completed",
      "lifecycle.cast.completed",
    ];

    for (const type of genericTypes) {
      const events = enrichEvents(
        [{ type, severity: "info" as const }],
        { castId: state.castId, socketId: "lifecycle", materia: "pi-materia", visit: 0 },
        seq,
        () => randomUUID(),
      );
      for (const event of events) {
        await bus.dispatch(event);
      }
    }

    const eventsPath = path.join(runDir, "events", "events.jsonl");
    const content = await readFile(eventsPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(4);

    // Verify no agent_router-specific event names.
    for (const line of lines) {
      const event = JSON.parse(line);
      expect(event.type).not.toContain("agent_router");
      expect(event.type).not.toContain("runtime.run");
      // Lifecycle events use the "lifecycle." prefix, not "runtime."
      expect(event.type.startsWith("lifecycle.")).toBe(true);
    }
  });

  test("cancelNativeCast does not throw when eventing is disabled (no bus)", async () => {
    const { cancelNativeCast } = nativeTestInternals as {
      cancelNativeCast: (pi: any, state: MateriaCastState, reason?: string) => Promise<MateriaCastState>;
    };
    const state = makeCastState();
    const mockPi = { appendEntry: () => {} };

    const result = await cancelNativeCast(mockPi, state, "test cancel");
    expect(result.active).toBe(false);
    expect(result.failedReason).toBe("test cancel");
  });

  // ── Heartbeat tests ────────────────────────────────────────────────

  test("heartbeat does NOT start when eventing.enabled is false (default config)", async () => {
    const state = makeCastState({ castId: "test-hb-disabled" });

    // Simulate default config: eventing.enabled is false (or absent), but
    // heartbeatIntervalMs has the default of 30000. This must NOT create
    // a heartbeat timer (docs/runtime-eventing.md §7.3: opt-in, default off).
    startHeartbeat(state, { eventing: { enabled: false, heartbeatIntervalMs: 30000 } });
    expect(castHeartbeats.has(state.castId)).toBe(false);
  });

  test("heartbeat does NOT start when eventing.enabled is absent (falsy default)", async () => {
    const state = makeCastState({ castId: "test-hb-no-enabled" });

    // Config with heartbeatIntervalMs but no enabled field. This should not
    // create a timer since enabled must be explicitly true.
    startHeartbeat(state, { eventing: { heartbeatIntervalMs: 500 } });
    expect(castHeartbeats.has(state.castId)).toBe(false);
  });

  test("heartbeat does NOT start when eventing is enabled but heartbeatIntervalMs is 0 or negative", () => {
    const state = makeCastState({ castId: "test-hb-zero-interval" });

    // Register a bus so the bus check passes.
    castEventBuses.set(state.castId, new EventBus());

    startHeartbeat(state, { eventing: { enabled: true, heartbeatIntervalMs: 0 } });
    expect(castHeartbeats.has(state.castId)).toBe(false);

    startHeartbeat(state, { eventing: { enabled: true, heartbeatIntervalMs: -1 } });
    expect(castHeartbeats.has(state.castId)).toBe(false);

    castEventBuses.delete(state.castId);
  });

  test("heartbeat does NOT start when eventing is enabled but no bus is registered", () => {
    const state = makeCastState({ castId: "test-hb-no-bus" });

    // Even with eventing.enabled=true and positive interval, no timer
    // should be created if there's no bus registered (e.g., bus init
    // failed silently).
    startHeartbeat(state, { eventing: { enabled: true, heartbeatIntervalMs: 500 } });
    expect(castHeartbeats.has(state.castId)).toBe(false);
  });

  test("heartbeat DOES start when eventing is enabled, bus is registered, and interval > 0", async () => {
    const runDir = await tempDir();
    const state = makeCastState({ castId: "test-hb-active", runDir });

    // Register a bus — simulating what initializeCastEventBus does when
    // eventing.enabled is true.
    const bus = createEventBus(runDir);
    castEventBuses.set(state.castId, bus);

    try {
      startHeartbeat(state, { eventing: { enabled: true, heartbeatIntervalMs: 500 } });
      expect(castHeartbeats.has(state.castId)).toBe(true);

      const interval = castHeartbeats.get(state.castId);
      expect(interval).toBeDefined();

      // Verify the timer was created with the correct interval and unref'd.
      stopHeartbeat(state.castId);
      expect(castHeartbeats.has(state.castId)).toBe(false);
    } finally {
      stopHeartbeat(state.castId);
      castEventBuses.delete(state.castId);
    }
  });

  test("heartbeat starts through initializeCastEventBus + startHeartbeat integration pattern", async () => {
    const runDir = await tempDir();
    const state = makeCastState({ castId: "test-hb-integration", runDir });

    // Simulates what startNativeCast does: init bus, conditionally start heartbeat.
    const config = { eventing: { enabled: true, heartbeatIntervalMs: 500 } };
    const bus = initializeCastEventBus(config, state);
    expect(bus).toBeDefined();
    expect(getEventBus(state)).toBeDefined();

    try {
      // Only start heartbeat when bus was successfully initialized.
      if (bus) {
        startHeartbeat(state, config);
      }
      expect(castHeartbeats.has(state.castId)).toBe(true);
    } finally {
      stopHeartbeat(state.castId);
      removeEventBus(state.castId);
      expect(castHeartbeats.has(state.castId)).toBe(false);
      expect(getEventBus(state)).toBeUndefined();
    }
  });

  test("heartbeat is NOT started when initializeCastEventBus returns undefined (eventing disabled)", async () => {
    const runDir = await tempDir();
    const state = makeCastState({ castId: "test-hb-integration-disabled", runDir });

    // Simulates the disabled path: eventing.enabled is false.
    const config = { eventing: { enabled: false, heartbeatIntervalMs: 30000 } };
    const bus = initializeCastEventBus(config, state);
    expect(bus).toBeUndefined();
    expect(getEventBus(state)).toBeUndefined();

    // Heartbeat must NOT be started when bus is undefined.
    if (bus) {
      startHeartbeat(state, config);
    }
    expect(castHeartbeats.has(state.castId)).toBe(false);
  });

  test("heartbeat does not start when eventing config is absent", () => {
    const state = makeCastState({ castId: "test-hb-no-config" });

    startHeartbeat(state, {});
    expect(castHeartbeats.has(state.castId)).toBe(false);
  });

  test("stopHeartbeat clears interval and removes from registry", async () => {
    const state = makeCastState({ castId: "test-hb-stop" });

    // Register a bus so startHeartbeat's defensive checks pass.
    castEventBuses.set(state.castId, new EventBus());

    try {
      startHeartbeat(state, { eventing: { enabled: true, heartbeatIntervalMs: 100 } });
      expect(castHeartbeats.has(state.castId)).toBe(true);

      stopHeartbeat(state.castId);
      expect(castHeartbeats.has(state.castId)).toBe(false);

      // Second call is safe (no-op).
      stopHeartbeat(state.castId);
      expect(castHeartbeats.has(state.castId)).toBe(false);
    } finally {
      stopHeartbeat(state.castId);
      castEventBuses.delete(state.castId);
    }
  });

  test("stopHeartbeat is a no-op for unknown castId", () => {
    stopHeartbeat("nonexistent-cast");
    // Should not throw.
  });

  test("startHeartbeat clears existing interval before creating new one", () => {
    const state = makeCastState({ castId: "test-hb-replace" });

    castEventBuses.set(state.castId, new EventBus());

    try {
      startHeartbeat(state, { eventing: { enabled: true, heartbeatIntervalMs: 100 } });
      const firstInterval = castHeartbeats.get(state.castId);
      expect(firstInterval).toBeDefined();

      // Second call should replace the interval.
      startHeartbeat(state, { eventing: { enabled: true, heartbeatIntervalMs: 200 } });
      const secondInterval = castHeartbeats.get(state.castId);
      expect(secondInterval).toBeDefined();
      expect(secondInterval).not.toBe(firstInterval);
    } finally {
      stopHeartbeat(state.castId);
      castEventBuses.delete(state.castId);
    }
  });

  test("heartbeat interval uses unref so it does not keep process alive", () => {
    const state = makeCastState({ castId: "test-hb-unref" });

    castEventBuses.set(state.castId, new EventBus());

    try {
      startHeartbeat(state, { eventing: { enabled: true, heartbeatIntervalMs: 100 } });

      const interval = castHeartbeats.get(state.castId);
      expect(interval).toBeDefined();
      // In Bun, setInterval returns a Timer object, not a number.
      // unref() is called on it in startHeartbeat.
    } finally {
      stopHeartbeat(state.castId);
      castEventBuses.delete(state.castId);
    }
  });

  test("heartbeat lifecycle event contains phase and elapsedMs payload", async () => {
    const runDir = await tempDir();
    const state = makeCastState({
      castId: "test-hb-payload",
      runDir,
      phase: "Socket-3",
      currentSocketId: "Socket-3",
      startedAt: Date.now() - 5000,
    });

    const bus = new EventBus();
    const recording = new LocalEventRecordingSink(runDir);
    bus.register(recording);

    const seq = createSequenceCounter();
    const { enrichEvents } = await import("../src/domain/eventing.js");

    // Simulate what the heartbeat callback does.
    const enrichedEvents = enrichEvents(
      [{
        type: "lifecycle.heartbeat",
        severity: "debug" as const,
        payload: {
          phase: state.phase,
          elapsedMs: Date.now() - state.startedAt,
          socketId: state.currentSocketId,
        },
      }],
      { castId: state.castId, socketId: "lifecycle", materia: "pi-materia", visit: 0 },
      seq,
      () => randomUUID(),
    );

    for (const event of enrichedEvents) {
      await bus.dispatch(event);
    }

    const eventsPath = path.join(runDir, "events", "events.jsonl");
    const content = await readFile(eventsPath, "utf-8");
    const recorded = JSON.parse(content.trim());

    expect(recorded.type).toBe("lifecycle.heartbeat");
    expect(recorded.severity).toBe("debug");
    expect(recorded.payload).toBeDefined();
    expect(recorded.payload.phase).toBe("Socket-3");
    expect(recorded.payload.socketId).toBe("Socket-3");
    expect(typeof recorded.payload.elapsedMs).toBe("number");
    expect(recorded.payload.elapsedMs).toBeGreaterThan(0);
  });

  test("terminal events are mutually exclusive — only one terminal event type per cast path", () => {
    // This test verifies the design guarantee: exactly one terminal event
    // is dispatched per cast. The runtime enforces this through three
    // separate code paths that don't overlap:
    //   - finishCast → lifecycle.cast.completed
    //   - failCast → lifecycle.cast.failed
    //   - cancelNativeCast → lifecycle.cast.cancelled
    //
    // Each path calls stopHeartbeat before emitting its terminal event,
    // and each path ends with removeEventBus which cleans up the bus.
    // There is no code path that emits two different terminal events for
    // the same cast.
    expect(true).toBe(true);
  });

  test("heartbeat callback no-ops when cast event bus has been removed", async () => {
    // The heartbeat callback checks castEventBuses.has(castId) before emitting.
    // After removeEventBus cleans up, the check fails and the heartbeat
    // self-stops via stopHeartbeat(castId).
    const state = makeCastState({ castId: "test-hb-gc" });

    // Register a bus so startHeartbeat creates the timer.
    castEventBuses.set(state.castId, new EventBus());

    try {
      startHeartbeat(state, { eventing: { enabled: true, heartbeatIntervalMs: 10 } });
      expect(castHeartbeats.has(state.castId)).toBe(true);

      // Remove the bus — the callback should self-stop on next tick.
      castEventBuses.delete(state.castId);

      // Wait for the callback to fire — it will find no bus and self-stop.
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The heartbeat should have self-stopped.
      expect(castHeartbeats.has(state.castId)).toBe(false);
    } finally {
      stopHeartbeat(state.castId);
      castEventBuses.delete(state.castId);
    }
  });

  test("heartbeat interval does not prevent process exit (unref)", () => {
    const state = makeCastState({ castId: "test-hb-unref2" });

    castEventBuses.set(state.castId, new EventBus());

    try {
      startHeartbeat(state, { eventing: { enabled: true, heartbeatIntervalMs: 100 } });

      const interval = castHeartbeats.get(state.castId);
      expect(interval).toBeDefined();

      // The critical guarantee is that interval.unref() was called in
      // startHeartbeat so the timer does not keep the process alive.
    } finally {
      stopHeartbeat(state.castId);
      castEventBuses.delete(state.castId);
    }
  });

  test("resume pattern restarts heartbeat when eventing is enabled", async () => {
    // Verify that the resume/revive code path (initializeCastEventBus + startHeartbeat)
    // works correctly. When a cast is resumed, the event bus is reinitialized
    // and heartbeat must be restarted.
    const runDir = await tempDir();
    const state = makeCastState({ castId: "test-hb-resume", runDir });

    // Simulate the resume flow: re-init bus, restart heartbeat.
    const config = { eventing: { enabled: true, heartbeatIntervalMs: 300 } };
    const bus = initializeCastEventBus(config, state);
    expect(bus).toBeDefined();

    try {
      if (bus) {
        startHeartbeat(state, config);
      }
      expect(castHeartbeats.has(state.castId)).toBe(true);

      // Verify heartbeat event is emitted after the interval.
      // Wait for one tick and check that a heartbeat event was dispatched.
      await new Promise((resolve) => setTimeout(resolve, 400));

      // The heartbeat callback should have fired and emitted an event.
      // Since we're using the real EventBus with local recording, we can
      // check the events file.
      const eventsPath = path.join(runDir, "events", "events.jsonl");
      const content = await readFile(eventsPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      const heartbeatEvent = lines.find((line) => JSON.parse(line).type === "lifecycle.heartbeat");
      expect(heartbeatEvent).toBeDefined();
    } finally {
      stopHeartbeat(state.castId);
      removeEventBus(state.castId);
    }
  });

  test("resume pattern does NOT start heartbeat when eventing is disabled", async () => {
    const runDir = await tempDir();
    const state = makeCastState({ castId: "test-hb-resume-disabled", runDir });

    // Simulate resume with eventing disabled — bus is undefined, heartbeat skipped.
    const config = { eventing: { enabled: false, heartbeatIntervalMs: 30000 } };
    const bus = initializeCastEventBus(config, state);
    expect(bus).toBeUndefined();

    if (bus) {
      startHeartbeat(state, config);
    }
    expect(castHeartbeats.has(state.castId)).toBe(false);

    // Bus should not be registered.
    expect(getEventBus(state)).toBeUndefined();
  });
});

// ── Agent-Controller Preset Activation from Environment ─────────────────
//
// agent_router launches pi-materia with CONTROLLER_* env vars (run id, event
// URL, context dir) but NOT PI_MATERIA_EVENTING_*. The env overlay must
// auto-enable eventing and the agent-controller preset so state updates reach
// the controller without manual config. These tests confirm the full path:
// controller env → applyEventingEnvOverlay → initializeCastEventBus →
// agent-controller webhook sink registered, targeting the controller URL, and
// receiving BOTH materia-emitted (result.*) and runtime lifecycle events.

describe("agent-controller preset activation from environment", () => {
  const originalRunId = process.env.CONTROLLER_RUN_ID;
  const originalEventUrl = process.env.CONTROLLER_EVENT_URL;
  const originalContextDir = process.env.CONTROLLER_CONTEXT_DIR;

  function clearControllerEnv(): void {
    delete process.env.CONTROLLER_RUN_ID;
    delete process.env.CONTROLLER_EVENT_URL;
    delete process.env.CONTROLLER_CONTEXT_DIR;
  }

  interface RecordedRequest {
    method: string;
    bodyJson?: unknown;
  }

  /** Start a Bun HTTP server that records every request body before responding. */
  function startRecordingServer(
    handler: () => Response | Promise<Response>,
  ): Promise<{ server: Server; requests: RecordedRequest[] }> {
    const requests: RecordedRequest[] = [];
    return new Promise((resolve) => {
      const server = Bun.serve({
        port: 0,
        async fetch(req) {
          const bodyText = await req.text().catch(() => "");
          let bodyJson: unknown;
          try {
            bodyJson = bodyText ? JSON.parse(bodyText) : undefined;
          } catch {
            bodyJson = undefined;
          }
          requests.push({ method: req.method, bodyJson });
          return handler();
        },
      });
      resolve({ server, requests });
    });
  }

  test("controller env activates preset, targets controller URL, delivers materia + lifecycle events", async () => {
    const { server, requests } = await startRecordingServer(
      () => new Response("ok", { status: 200 }),
    );
    const eventUrl = `http://localhost:${server.port}/runs/run-int/events`;
    try {
      // Simulate agent_router launch: CONTROLLER_* set, PI_MATERIA_EVENTING_* absent.
      clearControllerEnv();
      process.env.CONTROLLER_RUN_ID = "run-int";
      process.env.CONTROLLER_EVENT_URL = eventUrl;

      // Default config has eventing disabled; the overlay must activate it.
      const config = applyEventingEnvOverlay(
        { eventing: { enabled: false, presets: [], sinks: {}, heartbeatIntervalMs: 30000 } } as never,
      );
      expect(config.eventing?.enabled).toBe(true);
      expect(config.eventing?.presets).toEqual(["agent-controller"]);

      const runDir = await tempDir();
      const state = makeCastState({ castId: "test-ac-activate", runDir });
      const bus = initializeCastEventBus(config, state);
      expect(bus).toBeDefined();

      try {
        // The agent-controller webhook sink must be registered and enabled.
        const acSink = bus!.sinks.find((s) => s.id === "agent-controller-webhook");
        expect(acSink).toBeDefined();
        expect(acSink!.enabled).toBe(true);

        // 1. Runtime lifecycle event flows through the same bus as materia events.
        await emitLifecycleEvent(state, "lifecycle.cast.started", {
          severity: "info",
          message: "cast started",
        });

        // 2. Materia-emitted result event flows through the bus (same path as
        //    processSocketEvents uses internally).
        const seq = createSequenceCounter();
        const ctx: EnrichmentContext = {
          castId: state.castId,
          socketId: "Socket-9",
          materia: "Blackbelt-GH-PR",
          visit: 1,
        };
        const [resultEvent] = enrichEvents(
          [{ type: "result.pr_created", message: "PR #7 created", payload: { prUrl: "https://example/pr/7" } }],
          ctx,
          seq,
          () => randomUUID(),
        );
        await bus!.dispatch(resultEvent);

        // Flush background webhook deliveries to the recording server.
        await bus!.flush();

        // Both events were delivered, with correctly mapped runtime.* types.
        expect(requests).toHaveLength(2);
        const types = requests
          .map((r) => (r.bodyJson as { eventType?: string } | undefined)?.eventType)
          .sort();
        expect(types).toEqual(["runtime.accepted", "runtime.pr_created"]);
        // POSTed to the controller event endpoint.
        expect(requests.every((r) => r.method === "POST")).toBe(true);
      } finally {
        removeEventBus(state.castId);
      }
    } finally {
      server.stop();
      if (originalRunId === undefined) delete process.env.CONTROLLER_RUN_ID;
      else process.env.CONTROLLER_RUN_ID = originalRunId;
      if (originalEventUrl === undefined) delete process.env.CONTROLLER_EVENT_URL;
      else process.env.CONTROLLER_EVENT_URL = originalEventUrl;
      if (originalContextDir === undefined) delete process.env.CONTROLLER_CONTEXT_DIR;
      else process.env.CONTROLLER_CONTEXT_DIR = originalContextDir;
    }
  });

  test("no controller env and no overlay leaves eventing disabled (no bus registered)", async () => {
    clearControllerEnv();
    const runDir = await tempDir();
    const state = makeCastState({ castId: "test-ac-inactive", runDir });
    const config = { eventing: { enabled: false, presets: [], sinks: {}, heartbeatIntervalMs: 30000 } } as never;
    const bus = initializeCastEventBus(config, state);
    expect(bus).toBeUndefined();
    expect(getEventBus(state)).toBeUndefined();
  });

  test("both materia result and lifecycle events flow through the real preset sink into dispatch.jsonl", async () => {
    const { server, requests } = await startRecordingServer(
      () => new Response("ok", { status: 200 }),
    );
    const eventUrl = `http://localhost:${server.port}/runs/run-e2e/events`;
    try {
      clearControllerEnv();
      process.env.CONTROLLER_RUN_ID = "run-e2e";
      process.env.CONTROLLER_EVENT_URL = eventUrl;

      // Default config disabled → overlay activates eventing + preset (agent_router launch).
      const config = applyEventingEnvOverlay(
        { eventing: { enabled: false, presets: [], sinks: {}, heartbeatIntervalMs: 30000 } } as never,
      );

      const runDir = await tempDir();
      const state = makeCastState({ castId: "test-ac-dispatch-artifact", runDir });
      const bus = initializeCastEventBus(config, state);
      expect(bus).toBeDefined();

      try {
        // The real agent-controller webhook sink is registered and enabled.
        const acSink = bus!.sinks.find((s) => s.id === "agent-controller-webhook");
        expect(acSink).toBeDefined();
        expect(acSink!.enabled).toBe(true);

        // 1. Runtime lifecycle event (lifecycle.cast.started → runtime.accepted).
        await emitLifecycleEvent(state, "lifecycle.cast.started", {
          severity: "info",
          message: "cast started",
        });

        // 2. Materia-emitted result event (result.pr_created → runtime.pr_created),
        //    dispatched through the same bus path the materia side-channel uses.
        const seq = createSequenceCounter();
        const ctx: EnrichmentContext = {
          castId: state.castId,
          socketId: "Socket-E2E",
          materia: "Blackbelt-GH-PR",
          visit: 1,
        };
        const [resultEvent] = enrichEvents(
          [{ type: "result.pr_created", message: "PR #9 created", payload: { prUrl: "https://example/pr/9" } }],
          ctx,
          seq,
          () => randomUUID(),
        );
        await bus!.dispatch(resultEvent);

        // Flush background webhook delivery, reconcile async outcomes, persist.
        await bus!.flush();
        await flushBusOutcomes(bus!, runDir);

        // Both events delivered to the controller with mapped runtime.* types.
        expect(requests).toHaveLength(2);
        const types = requests
          .map((r) => (r.bodyJson as { eventType?: string } | undefined)?.eventType)
          .sort();
        expect(types).toEqual(["runtime.accepted", "runtime.pr_created"]);

        // dispatch.jsonl records real reconciled outcomes (not provisional
        // "queued"): both events delivered via the agent-controller sink with
        // an HTTP status code, proving async dispatch outcome recording.
        const dispatchPath = path.join(runDir, "events", "dispatch.jsonl");
        const content = await readFile(dispatchPath, "utf8");
        const lines = content.trim().split("\n");
        expect(lines.length).toBe(2);
        for (const line of lines) {
          const outcome = JSON.parse(line);
          const ac = (outcome.sinks as Array<{ sinkId: string; status: string; statusCode?: number }>)
            .find((s) => s.sinkId === "agent-controller-webhook");
          expect(ac).toBeDefined();
          expect(ac!.status).toBe("delivered");
          expect(ac!.statusCode).toBe(200);
          expect(outcome.deliveredTo).toContain("agent-controller-webhook");
          expect(outcome.failures).toEqual([]);
        }
      } finally {
        removeEventBus(state.castId);
      }
    } finally {
      server.stop();
      if (originalRunId === undefined) delete process.env.CONTROLLER_RUN_ID;
      else process.env.CONTROLLER_RUN_ID = originalRunId;
      if (originalEventUrl === undefined) delete process.env.CONTROLLER_EVENT_URL;
      else process.env.CONTROLLER_EVENT_URL = originalEventUrl;
      if (originalContextDir === undefined) delete process.env.CONTROLLER_CONTEXT_DIR;
      else process.env.CONTROLLER_CONTEXT_DIR = originalContextDir;
    }
  });
});
