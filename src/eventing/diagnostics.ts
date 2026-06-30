import type {
  EventingConfig,
  EventingWebhookSinkConfig,
  EventSinkConfig,
} from "../types.js";
import {
  CONTROLLER_CONTEXT_DIR_ENV,
  CONTROLLER_LAUNCH_ENV_VARS,
  CONTROLLER_RUN_ID_ENV,
  type ControllerLaunchDetection,
} from "./presets.js";

// ── Reason Codes ────────────────────────────────────────────────────────

/**
 * Machine-readable reasons the agent-controller webhook delivery is (or is
 * not) active.
 *
 * Each value maps to a specific, actionable misconfiguration surfaced by
 * {@link evaluateAgentControllerWebhookStatus}. Stable identifiers so
 * agent_router integration tooling and tests can match on them without
 * parsing free-text messages.
 */
export const AGENT_CONTROLLER_WEBHOOK_REASON = {
  /** Runtime eventing master switch is off (`eventing.enabled` falsy). */
  EventingDisabled: "eventing_disabled",
  /** Eventing enabled but no `agent-controller` preset or sink is present. */
  PresetMissing: "preset_missing",
  /** No `CONTROLLER_*` environment detected at all (running outside a controller launch). */
  ControllerEnvironmentMissing: "controller_environment_missing",
  /** Controller launch detected but no runId could be resolved. */
  RunIdUnresolved: "run_id_unresolved",
  /** The configured sink has no target URL. */
  TargetUrlMissing: "target_url_missing",
  /** The configured sink target URL is not a valid absolute http(s) URL. */
  TargetUrlInvalid: "target_url_invalid",
  /** The sink is explicitly disabled for a reason other than an unresolved runId. */
  SinkDisabled: "sink_disabled",
  /** Delivery is active — informational confirmation (no remediation needed). */
  Active: "active",
} as const;

/** A machine-readable reason code produced by the diagnostics evaluator. */
export type AgentControllerWebhookReason =
  (typeof AGENT_CONTROLLER_WEBHOOK_REASON)[keyof typeof AGENT_CONTROLLER_WEBHOOK_REASON];

// ── Diagnostics ─────────────────────────────────────────────────────────

/** Severity for an agent-controller webhook diagnostic. */
export type AgentControllerWebhookSeverity = "info" | "warning";

/**
 * A single diagnostic describing why agent-controller webhook delivery is (or
 * is not) active.
 *
 * Diagnostics are non-fatal: they exist purely to make agent_router webhook
 * integration debuggable from session logs and cast artifacts. They never
 * fail config load, the cast, or unrelated local runs.
 */
export interface AgentControllerWebhookDiagnostic {
  /** Diagnostic severity. `warning` for gaps; `info` for the active confirmation. */
  readonly severity: AgentControllerWebhookSeverity;
  /** Machine-readable reason code (see {@link AgentControllerWebhookReason}). */
  readonly reason: AgentControllerWebhookReason;
  /** Human-readable explanation and remediation hint. */
  readonly message: string;
}

// ── Status Result ───────────────────────────────────────────────────────

/**
 * Result of evaluating whether the agent-controller webhook will deliver
 * events for a cast.
 *
 * - {@link expected}: there is any signal that controller delivery was
 *   intended (controller launch, referenced preset, or configured sink).
 *   When false, the evaluator returns no diagnostics so unrelated local
 *   runs are left untouched.
 * - {@link active}: an enabled sink with a valid target URL exists and
 *   eventing is enabled, i.e. events will actually be POSTed.
 */
export interface AgentControllerWebhookStatus {
  /** Whether agent-controller webhook delivery will actually deliver events. */
  readonly active: boolean;
  /**
   * Whether controller webhook delivery was expected/intended. When false,
   * {@link diagnostics} is empty and callers should surface nothing.
   */
  readonly expected: boolean;
  /** Diagnostics describing gaps (or the active confirmation). */
  readonly diagnostics: readonly AgentControllerWebhookDiagnostic[];
  /**
   * The resolved target URL (origin + pathname only; query/fragment redacted)
   * when a usable sink exists. Useful for confirming the agent_router endpoint.
   */
  readonly targetUrl?: string;
}

// ── Input ───────────────────────────────────────────────────────────────

/**
 * Input to {@link evaluateAgentControllerWebhookStatus}.
 *
 * Deliberately takes already-resolved pieces (resolved eventing config, the
 * resolved agent-controller sink after preset expansion, controller launch
 * detection, and runId resolution) rather than `(config, env)` so the
 * evaluator stays pure, side-effect free, and trivially testable. The runtime
 * resolves these once (in `initializeCastEventBus`) and passes them in.
 */
