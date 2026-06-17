import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, afterEach } from "bun:test";
import {
  KNOWN_PRESETS,
  resolveControllerRunId,
  resolveControllerUrl,
  buildAgentControllerSinkConfig,
  expandPresets,
  CONTROLLER_RUN_ID_ENV,
  CONTROLLER_EVENT_URL_ENV,
  CONTROLLER_CONTEXT_DIR_ENV,
} from "../src/eventing/presets.js";

// ── Helpers ─────────────────────────────────────────────────────────────

const originalEnv = { ...process.env };

function clearControllerEnv(): void {
  delete process.env[CONTROLLER_RUN_ID_ENV];
  delete process.env[CONTROLLER_EVENT_URL_ENV];
  delete process.env[CONTROLLER_CONTEXT_DIR_ENV];
}

afterEach(() => {
  // Restore original environment after each test.
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
});

async function tmpContextDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-preset-tests-"));
  return dir;
}

/**
 * Write a controller-run.json file directly into the given directory
 * (matching the agent_router layout: `{CONTROLLER_CONTEXT_DIR}/controller-run.json`).
 */
async function writeControllerRunFile(
  contextDir: string,
  content: unknown,
): Promise<string> {
  const filePath = path.join(contextDir, "controller-run.json");
  await writeFile(filePath, JSON.stringify(content), "utf8");
  return filePath;
}

// ── Known Presets ───────────────────────────────────────────────────────

describe("KNOWN_PRESETS", () => {
  test("includes agent-controller", () => {
    expect(KNOWN_PRESETS).toContain("agent-controller");
  });

  test("is readonly array of strings", () => {
    for (const preset of KNOWN_PRESETS) {
      expect(typeof preset).toBe("string");
    }
  });
});

// ── Controller Run ID Resolution ────────────────────────────────────────

