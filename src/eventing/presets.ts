import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  EventingWebhookSinkConfig,
  EventBodyFieldMapping,
  EventFilter,
  EventSinkConfig,
} from "../types.js";

// ── Known Preset Names ──────────────────────────────────────────────────

/** All recognized preset identifiers. */
export const KNOWN_PRESETS = ["agent-controller"] as const;
export type KnownPreset = (typeof KNOWN_PRESETS)[number];

/**
 * Environment variable name for the controller-assigned run identifier.
 *
 * The agent_router controller sets this when invoking pi-materia
 * (see agent_router docs §13b.5 — `CONTROLLER_RUN_ID`).
 */
export const CONTROLLER_RUN_ID_ENV = "CONTROLLER_RUN_ID";

/**
 * Environment variable name for the controller's event ingestion URL.
 *
 * The agent_router controller sets this for HTTP webhook fallback
 * (see agent_router docs §13b.5 — `CONTROLLER_EVENT_URL`).
 */
export const CONTROLLER_EVENT_URL_ENV = "CONTROLLER_EVENT_URL";

/**
 * Environment variable name for the controller's context directory.
 *
 * The agent_router controller writes `controller-run.json` directly into
 * this directory (see agent_router docs §13b.5 — `CONTROLLER_CONTEXT_DIR`).
 */
export const CONTROLLER_CONTEXT_DIR_ENV = "CONTROLLER_CONTEXT_DIR";

/** Default controller base URL when no environment variable is set. */
const DEFAULT_CONTROLLER_URL = "http://localhost:5000";

/** Context file name expected in the controller's workspace context directory. */
const CONTROLLER_CONTEXT_FILE = "controller-run.json";

// ── Controller Run ID Resolution ────────────────────────────────────────

/**
 * Resolve the controller-assigned run identifier.
 *
 * Resolution order (per agent_router docs §13b.5 and
 * docs/runtime-eventing.md §9.3):
 * 1. `CONTROLLER_RUN_ID` environment variable.
 * 2. `CONTROLLER_CONTEXT_DIR` environment variable — if set, looks for
 *    `controller-run.json` directly inside that directory (no `.agent/`
 *    subdirectory; the agent_router writes context files flat into the
 *    context dir).
 * 3. Explicit `contextDir` parameter — same lookup as step 2.
 *
 * Returns `undefined` when no runId could be resolved. When the runId is not
 * available, the sink should skip delivery rather than failing the cast.
 */
export function resolveControllerRunId(contextDir?: string): string | undefined {
  // 1. Environment variable (CONTROLLER_RUN_ID).
  const envRunId = process.env[CONTROLLER_RUN_ID_ENV]?.trim();
  if (envRunId) return envRunId;

  // 2. CONTROLLER_CONTEXT_DIR env var (same layout as agent_router docs).
  const envContextDir = process.env[CONTROLLER_CONTEXT_DIR_ENV]?.trim();
  if (envContextDir) {
    const result = readRunIdFromContextFile(envContextDir);
    if (result) return result;
  }

  // 3. Explicit context directory parameter.
  if (contextDir) {
    const result = readRunIdFromContextFile(contextDir);
    if (result) return result;
  }

  return undefined;
}

/**
 * Try to read the runId from a controller-run.json file in the given
 * directory. Returns the runId string or undefined.
 */
function readRunIdFromContextFile(dir: string): string | undefined {
  const contextPath = path.join(dir, CONTROLLER_CONTEXT_FILE);
  if (!existsSync(contextPath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(contextPath, "utf8"));
    if (raw && typeof raw === "object" && typeof raw.runId === "string" && raw.runId.trim()) {
      return raw.runId.trim();
    }
  } catch {
    // Context file parse failure is non-fatal — we fall through to undefined.
  }
  return undefined;
}

/**
 * Resolve the controller base URL.
 *
 * Reads `CONTROLLER_EVENT_URL` environment variable. Falls back to the default
 * `http://localhost:5000`. The returned value never has a trailing slash.
 */
export function resolveControllerUrl(): string {
  const envUrl = process.env[CONTROLLER_EVENT_URL_ENV]?.trim();
  const base = envUrl || DEFAULT_CONTROLLER_URL;
  return base.replace(/\/+$/, "");
}

// ── Agent-Controller Preset ─────────────────────────────────────────────

