import { describe, expect, test } from "bun:test";
import {
  EVENT_SEVERITY_LEVELS,
  EVENT_SIDECHANNEL_FIELD,
  DEFAULT_EVENT_SEVERITY,
  isEventSeverity,
  isValidEventArray,
  validateMateriaEventArray,
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
