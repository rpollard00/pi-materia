/**
 * Shared constants and helpers for the central control-plane in-memory adapters.
 *
 * Central adapters live under `src/central/`, separate from the local session
 * WebUI server and from the local control-plane adapter in `src/infrastructure`
 * (docs/enterprise-control-plane.md §4). They always report `central-admin`
 * topology (central reachable, no local repository session) and back the central
 * server skeleton with in-memory storage only — no persistence and no local
 * repository coupling (docs/enterprise-control-plane.md §16.4).
 */

/** Stable service identifier surfaced on central health/status envelopes. */
export const CENTRAL_SERVICE_ID = "pi-materia-central";

/** Scope marker that distinguishes central control-plane responses from local session (`session`) ones. */
export const CENTRAL_CONTROL_PLANE_SCOPE = "control-plane";

/**
 * Soft cap on retained ingested events in the in-memory central telemetry store.
 * The ingestion endpoint (`POST /api/telemetry/ingest`, §16.15) stores normalized
 * events in memory initially; this cap keeps that store bounded (oldest events
 * are dropped when it is reached). Persistence is a later work item
 * (docs/enterprise-control-plane.md §15).
 */
export const CENTRAL_IN_MEMORY_EVENT_CAP = 1000;

/** Current RFC3339 timestamp. */
export function nowIso(): string {
  return new Date().toISOString();
}