/**
 * Default event filter for the agent-controller preset.
 *
 * Only delivers events that have an explicit `runtime.*` type mapping in
 * {@link AGENT_CONTROLLER_TYPE_MAP}. Broad `result.*` and `status.*`
 * patterns are intentionally avoided: pi-materia emits result events
 * (e.g. `result.no_changes_needed`) that have no direct controller
 * equivalent; those are aggregated into the terminal `lifecycle.cast.completed`
 * event and reported via `runtime.completed` with a `payload.outcome`. Delivering
 * unmapped types would produce non-`runtime.*` eventType values that the
 * controller rejects with 422 (§7.4).
 *
 * Unmapped lifecycle events (`lifecycle.socket.started`,
 * `lifecycle.socket.completed`, `lifecycle.refinement.waiting`,
 * `lifecycle.socket.failed`) are also excluded — they have no `runtime.*`
 * equivalent in the controller contract.
 *
 * The controller supports (see agent_router docs §4):
 *   runtime.accepted, runtime.heartbeat, runtime.status, runtime.branch_created,
 *   runtime.pr_created, runtime.needs_human, runtime.completed, runtime.failed,
 *   runtime.cancelled
 */
const AGENT_CONTROLLER_FILTER: EventFilter = {
  include: [
    // Lifecycle events with explicit controller type mappings.
    "lifecycle.cast.started",
    "lifecycle.heartbeat",
    "lifecycle.status",
    "lifecycle.cast.completed",
    "lifecycle.cast.failed",
    "lifecycle.cast.cancelled",
    // Result events with explicit controller type mappings.
    "result.pr_created",
    "result.branch_pushed",
    "result.needs_human",
    // Status events with explicit controller type mappings.
    "status.progress",
    "status.info",
    "status.warning",
  ],
};

/**
 * Event type mapping: pi-materia → agent controller.
 *
 * Maps the generic pi-materia event types to the controller's `runtime.*`
 * event contract as defined in docs/runtime-eventing.md §9.2 and the agent
 * controller runtime event docs.
 */
const AGENT_CONTROLLER_TYPE_MAP: Record<string, string> = {
  "lifecycle.cast.started": "runtime.accepted",
  "lifecycle.heartbeat": "runtime.heartbeat",
  "lifecycle.status": "runtime.status",
  "lifecycle.cast.completed": "runtime.completed",
  "lifecycle.cast.failed": "runtime.failed",
  "lifecycle.cast.cancelled": "runtime.cancelled",
  "result.pr_created": "runtime.pr_created",
  "result.branch_pushed": "runtime.branch_created",
  "result.needs_human": "runtime.needs_human",
  // status.* events from materia (e.g. "status.progress", "status.info")
  // are also mapped to runtime.status for progress updates.
  "status.progress": "runtime.status",
  "status.info": "runtime.status",
  "status.warning": "runtime.status",
};

/**
 * Severity mapping: pi-materia → agent controller.
 *
 * The controller only accepts `info`, `warning`, `error`, and `critical`
 * (see agent_router runtime-events.md §2.2 and §3). pi-materia heartbeat
 * and socket-level events use `debug`, which the controller rejects.
 * This map transforms internal `debug` severity to `info` so events are
 * accepted by the controller without changing the internal event model.
 */
const AGENT_CONTROLLER_SEVERITY_MAP: Record<string, string> = {
  debug: "info",
};

/**
 * Body field mapping for the agent-controller preset.
 *
 * Translates the enriched event into the controller's expected envelope as
 * defined in the controller runtime event contract §2. The `eventType` field
 * uses the typeMap to transform pi-materia event types to controller types.
 * The `runtimeRunId` field uses the pi-materia castId.
 */
const AGENT_CONTROLLER_BODY_MAPPING: EventBodyFieldMapping = {
  eventId: "eventId",
  eventType: "type", // transformed via typeMap during body construction
  runtimeRunId: "castId",
  occurredAt: "occurredAt",
  severity: "severity", // transformed via severityMap during body construction
  message: "message",
  payload: "payload",
  sequence: "sequence",
};

/**
 * Determine whether a URL looks like a base URL (just an origin with no path)
 * rather than a full endpoint.
 */
function isBaseUrlOnly(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/" || parsed.pathname === "";
  } catch {
    return false;
  }
}

/**
 * Build the webhook URL for the agent-controller sink.
 *
 * Per agent_router docs §13b.5, `CONTROLLER_EVENT_URL` is the **full POST
 * endpoint** (e.g. `http://localhost:5000/runs/run_a1b2c3d4/events`). When
 * the environment variable is set we use it directly so the URL is not
 * doubled. When it is not set or appears to be only a base URL (origin with
 * no path), we construct the default URL with the resolved runId.
 */
function buildControllerUrl(runId: string | undefined): string {
  const envUrl = process.env[CONTROLLER_EVENT_URL_ENV]?.trim();

  if (envUrl) {
    const cleaned = envUrl.replace(/\/+$/, "");
    // When the env var is the full endpoint (has a path beyond just "/"),
    // use it directly to avoid doubling. When it's just a base URL
    // (e.g. "https://controller.example.com"), append the run path.
    if (!isBaseUrlOnly(cleaned)) {
      return cleaned;
    }
    return `${cleaned}/runs/${runId ?? "{runId}"}/events`;
  }

  return `${DEFAULT_CONTROLLER_URL}/runs/${runId ?? "{runId}"}/events`;
}

