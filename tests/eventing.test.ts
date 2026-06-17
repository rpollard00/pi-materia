import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  EVENT_SEVERITY_LEVELS,
  EVENT_SIDECHANNEL_FIELD,
  DEFAULT_EVENT_SEVERITY,
  SequenceCounter,
  createSequenceCounter,
  enrichEvents,
  isEventSeverity,
  isValidEventArray,
  validateMateriaEventArray,
  type EnrichedEvent,
  type EnrichmentContext,
  type MateriaEventObject,
} from "../src/domain/eventing.js";

describe("event model constants", () => {
  test("EVENT_SIDECHANNEL_FIELD is exactly 'event'", () => {
    expect(EVENT_SIDECHANNEL_FIELD).toBe("event");
  });

  test("EVENT_SEVERITY_LEVELS has all five levels in order", () => {
    expect(EVENT_SEVERITY_LEVELS).toEqual(["debug", "info", "warning", "error", "critical"]);
  });

  test("DEFAULT_EVENT_SEVERITY is 'info'", () => {
    expect(DEFAULT_EVENT_SEVERITY).toBe("info");
  });
});

describe("isEventSeverity", () => {
  test.each(["debug", "info", "warning", "error", "critical"])(
    "recognizes valid severity: %s",
    (s) => {
      expect(isEventSeverity(s)).toBe(true);
    },
  );

  test.each(["unknown", "fatal", "", "INFO", "Info", "Debug "])(
    "rejects invalid severity: %s",
    (s) => {
      expect(isEventSeverity(s)).toBe(false);
    },
  );

  test("rejects non-string values", () => {
    expect(isEventSeverity(42 as unknown as string)).toBe(false);
    expect(isEventSeverity(null as unknown as string)).toBe(false);
  });
});

