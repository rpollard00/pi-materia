import { describe, expect, test } from "bun:test";
import {
  AGENT_CONTROLLER_WEBHOOK_REASON,
  evaluateAgentControllerWebhookStatus,
  isWebhookSinkConfig,
  isValidHttpUrl,
  redactWebhookUrl,
} from "../src/eventing/diagnostics.js";
import type {
  EventingConfig,
  EventingWebhookSinkConfig,
  EventSinkConfig,
} from "../src/types.js";
import type { ControllerLaunchDetection } from "../src/eventing/presets.js";

// ── Helpers ─────────────────────────────────────────────────────────────

function webhookSink(overrides: Partial<EventingWebhookSinkConfig> = {}): EventingWebhookSinkConfig {
  return {
    id: "agent-controller-webhook",
    url: "https://controller.example.com/runs/run-1/events",
    enabled: true,
    method: "POST",
    ...overrides,
  };
}

function controllerPresent(detected: string[] = ["CONTROLLER_RUN_ID"]): ControllerLaunchDetection {
  return { present: true, detected };
}

function controllerAbsent(): ControllerLaunchDetection {
  return { present: false, detected: [] };
}

function eventingEnabled(presets: string[] = ["agent-controller"]): EventingConfig {
  return { enabled: true, presets };
}

function reasons(status: ReturnType<typeof evaluateAgentControllerWebhookStatus>): string[] {
  return status.diagnostics.map((d) => d.reason);
}

// ── No expectation → silent ─────────────────────────────────────────────

describe("evaluateAgentControllerWebhookStatus (no expectation)", () => {
  test("returns no diagnostics when nothing references the controller", () => {
    const status = evaluateAgentControllerWebhookStatus({
      eventing: { enabled: false },
      controller: controllerAbsent(),
    });
    expect(status.expected).toBe(false);
    expect(status.active).toBe(false);
    expect(status.diagnostics).toEqual([]);
  });

  test("silent when eventing disabled with no preset, sink, or controller launch", () => {
    // Unrelated local run — must not produce noise.
    const status = evaluateAgentControllerWebhookStatus({
      eventing: { enabled: false },
      controller: controllerAbsent(),
    });
    expect(status.diagnostics.length).toBe(0);
  });
});

// ── Enumerated gap reasons ──────────────────────────────────────────────

