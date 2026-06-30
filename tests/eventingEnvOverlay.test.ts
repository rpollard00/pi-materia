import { describe, expect, test } from "bun:test";
import {
  DOCUMENTED_EVENTING_ENV_VARS,
  EVENTING_ENABLED_ENV,
  EVENTING_HEARTBEAT_MS_ENV,
  EVENTING_PRESETS_ENV,
  readEventingEnvOverlay,
  type EventingEnvSource,
} from "../src/eventing/envOverlay.js";

// ── Documented Variables ────────────────────────────────────────────────

describe("DOCUMENTED_EVENTING_ENV_VARS", () => {
  test("exposes exactly the documented variable names", () => {
    expect(DOCUMENTED_EVENTING_ENV_VARS).toEqual([
      "PI_MATERIA_EVENTING_ENABLED",
      "PI_MATERIA_EVENTING_PRESETS",
      "PI_MATERIA_EVENTING_HEARTBEAT_MS",
    ]);
  });

  test("exported name constants match the documented list", () => {
    expect(EVENTING_ENABLED_ENV).toBe("PI_MATERIA_EVENTING_ENABLED");
    expect(EVENTING_PRESETS_ENV).toBe("PI_MATERIA_EVENTING_PRESETS");
    expect(EVENTING_HEARTBEAT_MS_ENV).toBe("PI_MATERIA_EVENTING_HEARTBEAT_MS");
  });
});

// ── Empty / Unset Handling ──────────────────────────────────────────────

describe("readEventingEnvOverlay — unset and empty values", () => {
  test("returns an empty overlay with no presence when env is empty", () => {
    const result = readEventingEnvOverlay({});
    expect(result.present).toBe(false);
    expect(result.overlay).toEqual({});
    expect(result.diagnostics).toEqual([]);
  });

  test("ignores unset variables", () => {
    const result = readEventingEnvOverlay({ [EVENTING_ENABLED_ENV]: undefined });
    expect(result.present).toBe(false);
    expect(result.overlay).toEqual({});
    expect(result.diagnostics).toEqual([]);
  });

  test("ignores empty/whitespace-only values", () => {
    const result = readEventingEnvOverlay({
      [EVENTING_ENABLED_ENV]: "",
      [EVENTING_PRESETS_ENV]: "   ",
      [EVENTING_HEARTBEAT_MS_ENV]: "\t",
    });
    expect(result.present).toBe(false);
    expect(result.overlay).toEqual({});
    expect(result.diagnostics).toEqual([]);
  });

  test("ignores unknown PI_MATERIA_EVENTING_* variables", () => {
    // Only documented variables are parsed; others are silently ignored.
    const result = readEventingEnvOverlay({
      PI_MATERIA_EVENTING_SINK_URL: "http://example.com/hook",
      PI_MATERIA_EVENTING_FOO: "bar",
      UNRELATED_VAR: "baz",
    } as EventingEnvSource);
    expect(result.present).toBe(false);
    expect(result.overlay).toEqual({});
    expect(result.diagnostics).toEqual([]);
  });
});

// ── enabled Parsing ─────────────────────────────────────────────────────

describe("readEventingEnvOverlay — enabled", () => {
  test.each(["true", "TRUE", "True", "1", "yes", "YES", "on"])("parses truthy value %s", (value) => {
    const result = readEventingEnvOverlay({ [EVENTING_ENABLED_ENV]: value });
    expect(result.present).toBe(true);
    expect(result.overlay.enabled).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  test.each(["false", "FALSE", "0", "no", "No", "off"])("parses falsy value %s", (value) => {
    const result = readEventingEnvOverlay({ [EVENTING_ENABLED_ENV]: value });
    expect(result.present).toBe(true);
    expect(result.overlay.enabled).toBe(false);
    expect(result.diagnostics).toEqual([]);
  });

  test("trims surrounding whitespace", () => {
    const result = readEventingEnvOverlay({ [EVENTING_ENABLED_ENV]: "  true  " });
    expect(result.overlay.enabled).toBe(true);
  });

  test("ignores unrecognized boolean values with a diagnostic", () => {
    const result = readEventingEnvOverlay({ [EVENTING_ENABLED_ENV]: "maybe" });
    expect(result.present).toBe(false);
    expect(result.overlay.enabled).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].varName).toBe(EVENTING_ENABLED_ENV);
    expect(result.diagnostics[0].severity).toBe("warning");
    expect(result.diagnostics[0].message).toContain("PI_MATERIA_EVENTING_ENABLED");
    expect(result.diagnostics[0].message).toContain("maybe");
    expect(result.diagnostics[0].rawValue).toBe("maybe");
  });
});

// ── presets Parsing ─────────────────────────────────────────────────────