describe("validateMateriaEventArray", () => {
  // ── Absent / null / empty ───────────────────────────────────────────
  test("returns empty array when event is undefined", () => {
    const result = validateMateriaEventArray(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  test("returns empty array when event is null", () => {
    const result = validateMateriaEventArray(null);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  test("accepts an empty array", () => {
    const result = validateMateriaEventArray([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  // ── Valid single events ──────────────────────────────────────────────
  test("accepts a minimal event with only type", () => {
    const event = [{ type: "status.progress" }];
    const result = validateMateriaEventArray(event);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0].type).toBe("status.progress");
      expect(result.value[0].severity).toBeUndefined();
    }
  });

  test("accepts a complete event with all fields", () => {
    const event: MateriaEventObject[] = [
      {
        type: "result.pr_created",
        severity: "info",
        message: "PR #42 created for retry handling",
        payload: {
          prUrl: "https://github.com/org/repo/pull/42",
          branchName: "agent/42-add-retry",
          baseBranch: "main",
        },
        source: {
          materia: "Blackbelt-GH-PR",
          socketId: "Socket-7",
        },
      },
    ];
    const result = validateMateriaEventArray(event);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      const evt = result.value[0];
      expect(evt.type).toBe("result.pr_created");
      expect(evt.severity).toBe("info");
      expect(evt.message).toBe("PR #42 created for retry handling");
      expect(evt.payload).toEqual({
        prUrl: "https://github.com/org/repo/pull/42",
        branchName: "agent/42-add-retry",
        baseBranch: "main",
      });
      expect(evt.source).toEqual({
        materia: "Blackbelt-GH-PR",
        socketId: "Socket-7",
      });
    }
  });

  // ── Multiple events ──────────────────────────────────────────────────
  test("accepts multiple events in array order", () => {
    const events = [
      { type: "status.progress", message: "Starting" },
      { type: "result.pr_created", message: "PR #1 created" },
    ];
    const result = validateMateriaEventArray(events);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0].type).toBe("status.progress");
      expect(result.value[1].type).toBe("result.pr_created");
    }
  });

  // ── Severity variants ────────────────────────────────────────────────
  test.each(EVENT_SEVERITY_LEVELS)("accepts severity: %s", (severity) => {
    const result = validateMateriaEventArray([{ type: "test", severity }]);
    expect(result.ok).toBe(true);
  });

  // ── Forward compatibility: unknown fields ────────────────────────────
  test("allows unknown fields on event objects (forward-compatible)", () => {
    const event = [{ type: "test", extraField: "anything", nested: { ok: true } }];
    const result = validateMateriaEventArray(event);
    expect(result.ok).toBe(true);
  });

  // ── source with partial fields ───────────────────────────────────────
  test("accepts source with only materia", () => {
    const event = [{ type: "test", source: { materia: "my-materia" } }];
    const result = validateMateriaEventArray(event);
    expect(result.ok).toBe(true);
  });

  test("accepts source with only socketId", () => {
    const event = [{ type: "test", source: { socketId: "Socket-3" } }];
    const result = validateMateriaEventArray(event);
    expect(result.ok).toBe(true);
  });

  // ── Non-array event ──────────────────────────────────────────────────
  test("rejects event that is not an array", () => {
    const result = validateMateriaEventArray({ type: "test" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("$.event");
      expect(result.issues[0].message).toContain("must be an array");
    }
  });

  test("rejects event that is a string", () => {
    const result = validateMateriaEventArray("not an array");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("$.event");
    }
  });

  // ── Missing type ─────────────────────────────────────────────────────
  test("rejects event object missing type field", () => {
    const result = validateMateriaEventArray([{ message: "no type here" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("$.event[0].type");
      expect(result.issues[0].message).toContain("type");
    }
  });

  test("rejects event object with empty string type", () => {
    const result = validateMateriaEventArray([{ type: "" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("$.event[0].type");
    }
  });

  test("rejects event object with whitespace-only type", () => {
    const result = validateMateriaEventArray([{ type: "   " }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("$.event[0].type");
    }
  });

  test("rejects event object with non-string type", () => {
    const result = validateMateriaEventArray([{ type: 42 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("$.event[0].type");
    }
  });

  // ── Invalid severity ─────────────────────────────────────────────────
  test("rejects invalid severity value", () => {
    const result = validateMateriaEventArray([{ type: "test", severity: "fatal" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("$.event[0].severity");
      expect(result.issues[0].message).toContain("severity");
      expect(result.issues[0].message).toContain("debug");
    }
  });

  // ── Invalid message ──────────────────────────────────────────────────
  test("rejects non-string message", () => {
    const result = validateMateriaEventArray([{ type: "test", message: 123 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("$.event[0].message");
    }
  });

  // ── Invalid payload ─────────────────────────────────────────────────
  test("rejects non-object payload", () => {
    const result = validateMateriaEventArray([{ type: "test", payload: "not an object" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("$.event[0].payload");
    }
  });

  test("rejects array payload (must be plain object)", () => {
    const result = validateMateriaEventArray([{ type: "test", payload: [1, 2, 3] }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("$.event[0].payload");
    }
  });

  test("accepts null payload (null is absent, not set)", () => {
    // null is a valid way to explicitly clear a field in some JSON contexts.
    // Our validator treats it as "present but not a plain object", which is fine.
    // Actually, we should check: does the spec say anything about null?
    // The spec says "payload (if present) must be a plain object". null is not a plain object.
    const result = validateMateriaEventArray([{ type: "test", payload: null }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("$.event[0].payload");
    }
  });

  // ── Invalid source ──────────────────────────────────────────────────
  test("rejects non-object source", () => {
    const result = validateMateriaEventArray([{ type: "test", source: "not object" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("$.event[0].source");
    }
  });

  test("rejects non-string source.materia", () => {
    const result = validateMateriaEventArray([{ type: "test", source: { materia: 42 } }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("$.event[0].source.materia");
    }
  });

  test("rejects non-string source.socketId", () => {
    const result = validateMateriaEventArray([{ type: "test", source: { socketId: true } }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("$.event[0].source.socketId");
    }
  });

  // ── Non-object element ───────────────────────────────────────────────
  test("rejects a non-object element in the array", () => {
    const result = validateMateriaEventArray(["not an object"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("$.event[0]");
      expect(result.issues[0].message).toContain("plain object");
    }
  });

  test("rejects a null element in the array", () => {
    const result = validateMateriaEventArray([null]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("$.event[0]");
      expect(result.issues[0].message).toContain("plain object");
    }
  });

  // ── Mixed valid/invalid elements ─────────────────────────────────────
  test("reports issues for invalid elements but does not lose valid ones", () => {
    const events = [
      { type: "valid.one" },
      { message: "missing type" },
      { type: "valid.two" },
    ];
    const result = validateMateriaEventArray(events);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // One issue for the invalid middle element (missing type)
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].path).toBe("$.event[1].type");
    }
  });

  test("reports all issues for multiple invalid elements", () => {
    const events = [
      { type: "valid" },
      { message: "missing type", severity: "fatal" },
      { type: "" },
    ];
    const result = validateMateriaEventArray(events);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Issues for element 1: missing type, invalid severity
      // Issues for element 2: empty type
      expect(result.issues.length).toBeGreaterThanOrEqual(3);
    }
  });

  // ── result.* naming conventions ──────────────────────────────────────
  test("accepts documented result event types", () => {
    const types = [
      "result.pr_created",
      "result.branch_pushed",
      "result.no_changes_needed",
      "result.needs_human",
    ];
    for (const type of types) {
      const result = validateMateriaEventArray([{ type }]);
      expect(result.ok).toBe(true);
    }
  });

  // ── status.* naming conventions ──────────────────────────────────────
  test("accepts documented status event types", () => {
    const types = ["status.progress", "status.info"];
    for (const type of types) {
      const result = validateMateriaEventArray([{ type }]);
      expect(result.ok).toBe(true);
    }
  });

  // ── error.* naming conventions ───────────────────────────────────────
  test("accepts error event types", () => {
    const types = ["error.validation_failed", "error.timeout"];
    for (const type of types) {
      const result = validateMateriaEventArray([{ type }]);
      expect(result.ok).toBe(true);
    }
  });
});

describe("isValidEventArray", () => {
  test("returns false for undefined", () => {
    expect(isValidEventArray(undefined)).toBe(false);
  });

  test("returns false for null", () => {
    expect(isValidEventArray(null)).toBe(false);
  });

  test("returns false for non-array", () => {
    expect(isValidEventArray({ type: "test" })).toBe(false);
  });

  test("returns true for empty array", () => {
    expect(isValidEventArray([])).toBe(true);
  });

  test("returns true for valid event array", () => {
    expect(isValidEventArray([{ type: "test" }])).toBe(true);
  });

  test("returns false for array with invalid element", () => {
    expect(isValidEventArray([{ type: "" }])).toBe(false);
  });

  test("returns false for array with non-object element", () => {
    expect(isValidEventArray(["bad"])).toBe(false);
  });
});

// ── SequenceCounter ─────────────────────────────────────────────────────

describe("SequenceCounter", () => {
  test("starts at 1", () => {
    const seq = new SequenceCounter();
    expect(seq.peek()).toBe(1);
  });

  test("nextValue returns consecutive numbers", () => {
    const seq = new SequenceCounter();
    expect(seq.nextValue()).toBe(1);
    expect(seq.nextValue()).toBe(2);
    expect(seq.nextValue()).toBe(3);
    expect(seq.nextValue()).toBe(4);
    expect(seq.nextValue()).toBe(5);
  });

  test("peek does not advance", () => {
    const seq = new SequenceCounter();
    expect(seq.peek()).toBe(1);
    expect(seq.peek()).toBe(1);
    expect(seq.peek()).toBe(1);
    expect(seq.nextValue()).toBe(1);
    expect(seq.peek()).toBe(2);
  });

  test("reset returns to 1", () => {
    const seq = new SequenceCounter();
    seq.nextValue();
    seq.nextValue();
    seq.nextValue();
    expect(seq.peek()).toBe(4);
    seq.reset();
    expect(seq.peek()).toBe(1);
    expect(seq.nextValue()).toBe(1);
  });

  test("two separate counters are independent", () => {
    const a = new SequenceCounter();
    const b = new SequenceCounter();
    expect(a.nextValue()).toBe(1);
    expect(b.nextValue()).toBe(1);
    expect(a.nextValue()).toBe(2);
    expect(b.nextValue()).toBe(2);
  });

  test("createSequenceCounter factory produces independent counters", () => {
    const a = createSequenceCounter();
    const b = createSequenceCounter();
    a.nextValue(); // 1
    a.nextValue(); // 2
    expect(b.nextValue()).toBe(1);
    expect(b.peek()).toBe(2);
  });
});

// ── Enrichment ──────────────────────────────────────────────────────────

describe("enrichEvents", () => {
  const baseCtx: EnrichmentContext = {
    castId: "2026-06-16T22-00-00-000Z",
    socketId: "Socket-7",
    materia: "Blackbelt-GH-PR",
    materiaLabel: "GitHub PR Creator",
    visit: 2,
    itemKey: "WI-3",
    itemLabel: "feat: implement retry logic",
  };

  function freshSeq(): SequenceCounter {
    const seq = new SequenceCounter();
    seq.reset();
    return seq;
  }

  /** Real UUID generator for integration-style tests. */
  function generateEventId(): string {
    return randomUUID();
  }

  // ── Basic enrichment ─────────────────────────────────────────────────
  test("enriches a single minimal event", () => {
    const events: MateriaEventObject[] = [{ type: "status.progress" }];
    const seq = freshSeq();
    const result = enrichEvents(events, baseCtx, seq, generateEventId);

    expect(result).toHaveLength(1);
    const evt = result[0];

    // Original fields preserved
    expect(evt.type).toBe("status.progress");
    expect(evt.severity).toBe("info"); // default

    // Enriched fields
    expect(evt.eventId).toBeString();
    expect(evt.eventId.length).toBeGreaterThan(0);
    expect(evt.occurredAt).toBeString();
    // ISO 8601 roughly: contains T or starts with a date pattern
    expect(evt.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(evt.sequence).toBe(1);
    expect(evt.castId).toBe(baseCtx.castId);
    expect(evt.socketId).toBe(baseCtx.socketId);
    expect(evt.materia).toBe(baseCtx.materia);
    expect(evt.materiaLabel).toBe(baseCtx.materiaLabel);
    expect(evt.visit).toBe(baseCtx.visit);
    expect(evt.itemKey).toBe(baseCtx.itemKey);
    expect(evt.itemLabel).toBe(baseCtx.itemLabel);
  });

  test("enriches a complete event with all fields", () => {
    const events: MateriaEventObject[] = [
      {
        type: "result.pr_created",
        severity: "info",
        message: "PR #42 created for retry handling",
        payload: {
          prUrl: "https://github.com/org/repo/pull/42",
          branchName: "agent/42-add-retry",
          baseBranch: "main",
        },
        source: {
          materia: "Blackbelt-GH-PR",
          socketId: "Socket-7",
        },
      },
    ];
    const seq = freshSeq();
    const result = enrichEvents(events, baseCtx, seq, generateEventId);

    expect(result).toHaveLength(1);
    const evt = result[0];

    // Original fields
    expect(evt.type).toBe("result.pr_created");
    expect(evt.severity).toBe("info");
    expect(evt.message).toBe("PR #42 created for retry handling");
    expect(evt.payload).toEqual({
      prUrl: "https://github.com/org/repo/pull/42",
      branchName: "agent/42-add-retry",
      baseBranch: "main",
    });
    expect(evt.source).toEqual({
      materia: "Blackbelt-GH-PR",
      socketId: "Socket-7",
    });

    // Enriched fields present
    expect(evt.eventId).toBeString();
    expect(evt.occurredAt).toBeString();
    expect(evt.sequence).toBe(1);
  });

  // ── Empty array ──────────────────────────────────────────────────────
  test("empty input returns empty output", () => {
    const seq = freshSeq();
    const result = enrichEvents([], baseCtx, seq, generateEventId);
    expect(result).toEqual([]);
    // Counter not advanced
    expect(seq.peek()).toBe(1);
  });

  // ── Deterministic ordering ───────────────────────────────────────────
  test("preserves input array order", () => {
    const events: MateriaEventObject[] = [
      { type: "first" },
      { type: "second" },
      { type: "third" },
      { type: "fourth" },
    ];
    const seq = freshSeq();
    const result = enrichEvents(events, baseCtx, seq, generateEventId);

    expect(result).toHaveLength(4);
    expect(result[0].type).toBe("first");
    expect(result[0].sequence).toBe(1);
    expect(result[1].type).toBe("second");
    expect(result[1].sequence).toBe(2);
    expect(result[2].type).toBe("third");
    expect(result[2].sequence).toBe(3);
    expect(result[3].type).toBe("fourth");
    expect(result[3].sequence).toBe(4);
  });

  test("order and sequencing matches input position", () => {
    const events: MateriaEventObject[] = [
      { type: "z" },
      { type: "a" },
      { type: "m" },
    ];
    const seq = freshSeq();
    const result = enrichEvents(events, baseCtx, seq, generateEventId);

    // Types match input order (z, a, m)
    expect(result.map((e) => e.type)).toEqual(["z", "a", "m"]);
    // Sequences are monotonic (1, 2, 3)
    expect(result.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  // ── Monotonic per-cast sequence ──────────────────────────────────────
  test("shared sequence counter spans enrichment calls", () => {
    const seq = freshSeq();

    const batch1 = enrichEvents(
      [{ type: "batch1.a" }, { type: "batch1.b" }],
      baseCtx,
      seq,
      generateEventId,
    );
    expect(batch1[0].sequence).toBe(1);
    expect(batch1[1].sequence).toBe(2);

    const batch2 = enrichEvents(
      [{ type: "batch2.a" }],
      { ...baseCtx, socketId: "Socket-8", visit: 3 },
      seq,
      generateEventId,
    );
    expect(batch2[0].sequence).toBe(3);

    const batch3 = enrichEvents(
      [{ type: "batch3.a" }, { type: "batch3.b" }, { type: "batch3.c" }],
      baseCtx,
      seq,
      generateEventId,
    );
    expect(batch3[0].sequence).toBe(4);
    expect(batch3[1].sequence).toBe(5);
    expect(batch3[2].sequence).toBe(6);

    expect(seq.peek()).toBe(7);
  });

  test("sequence numbers are always increasing within a batch", () => {
    const events: MateriaEventObject[] = Array.from({ length: 100 }, (_, i) => ({
      type: `event.${i}`,
    }));
    const seq = freshSeq();
    const result = enrichEvents(events, baseCtx, seq, generateEventId);

    for (let i = 0; i < result.length; i++) {
      expect(result[i].sequence).toBe(i + 1);
    }
  });

  // ── Unique eventId per event ─────────────────────────────────────────
  test("each event gets a unique eventId", () => {
    const events: MateriaEventObject[] = [
      { type: "a" },
      { type: "b" },
      { type: "c" },
      { type: "d" },
      { type: "e" },
    ];
    const seq = freshSeq();
    const result = enrichEvents(events, baseCtx, seq, generateEventId);

    const ids = result.map((e) => e.eventId);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(5);
  });

  test("eventIds are UUID v4 format", () => {
    const events: MateriaEventObject[] = [{ type: "test" }];
    const seq = freshSeq();
    const result = enrichEvents(events, baseCtx, seq, generateEventId);

    // UUID v4 pattern: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    expect(result[0].eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  // ── occurredAt timestamps ────────────────────────────────────────────
  test("all events in a batch share the same occurredAt timestamp", () => {
    const events: MateriaEventObject[] = [
      { type: "a" },
      { type: "b" },
      { type: "c" },
    ];
    const seq = freshSeq();
    const result = enrichEvents(events, baseCtx, seq, generateEventId);

    const timestamps = result.map((e) => e.occurredAt);
    expect(new Set(timestamps).size).toBe(1);
    expect(timestamps[0]).toBeString();
    // ISO 8601 pattern
    expect(timestamps[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(timestamps[0]).toContain("Z");
    // Verify it parseable as Date
    expect(() => new Date(timestamps[0])).not.toThrow();
    expect(isNaN(new Date(timestamps[0]).getTime())).toBe(false);
  });

  test("different enrichment calls produce different timestamps", async () => {
    const seq = freshSeq();
    const batch1 = enrichEvents([{ type: "first" }], baseCtx, seq, generateEventId);

    // Small delay to ensure different timestamp
    await new Promise((resolve) => setTimeout(resolve, 2));

    const batch2 = enrichEvents([{ type: "second" }], baseCtx, seq, generateEventId);

    expect(batch1[0].occurredAt).not.toBe(batch2[0].occurredAt);
  });

  // ── Optional context fields ──────────────────────────────────────────
  test("omits materiaLabel when not provided", () => {
    const ctx: EnrichmentContext = {
      castId: "cast-1",
      socketId: "Socket-1",
      materia: "Test-Materia",
      visit: 1,
    };
    const seq = freshSeq();
    const result = enrichEvents([{ type: "test" }], ctx, seq, generateEventId);

    expect(result[0]).not.toHaveProperty("materiaLabel");
  });

  test("omits itemKey and itemLabel when not provided", () => {
    const ctx: EnrichmentContext = {
      castId: "cast-1",
      socketId: "Socket-1",
      materia: "Test-Materia",
      visit: 2,
    };
    const seq = freshSeq();
    const result = enrichEvents([{ type: "test" }], ctx, seq, generateEventId);

    expect(result[0]).not.toHaveProperty("itemKey");
    expect(result[0]).not.toHaveProperty("itemLabel");
  });

  // ── Default severity applied ─────────────────────────────────────────
  test("applies default severity when event omits it", () => {
    const seq = freshSeq();
    const result = enrichEvents([{ type: "test" }], baseCtx, seq, generateEventId);
    expect(result[0].severity).toBe("info");
  });

  test("preserves explicit severity from input", () => {
    const seq = freshSeq();
    const result = enrichEvents(
      [{ type: "test", severity: "critical" }],
      baseCtx,
      seq,
      generateEventId,
    );
    expect(result[0].severity).toBe("critical");
  });

  test("each severity level is preserved through enrichment", () => {
    for (const severity of EVENT_SEVERITY_LEVELS) {
      const seq = freshSeq();
      const result = enrichEvents(
        [{ type: "test", severity }],
        baseCtx,
        seq,
        generateEventId,
      );
      expect(result[0].severity).toBe(severity);
    }
  });

  // ── TypeScript type assertion ────────────────────────────────────────
  test("returned events satisfy EnrichedEvent type", () => {
    const events: MateriaEventObject[] = [{ type: "status.progress" }];
    const seq = freshSeq();
    const result: EnrichedEvent[] = enrichEvents(events, baseCtx, seq, generateEventId);

    // Just a type-level check — if it compiles, this passes.
    // We also verify runtime shape.
    expect(result).toHaveLength(1);
    for (const evt of result) {
      expect(typeof evt.eventId).toBe("string");
      expect(typeof evt.occurredAt).toBe("string");
      expect(typeof evt.sequence).toBe("number");
    }
  });

  // ── Forward-compatible unknown fields preserved ─────────────────────
  test("known fields are fully preserved", () => {
    const event: MateriaEventObject = {
      type: "result.pr_created",
      severity: "warning",
      message: "A message",
      payload: { key: "value" },
      source: { materia: "src-m" },
    };
    const seq = freshSeq();
    const result = enrichEvents([event], baseCtx, seq, generateEventId);

    expect(result[0].type).toBe("result.pr_created");
    expect(result[0].severity).toBe("warning");
    expect(result[0].message).toBe("A message");
    expect(result[0].payload).toEqual({ key: "value" });
    expect(result[0].source).toEqual({ materia: "src-m" });
  });

  // ── Regression: forward-compatible unknown fields survive enrichment ─
  test("unknown fields survive enrichment per §2.4", () => {
    // Simulate a validated event object that carries extra forward-compat fields.
    // At runtime these survive validation because the validator does not strip them.
    const event = {
      type: "result.pr_created",
      message: "PR #42 created",
      // Forward-compatible unknown fields
      extraField: "anything",
      nested: { ok: true },
      futureFlag: 42,
      customTags: ["a", "b"],
    } as MateriaEventObject;

    const seq = freshSeq();
    const result = enrichEvents([event], baseCtx, seq, generateEventId);

    expect(result).toHaveLength(1);
    const enriched = result[0];

    // Known fields preserved
    expect(enriched.type).toBe("result.pr_created");
    expect(enriched.message).toBe("PR #42 created");

    // Unknown fields must survive (per §2.4)
    expect((enriched as Record<string, unknown>).extraField).toBe("anything");
    expect((enriched as Record<string, unknown>).nested).toEqual({ ok: true });
    expect((enriched as Record<string, unknown>).futureFlag).toBe(42);
    expect((enriched as Record<string, unknown>).customTags).toEqual(["a", "b"]);

    // Runtime-enriched fields must also be present
    expect(enriched.eventId).toBeString();
    expect(enriched.occurredAt).toBeString();
    expect(enriched.sequence).toBe(1);
    expect(enriched.castId).toBe(baseCtx.castId);
  });

  // ── Determinism ──────────────────────────────────────────────────────
  test("same inputs produce same enriched fields (except eventId and occurredAt)", () => {
    const events: MateriaEventObject[] = [
      { type: "a", message: "msg-a", payload: { x: 1 } },
      { type: "b", message: "msg-b", payload: { y: 2 } },
    ];

    const seq1 = freshSeq();
    const result1 = enrichEvents(events, baseCtx, seq1, generateEventId);

    const seq2 = freshSeq();
    const result2 = enrichEvents(events, baseCtx, seq2, generateEventId);

    expect(result1).toHaveLength(2);
    expect(result2).toHaveLength(2);

    // eventId and occurredAt will differ, but everything else should match
    for (const key of [
      "type",
      "severity",
      "message",
      "payload",
      "source",
      "sequence",
      "castId",
      "socketId",
      "materia",
      "materiaLabel",
      "visit",
      "itemKey",
      "itemLabel",
    ] as const) {
      expect(result1[0][key]).toEqual(result2[0][key]);
      expect(result1[1][key]).toEqual(result2[1][key]);
    }
  });
});