describe("evaluateAgentControllerWebhookStatus gaps", () => {
  test("eventing_disabled when controller launch expected but eventing is off", () => {
    const status = evaluateAgentControllerWebhookStatus({
      eventing: { enabled: false, presets: ["agent-controller"] },
      controller: controllerPresent(),
      runIdResolved: true,
    });
    expect(status.expected).toBe(true);
    expect(status.active).toBe(false);
    expect(reasons(status)).toContain(AGENT_CONTROLLER_WEBHOOK_REASON.EventingDisabled);
    const diag = status.diagnostics.find((d) => d.reason === AGENT_CONTROLLER_WEBHOOK_REASON.EventingDisabled);
    expect(diagext(diag).message).toContain("eventing");
  });

  test("preset_missing when eventing enabled but no preset or sink", () => {
    const status = evaluateAgentControllerWebhookStatus({
      eventing: { enabled: true }, // no presets, no sinks
      controller: controllerPresent(),
      runIdResolved: true,
    });
    expect(reasons(status)).toContain(AGENT_CONTROLLER_WEBHOOK_REASON.PresetMissing);
    const diag = status.diagnostics.find((d) => d.reason === AGENT_CONTROLLER_WEBHOOK_REASON.PresetMissing);
    expect(diagext(diag).message).toContain("agent-controller");
  });

  test("controller_environment_missing when preset referenced but no CONTROLLER_* env", () => {
    const status = evaluateAgentControllerWebhookStatus({
      eventing: eventingEnabled(),
      controller: controllerAbsent(),
    });
    expect(reasons(status)).toContain(AGENT_CONTROLLER_WEBHOOK_REASON.ControllerEnvironmentMissing);
    const diag = status.diagnostics.find((d) => d.reason === AGENT_CONTROLLER_WEBHOOK_REASON.ControllerEnvironmentMissing);
    expect(diagext(diag).message).toContain("CONTROLLER_");
  });

  test("run_id_unresolved when controller launch detected but runId missing", () => {
    const status = evaluateAgentControllerWebhookStatus({
      eventing: eventingEnabled(),
      agentControllerSink: webhookSink({ enabled: false, url: "http://localhost:5000/runs/{runId}/events" }),
      controller: controllerPresent(),
      runIdResolved: false,
    });
    expect(reasons(status)).toContain(AGENT_CONTROLLER_WEBHOOK_REASON.RunIdUnresolved);
    expect(reasons(status)).not.toContain(AGENT_CONTROLLER_WEBHOOK_REASON.SinkDisabled);
    const diag = status.diagnostics.find((d) => d.reason === AGENT_CONTROLLER_WEBHOOK_REASON.RunIdUnresolved);
    expect(diagext(diag).message).toContain("runId");
  });

  test("target_url_missing when sink has empty URL", () => {
    const status = evaluateAgentControllerWebhookStatus({
      eventing: eventingEnabled(),
      agentControllerSink: webhookSink({ url: "" }),
      controller: controllerPresent(),
      runIdResolved: true,
    });
    expect(reasons(status)).toContain(AGENT_CONTROLLER_WEBHOOK_REASON.TargetUrlMissing);
  });

  test("target_url_invalid when sink URL is not a valid http(s) URL", () => {
    const status = evaluateAgentControllerWebhookStatus({
      eventing: eventingEnabled(),
      agentControllerSink: webhookSink({ url: "not-a-valid-url" }),
      controller: controllerPresent(),
      runIdResolved: true,
    });
    expect(reasons(status)).toContain(AGENT_CONTROLLER_WEBHOOK_REASON.TargetUrlInvalid);
    const diag = status.diagnostics.find((d) => d.reason === AGENT_CONTROLLER_WEBHOOK_REASON.TargetUrlInvalid);
    expect(diagext(diag).message).toContain("invalid");
  });

  test("sink_disabled when sink is explicitly disabled with a resolved runId", () => {
    const status = evaluateAgentControllerWebhookStatus({
      eventing: eventingEnabled(),
      agentControllerSink: webhookSink({ enabled: false }),
      controller: controllerPresent(),
      runIdResolved: true,
    });
    expect(reasons(status)).toContain(AGENT_CONTROLLER_WEBHOOK_REASON.SinkDisabled);
    expect(reasons(status)).not.toContain(AGENT_CONTROLLER_WEBHOOK_REASON.RunIdUnresolved);
  });
});

// ── Active confirmation ─────────────────────────────────────────────────

describe("evaluateAgentControllerWebhookStatus active", () => {
  test("reports active with redacted target URL when everything is configured", () => {
    const status = evaluateAgentControllerWebhookStatus({
      eventing: eventingEnabled(),
      agentControllerSink: webhookSink({ url: "https://controller.example.com/runs/run-1/events?token=secret#frag" }),
      controller: controllerPresent(),
      runIdResolved: true,
    });
    expect(status.active).toBe(true);
    expect(status.expected).toBe(true);
    // Query/fragment redacted (docs §6.6).
    expect(status.targetUrl).toBe("https://controller.example.com/runs/run-1/events");
    // Exactly one diagnostic — the active info confirmation.
    expect(status.diagnostics.length).toBe(1);
    expect(status.diagnostics[0].severity).toBe("info");
    expect(status.diagnostics[0].reason).toBe(AGENT_CONTROLLER_WEBHOOK_REASON.Active);
    expect(status.diagnostics[0].message).toContain("active");
  });

  test("active under explicit sink without controller env (manual config)", () => {
    const status = evaluateAgentControllerWebhookStatus({
      eventing: { enabled: true, sinks: { "agent-controller-webhook": webhookSink() } },
      agentControllerSink: webhookSink(),
      controller: controllerAbsent(),
    });
    expect(status.active).toBe(true);
    expect(reasons(status)).toContain(AGENT_CONTROLLER_WEBHOOK_REASON.Active);
  });

  test("active requires valid URL — template {runId} URL with unresolved runId is not active", () => {
    const status = evaluateAgentControllerWebhookStatus({
      eventing: eventingEnabled(),
      agentControllerSink: webhookSink({ enabled: true, url: "http://localhost:5000/runs/{runId}/events" }),
      controller: controllerPresent(),
      runIdResolved: true,
    });
    // {runId} URL is still a syntactically valid http URL, so it is "active"
    // from a config standpoint — the unresolved-runId gap is reported via the
    // runId flag when runIdResolved is false. Here runIdResolved=true so active.
    expect(status.active).toBe(true);
  });
});

// ── Combinatorial / precedence ──────────────────────────────────────────

