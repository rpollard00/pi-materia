/**
 * Shared constants and helpers for the central control-plane in-memory adapters.
 *
 * Central adapters live under `src/central/`, separate from the local session
 * WebUI server and from the local control-plane adapter in `src/infrastructure`
 * (docs/enterprise-control-plane.md §4). They always report `central-admin`
 * topology (central reachable, no local repository session) and never couple to
 * a local repository. Standalone server composition uses SQLite persistence;
 * in-memory adapters remain available for tests (docs/enterprise-control-plane.md §16.4).
 */

/** Stable service identifier surfaced on central health/status envelopes. */
export const CENTRAL_SERVICE_ID = "pi-materia-central";

/** Scope marker that distinguishes central control-plane responses from local session (`session`) ones. */
export const CENTRAL_CONTROL_PLANE_SCOPE = "control-plane";

/**
 * Soft cap on retained events in the test/development in-memory telemetry
 * fallback. Standalone server composition uses the durable SQLite telemetry
 * adapter with time-based retention instead.
 */
export const CENTRAL_IN_MEMORY_EVENT_CAP = 1000;

/** Current RFC3339 timestamp. */
export function nowIso(): string {
  return new Date().toISOString();
}