describe("resolveControllerRunId", () => {
  test("resolves from CONTROLLER_RUN_ID env var", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-abc-123";
    expect(resolveControllerRunId()).toBe("run-abc-123");
  });

  test("trims whitespace from env var value", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "  run-xyz-789  ";
    expect(resolveControllerRunId()).toBe("run-xyz-789");
  });

  test("returns undefined when env var is empty string", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "   ";
    expect(resolveControllerRunId()).toBeUndefined();
  });

  test("resolves from CONTROLLER_CONTEXT_DIR env var with controller-run.json", async () => {
    clearControllerEnv();
    const ctxDir = await tmpContextDir();
    try {
      await writeControllerRunFile(ctxDir, { runId: "ctx-run-42" });
      process.env[CONTROLLER_CONTEXT_DIR_ENV] = ctxDir;
      expect(resolveControllerRunId()).toBe("ctx-run-42");
    } finally {
      await rm(ctxDir, { recursive: true, force: true });
    }
  });

  test("CONTROLLER_RUN_ID env var takes precedence over CONTROLLER_CONTEXT_DIR", async () => {
    process.env[CONTROLLER_RUN_ID_ENV] = "env-run-first";
    const ctxDir = await tmpContextDir();
    try {
      await writeControllerRunFile(ctxDir, { runId: "ctx-run-second" });
      process.env[CONTROLLER_CONTEXT_DIR_ENV] = ctxDir;
      expect(resolveControllerRunId()).toBe("env-run-first");
    } finally {
      await rm(ctxDir, { recursive: true, force: true });
    }
  });

  test("ignores context file with missing runId field", async () => {
    clearControllerEnv();
    const ctxDir = await tmpContextDir();
    try {
      await writeControllerRunFile(ctxDir, { otherField: "value" });
      process.env[CONTROLLER_CONTEXT_DIR_ENV] = ctxDir;
      expect(resolveControllerRunId()).toBeUndefined();
    } finally {
      await rm(ctxDir, { recursive: true, force: true });
    }
  });

  test("ignores context file with non-string runId", async () => {
    clearControllerEnv();
    const ctxDir = await tmpContextDir();
    try {
      await writeControllerRunFile(ctxDir, { runId: 12345 });
      process.env[CONTROLLER_CONTEXT_DIR_ENV] = ctxDir;
      expect(resolveControllerRunId()).toBeUndefined();
    } finally {
      await rm(ctxDir, { recursive: true, force: true });
    }
  });

  test("ignores corrupt context file", async () => {
    clearControllerEnv();
    const ctxDir = await tmpContextDir();
    try {
      await writeFile(path.join(ctxDir, "controller-run.json"), "not-valid-json", "utf8");
      process.env[CONTROLLER_CONTEXT_DIR_ENV] = ctxDir;
      expect(resolveControllerRunId()).toBeUndefined();
    } finally {
      await rm(ctxDir, { recursive: true, force: true });
    }
  });

  test("returns undefined when no source provides runId", () => {
    clearControllerEnv();
    expect(resolveControllerRunId()).toBeUndefined();
  });

  test("returns undefined when context dir env var has no context file", async () => {
    clearControllerEnv();
    const ctxDir = await tmpContextDir();
    try {
      process.env[CONTROLLER_CONTEXT_DIR_ENV] = ctxDir;
      expect(resolveControllerRunId()).toBeUndefined();
    } finally {
      await rm(ctxDir, { recursive: true, force: true });
    }
  });

  test("resolves from explicit contextDir parameter", async () => {
    clearControllerEnv();
    const ctxDir = await tmpContextDir();
    try {
      await writeControllerRunFile(ctxDir, { runId: "param-run-99" });
      expect(resolveControllerRunId(ctxDir)).toBe("param-run-99");
    } finally {
      await rm(ctxDir, { recursive: true, force: true });
    }
  });

  test("explicit contextDir takes precedence over CONTROLLER_CONTEXT_DIR env var", async () => {
    clearControllerEnv();
    const ctxDir1 = await tmpContextDir();
    const ctxDir2 = await tmpContextDir();
    try {
      await writeControllerRunFile(ctxDir1, { runId: "ctx-1" });
      await writeControllerRunFile(ctxDir2, { runId: "ctx-2" });
      process.env[CONTROLLER_CONTEXT_DIR_ENV] = ctxDir1;
      // Explicit parameter is checked after env var, so env var wins.
      // (resolveControllerRunId checks CONTROLLER_RUN_ID, then CONTROLLER_CONTEXT_DIR, then explicit param)
      expect(resolveControllerRunId(ctxDir2)).toBe("ctx-1");
    } finally {
      await rm(ctxDir1, { recursive: true, force: true });
      await rm(ctxDir2, { recursive: true, force: true });
    }
  });
});

// ── Controller URL Resolution ───────────────────────────────────────────

describe("resolveControllerUrl", () => {
  test("defaults to localhost:5000 when no env var", () => {
    clearControllerEnv();
    expect(resolveControllerUrl()).toBe("http://localhost:5000");
  });

  test("reads from CONTROLLER_EVENT_URL env var", () => {
    clearControllerEnv();
    process.env[CONTROLLER_EVENT_URL_ENV] = "https://controller.example.com";
    expect(resolveControllerUrl()).toBe("https://controller.example.com");
  });

  test("strips trailing slash", () => {
    clearControllerEnv();
    process.env[CONTROLLER_EVENT_URL_ENV] = "https://controller.example.com/";
    expect(resolveControllerUrl()).toBe("https://controller.example.com");
  });

  test("strips multiple trailing slashes", () => {
    clearControllerEnv();
    process.env[CONTROLLER_EVENT_URL_ENV] = "https://controller.example.com///";
    expect(resolveControllerUrl()).toBe("https://controller.example.com");
  });

  test("trims whitespace", () => {
    clearControllerEnv();
    process.env[CONTROLLER_EVENT_URL_ENV] = "  https://custom-controller.io  ";
    expect(resolveControllerUrl()).toBe("https://custom-controller.io");
  });
});

// ── Agent Controller Sink Config ────────────────────────────────────────

