import { requirePermission, type CentralAuth } from "../auth/index.js";
import { normalizeTelemetryIngestBody } from "../controlPlane/telemetryIngest.js";
import { CENTRAL_CONTROL_PLANE_SCOPE, CENTRAL_SERVICE_ID } from "../controlPlane/shared.js";
import { errorMessage, readJsonBody, sendJson } from "./http.js";
import type { TelemetryEventFilter, TelemetryStatusPort } from "../../application/controlPlane.js";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Central telemetry HTTP routes.
 *
 * The HTTP surface for central telemetry ingestion
 * (docs/enterprise-control-plane.md §15, §16.15). Ingestion is a fan-out
 * **sink**: local pi-materia runtimes deliver enriched runtime events (via the
 * existing webhook sink contract) and the central control plane records them
 * for future monitoring views. It never issues lifecycle/claim/state commands
 * back into pi-materia or `agent_router` (§6), and it is not a local
 * session/artifact monitoring channel.
 *
 * Routes:
 * - `POST /api/telemetry/ingest` → ingest a normalized event batch
 *   (body: enriched event | `[events]` | `{ events, runtimeId?, scope? }`;
 *   `?runtimeId=` is accepted as a fallback).
 * - `GET  /api/telemetry/events`  → read ingested events for central
 *   monitoring views (query: `runtimeId`/`castId`/`sinceSequence`/`limit`).
 *
 * Authorization follows §13: route matching precedes auth (unknown sub-paths
 * return 404, not 401), then the matched route calls {@link requirePermission}.
 * Ingestion requires `telemetry.ingest` — the `central-telemetry-sink` role
 * permission bound to the development sink token. The monitoring read surface
 * (`GET /api/telemetry/events`) requires `telemetry.read`. The status snapshot
 * read surface (`/api/status`) lives in its own handler; central monitoring
 * aggregates across runtimes and is **not** a replacement for local
 * session/artifact monitoring (§15, §16.16).
 */

export interface CentralTelemetryRouteDeps {
  telemetry: TelemetryStatusPort;
  auth: CentralAuth;
}

const TELEMETRY_PATH_PREFIX = "/api/telemetry";
const INGEST_PATH = `${TELEMETRY_PATH_PREFIX}/ingest`;
const EVENTS_PATH = `${TELEMETRY_PATH_PREFIX}/events`;
const SCOPE = CENTRAL_CONTROL_PLANE_SCOPE;
const SERVICE = CENTRAL_SERVICE_ID;

/**
 * Dispatch a `/api/telemetry*` request. Returns 404 for unknown sub-paths and
 * 405 for unsupported methods without invoking auth, so the dispatcher's "route
 * matching precedes auth" behavior is preserved.
 */
export async function handleCentralTelemetryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CentralTelemetryRouteDeps,
): Promise<void> {
  const url = new URL(req.url ?? "", "http://localhost");
  const pathname = url.pathname;

  if (pathname === INGEST_PATH || pathname.startsWith(`${INGEST_PATH}/`)) {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, "Use POST to ingest telemetry events.");
      return;
    }
    await handleIngest(req, res, url, deps);
    return;
  }

  // Central monitoring read surface for ingested events (§16.16). Reads
  // require telemetry.read; no sub-paths are defined so deeper paths 404.
  if (pathname === EVENTS_PATH) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "Use GET to read ingested telemetry events.");
      return;
    }
    await handleEvents(req, res, url, deps);
    return;
  }

  // Unknown sub-paths 404.
  sendNotFound(res);
}

// ───────────────────────────────────────────────────────────────────────
// Ingestion (telemetry.ingest)
// ───────────────────────────────────────────────────────────────────────