describe("readEventingEnvOverlay — presets", () => {
  test("parses a single preset", () => {
    const result = readEventingEnvOverlay({ [EVENTING_PRESETS_ENV]: "agent-controller" });
    expect(result.present).toBe(true);
    expect(result.overlay.presets).toEqual(["agent-controller"]);
    expect(result.diagnostics).toEqual([]);
  });

  test("parses comma-separated presets", () => {
    const result = readEventingEnvOverlay({ [EVENTING_PRESETS_ENV]: "agent-controller, other-preset" });
    expect(result.overlay.presets).toEqual(["agent-controller", "other-preset"]);
  });

  test("parses whitespace-separated presets", () => {
    const result = readEventingEnvOverlay({ [EVENTING_PRESETS_ENV]: "agent-controller  other-preset" });
    expect(result.overlay.presets).toEqual(["agent-controller", "other-preset"]);
  });

  test("parses mixed comma/whitespace separators", () => {
    const result = readEventingEnvOverlay({ [EVENTING_PRESETS_ENV]: "agent-controller,  other-preset ,third" });
    expect(result.overlay.presets).toEqual(["agent-controller", "other-preset", "third"]);
  });

  test("de-duplicates presets preserving first-occurrence order", () => {
    const result = readEventingEnvOverlay({
      [EVENTING_PRESETS_ENV]: "agent-controller, agent-controller, other, other",
    });
    expect(result.overlay.presets).toEqual(["agent-controller", "other"]);
  });

  test("treats a commas/whitespace-only value as unset (no diagnostic)", () => {
    const result = readEventingEnvOverlay({ [EVENTING_PRESETS_ENV]: " , , " });
    expect(result.present).toBe(false);
    expect(result.overlay.presets).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
  });
});

// ── heartbeatIntervalMs Parsing ─────────────────────────────────────────

describe("readEventingEnvOverlay — heartbeatIntervalMs", () => {
  test("parses a positive integer", () => {
    const result = readEventingEnvOverlay({ [EVENTING_HEARTBEAT_MS_ENV]: "30000" });
    expect(result.present).toBe(true);
    expect(result.overlay.heartbeatIntervalMs).toBe(30000);
    expect(result.diagnostics).toEqual([]);
  });

  test("parses a small positive integer", () => {
    const result = readEventingEnvOverlay({ [EVENTING_HEARTBEAT_MS_ENV]: "1" });
    expect(result.overlay.heartbeatIntervalMs).toBe(1);
  });

  test("trims surrounding whitespace", () => {
    const result = readEventingEnvOverlay({ [EVENTING_HEARTBEAT_MS_ENV]: "  5000  " });
    expect(result.overlay.heartbeatIntervalMs).toBe(5000);
  });

  test.each(["0", "-1", "1.5", "abc", "10e2", "+10", "0x10"])(
    "ignores invalid heartbeat value %s with a diagnostic",
    (value) => {
      const result = readEventingEnvOverlay({ [EVENTING_HEARTBEAT_MS_ENV]: value });
      expect(result.present).toBe(false);
      expect(result.overlay.heartbeatIntervalMs).toBeUndefined();
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].varName).toBe(EVENTING_HEARTBEAT_MS_ENV);
      expect(result.diagnostics[0].severity).toBe("warning");
      expect(result.diagnostics[0].message).toContain("PI_MATERIA_EVENTING_HEARTBEAT_MS");
      expect(result.diagnostics[0].rawValue).toBe(value);
    },
  );
});

// ── Combined Parsing ────────────────────────────────────────────────────

describe("readEventingEnvOverlay — combined variables", () => {
  test("parses all documented variables together", () => {
    const result = readEventingEnvOverlay({
      [EVENTING_ENABLED_ENV]: "true",
      [EVENTING_PRESETS_ENV]: "agent-controller",
      [EVENTING_HEARTBEAT_MS_ENV]: "15000",
    });
    expect(result.present).toBe(true);
    expect(result.overlay).toEqual({
      enabled: true,
      presets: ["agent-controller"],
      heartbeatIntervalMs: 15000,
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("applies valid values and reports diagnostics for invalid ones together", () => {
    const result = readEventingEnvOverlay({
      [EVENTING_ENABLED_ENV]: "true",
      [EVENTING_PRESETS_ENV]: "agent-controller",
      [EVENTING_HEARTBEAT_MS_ENV]: "not-a-number",
    });
    expect(result.present).toBe(true);
    expect(result.overlay).toEqual({
      enabled: true,
      presets: ["agent-controller"],
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].varName).toBe(EVENTING_HEARTBEAT_MS_ENV);
  });

  test("overlay does not include keys for unset variables", () => {
    const result = readEventingEnvOverlay({ [EVENTING_ENABLED_ENV]: "true" });
    expect(Object.keys(result.overlay)).toEqual(["enabled"]);
    expect(result.overlay).not.toHaveProperty("presets");
    expect(result.overlay).not.toHaveProperty("heartbeatIntervalMs");
  });

  test("overlay is in-memory only and does not touch process.env config files", () => {
    // Sanity: reading the overlay is a pure parse with no side effects.
    // The returned overlay is a plain object describing overrides to merge
    // elsewhere; it never persists anything.
    const before = { ...process.env };
    const result = readEventingEnvOverlay({ [EVENTING_ENABLED_ENV]: "true" });
    const after = { ...process.env };
    expect(result.present).toBe(true);
    expect(after).toEqual(before);
  });
});
