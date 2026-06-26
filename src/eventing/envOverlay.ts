import type { EventingConfig } from "../types.js";

// ── Documented PI_MATERIA_EVENTING_* Variables ──────────────────────────

/**
 * Documented `PI_MATERIA_EVENTING_*` environment variable contract.
 *
 * These variables let a launcher (e.g. agent_router) override the eventing
 * configuration at launch time **without editing config files**. The parsed
 * overlay is kept in memory and merged on top of the normally-loaded config
 * (see {@link readEventingEnvOverlay} and the merge step in config loading) so
 * launch-time values take precedence over bundled/user/project/explicit layers.
 *
 * Resolution of the underlying webhook target still flows through the
 * agent-controller preset (see `eventing/presets.ts`), which reads the
 * `CONTROLLER_RUN_ID` / `CONTROLLER_EVENT_URL` / `CONTROLLER_CONTEXT_DIR`
 * variables set by the controller. The overlay here only controls the
 * top-level eventing switches that the controller cannot otherwise flip when
 * the local config has eventing disabled.
 *
 * Parsing rules (docs/runtime-eventing.md §6 / §8.4):
 * - Only the documented variables below are parsed. Unknown
 *   `PI_MATERIA_EVENTING_*` variables are ignored.
 * - Unset or empty values are ignored.
 * - Invalid values are ignored and reported as diagnostics; they never fail
 *   config load or the cast.
 * - The overlay is in-memory only — it is never written back to config files.
 */

/** Master switch: enable/disable runtime eventing at launch time. */
export const EVENTING_ENABLED_ENV = "PI_MATERIA_EVENTING_ENABLED";

/** Comma/whitespace-separated preset names to activate (e.g. "agent-controller"). */
export const EVENTING_PRESETS_ENV = "PI_MATERIA_EVENTING_PRESETS";

/** Heartbeat emission interval in milliseconds (positive integer). */
export const EVENTING_HEARTBEAT_MS_ENV = "PI_MATERIA_EVENTING_HEARTBEAT_MS";

/** All documented `PI_MATERIA_EVENTING_*` variable names. */
export const DOCUMENTED_EVENTING_ENV_VARS = [
  EVENTING_ENABLED_ENV,
  EVENTING_PRESETS_ENV,
  EVENTING_HEARTBEAT_MS_ENV,
] as const;

/** A documented `PI_MATERIA_EVENTING_*` variable name. */
export type DocumentedEventingEnvVar = (typeof DOCUMENTED_EVENTING_ENV_VARS)[number];

// ── Env Source ──────────────────────────────────────────────────────────

/**
 * Minimal environment record shape used by the overlay reader.
 *
 * Accepting an explicit record (instead of reading `process.env` directly)
 * keeps parsing pure and testable. {@link readEventingEnvOverlay} defaults to
 * `process.env`.
 */
export type EventingEnvSource = Readonly<Record<string, string | undefined>>;

// ── Diagnostics ─────────────────────────────────────────────────────────

/** Severity for overlay diagnostics. Always "warning" — parsing never fails. */
export type EventingEnvDiagnosticSeverity = "warning";

/**
 * A diagnostic produced while parsing the eventing env overlay.
 *
 * Diagnostics are non-fatal: an invalid documented variable is ignored (not
 * applied to the overlay) and surfaced here so callers can log it without
 * failing unrelated local runs.
 */
export interface EventingEnvDiagnostic {
  /** The documented variable that produced the diagnostic. */
  readonly varName: DocumentedEventingEnvVar;
  /** Diagnostic severity (always "warning"). */
  readonly severity: EventingEnvDiagnosticSeverity;
  /** Human-readable explanation of why the value was ignored. */
  readonly message: string;
  /** The raw (untrimmed) value that was rejected, for context. */
  readonly rawValue: string;
}

// ── Overlay Result ──────────────────────────────────────────────────────

/**
 * Result of reading the documented `PI_MATERIA_EVENTING_*` overlay.
 *
 * The {@link overlay} is a partial eventing config containing only the fields
 * that were successfully parsed from a non-empty, valid documented variable.
 * Callers merge this on top of the loaded config (precedence: env wins).
 */
export interface EventingEnvOverlay {
  /**
   * Partial eventing config derived from documented env vars.
   *
   * Contains only successfully-parsed fields. When {@link present} is false
   * this is an empty object.
   */
  readonly overlay: Readonly<Partial<EventingConfig>>;
  /** Whether at least one documented variable produced a usable value. */
  readonly present: boolean;
  /** Non-fatal diagnostics for ignored/invalid documented values. */
  readonly diagnostics: readonly EventingEnvDiagnostic[];
}

// ── Value Parsing ───────────────────────────────────────────────────────

/** Case-insensitive strings interpreted as boolean `true`. */
const ENV_BOOLEAN_TRUE = new Set(["true", "1", "yes", "on"]);
/** Case-insensitive strings interpreted as boolean `false`. */
const ENV_BOOLEAN_FALSE = new Set(["false", "0", "no", "off"]);