describe("buildAgentControllerSinkConfig", () => {
  test("builds full config when runId is resolved from env", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-42";

    const config = buildAgentControllerSinkConfig();

    expect(config.id).toBe("agent-controller-webhook");
    expect(config.enabled).toBe(true);
    // Default URL includes the resolved runId in the path.
    expect(config.url).toBe("http://localhost:5000/runs/run-42/events");
    expect(config.method).toBe("POST");
    expect(config.headers).toEqual({
      "Content-Type": "application/json",
      "X-Controller-Run-Id": "run-42",
    });
    expect(config.bodyTemplate).toBe("mapped");
    expect(config.typeMap).toBeDefined();
    expect(config.severityMap).toBeDefined();
    expect(config.eventFilter).toBeDefined();
  });

  test("url includes resolved runId in path", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-abc-123";

    const config = buildAgentControllerSinkConfig();

    expect(config.url).toContain("/runs/run-abc-123/events");
    expect(config.url).not.toContain("{runId}");
    // Without CONTROLLER_EVENT_URL, defaults to localhost:5000 base.
    expect(config.url).toBe("http://localhost:5000/runs/run-abc-123/events");
  });

  test("body mapping maps runtimeRunId from castId", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";

    const config = buildAgentControllerSinkConfig();

    expect(config.bodyMapping?.runtimeRunId).toBe("castId");
    expect(config.bodyMapping?.eventId).toBe("eventId");
    expect(config.bodyMapping?.sequence).toBe("sequence");
  });

  test("typeMap maps lifecycle.cast.started to runtime.accepted", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";

    const config = buildAgentControllerSinkConfig();

    expect(config.typeMap!["lifecycle.cast.started"]).toBe("runtime.accepted");
  });

  test("typeMap maps lifecycle.cast.completed to runtime.completed", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";

    const config = buildAgentControllerSinkConfig();

    expect(config.typeMap!["lifecycle.cast.completed"]).toBe("runtime.completed");
    expect(config.typeMap!["lifecycle.cast.failed"]).toBe("runtime.failed");
    expect(config.typeMap!["lifecycle.cast.cancelled"]).toBe("runtime.cancelled");
    expect(config.typeMap!["lifecycle.heartbeat"]).toBe("runtime.heartbeat");
  });

  test("typeMap maps result events to controller types", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";

    const config = buildAgentControllerSinkConfig();

    expect(config.typeMap!["result.pr_created"]).toBe("runtime.pr_created");
    expect(config.typeMap!["result.branch_pushed"]).toBe("runtime.branch_created");
    expect(config.typeMap!["result.needs_human"]).toBe("runtime.needs_human");
  });

  test("typeMap maps status events to runtime.status", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";

    const config = buildAgentControllerSinkConfig();

    expect(config.typeMap!["lifecycle.status"]).toBe("runtime.status");
    expect(config.typeMap!["status.progress"]).toBe("runtime.status");
    expect(config.typeMap!["status.info"]).toBe("runtime.status");
  });

  test("severityMap maps debug to info for controller compatibility", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";

    const config = buildAgentControllerSinkConfig();

    expect(config.severityMap).toBeDefined();
    expect(config.severityMap!["debug"]).toBe("info");
    // Only debug needs mapping — info, warning, error, critical are accepted as-is.
    expect(config.severityMap!["info"]).toBeUndefined();
    expect(config.severityMap!["warning"]).toBeUndefined();
    expect(config.severityMap!["error"]).toBeUndefined();
  });

  test("eventFilter only includes mapped concrete types (not lifecycle.* nor result.* nor status.*)", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";

    const config = buildAgentControllerSinkConfig();

    const include = config.eventFilter?.include ?? [];
    // Should NOT include broad wildcard patterns.
    expect(include).not.toContain("lifecycle.*");
    expect(include).not.toContain("result.*");
    expect(include).not.toContain("status.*");
    // Specific lifecycle events that have controller mappings.
    expect(include).toContain("lifecycle.cast.started");
    expect(include).toContain("lifecycle.heartbeat");
    expect(include).toContain("lifecycle.status");
    expect(include).toContain("lifecycle.cast.completed");
    expect(include).toContain("lifecycle.cast.failed");
    expect(include).toContain("lifecycle.cast.cancelled");
    // Specific result events with controller mappings.
    expect(include).toContain("result.pr_created");
    expect(include).toContain("result.branch_pushed");
    expect(include).toContain("result.needs_human");
    // Specific status events with controller mappings.
    expect(include).toContain("status.progress");
    expect(include).toContain("status.info");
    expect(include).toContain("status.warning");
    // Unmapped lifecycle events should NOT be included.
    expect(include).not.toContain("lifecycle.socket.started");
    expect(include).not.toContain("lifecycle.socket.completed");
    expect(include).not.toContain("lifecycle.refinement.waiting");
    expect(include).not.toContain("lifecycle.socket.failed");
    // Unmapped result/status events should NOT be included.
    expect(include).not.toContain("result.no_changes_needed");
    expect(include).not.toContain("status.building");
    expect(include).not.toContain("status.testing");
  });

  test("uses default controller URL when env var not set", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";

    const config = buildAgentControllerSinkConfig();

    expect(config.url).toBe("http://localhost:5000/runs/run-1/events");
  });

  test("creates disabled sink when runId cannot be resolved", () => {
    clearControllerEnv();

    const config = buildAgentControllerSinkConfig();

    expect(config.id).toBe("agent-controller-webhook");
    expect(config.enabled).toBe(false);
    // URL keeps the {runId} template since we couldn't resolve it.
    expect(config.url).toContain("{runId}");
    // Body mapping, typeMap, severityMap still provided so users can debug the config.
    expect(config.bodyMapping).toBeDefined();
    expect(config.typeMap).toBeDefined();
    expect(config.severityMap).toBeDefined();
  });

  test("disabled sink still has body mapping, typeMap, severityMap, and correct filter for inspection", () => {
    clearControllerEnv();

    const config = buildAgentControllerSinkConfig();

    expect(config.bodyMapping?.runtimeRunId).toBe("castId");
    expect(config.typeMap!["lifecycle.cast.started"]).toBe("runtime.accepted");
    expect(config.severityMap!["debug"]).toBe("info");
    // Filter only has concrete types, not broad patterns.
    const include = config.eventFilter?.include ?? [];
    expect(include).not.toContain("result.*");
    expect(include).not.toContain("status.*");
    expect(include).not.toContain("lifecycle.*");
    // But mapped concrete types are present.
    expect(include).toContain("result.pr_created");
    expect(include).toContain("status.progress");
  });

  test("resolves runId from CONTROLLER_CONTEXT_DIR env var", async () => {
    clearControllerEnv();
    const ctxDir = await tmpContextDir();
    try {
      await writeControllerRunFile(ctxDir, { runId: "ctx-from-env-99" });
      process.env[CONTROLLER_CONTEXT_DIR_ENV] = ctxDir;

      const config = buildAgentControllerSinkConfig();

      expect(config.enabled).toBe(true);
      expect(config.url).toContain("/runs/ctx-from-env-99/events");
    } finally {
      await rm(ctxDir, { recursive: true, force: true });
    }
  });

  test("resolves runId from context file via explicit contextDir parameter", async () => {
    clearControllerEnv();
    const ctxDir = await tmpContextDir();
    try {
      await writeControllerRunFile(ctxDir, { runId: "ctx-99" });

      const config = buildAgentControllerSinkConfig(ctxDir);

      expect(config.enabled).toBe(true);
      expect(config.url).toContain("/runs/ctx-99/events");
    } finally {
      await rm(ctxDir, { recursive: true, force: true });
    }
  });

  test("CONTROLLER_RUN_ID env var overrides context file runId", async () => {
    process.env[CONTROLLER_RUN_ID_ENV] = "env-77";
    const ctxDir = await tmpContextDir();
    try {
      await writeControllerRunFile(ctxDir, { runId: "ctx-88" });

      const config = buildAgentControllerSinkConfig(ctxDir);

      expect(config.enabled).toBe(true);
      expect(config.url).toContain("/runs/env-77/events");
    } finally {
      await rm(ctxDir, { recursive: true, force: true });
    }
  });
});