/**
 * Build the agent-controller webhook sink configuration.
 *
 * Resolves the controller runId and URL from the environment/context.
 * If the runId cannot be resolved, the sink is created with `enabled: false`
 * so it is skipped at dispatch time without failing the cast.
 *
 * @param contextDir - Optional context directory for context file resolution.
 *   If omitted, `CONTROLLER_CONTEXT_DIR` env var is checked automatically.
 * @returns A complete webhook sink config for the agent controller.
 */
export function buildAgentControllerSinkConfig(
  contextDir?: string,
): EventingWebhookSinkConfig {
  const runId = resolveControllerRunId(contextDir);
  const url = buildControllerUrl(runId);

  if (!runId) {
    // No runId resolved — create a disabled sink. The cast continues but
    // no events are delivered to the controller (per §9.3).
    return {
      id: "agent-controller-webhook",
      url,
      enabled: false,
      bodyMapping: AGENT_CONTROLLER_BODY_MAPPING,
      typeMap: AGENT_CONTROLLER_TYPE_MAP,
      severityMap: AGENT_CONTROLLER_SEVERITY_MAP,
      eventFilter: AGENT_CONTROLLER_FILTER,
    };
  }

  return {
    id: "agent-controller-webhook",
    url,
    enabled: true,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Controller-Run-Id": runId,
    },
    bodyTemplate: "mapped",
    bodyMapping: AGENT_CONTROLLER_BODY_MAPPING,
    typeMap: AGENT_CONTROLLER_TYPE_MAP,
    severityMap: AGENT_CONTROLLER_SEVERITY_MAP,
    eventFilter: AGENT_CONTROLLER_FILTER,
  };
}

// ── Preset Expansion ────────────────────────────────────────────────────

/**
 * Result of expanding preset names into concrete sink configurations.
 */
export interface ExpandedPresets {
  /** Sink configurations produced by the presets, keyed by sink id. */
  sinks: Record<string, EventSinkConfig>;
  /** Warnings produced during expansion (e.g. unresolved runId). */
  warnings: string[];
}

/**
 * Expand named presets into concrete sink configurations.
 *
 * Each preset name is looked up against the known presets. Unknown preset
 * names are logged as warnings and skipped (they do not cause errors).
 *
 * When a preset produces a sink id that already exists in the existing sinks,
 * the existing sink takes precedence — preset sinks are defaults that users
 * can override.
 *
 * @param presetNames - List of preset names to expand (e.g. `["agent-controller"]`).
 * @param existingSinks - Already-configured sinks that take precedence over preset expansions.
 * @param contextDir - Optional context directory for context file resolution.
 *   If omitted, `CONTROLLER_CONTEXT_DIR` env var is checked automatically.
 * @returns The expanded sink configs and any warnings.
 */
export function expandPresets(
  presetNames: readonly string[],
  existingSinks: Record<string, EventSinkConfig> | undefined,
  contextDir?: string,
): ExpandedPresets {
  const sinks: Record<string, EventSinkConfig> = {};
  const warnings: string[] = [];

  for (const presetName of presetNames) {
    const configs = expandPreset(presetName, contextDir);
    if (!configs) {
      warnings.push(
        `Unknown eventing preset "${presetName}". Supported presets: ${KNOWN_PRESETS.join(", ")}.`,
      );
      continue;
    }

    for (const [sinkId, sinkConfig] of Object.entries(configs)) {
      // Existing user-configured sinks take precedence over preset defaults.
      if (existingSinks && sinkId in existingSinks) {
        continue;
      }
      // Avoid duplicate preset sink configs from multiple preset expansions.
      if (sinkId in sinks) {
        continue;
      }
      sinks[sinkId] = sinkConfig;

      // Warn when agent-controller runId could not be resolved.
      if (sinkConfig.enabled === false && presetName === "agent-controller") {
        warnings.push(
          `Agent-controller preset active but no controller runId could be resolved ` +
          `from ${CONTROLLER_RUN_ID_ENV} environment variable or ${CONTROLLER_CONTEXT_DIR_ENV} ` +
          `environment variable / ${CONTROLLER_CONTEXT_FILE} context file. ` +
          `The webhook sink will be disabled until a runId is available.`,
        );
      }
    }
  }

  return { sinks, warnings };
}

/**
 * Expand a single preset name into its sink configurations.
 *
 * Returns `undefined` for unknown preset names (caller should warn).
 *
 * @param presetName - A known preset identifier.
 * @param contextDir - Optional context directory for context resolution.
 */
function expandPreset(
  presetName: string,
  contextDir?: string,
): Record<string, EventSinkConfig> | undefined {
  switch (presetName) {
    case "agent-controller":
      return {
        "agent-controller-webhook": buildAgentControllerSinkConfig(contextDir),
      };
    default:
      return undefined;
  }
}