/**
 * Parse a documented boolean env value.
 *
 * Accepts case-insensitive `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`.
 * Returns `undefined` for empty or unrecognized values (caller ignores).
 */
function parseEnvBoolean(raw: string): boolean | undefined {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  if (ENV_BOOLEAN_TRUE.has(normalized)) return true;
  if (ENV_BOOLEAN_FALSE.has(normalized)) return false;
  return undefined;
}

/**
 * Parse a documented list env value into a de-duplicated string array.
 *
 * Values are split on commas and/or whitespace; empty fragments are dropped.
 * Order is preserved on first occurrence. Returns an empty array when the
 * trimmed value contains no tokens.
 */
function parseEnvStringList(raw: string): string[] {
  const tokens = raw.split(/[,\s]+/).map((token) => token.trim()).filter((token) => token.length > 0);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token);
      result.push(token);
    }
  }
  return result;
}

/**
 * Parse a documented positive-integer env value.
 *
 * Accepts only digits (an optional leading `+` is rejected to keep the format
 * strict). Returns `undefined` for empty, non-numeric, zero, or negative
 * values (caller ignores).
 */
function parseEnvPositiveInteger(raw: string): number | undefined {
  const normalized = raw.trim();
  if (!normalized) return undefined;
  if (!/^[0-9]+$/.test(normalized)) return undefined;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

// ── Overlay Reader ──────────────────────────────────────────────────────

/**
 * Read the documented `PI_MATERIA_EVENTING_*` overlay from an environment.
 *
 * This is the single entry point for env-overlay parsing. It reads only the
 * documented variables, ignores unset/empty/invalid values, and returns a
 * partial eventing config plus any non-fatal diagnostics. It performs no I/O
 * and never mutates config files — the result is in-memory only.
 *
 * Use {@link readEventingEnvOverlayFromProcess} for the convenience wrapper
 * that reads `process.env`.
 *
 * @param env - Environment record to read (defaults to `process.env`).
 * @returns The parsed overlay, whether any value was present, and diagnostics.
 */
export function readEventingEnvOverlay(env: EventingEnvSource = process.env): EventingEnvOverlay {
  const overlay: Partial<EventingConfig> = {};
  const diagnostics: EventingEnvDiagnostic[] = [];
  let present = false;

  // ── enabled ──────────────────────────────────────────────────────────
  const enabledRaw = env[EVENTING_ENABLED_ENV];
  if (typeof enabledRaw === "string" && enabledRaw.trim()) {
    const enabled = parseEnvBoolean(enabledRaw);
    if (enabled === undefined) {
      diagnostics.push({
        varName: EVENTING_ENABLED_ENV,
        severity: "warning",
        message:
          `Ignoring ${EVENTING_ENABLED_ENV}: value "${enabledRaw.trim()}" is not a recognized boolean ` +
          `(expected one of: true, false, 1, 0, yes, no, on, off).`,
        rawValue: enabledRaw,
      });
    } else {
      overlay.enabled = enabled;
      present = true;
    }
  }

  // ── presets ──────────────────────────────────────────────────────────
  const presetsRaw = env[EVENTING_PRESETS_ENV];
  if (typeof presetsRaw === "string" && presetsRaw.trim()) {
    const presets = parseEnvStringList(presetsRaw);
    if (presets.length > 0) {
      overlay.presets = presets;
      present = true;
    }
    // An all-whitespace/commas value (presets.length === 0) is treated as
    // unset — no diagnostic, since an empty presets list is a legitimate
    // no-op rather than a malformed value.
  }

  // ── heartbeatIntervalMs ──────────────────────────────────────────────
  const heartbeatRaw = env[EVENTING_HEARTBEAT_MS_ENV];
  if (typeof heartbeatRaw === "string" && heartbeatRaw.trim()) {
    const heartbeatMs = parseEnvPositiveInteger(heartbeatRaw);
    if (heartbeatMs === undefined) {
      diagnostics.push({
        varName: EVENTING_HEARTBEAT_MS_ENV,
        severity: "warning",
        message:
          `Ignoring ${EVENTING_HEARTBEAT_MS_ENV}: value "${heartbeatRaw.trim()}" is not a positive integer ` +
          `(milliseconds).`,
        rawValue: heartbeatRaw,
      });
    } else {
      overlay.heartbeatIntervalMs = heartbeatMs;
      present = true;
    }
  }

  return { overlay, present, diagnostics };
}

/**
 * Convenience wrapper that reads the documented overlay from `process.env`.
 *
 * Equivalent to `readEventingEnvOverlay(process.env)` but makes the launch-time
 * intent explicit at call sites.
 */
export function readEventingEnvOverlayFromProcess(): EventingEnvOverlay {
  return readEventingEnvOverlay(process.env);
}