export interface AgentControllerWebhookStatusInput {
  /** Resolved eventing config (after the env overlay is applied). */
  readonly eventing?: EventingConfig;
  /**
   * The resolved agent-controller webhook sink after preset expansion and
   * explicit-config merge, or `undefined` when none exists. Accepts the
   * full sink-config union; the evaluator narrows to the webhook shape.
   */
  readonly agentControllerSink?: EventSinkConfig;
  /** Controller launch detection result (`CONTROLLER_*` env presence). */
  readonly controller?: ControllerLaunchDetection;
  /**
   * Whether a controller runId was resolved. When explicitly `false` and the
   * sink is disabled, the diagnostic attributes it to an unresolved runId
   * rather than a generic disabled sink. `undefined` means "unknown" and
   * suppresses the runId-specific diagnostic.
   */
  readonly runIdResolved?: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Narrow an {@link EventSinkConfig} union member to its webhook shape.
 *
 * The agent-controller preset always emits a webhook-shaped config (it has a
 * `url`), even when disabled due to an unresolved runId. An explicit
 * `EventingDisabledSinkConfig` (`{ id, enabled: false }`) has no `url` and is
 * treated as "no usable webhook sink" by callers.
 */
export function isWebhookSinkConfig(
  sink: EventSinkConfig | undefined,
): sink is EventingWebhookSinkConfig {
  return (
    !!sink &&
    typeof (sink as EventingWebhookSinkConfig).url === "string"
  );
}

/**
 * Whether a string is a valid absolute http(s) URL.
 *
 * Used to validate the configured webhook target. Relative URLs, other
 * protocols, and malformed values are rejected.
 */
export function isValidHttpUrl(value: string): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Redact a URL to its origin + pathname for safe inclusion in diagnostics.
 *
 * Strips query parameters and fragments that might carry tokens or secrets
 * (docs/runtime-eventing.md §6.6). Mirrors the redaction used by the webhook
 * sink so diagnostics never leak secrets.
 */
export function redactWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "invalid-url";
  }
}

// ── Evaluator ───────────────────────────────────────────────────────────

/**
 * Evaluate whether agent-controller webhook delivery will be active and
 * produce clear diagnostics for any gap.
 *
 * Pure and side-effect free: it inspects the resolved config/sink/controller
 * pieces and returns a status plus a list of diagnostics. Callers surface the
 * diagnostics to session logs and cast artifacts (see
 * `surfaceAgentControllerDiagnostics` in `nativeLifecycle.ts`).
 *
 * Gaps reported (docs/runtime-eventing.md §9, agent_router integration):
 * - disabled eventing (`eventing_disabled`)
 * - missing preset/sink (`preset_missing`)
 * - missing controller environment (`controller_environment_missing`)
 * - unresolved controller runId (`run_id_unresolved`)
 * - missing target URL (`target_url_missing`)
 * - invalid target URL (`target_url_invalid`)
 * - explicitly disabled sink (`sink_disabled`)
 *
 * When delivery is expected and active, a single `info` diagnostic with reason
 * `active` is returned so agent_router integration is positively confirmable
 * from logs/artifacts. When delivery was never expected (no controller launch,
 * no preset, no sink), {@link expected} is `false` and no diagnostics are
 * produced — unrelated local runs are left untouched.
 */
