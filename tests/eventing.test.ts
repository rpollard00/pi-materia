import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  EVENT_SEVERITY_LEVELS,
  EVENT_SIDECHANNEL_FIELD,
  DEFAULT_EVENT_SEVERITY,
  RESULT_EVENT_PREFIX,
  RESULT_EVENT_TYPES,
  ResultAccumulator,
  SequenceCounter,
  createSequenceCounter,
  enrichEvents,
  isEventSeverity,
  isValidEventArray,
  validateMateriaEventArray,
  type CastFinalOutcome,
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

  // Per §2.2 and §2.4: when the event property exists in parsed JSON but is
  // null, that is an invalid non-array value, not an absent field. The caller
  // (processSocketEvents) only invokes validation after confirming the property
  // exists on the parsed object, so null here means `"event": null` in JSON.
  test("rejects null event (must be an array when property is present)", () => {
    const result = validateMateriaEventArray(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("$.event");
      expect(result.issues[0].message).toContain("must be an array");
    }
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

  // Regression: non-array scalar values for `event` must be rejected (§2.2, §2.4).
  // These occur in JSON like `"event": true`, `"event": 42`, etc.
  test("rejects event that is a boolean", () => {
    const result = validateMateriaEventArray(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("$.event");
      expect(result.issues[0].message).toContain("must be an array");
    }
  });

  test("rejects event that is a boolean false", () => {
    const result = validateMateriaEventArray(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("$.event");
      expect(result.issues[0].message).toContain("must be an array");
    }
  });

  test("rejects event that is a number", () => {
    const result = validateMateriaEventArray(42);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("$.event");
      expect(result.issues[0].message).toContain("must be an array");
    }
  });

  test("rejects event that is a float", () => {
    const result = validateMateriaEventArray(3.14);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("$.event");
      expect(result.issues[0].message).toContain("must be an array");
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

// ── ResultAccumulator ───────────────────────────────────────────────────

/** Minimal enriched-like event shape for accumulator tests. */
function mkEvent(type: string, overrides: Partial<EnrichedEvent> = {}): EnrichedEvent {
  return {
    eventId: `evt-${type}-${Math.random().toString(36).slice(2, 8)}`,
    occurredAt: new Date().toISOString(),
    sequence: 1,
    castId: "test-cast",
    socketId: "Socket-1",
    materia: "Test-Materia",
    visit: 1,
    type,
    severity: "info",
    ...overrides,
  };
}

describe("ResultAccumulator", () => {
  describe("constants", () => {
    test("RESULT_EVENT_PREFIX is 'result.'", () => {
      expect(RESULT_EVENT_PREFIX).toBe("result.");
    });

    test("RESULT_EVENT_TYPES has expected values", () => {
      expect(RESULT_EVENT_TYPES.PR_CREATED).toBe("result.pr_created");
      expect(RESULT_EVENT_TYPES.BRANCH_PUSHED).toBe("result.branch_pushed");
      expect(RESULT_EVENT_TYPES.NO_CHANGES_NEEDED).toBe("result.no_changes_needed");
      expect(RESULT_EVENT_TYPES.NEEDS_HUMAN).toBe("result.needs_human");
    });
  });

  // ── Default outcome (no result events) ───────────────────────────────
  describe("default outcome", () => {
    test("no result events → patch_created", () => {
      const acc = new ResultAccumulator();
      expect(acc.deriveOutcome()).toBe("patch_created");
      expect(acc.hasResults).toBe(false);
      expect(acc.size).toBe(0);
    });

    test("only non-result events → patch_created", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent("status.progress"));
      acc.record(mkEvent("lifecycle.cast.started"));
      acc.record(mkEvent("error.timeout"));
      expect(acc.deriveOutcome()).toBe("patch_created");
      expect(acc.hasResults).toBe(false);
      expect(acc.size).toBe(0);
    });

    test("empty record calls don't change default", () => {
      const acc = new ResultAccumulator();
      // Simulate what happens when no result.* events are emitted.
      expect(acc.deriveOutcome()).toBe("patch_created");
      expect(acc.getResultEvents()).toEqual([]);
    });
  });

  // ── Single result type → corresponding outcome ───────────────────────
  describe("single result type outcome mapping", () => {
    test("pr_created → pull_request_opened", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent(RESULT_EVENT_TYPES.PR_CREATED, {
        message: "PR #42 created",
        payload: { prUrl: "https://github.com/org/repo/pull/42" },
      }));
      expect(acc.deriveOutcome()).toBe("pull_request_opened");
      expect(acc.hasResults).toBe(true);
      expect(acc.size).toBe(1);
    });

    test("branch_pushed → branch_pushed", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent(RESULT_EVENT_TYPES.BRANCH_PUSHED, {
        message: "Branch agent/42 pushed",
      }));
      expect(acc.deriveOutcome()).toBe("branch_pushed");
      expect(acc.hasResults).toBe(true);
      expect(acc.size).toBe(1);
    });

    test("no_changes_needed → no_changes_needed", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent(RESULT_EVENT_TYPES.NO_CHANGES_NEEDED, {
        message: "No changes required",
      }));
      expect(acc.deriveOutcome()).toBe("no_changes_needed");
      expect(acc.hasResults).toBe(true);
      expect(acc.size).toBe(1);
    });

    test("needs_human → needs_human", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent(RESULT_EVENT_TYPES.NEEDS_HUMAN, {
        severity: "warning",
        message: "Ambiguous acceptance criteria",
        payload: { reason: "ambiguous" },
      }));
      expect(acc.deriveOutcome()).toBe("needs_human");
      expect(acc.hasResults).toBe(true);
      expect(acc.size).toBe(1);
    });
  });

  // ── Precedence rules ─────────────────────────────────────────────────
  describe("precedence: PR > branch > no_changes > needs_human > patch_created", () => {
    test("PR + branch → pull_request_opened", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent(RESULT_EVENT_TYPES.BRANCH_PUSHED));
      acc.record(mkEvent(RESULT_EVENT_TYPES.PR_CREATED));
      expect(acc.deriveOutcome()).toBe("pull_request_opened");
    });

    test("branch + PR (reverse order) → pull_request_opened", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent(RESULT_EVENT_TYPES.PR_CREATED));
      acc.record(mkEvent(RESULT_EVENT_TYPES.BRANCH_PUSHED));
      expect(acc.deriveOutcome()).toBe("pull_request_opened");
    });

    test("PR + no_changes_needed → pull_request_opened", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent(RESULT_EVENT_TYPES.NO_CHANGES_NEEDED));
      acc.record(mkEvent(RESULT_EVENT_TYPES.PR_CREATED));
      expect(acc.deriveOutcome()).toBe("pull_request_opened");
    });

    test("PR + needs_human → pull_request_opened", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent(RESULT_EVENT_TYPES.NEEDS_HUMAN));
      acc.record(mkEvent(RESULT_EVENT_TYPES.PR_CREATED));
      expect(acc.deriveOutcome()).toBe("pull_request_opened");
    });

    test("PR + needs_human + no_changes_needed + branch → pull_request_opened", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent(RESULT_EVENT_TYPES.NEEDS_HUMAN));
      acc.record(mkEvent(RESULT_EVENT_TYPES.NO_CHANGES_NEEDED));
      acc.record(mkEvent(RESULT_EVENT_TYPES.BRANCH_PUSHED));
      acc.record(mkEvent(RESULT_EVENT_TYPES.PR_CREATED));
      expect(acc.deriveOutcome()).toBe("pull_request_opened");
    });

    test("branch + no_changes_needed → branch_pushed", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent(RESULT_EVENT_TYPES.NO_CHANGES_NEEDED));
      acc.record(mkEvent(RESULT_EVENT_TYPES.BRANCH_PUSHED));
      expect(acc.deriveOutcome()).toBe("branch_pushed");
    });

    test("branch + needs_human → branch_pushed", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent(RESULT_EVENT_TYPES.NEEDS_HUMAN));
      acc.record(mkEvent(RESULT_EVENT_TYPES.BRANCH_PUSHED));
      expect(acc.deriveOutcome()).toBe("branch_pushed");
    });

    test("no_changes_needed + needs_human → no_changes_needed", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent(RESULT_EVENT_TYPES.NEEDS_HUMAN));
      acc.record(mkEvent(RESULT_EVENT_TYPES.NO_CHANGES_NEEDED));
      expect(acc.deriveOutcome()).toBe("no_changes_needed");
    });

    test("needs_human alone → needs_human", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent(RESULT_EVENT_TYPES.NEEDS_HUMAN));
      expect(acc.deriveOutcome()).toBe("needs_human");
    });
  });

  // ── Last-wins for same type ──────────────────────────────────────────
  describe("last-wins for same type", () => {
    test("two pr_created events → both preserved, last wins for signal", () => {
      const acc = new ResultAccumulator();
      const first = mkEvent(RESULT_EVENT_TYPES.PR_CREATED, {
        message: "PR #1 created",
        payload: { prUrl: "https://github.com/org/repo/pull/1" },
      });
      const second = mkEvent(RESULT_EVENT_TYPES.PR_CREATED, {
        message: "PR #2 created",
        payload: { prUrl: "https://github.com/org/repo/pull/2" },
      });

      acc.record(first);
      acc.record(second);

      expect(acc.deriveOutcome()).toBe("pull_request_opened");
      // All events are preserved in the accumulated history (§10.1).
      expect(acc.size).toBe(2);
      expect(acc.getResultEvents()).toHaveLength(2);
      expect(acc.getResultEvents()[0].message).toBe("PR #1 created");
      expect(acc.getResultEvents()[1].message).toBe("PR #2 created");
      // Last event wins for type-specific lookup and signal derivation (§10.3).
      expect(acc.get(RESULT_EVENT_TYPES.PR_CREATED)?.message).toBe("PR #2 created");
      expect(acc.get(RESULT_EVENT_TYPES.PR_CREATED)?.payload).toEqual({
        prUrl: "https://github.com/org/repo/pull/2",
      });
    });

    test("three branch_pushed events → all preserved, last wins for signal", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent(RESULT_EVENT_TYPES.BRANCH_PUSHED, { message: "branch-1" }));
      acc.record(mkEvent(RESULT_EVENT_TYPES.BRANCH_PUSHED, { message: "branch-2" }));
      acc.record(mkEvent(RESULT_EVENT_TYPES.BRANCH_PUSHED, { message: "branch-3" }));

      expect(acc.deriveOutcome()).toBe("branch_pushed");
      // All three events are preserved.
      expect(acc.size).toBe(3);
      expect(acc.getResultEvents()).toHaveLength(3);
      expect(acc.getResultEvents()[0].message).toBe("branch-1");
      expect(acc.getResultEvents()[2].message).toBe("branch-3");
      // Last event wins for type-specific lookup.
      expect(acc.get(RESULT_EVENT_TYPES.BRANCH_PUSHED)?.message).toBe("branch-3");
    });

    test("multiple needs_human → both preserved, last wins for signal", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent(RESULT_EVENT_TYPES.NEEDS_HUMAN, {
        message: "First issue",
        payload: { reason: "reason-1" },
      }));
      acc.record(mkEvent(RESULT_EVENT_TYPES.NEEDS_HUMAN, {
        message: "Second issue",
        payload: { reason: "reason-2" },
      }));

      expect(acc.deriveOutcome()).toBe("needs_human");
      // Both events are preserved.
      expect(acc.size).toBe(2);
      expect(acc.getResultEvents()).toHaveLength(2);
      expect(acc.getResultEvents()[0].message).toBe("First issue");
      expect(acc.getResultEvents()[1].message).toBe("Second issue");
      // Last event wins for type-specific lookup.
      expect(acc.get(RESULT_EVENT_TYPES.NEEDS_HUMAN)?.message).toBe("Second issue");
      expect(acc.get(RESULT_EVENT_TYPES.NEEDS_HUMAN)?.payload).toEqual({ reason: "reason-2" });
    });
  });

  // ── Complex mixed sequences ──────────────────────────────────────────
  describe("mixed event sequences", () => {
    test("interleaved status + result events", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent("status.progress"));
      acc.record(mkEvent(RESULT_EVENT_TYPES.BRANCH_PUSHED));
      acc.record(mkEvent("status.progress"));
      acc.record(mkEvent(RESULT_EVENT_TYPES.PR_CREATED));
      acc.record(mkEvent("lifecycle.heartbeat"));

      // PR wins over branch
      expect(acc.deriveOutcome()).toBe("pull_request_opened");
      expect(acc.size).toBe(2); // branch + PR
      expect(acc.hasResults).toBe(true);
    });

    test("result events from multiple sockets", () => {
      const acc = new ResultAccumulator();
      // Socket 3 emits branch_pushed
      acc.record(mkEvent(RESULT_EVENT_TYPES.BRANCH_PUSHED, {
        socketId: "Socket-3",
        sequence: 5,
      }));
      // Socket 7 emits pr_created
      acc.record(mkEvent(RESULT_EVENT_TYPES.PR_CREATED, {
        socketId: "Socket-7",
        sequence: 12,
      }));

      expect(acc.deriveOutcome()).toBe("pull_request_opened");
      expect(acc.get(RESULT_EVENT_TYPES.BRANCH_PUSHED)?.socketId).toBe("Socket-3");
      expect(acc.get(RESULT_EVENT_TYPES.PR_CREATED)?.socketId).toBe("Socket-7");
    });

    test("branch_pushed only, with many status events → branch_pushed", () => {
      const acc = new ResultAccumulator();
      for (let i = 0; i < 10; i++) {
        acc.record(mkEvent("status.progress", { message: `Step ${i}` }));
      }
      acc.record(mkEvent(RESULT_EVENT_TYPES.BRANCH_PUSHED));
      for (let i = 0; i < 5; i++) {
        acc.record(mkEvent("status.info", { message: `Cleanup ${i}` }));
      }

      expect(acc.deriveOutcome()).toBe("branch_pushed");
      expect(acc.size).toBe(1);
    });

    test("all four result types recorded → PR wins", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent(RESULT_EVENT_TYPES.NEEDS_HUMAN));
      acc.record(mkEvent(RESULT_EVENT_TYPES.NO_CHANGES_NEEDED));
      acc.record(mkEvent(RESULT_EVENT_TYPES.BRANCH_PUSHED));
      acc.record(mkEvent(RESULT_EVENT_TYPES.PR_CREATED));

      expect(acc.deriveOutcome()).toBe("pull_request_opened");
      expect(acc.size).toBe(4);
    });
  });

  // ── getResultEvents ──────────────────────────────────────────────────
  describe("getResultEvents", () => {
    test("returns empty array when no result events", () => {
      const acc = new ResultAccumulator();
      expect(acc.getResultEvents()).toEqual([]);
    });

    test("returns events in insertion order", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent(RESULT_EVENT_TYPES.BRANCH_PUSHED));
      acc.record(mkEvent(RESULT_EVENT_TYPES.PR_CREATED));

      const results = acc.getResultEvents();
      expect(results).toHaveLength(2);
      expect(results[0].type).toBe(RESULT_EVENT_TYPES.BRANCH_PUSHED);
      expect(results[1].type).toBe(RESULT_EVENT_TYPES.PR_CREATED);
    });

    test("returns all events including duplicates of the same type", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent(RESULT_EVENT_TYPES.BRANCH_PUSHED, { message: "v1" }));
      acc.record(mkEvent(RESULT_EVENT_TYPES.BRANCH_PUSHED, { message: "v2" }));
      acc.record(mkEvent(RESULT_EVENT_TYPES.NO_CHANGES_NEEDED, { message: "nc1" }));

      // All three events are preserved in the accumulated history.
      const results = acc.getResultEvents();
      expect(results).toHaveLength(3);
      expect(results[0].type).toBe(RESULT_EVENT_TYPES.BRANCH_PUSHED);
      expect(results[0].message).toBe("v1");
      expect(results[1].type).toBe(RESULT_EVENT_TYPES.BRANCH_PUSHED);
      expect(results[1].message).toBe("v2");
      expect(results[2].type).toBe(RESULT_EVENT_TYPES.NO_CHANGES_NEEDED);
      expect(results[2].message).toBe("nc1");
    });
  });

  // ── get specific type ────────────────────────────────────────────────
  describe("get by type", () => {
    test("returns event for known type", () => {
      const acc = new ResultAccumulator();
      const event = mkEvent(RESULT_EVENT_TYPES.PR_CREATED, { message: "PR #99" });
      acc.record(event);
      expect(acc.get(RESULT_EVENT_TYPES.PR_CREATED)?.message).toBe("PR #99");
    });

    test("returns undefined for unknown type", () => {
      const acc = new ResultAccumulator();
      expect(acc.get(RESULT_EVENT_TYPES.PR_CREATED)).toBeUndefined();
      expect(acc.get("result.unknown_type")).toBeUndefined();
    });

    test("returns undefined for non-result type", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent("status.progress"));
      expect(acc.get("status.progress")).toBeUndefined();
    });
  });

  // ── Custom result.* types ────────────────────────────────────────────
  describe("custom result.* types", () => {
    test("unknown result types are stored but don't affect default outcome", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent("result.custom_action"));
      expect(acc.hasResults).toBe(true);
      expect(acc.size).toBe(1);
      // Custom result types don't map to a known outcome — patch_created is the fallback.
      expect(acc.deriveOutcome()).toBe("patch_created");
    });

    test("custom result type + known result type → known wins", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent("result.custom_action"));
      acc.record(mkEvent(RESULT_EVENT_TYPES.PR_CREATED));
      expect(acc.deriveOutcome()).toBe("pull_request_opened");
      expect(acc.size).toBe(2);
    });

    test("custom result types are included in getResultEvents", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent("result.custom_action", { message: "custom" }));
      const results = acc.getResultEvents();
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("result.custom_action");
      expect(results[0].message).toBe("custom");
    });
  });

  // ── Reset ────────────────────────────────────────────────────────────
  describe("reset", () => {
    test("clears all accumulated data", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent(RESULT_EVENT_TYPES.PR_CREATED));
      acc.record(mkEvent(RESULT_EVENT_TYPES.BRANCH_PUSHED));
      expect(acc.size).toBe(2);
      expect(acc.hasResults).toBe(true);

      acc.reset();

      expect(acc.size).toBe(0);
      expect(acc.hasResults).toBe(false);
      expect(acc.deriveOutcome()).toBe("patch_created");
      expect(acc.getResultEvents()).toEqual([]);
    });

    test("can accumulate again after reset", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent(RESULT_EVENT_TYPES.PR_CREATED));
      acc.reset();
      acc.record(mkEvent(RESULT_EVENT_TYPES.BRANCH_PUSHED));
      expect(acc.deriveOutcome()).toBe("branch_pushed");
      expect(acc.size).toBe(1);
    });
  });

  // ── hasResults / size ────────────────────────────────────────────────
  describe("hasResults and size", () => {
    test("fresh accumulator has no results", () => {
      const acc = new ResultAccumulator();
      expect(acc.hasResults).toBe(false);
      expect(acc.size).toBe(0);
    });

    test("reflects accumulated result events", () => {
      const acc = new ResultAccumulator();
      expect(acc.hasResults).toBe(false);

      acc.record(mkEvent(RESULT_EVENT_TYPES.BRANCH_PUSHED));
      expect(acc.hasResults).toBe(true);
      expect(acc.size).toBe(1);

      acc.record(mkEvent(RESULT_EVENT_TYPES.PR_CREATED));
      expect(acc.hasResults).toBe(true);
      expect(acc.size).toBe(2);
    });

    test("non-result events do not affect hasResults or size", () => {
      const acc = new ResultAccumulator();
      acc.record(mkEvent("status.progress"));
      acc.record(mkEvent("lifecycle.heartbeat"));
      expect(acc.hasResults).toBe(false);
      expect(acc.size).toBe(0);
    });
  });

  // ── TypeScript type covering ─────────────────────────────────────────
  describe("type coverage", () => {
    test("all CastFinalOutcome values are returned by deriveOutcome", () => {
      const outcomes = new Set<CastFinalOutcome>();

      // patch_created (default)
      outcomes.add(new ResultAccumulator().deriveOutcome());

      // pull_request_opened
      const pr = new ResultAccumulator();
      pr.record(mkEvent(RESULT_EVENT_TYPES.PR_CREATED));
      outcomes.add(pr.deriveOutcome());

      // branch_pushed
      const branch = new ResultAccumulator();
      branch.record(mkEvent(RESULT_EVENT_TYPES.BRANCH_PUSHED));
      outcomes.add(branch.deriveOutcome());

      // no_changes_needed
      const nc = new ResultAccumulator();
      nc.record(mkEvent(RESULT_EVENT_TYPES.NO_CHANGES_NEEDED));
      outcomes.add(nc.deriveOutcome());

      // needs_human
      const nh = new ResultAccumulator();
      nh.record(mkEvent(RESULT_EVENT_TYPES.NEEDS_HUMAN));
      outcomes.add(nh.deriveOutcome());

      // All five outcomes covered.
      expect(outcomes.size).toBe(5);
      expect(outcomes.has("pull_request_opened")).toBe(true);
      expect(outcomes.has("branch_pushed")).toBe(true);
      expect(outcomes.has("no_changes_needed")).toBe(true);
      expect(outcomes.has("needs_human")).toBe(true);
      expect(outcomes.has("patch_created")).toBe(true);
    });

    test("MateriaEventObject accepted by record (non-enriched event)", () => {
      const acc = new ResultAccumulator();
      // record accepts EnrichedEvent | MateriaEventObject
      const plainEvent: MateriaEventObject = {
        type: RESULT_EVENT_TYPES.PR_CREATED,
        message: "PR from plain object",
      };
      acc.record(plainEvent);
      expect(acc.deriveOutcome()).toBe("pull_request_opened");
    });
  });

  // ── Independent instances ────────────────────────────────────────────
  describe("independent instances", () => {
    test("two accumulators are independent", () => {
      const acc1 = new ResultAccumulator();
      const acc2 = new ResultAccumulator();

      acc1.record(mkEvent(RESULT_EVENT_TYPES.PR_CREATED));
      acc2.record(mkEvent(RESULT_EVENT_TYPES.BRANCH_PUSHED));

      expect(acc1.deriveOutcome()).toBe("pull_request_opened");
      expect(acc2.deriveOutcome()).toBe("branch_pushed");
    });
  });
});
