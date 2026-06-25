import { requirePermission, type CentralAuth } from "../auth/index.js";
import { normalizeTelemetryIngestBody } from "../controlPlane/telemetryIngest.js";
import { CENTRAL_CONTROL_PLANE_SCOPE, CENTRAL_SERVICE_ID } from "../controlPlane/shared.js";
import { errorMessage, readJsonBody, sendJson } from "./http.js";
import type { TelemetryStatusPort } from "../../application/controlPlane.js";
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
 *
 * Authorization follows §13: route matching precedes auth (unknown sub-paths
 * return 404, not 401), then the matched route calls {@link requirePermission}.
 * Ingestion requires `telemetry.ingest` — the `central-telemetry-sink` role
 * permission bound to the development sink token. The status snapshot read
 * surface (`/api/status`) lives in its own handler; broader telemetry read APIs
 * (e.g. event queries) arrive in the central monitoring read-APIs work item
 * (§16.16).
 */

export interface CentralTelemetryRouteDeps {
  telemetry: TelemetryStatusPort;
  auth: CentralAuth;
}

const TELEMETRY_PATH_PREFIX = "/api/telemetry";
const INGEST_PATH = `${TELEMETRY_PATH_PREFIX}/ingest`;
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

  // Future telemetry read APIs (e.g. /api/telemetry/events) land in the
  // central monitoring read-APIs work item (§16.16). Unknown sub-paths 404.
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
// Envelope helpers
// ───────────────────────────────────────────────────────────────────────

function readQueryParam(searchParams: URLSearchParams, name: string): string | undefined {
  const raw = searchParams.get(name);
  if (raw === null || raw.length === 0) return undefined;
  return raw;
}

function sendNotFound(res: ServerResponse): void {
  sendJson(res, 404, { ok: false, scope: SCOPE, service: SERVICE, error: "Not found" });
}

function sendMethodNotAllowed(res: ServerResponse, allow: string): void {
  sendJson(res, 405, { ok: false, scope: SCOPE, service: SERVICE, error: "Method not allowed", allow });
}
