import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  type EnrichedEvent,
  type EventSink,
  enrichEvents,
  createSequenceCounter,
  type EnrichmentContext,
} from "../src/domain/eventing.js";
import {
  EventBus,
  LocalEventRecordingSink,
  createEventBus,
  appendDispatchOutcomes,
  flushBusOutcomes,
  type DispatchOutcome,
} from "../src/runtime/eventBus.js";

// ── Helpers ─────────────────────────────────────────────────────────────

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "pi-materia-eventbus-"));
}

const baseCtx: EnrichmentContext = {
  castId: "2026-06-16T22-00-00-000Z",
  socketId: "Socket-7",
  materia: "Blackbelt-GH-PR",
  materiaLabel: "GitHub PR Creator",
  visit: 2,
  itemKey: "WI-3",
  itemLabel: "feat: implement retry logic",
};

function freshSeq(): ReturnType<typeof createSequenceCounter> {
  const seq = createSequenceCounter();
  seq.reset();
  return seq;
}

function makeEvent(
  overrides: Partial<EnrichedEvent> = {},
): EnrichedEvent {
  const seq = freshSeq();
  const [event] = enrichEvents(
    [{ type: "test.event", message: "test message" }],
    baseCtx,
    seq,
    () => randomUUID(),
  );
  return { ...event, ...overrides } as EnrichedEvent;
}

// ── EventBus ─────────────────────────────────────────────────────────────