// ── Preset Expansion ────────────────────────────────────────────────────

describe("expandPresets", () => {
  test("expands agent-controller into webhook sink config", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";

    const result = expandPresets(["agent-controller"], undefined);

    expect(result.sinks["agent-controller-webhook"]).toBeDefined();
    const sink = result.sinks["agent-controller-webhook"];
    expect(sink.enabled).toBe(true);
    expect(sink.id).toBe("agent-controller-webhook");
    expect(result.warnings).toEqual([]);
  });

  test("returns empty sinks for unknown preset names", () => {
    const result = expandPresets(["nonexistent-preset"], undefined);

    expect(result.sinks).toEqual({});
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("Unknown eventing preset");
    expect(result.warnings[0]).toContain("nonexistent-preset");
  });

  test("returns warning for mixed known and unknown presets", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";

    const result = expandPresets(["agent-controller", "future-preset"], undefined);

    expect(result.sinks["agent-controller-webhook"]).toBeDefined();
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("Unknown eventing preset");
    expect(result.warnings[0]).toContain("future-preset");
  });

  test("warning lists supported presets when unknown name is given", () => {
    const result = expandPresets(["bogus"], undefined);

    expect(result.warnings[0]).toContain(KNOWN_PRESETS.join(", "));
  });

  test("existing user-configured sink takes precedence over preset sink", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";

    const existingSinks = {
      "agent-controller-webhook": {
        id: "agent-controller-webhook",
        url: "https://custom.example.com/webhook",
        enabled: true,
        timeoutMs: 5000,
      },
    };

    const result = expandPresets(["agent-controller"], existingSinks);

    // Preset sink should not override the existing user-configured sink.
    expect(result.sinks["agent-controller-webhook"]).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  test("does not warn when existing sink overrides preset", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";

    const existingSinks = {
      "agent-controller-webhook": {
        id: "agent-controller-webhook",
        url: "https://custom.example.com/webhook",
        enabled: true,
      },
    };

    const result = expandPresets(["agent-controller"], existingSinks);

    // No warning because the user explicitly configured the sink.
    expect(result.warnings).toEqual([]);
  });

  test("warns when agent-controller preset cannot resolve runId", () => {
    clearControllerEnv();

    const result = expandPresets(["agent-controller"], undefined);

    expect(result.sinks["agent-controller-webhook"]).toBeDefined();
    const sink = result.sinks["agent-controller-webhook"];
    expect(sink.enabled).toBe(false);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("no controller runId could be resolved");
    expect(result.warnings[0]).toContain(CONTROLLER_RUN_ID_ENV);
    expect(result.warnings[0]).toContain(CONTROLLER_CONTEXT_DIR_ENV);
  });

  test("preserves existing sinks from other presets when merging", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";

    // Simulate two presets producing different sink ids (future expansion).
    const result = expandPresets(["agent-controller"], undefined);

    expect(result.sinks["agent-controller-webhook"]).toBeDefined();
  });

  test("handles empty preset list", () => {
    const result = expandPresets([], undefined);

    expect(result.sinks).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  test("multiple expansions of same preset are idempotent", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";

    // Two agent-controller entries should produce one sink.
    const result = expandPresets(["agent-controller", "agent-controller"], undefined);

    expect(Object.keys(result.sinks).length).toBe(1);
    expect(result.sinks["agent-controller-webhook"]).toBeDefined();
    // No warning for duplicates — second is silently skipped.
    expect(result.warnings).toEqual([]);
  });
});