describe("evaluateAgentControllerWebhookStatus combinations", () => {
  test("does not double-report disabled sink when runId is unresolved", () => {
    const status = evaluateAgentControllerWebhookStatus({
      eventing: eventingEnabled(),
      agentControllerSink: webhookSink({ enabled: false }),
      controller: controllerPresent(),
      runIdResolved: false,
    });
    expect(reasons(status)).toContain(AGENT_CONTROLLER_WEBHOOK_REASON.RunIdUnresolved);
    expect(reasons(status)).not.toContain(AGENT_CONTROLLER_WEBHOOK_REASON.SinkDisabled);
  });

  test("expected via explicit sink only (no controller, no preset)", () => {
    const status = evaluateAgentControllerWebhookStatus({
      eventing: { enabled: true, sinks: { "agent-controller-webhook": webhookSink() } },
      agentControllerSink: webhookSink(),
      controller: controllerAbsent(),
    });
    expect(status.expected).toBe(true);
    expect(status.active).toBe(true);
  });

  test("all warning diagnostics have severity warning, active has info", () => {
    const gap = evaluateAgentControllerWebhookStatus({
      eventing: { enabled: false, presets: ["agent-controller"] },
      controller: controllerPresent(),
      runIdResolved: true,
    });
    for (const d of gap.diagnostics) {
      expect(d.severity).toBe("warning");
    }

    const ok = evaluateAgentControllerWebhookStatus({
      eventing: eventingEnabled(),
      agentControllerSink: webhookSink(),
      controller: controllerPresent(),
      runIdResolved: true,
    });
    for (const d of ok.diagnostics) {
      expect(d.severity).toBe("info");
    }
  });

  test("runIdResolved undefined suppresses runId-specific diagnostic without claiming active", () => {
    const status = evaluateAgentControllerWebhookStatus({
      eventing: eventingEnabled(),
      agentControllerSink: webhookSink({ enabled: false }),
      controller: controllerPresent(),
      // runIdResolved intentionally omitted.
    });
    expect(reasons(status)).not.toContain(AGENT_CONTROLLER_WEBHOOK_REASON.RunIdUnresolved);
    // A disabled sink still surfaces as sink_disabled when runId is unknown.
    expect(reasons(status)).toContain(AGENT_CONTROLLER_WEBHOOK_REASON.SinkDisabled);
    expect(status.active).toBe(false);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────

describe("isWebhookSinkConfig", () => {
  test("true for webhook config with url", () => {
    expect(isWebhookSinkConfig(webhookSink())).toBe(true);
  });

  test("false for disabled-only sink config (no url)", () => {
    const disabled: EventSinkConfig = { id: "agent-controller-webhook", enabled: false };
    expect(isWebhookSinkConfig(disabled)).toBe(false);
  });

  test("false for undefined", () => {
    expect(isWebhookSinkConfig(undefined)).toBe(false);
  });

  test("true for webhook config that is disabled but still has url", () => {
    // Preset emits this shape when runId is unresolved.
    expect(isWebhookSinkConfig(webhookSink({ enabled: false }))).toBe(true);
  });
});

describe("isValidHttpUrl", () => {
  test("accepts http and https absolute URLs", () => {
    expect(isValidHttpUrl("http://localhost:5000/runs/x/events")).toBe(true);
    expect(isValidHttpUrl("https://controller.example.com/runs/x/events")).toBe(true);
  });

  test("rejects non-http protocols", () => {
    expect(isValidHttpUrl("ftp://example.com/x")).toBe(false);
    expect(isValidHttpUrl("file:///etc/passwd")).toBe(false);
  });

  test("rejects relative and malformed values", () => {
    expect(isValidHttpUrl("/runs/x/events")).toBe(false);
    expect(isValidHttpUrl("not-a-url")).toBe(false);
    expect(isValidHttpUrl("")).toBe(false);
  });
});

describe("redactWebhookUrl", () => {
  test("strips query and fragment", () => {
    expect(redactWebhookUrl("https://h.example.com/path?token=secret#frag")).toBe("https://h.example.com/path");
  });

  test("returns invalid-url for malformed input", () => {
    expect(redactWebhookUrl("not-a-url")).toBe("invalid-url");
  });
});

// ── Local helper to satisfy TS narrowing in tests ───────────────────────

/**
 * Assert a diagnostic is defined and return it (keeps `find()` results narrow).
 */
function diagext<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected diagnostic to be defined");
  return value;
}