describe("EventBus", () => {
  test("starts with no sinks and empty outcomes", () => {
    const bus = new EventBus();
    expect(bus.sinks).toEqual([]);
    expect(bus.outcomes).toEqual([]);
  });

  test("register adds sinks in order", () => {
    const bus = new EventBus();
    const sinkA = { id: "a", enabled: true, deliver: async () => {} };
    const sinkB = { id: "b", enabled: true, deliver: async () => {} };
    bus.register(sinkA);
    bus.register(sinkB);

    expect(bus.sinks).toHaveLength(2);
    expect(bus.sinks[0].id).toBe("a");
    expect(bus.sinks[1].id).toBe("b");
  });

  test("sinks returns a defensive copy", () => {
    const bus = new EventBus();
    const sink = { id: "a", enabled: true, deliver: async () => {} };
    bus.register(sink);

    const snapshot = bus.sinks;
    expect(snapshot).toHaveLength(1);

    // Mutating the snapshot does not affect the bus
    (snapshot as EventSink[]).push(sink);
    expect(bus.sinks).toHaveLength(1);
  });

  test("outcomes returns a defensive copy", () => {
    const bus = new EventBus();
    (bus.outcomes as DispatchOutcome[]).push({
      eventId: "fake",
      deliveredTo: [],
      failures: [],
      occurredAt: new Date().toISOString(),
    });
    expect(bus.outcomes).toEqual([]);
  });

  // ── Dispatch ─────────────────────────────────────────────────────────
  test("dispatches to all enabled sinks", async () => {
    const bus = new EventBus();
    const deliveredA: EnrichedEvent[] = [];
    const deliveredB: EnrichedEvent[] = [];

    bus.register({
      id: "a",
      enabled: true,
      deliver: async (e) => { deliveredA.push(e); },
    });
    bus.register({
      id: "b",
      enabled: true,
      deliver: async (e) => { deliveredB.push(e); },
    });

    const event = makeEvent();
    const outcome = await bus.dispatch(event);

    expect(deliveredA).toHaveLength(1);
    expect(deliveredA[0].eventId).toBe(event.eventId);
    expect(deliveredB).toHaveLength(1);
    expect(deliveredB[0].eventId).toBe(event.eventId);

    expect(outcome.eventId).toBe(event.eventId);
    expect(outcome.deliveredTo).toEqual(["a", "b"]);
    expect(outcome.failures).toEqual([]);
    expect(outcome.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(bus.outcomes).toHaveLength(1);
    expect(bus.outcomes[0].eventId).toBe(event.eventId);
  });

  test("skips disabled sinks", async () => {
    const bus = new EventBus();
    const delivered: EnrichedEvent[] = [];

    bus.register({
      id: "enabled-sink",
      enabled: true,
      deliver: async (e) => { delivered.push(e); },
    });
    bus.register({
      id: "disabled-sink",
      enabled: false,
      deliver: async () => { throw new Error("should not be called"); },
    });

    const event = makeEvent();
    const outcome = await bus.dispatch(event);

    expect(delivered).toHaveLength(1);
    expect(outcome.deliveredTo).toEqual(["enabled-sink"]);
    expect(outcome.failures).toEqual([]);
  });

  test("captures sink failure without throwing", async () => {
    const bus = new EventBus();
    const delivered: EnrichedEvent[] = [];

    bus.register({
      id: "good-sink",
      enabled: true,
      deliver: async (e) => { delivered.push(e); },
    });
    bus.register({
      id: "bad-sink",
      enabled: true,
      deliver: async () => { throw new Error("delivery failed"); },
    });

    const event = makeEvent();
    const outcome = await bus.dispatch(event);

    expect(delivered).toHaveLength(1);
    expect(outcome.deliveredTo).toEqual(["good-sink"]);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0].sinkId).toBe("bad-sink");
    expect(outcome.failures[0].error).toBe("delivery failed");
  });

  test("multiple sink failures are all captured", async () => {
    const bus = new EventBus();
    bus.register({
      id: "fail-a",
      enabled: true,
      deliver: async () => { throw new Error("error A"); },
    });
    bus.register({
      id: "fail-b",
      enabled: true,
      deliver: async () => { throw new Error("error B"); },
    });

    const event = makeEvent();
    const outcome = await bus.dispatch(event);

    expect(outcome.deliveredTo).toEqual([]);
    expect(outcome.failures).toHaveLength(2);
    expect(outcome.failures[0].sinkId).toBe("fail-a");
    expect(outcome.failures[0].error).toBe("error A");
    expect(outcome.failures[1].sinkId).toBe("fail-b");
    expect(outcome.failures[1].error).toBe("error B");
  });

  test("dispatch to later sinks continues after an earlier failure", async () => {
    const bus = new EventBus();
    const delivered: EnrichedEvent[] = [];

    bus.register({
      id: "fail-first",
      enabled: true,
      deliver: async () => { throw new Error("first fails"); },
    });
    bus.register({
      id: "succeed-second",
      enabled: true,
      deliver: async (e) => { delivered.push(e); },
    });
    bus.register({
      id: "fail-third",
      enabled: true,
      deliver: async () => { throw new Error("third fails"); },
    });

    const event = makeEvent();
    const outcome = await bus.dispatch(event);

    expect(delivered).toHaveLength(1);
    expect(delivered[0].eventId).toBe(event.eventId);
    expect(outcome.deliveredTo).toEqual(["succeed-second"]);
    expect(outcome.failures).toHaveLength(2);
  });

  test("dispatch accumulates outcomes across multiple events", async () => {
    const bus = new EventBus();
    bus.register({ id: "sink", enabled: true, deliver: async () => {} });

    const e1 = makeEvent();
    const e2 = makeEvent();
    const e3 = makeEvent();

    await bus.dispatch(e1);
    await bus.dispatch(e2);
    await bus.dispatch(e3);

    expect(bus.outcomes).toHaveLength(3);
    expect(bus.outcomes.map((o) => o.eventId)).toEqual([
      e1.eventId,
      e2.eventId,
      e3.eventId,
    ]);
  });

  // ── Error message redaction ──────────────────────────────────────────
  test("redacts error messages in failure records (no stack traces)", async () => {
    const bus = new EventBus();
    bus.register({
      id: "error-sink",
      enabled: true,
      deliver: async () => {
        const err = new Error("network timeout");
        err.stack = "/home/user/projects/secret-token-abc123/infra.ts:42:10";
        throw err;
      },
    });

    const outcome = await bus.dispatch(makeEvent());
    expect(outcome.failures[0].error).toBe("network timeout");
    expect(outcome.failures[0].error).not.toContain("secret-token");
    expect(outcome.failures[0].error).not.toContain("/home");
    expect(outcome.failures[0].error).not.toContain(".ts:42");
  });

  test("redacts non-Error thrown values", async () => {
    const bus = new EventBus();
    bus.register({
      id: "string-error",
      enabled: true,
      deliver: async () => { throw "raw string error"; },
    });
    bus.register({
      id: "object-error",
      enabled: true,
      deliver: async () => { throw { code: "ERR" }; },
    });

    const outcome = await bus.dispatch(makeEvent());
    expect(outcome.failures[0].error).toBe("raw string error");
    expect(outcome.failures[1].error).toBe("Unknown sink error");
  });

  test("truncates very long error messages", async () => {
    const bus = new EventBus();
    const long = "x".repeat(300);
    bus.register({
      id: "long-error",
      enabled: true,
      deliver: async () => { throw new Error(long); },
    });

    const outcome = await bus.dispatch(makeEvent());
    const error = outcome.failures[0].error;
    expect(error.length).toBeLessThanOrEqual(203); // 200 + "..."
    expect(error).toEndWith("...");
  });

  // ── Flush ────────────────────────────────────────────────────────────
  test("flush calls flush on sinks that support it", async () => {
    const bus = new EventBus();
    let flushedA = false;
    let flushedB = false;

    bus.register({
      id: "a",
      enabled: true,
      deliver: async () => {},
      flush: async () => { flushedA = true; },
    });
    bus.register({
      id: "b",
      enabled: true,
      deliver: async () => {},
      flush: async () => { flushedB = true; },
    });

    await bus.flush();

    expect(flushedA).toBe(true);
    expect(flushedB).toBe(true);
  });

  test("flush skips sinks without flush", async () => {
    const bus = new EventBus();
    let flushed = false;

    bus.register({
      id: "no-flush",
      enabled: true,
      deliver: async () => {},
    });
    bus.register({
      id: "has-flush",
      enabled: true,
      deliver: async () => {},
      flush: async () => { flushed = true; },
    });

    await bus.flush();

    expect(flushed).toBe(true);
  });

  test("flush failures do not throw", async () => {
    const bus = new EventBus();
    bus.register({
      id: "bad-flush",
      enabled: true,
      deliver: async () => {},
      flush: async () => { throw new Error("flush failed"); },
    });

    // Should not throw
    await bus.flush();
  });

  test("flush failure in one sink does not block other sinks", async () => {
    const bus = new EventBus();
    let flushedGood = false;

    bus.register({
      id: "bad",
      enabled: true,
      deliver: async () => {},
      flush: async () => { throw new Error("bad flush"); },
    });
    bus.register({
      id: "good",
      enabled: true,
      deliver: async () => {},
      flush: async () => { flushedGood = true; },
    });

    await bus.flush();

    expect(flushedGood).toBe(true);
  });

  // ── drainOutcomes ────────────────────────────────────────────────────
  test("drainOutcomes returns and clears accumulated outcomes", async () => {
    const bus = new EventBus();
    bus.register({ id: "s", enabled: true, deliver: async () => {} });

    await bus.dispatch(makeEvent());
    await bus.dispatch(makeEvent());

    const drained = bus.drainOutcomes();
    expect(drained).toHaveLength(2);
    expect(bus.outcomes).toEqual([]);
  });

  test("drainOutcomes on empty bus returns empty array", () => {
    const bus = new EventBus();
    expect(bus.drainOutcomes()).toEqual([]);
  });
});