async function handleIngest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: CentralTelemetryRouteDeps,
): Promise<void> {
  // telemetry.ingest is the sink permission. The authenticated principal is a
  // delivery credential (e.g. the dev sink token), not the originating runtime.
  if (requirePermission({ auth: deps.auth, req, res, permission: "telemetry.ingest" }) === undefined) return;

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { ok: false, scope: SCOPE, service: SERVICE, error: errorMessage(error) });
    return;
  }

  const queryRuntimeId = readQueryParam(url.searchParams, "runtimeId");
  const normalized = normalizeTelemetryIngestBody(
    body,
    queryRuntimeId !== undefined ? { runtimeId: queryRuntimeId } : {},
  );
  if (!normalized.ok) {
    sendJson(res, 400, { ok: false, scope: SCOPE, service: SERVICE, error: normalized.error });
    return;
  }

  const result = await deps.telemetry.ingest(normalized.value.input);
  sendJson(res, 200, {
    ok: true,
    scope: SCOPE,
    service: SERVICE,
    result,
    rejected: normalized.value.rejected,
  });
}

// ───────────────────────────────────────────────────────────────────────
// Monitoring reads (telemetry.read)
// ───────────────────────────────────────────────────────────────────────

/**
 * Read ingested telemetry events for central monitoring views (§16.16). Central
 * monitoring aggregates across runtimes and is **not** a replacement for local
 * session/artifact monitoring: this surface never reflects a specific local
 * session's live artifact state, and the local artifact monitor is unchanged.
 *
 * Query params map to {@link TelemetryEventFilter}: `runtimeId`, `castId`,
 * `sinceSequence` (inclusive lower bound), and `limit` (non-negative integer).
 */
async function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: CentralTelemetryRouteDeps,
): Promise<void> {
  if (requirePermission({ auth: deps.auth, req, res, permission: "telemetry.read" }) === undefined) return;
  const parsed = parseEventsQuery(url.searchParams);
  if (!parsed.ok) {
    sendJson(res, 400, { ok: false, scope: SCOPE, service: SERVICE, error: parsed.error });
    return;
  }
  const events = await deps.telemetry.queryEvents(parsed.value);
  sendJson(res, 200, {
    ok: true,
    scope: SCOPE,
    service: SERVICE,
    events,
    count: events.length,
  });
}

// ───────────────────────────────────────────────────────────────────────
// Envelope helpers
// ───────────────────────────────────────────────────────────────────────

function readQueryParam(searchParams: URLSearchParams, name: string): string | undefined {
  const raw = searchParams.get(name);
  if (raw === null || raw.length === 0) return undefined;
  return raw;
}

// ───────────────────────────────────────────────────────────────────────
// Events query parsing (telemetry.read)
// ───────────────────────────────────────────────────────────────────────

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

function fail<T = never>(error: string): Parsed<T> {
  return { ok: false, error };
}

/** Parse the events query string into a validated {@link TelemetryEventFilter}. */
function parseEventsQuery(searchParams: URLSearchParams): Parsed<TelemetryEventFilter> {
  const filter: TelemetryEventFilter = {};
  const runtimeId = searchParams.get("runtimeId");
  if (runtimeId !== null && runtimeId.length > 0) filter.runtimeId = runtimeId;
  const castId = searchParams.get("castId");
  if (castId !== null && castId.length > 0) filter.castId = castId;
  const sinceSequence = searchParams.get("sinceSequence");
  if (sinceSequence !== null && sinceSequence.length > 0) {
    const value = Number(sinceSequence);
    if (!Number.isFinite(value)) {
      return fail(`telemetry events 'sinceSequence' query param must be a finite number, got "${sinceSequence}".`);
    }
    filter.sinceSequence = value;
  }
  const limit = searchParams.get("limit");
  if (limit !== null && limit.length > 0) {
    const value = Number(limit);
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      return fail(`telemetry events 'limit' query param must be a non-negative integer, got "${limit}".`);
    }
    filter.limit = value;
  }
  return { ok: true, value: filter };
}

function sendNotFound(res: ServerResponse): void {
  sendJson(res, 404, { ok: false, scope: SCOPE, service: SERVICE, error: "Not found" });
}

function sendMethodNotAllowed(res: ServerResponse, allow: string): void {
  sendJson(res, 405, { ok: false, scope: SCOPE, service: SERVICE, error: "Method not allowed", allow });
}