export function evaluateAgentControllerWebhookStatus(
  input: AgentControllerWebhookStatusInput,
): AgentControllerWebhookStatus {
  const { eventing, agentControllerSink, controller, runIdResolved } = input;

  const controllerPresent = controller?.present ?? false;
  const presetReferenced = Boolean(eventing?.presets?.includes("agent-controller"));
  const sink = isWebhookSinkConfig(agentControllerSink) ? agentControllerSink : undefined;

  // Expectation of controller delivery: a controller launch, a referenced
  // preset, or an explicit/configured sink. Without any of these there is
  // nothing to diagnose and we stay silent (don't spam unrelated local runs).
  const expected = controllerPresent || presetReferenced || Boolean(sink);
  if (!expected) {
    return { active: false, expected: false, diagnostics: [] };
  }

  const enabled = eventing?.enabled === true;
  const diagnostics: AgentControllerWebhookDiagnostic[] = [];

  // 1. Eventing master switch.
  if (!enabled) {
    diagnostics.push({
      severity: "warning",
      reason: AGENT_CONTROLLER_WEBHOOK_REASON.EventingDisabled,
      message:
        "Runtime eventing is disabled, so agent-controller webhook delivery is inactive. " +
        "Enable eventing (eventing.enabled=true, or PI_MATERIA_EVENTING_ENABLED=true) to emit controller events.",
    });
  }

  // 2. Missing preset/sink — only meaningful when eventing is on (otherwise #1
  //    already explains why nothing will be delivered). Gated on
  //    `!presetReferenced` so a referenced-but-unknown preset (already warned
  //    about by expandPresets) does not also produce a misleading message.
  if (enabled && !presetReferenced && !sink) {
    diagnostics.push({
      severity: "warning",
      reason: AGENT_CONTROLLER_WEBHOOK_REASON.PresetMissing,
      message:
        'The "agent-controller" preset is not active and no "agent-controller-webhook" sink is configured. ' +
        'Add "agent-controller" to eventing.presets (or define an agent-controller-webhook sink) so controller events are delivered.',
    });
  }

  // 3. No controller environment at all (manual config referencing the preset
  //    outside of an agent_router launch). Skip when a controller launch was
  //    detected — that case is handled by the runId check below.
  if (!controllerPresent && (presetReferenced || Boolean(sink))) {
    diagnostics.push({
      severity: "warning",
      reason: AGENT_CONTROLLER_WEBHOOK_REASON.ControllerEnvironmentMissing,
      message:
        `No controller environment detected (none of ${CONTROLLER_LAUNCH_ENV_VARS.join(", ")} ` +
        `are set). The agent-controller webhook target cannot be resolved automatically. ` +
        `Run under agent_router or set the CONTROLLER_* environment variables.`,
    });
  }

  // 4. Controller launch detected but runId could not be resolved — the preset
  //    disables the sink in this case (docs/runtime-eventing.md §9.3).
  if (controllerPresent && runIdResolved === false && (presetReferenced || Boolean(sink))) {
    diagnostics.push({
      severity: "warning",
      reason: AGENT_CONTROLLER_WEBHOOK_REASON.RunIdUnresolved,
      message:
        `Controller launch detected but no runId could be resolved from ${CONTROLLER_RUN_ID_ENV} or ` +
        `${CONTROLLER_CONTEXT_DIR_ENV}/controller-run.json. The agent-controller webhook sink is disabled ` +
        `until a runId is available.`,
    });
  }

  // 5. Sink-level URL and enabled checks.
  if (sink) {
    const url = typeof sink.url === "string" ? sink.url.trim() : "";

    if (!url) {
      diagnostics.push({
        severity: "warning",
        reason: AGENT_CONTROLLER_WEBHOOK_REASON.TargetUrlMissing,
        message:
          'The agent-controller-webhook sink has no target URL. Set a valid "url" ' +
          "(or CONTROLLER_EVENT_URL) so events can be delivered.",
      });
    } else if (!isValidHttpUrl(url)) {
      diagnostics.push({
        severity: "warning",
        reason: AGENT_CONTROLLER_WEBHOOK_REASON.TargetUrlInvalid,
        message:
          `The agent-controller-webhook sink target URL is invalid: ${redactWebhookUrl(url)}. ` +
          "Provide an absolute http(s) URL (or CONTROLLER_EVENT_URL).",
      });
    }

    // A disabled sink that was NOT disabled due to an unresolved runId (that
    // case is reported above) is reported as an explicit disablement.
    if (sink.enabled === false && runIdResolved !== false) {
      diagnostics.push({
        severity: "warning",
        reason: AGENT_CONTROLLER_WEBHOOK_REASON.SinkDisabled,
        message:
          'The agent-controller-webhook sink is explicitly disabled (enabled=false). ' +
          "Set enabled=true to deliver controller events.",
      });
    }
  }

  const urlValid = sink ? isValidHttpUrl((sink.url ?? "").trim()) : false;
  const active = enabled && Boolean(sink) && sink!.enabled !== false && urlValid;
  const targetUrl = active && sink ? redactWebhookUrl((sink.url ?? "").trim()) : undefined;

  if (active) {
    // Positive confirmation so agent_router integration is debuggable: when
    // delivery is expected and active, surface a single info diagnostic.
    diagnostics.push({
      severity: "info",
      reason: AGENT_CONTROLLER_WEBHOOK_REASON.Active,
      message:
        `Agent-controller webhook delivery is active${targetUrl ? ` (target: ${targetUrl})` : ""}. ` +
        "Lifecycle and materia result events will be POSTed to the controller.",
    });
  }

  return { active, expected: true, diagnostics, ...(targetUrl !== undefined ? { targetUrl } : {}) };
}