// ── LocalEventRecordingSink ─────────────────────────────────────────────

describe("LocalEventRecordingSink", () => {
  test("has correct id and is always enabled", async () => {
    const dir = await tempDir();
    const sink = new LocalEventRecordingSink(dir);
    expect(sink.id).toBe("local-recording");
    expect(sink.enabled).toBe(true);
  });

  test("eventsPath and eventsDir are under runDir/events", async () => {
    const dir = await tempDir();
    const sink = new LocalEventRecordingSink(dir);
    expect(sink.eventsDir).toBe(path.join(dir, "events"));
    expect(sink.eventsPath).toBe(path.join(dir, "events", "events.jsonl"));
  });

  test("deliver writes event as JSON line to events.jsonl", async () => {
    const dir = await tempDir();
    const sink = new LocalEventRecordingSink(dir);
    const event = makeEvent({ type: "result.pr_created", message: "PR #42" });

    await sink.deliver(event);

    const content = await readFile(sink.eventsPath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.eventId).toBe(event.eventId);
    expect(parsed.type).toBe("result.pr_created");
    expect(parsed.message).toBe("PR #42");
    expect(parsed.sequence).toBe(event.sequence);
    expect(parsed.castId).toBe(event.castId);
  });

  test("deliver appends multiple events as separate lines", async () => {
    const dir = await tempDir();
    const sink = new LocalEventRecordingSink(dir);
    const e1 = makeEvent({ type: "first" });
    const e2 = makeEvent({ type: "second" });
    const e3 = makeEvent({ type: "third" });

    await sink.deliver(e1);
    await sink.deliver(e2);
    await sink.deliver(e3);

    const content = await readFile(sink.eventsPath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);

    const types = lines.map((l) => JSON.parse(l).type);
    expect(types).toEqual(["first", "second", "third"]);
  });

  test("deliver creates the events directory automatically", async () => {
    const dir = await tempDir();
    const sink = new LocalEventRecordingSink(dir);
    const event = makeEvent();

    await sink.deliver(event);

    // Should not throw — directory was created
    await readFile(sink.eventsPath, "utf8");
  });

  test("deliver preserves full enriched event shape including payload", async () => {
    const dir = await tempDir();
    const sink = new LocalEventRecordingSink(dir);
    const event = makeEvent({
      type: "result.pr_created",
      severity: "info",
      message: "PR created",
      payload: { prUrl: "https://github.com/org/repo/pull/42", branchName: "agent/42" },
      source: { materia: "GH-PR", socketId: "Socket-3" },
    });

    await sink.deliver(event);

    const content = await readFile(sink.eventsPath, "utf8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.type).toBe("result.pr_created");
    expect(parsed.payload).toEqual({ prUrl: "https://github.com/org/repo/pull/42", branchName: "agent/42" });
    expect(parsed.source).toEqual({ materia: "GH-PR", socketId: "Socket-3" });
    // Runtime metadata present
    expect(parsed.eventId).toBeString();
    expect(parsed.occurredAt).toBeString();
    expect(parsed.sequence).toBeNumber();
    expect(parsed.castId).toBeString();
  });

  test("recorded events are valid JSON lines (one object per line, no trailing comma)", async () => {
    const dir = await tempDir();
    const sink = new LocalEventRecordingSink(dir);
    const e1 = makeEvent();
    const e2 = makeEvent();

    await sink.deliver(e1);
    await sink.deliver(e2);

    const content = await readFile(sink.eventsPath, "utf8");
    const lines = content.trim().split("\n");

    // Each line must parse as a single JSON object
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toBeObject();
      expect(typeof parsed.eventId).toBe("string");
    }
  });

  test("deliver does not throw for successive writes", async () => {
    const dir = await tempDir();
    const sink = new LocalEventRecordingSink(dir);

    // Write many events in sequence
    for (let i = 0; i < 50; i++) {
      await sink.deliver(makeEvent());
    }

    const content = await readFile(sink.eventsPath, "utf8");
    expect(content.trim().split("\n")).toHaveLength(50);
  });
});