// ── Integration: Body Mapping and Type Map Shape ────────────────────────

describe("agent-controller preset contract", () => {
  test("body mapping includes all controller-required fields", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";

    const config = buildAgentControllerSinkConfig();

    // Controller contract §2 requires: eventId, eventType, and optionally
    // occurredAt, severity, message, payload, runId, runtimeRunId, sequence.
    expect(config.bodyMapping?.eventId).toBe("eventId");
    expect(config.bodyMapping?.eventType).toBe("type");
    expect(config.bodyMapping?.occurredAt).toBe("occurredAt");
    expect(config.bodyMapping?.severity).toBe("severity");
    expect(config.bodyMapping?.message).toBe("message");
    expect(config.bodyMapping?.payload).toBe("payload");
    expect(config.bodyMapping?.runtimeRunId).toBe("castId");
    expect(config.bodyMapping?.sequence).toBe("sequence");
  });

  test("typeMap covers all terminal lifecycle events", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";

    const config = buildAgentControllerSinkConfig();

    // Controller supports runtime.completed, runtime.failed, runtime.cancelled.
    expect(config.typeMap!["lifecycle.cast.completed"]).toBe("runtime.completed");
    expect(config.typeMap!["lifecycle.cast.failed"]).toBe("runtime.failed");
    expect(config.typeMap!["lifecycle.cast.cancelled"]).toBe("runtime.cancelled");
  });

  test("typeMap covers accepted and heartbeat", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";

    const config = buildAgentControllerSinkConfig();

    // Controller minimum contract: accepted, heartbeat, status, completed, failed.
    expect(config.typeMap!["lifecycle.cast.started"]).toBe("runtime.accepted");
    expect(config.typeMap!["lifecycle.heartbeat"]).toBe("runtime.heartbeat");
  });

  test("filter only delivers events that have explicit typeMap entries", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";

    const config = buildAgentControllerSinkConfig();

    const include = config.eventFilter?.include ?? [];
    const typeMapKeys = Object.keys(config.typeMap ?? {});

    // Every event type in the filter MUST have a corresponding typeMap entry.
    for (const filterPattern of include) {
      // Wildcard patterns are not allowed in the filter — only concrete types.
      expect(filterPattern).not.toContain("*");
      expect(typeMapKeys).toContain(filterPattern);
    }

    // Controller-mapped lifecycle events.
    expect(include).toContain("lifecycle.cast.started");
    expect(include).toContain("lifecycle.heartbeat");
    expect(include).toContain("lifecycle.status");
    expect(include).toContain("lifecycle.cast.completed");
    expect(include).toContain("lifecycle.cast.failed");
    expect(include).toContain("lifecycle.cast.cancelled");
    // Should NOT include lifecycle.* (would deliver unmapped events).
    expect(include).not.toContain("lifecycle.*");
    // Unmapped lifecycle events absent.
    expect(include).not.toContain("lifecycle.socket.started");
    expect(include).not.toContain("lifecycle.socket.completed");
  });

  test("all typeMap values use runtime. prefix", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";

    const config = buildAgentControllerSinkConfig();

    for (const value of Object.values(config.typeMap!)) {
      expect(value).toMatch(/^runtime\./);
    }
  });

  test("no pi-materia event type maps to itself", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";

    const config = buildAgentControllerSinkConfig();

    for (const [key, value] of Object.entries(config.typeMap!)) {
      // Every pi-materia type should be transformed to a controller type.
      // No identity mappings (e.g., "runtime.failed" → "runtime.failed").
      expect(value).not.toBe(key);
    }
  });

  test("severityMap ensures debug is never sent to controller", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";

    const config = buildAgentControllerSinkConfig();

    // The controller only accepts info, warning, error, critical (§2.2).
    // debug severity (used for heartbeats) must be remapped.
    expect(config.severityMap!["debug"]).toBe("info");
    // Other valid severities are not remapped.
    for (const sev of ["info", "warning", "error", "critical"]) {
      expect(config.severityMap![sev]).toBeUndefined();
    }
  });

  test("CONTROLLER_EVENT_URL as full endpoint is used directly (no path doubling)", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";
    // Per agent_router docs §13b.5, CONTROLLER_EVENT_URL is the full POST endpoint.
    process.env[CONTROLLER_EVENT_URL_ENV] = "https://example.com/runs/ctrl-run-99/events";

    const config = buildAgentControllerSinkConfig();

    // URL must be used directly — no /runs/run-1/events appended.
    expect(config.url).toBe("https://example.com/runs/ctrl-run-99/events");
    expect(config.url).not.toContain("/runs/run-1/events");
  });

  test("CONTROLLER_EVENT_URL as base URL gets path appended", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";
    process.env[CONTROLLER_EVENT_URL_ENV] = "https://controller.example.com";

    const config = buildAgentControllerSinkConfig();

    // Base URL gets the run path appended.
    expect(config.url).toBe("https://controller.example.com/runs/run-1/events");
  });

  test("CONTROLLER_EVENT_URL overrides default localhost URL", () => {
    clearControllerEnv();
    process.env[CONTROLLER_RUN_ID_ENV] = "run-1";
    process.env[CONTROLLER_EVENT_URL_ENV] = "https://custom.example.com/runs/run-abc/events";

    const config = buildAgentControllerSinkConfig();

    expect(config.url).toBe("https://custom.example.com/runs/run-abc/events");
  });
});