// ── Dispatch Outcome Persistence ────────────────────────────────────────

describe("appendDispatchOutcomes", () => {
  test("writes outcomes as JSON lines to dispatch.jsonl", async () => {
    const dir = await tempDir();
    const outcomes: DispatchOutcome[] = [
      {
        eventId: "evt-1",
        deliveredTo: ["local-recording", "webhook-1"],
        failures: [],
        occurredAt: "2026-06-16T22:00:00.100Z",
      },
      {
        eventId: "evt-2",
        deliveredTo: ["local-recording"],
        failures: [{ sinkId: "webhook-1", error: "timeout" }],
        occurredAt: "2026-06-16T22:00:01.200Z",
      },
    ];

    await appendDispatchOutcomes(dir, outcomes);

    const file = path.join(dir, "events", "dispatch.jsonl");
    const content = await readFile(file, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const parsed1 = JSON.parse(lines[0]);
    expect(parsed1.eventId).toBe("evt-1");
    expect(parsed1.deliveredTo).toEqual(["local-recording", "webhook-1"]);
    expect(parsed1.failures).toEqual([]);

    const parsed2 = JSON.parse(lines[1]);
    expect(parsed2.eventId).toBe("evt-2");
    expect(parsed2.failures).toEqual([{ sinkId: "webhook-1", error: "timeout" }]);
  });

  test("empty outcomes array is a no-op (does not create file)", async () => {
    const dir = await tempDir();
    await appendDispatchOutcomes(dir, []);

    // Should not throw, and dispatch dir may not exist
    const dispatchDir = path.join(dir, "events");
    const fs = await import("node:fs/promises");
    try {
      await fs.stat(dispatchDir);
      // Directory might exist from other operations, but file should not
      const dispatchFile = path.join(dispatchDir, "dispatch.jsonl");
      await fs.stat(dispatchFile);
      expect.unreachable("dispatch.jsonl should not exist");
    } catch (err: unknown) {
      // Expected: directory or file does not exist
      const code = (err as NodeJS.ErrnoException)?.code;
      expect(code === "ENOENT" || code === "ENOTDIR").toBe(true);
    }
  });

  test("appends to existing dispatch.jsonl", async () => {
    const dir = await tempDir();
    await appendDispatchOutcomes(dir, [
      { eventId: "evt-1", deliveredTo: ["sink-a"], failures: [], occurredAt: "2026-06-16T22:00:00Z" },
    ]);
    await appendDispatchOutcomes(dir, [
      { eventId: "evt-2", deliveredTo: ["sink-a"], failures: [], occurredAt: "2026-06-16T22:00:01Z" },
    ]);

    const file = path.join(dir, "events", "dispatch.jsonl");
    const content = await readFile(file, "utf8");
    expect(content.trim().split("\n")).toHaveLength(2);
  });
});

// ── flushBusOutcomes ────────────────────────────────────────────────────

describe("flushBusOutcomes", () => {
  test("writes bus outcomes and clears buffer", async () => {
    const dir = await tempDir();
    const bus = new EventBus();
    bus.register({ id: "sink-a", enabled: true, deliver: async () => {} });

    await bus.dispatch(makeEvent());
    await bus.dispatch(makeEvent());

    expect(bus.outcomes).toHaveLength(2);

    await flushBusOutcomes(bus, dir);

    // Outcomes should be drained
    expect(bus.outcomes).toEqual([]);

    // File should contain the two outcomes
    const file = path.join(dir, "events", "dispatch.jsonl");
    const content = await readFile(file, "utf8");
    expect(content.trim().split("\n")).toHaveLength(2);
  });

  test("empty bus is a no-op", async () => {
    const dir = await tempDir();
    const bus = new EventBus();
    await flushBusOutcomes(bus, dir);

    // Should not throw or create files
    expect(bus.outcomes).toEqual([]);
  });
});

// ── createEventBus factory ──────────────────────────────────────────────

describe("createEventBus", () => {
  test("creates bus with local recording sink registered", async () => {
    const dir = await tempDir();
    const bus = createEventBus(dir);

    expect(bus.sinks).toHaveLength(1);
    expect(bus.sinks[0].id).toBe("local-recording");
    expect(bus.sinks[0].enabled).toBe(true);
  });

  test("dispatches event to local recording sink and writes to events.jsonl", async () => {
    const dir = await tempDir();
    const bus = createEventBus(dir);
    const event = makeEvent({ type: "result.pr_created", message: "PR #99" });

    await bus.dispatch(event);

    // Verify events.jsonl was written
    const eventsPath = path.join(dir, "events", "events.jsonl");
    const content = await readFile(eventsPath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe("result.pr_created");
    expect(parsed.message).toBe("PR #99");
    expect(parsed.eventId).toBe(event.eventId);
  });

  test("dispatch outcome tracks local-recording sink", async () => {
    const dir = await tempDir();
    const bus = createEventBus(dir);
    const event = makeEvent();

    const outcome = await bus.dispatch(event);
    expect(outcome.deliveredTo).toEqual(["local-recording"]);
    expect(outcome.failures).toEqual([]);
  });

  test("multiple events are all recorded", async () => {
    const dir = await tempDir();
    const bus = createEventBus(dir);

    const events = [
      makeEvent({ type: "event.a" }),
      makeEvent({ type: "event.b" }),
      makeEvent({ type: "event.c" }),
    ];

    for (const event of events) {
      await bus.dispatch(event);
    }

    const eventsPath = path.join(dir, "events", "events.jsonl");
    const content = await readFile(eventsPath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);

    const types = lines.map((l) => JSON.parse(l).type);
    expect(types).toEqual(["event.a", "event.b", "event.c"]);
  });

  test("does not interfere with existing events.jsonl at runDir root", async () => {
    const dir = await tempDir();
    const fs = await import("node:fs/promises");
    // Create a fake existing events.jsonl at root (simulating the operational file)
    const existingPath = path.join(dir, "events.jsonl");
    await fs.writeFile(existingPath, '{"ts":1,"type":"cast_start","data":{}}\n');

    const bus = createEventBus(dir);
    await bus.dispatch(makeEvent());

    // Existing events.jsonl should be untouched
    const existingContent = await readFile(existingPath, "utf8");
    expect(existingContent.trim()).toBe('{"ts":1,"type":"cast_start","data":{}}');

    // New events/events.jsonl should exist and contain the runtime event
    const newPath = path.join(dir, "events", "events.jsonl");
    const newContent = await readFile(newPath, "utf8");
    expect(newContent.trim().split("\n")).toHaveLength(1);
  });
});
