import { centralAdminModeMetadata } from "../../application/controlPlane.js";
import { CENTRAL_CONTROL_PLANE_SCOPE, CENTRAL_SERVICE_ID } from "../controlPlane/shared.js";
import { sendJson } from "./http.js";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface CentralBackendModeRouteDeps {
  /** Optional deployment label surfaced to the browser shell. */
  label?: string;
}

/**
 * Public discovery document for the standalone central-admin browser.
 *
 * The central server is deliberately not attached to a repository session, so
 * local endpoints are always unavailable and central endpoints are same-origin.
 * Authentication is discovered separately by attempting a protected central
 * API read; no principal or credential information is exposed here.
 */
export function resolveCentralBackendMode(deps: CentralBackendModeRouteDeps = {}) {
  const mode = centralAdminModeMetadata(deps.label === undefined ? undefined : { label: deps.label });
  return {
    ok: true,
    scope: CENTRAL_CONTROL_PLANE_SCOPE,
    service: CENTRAL_SERVICE_ID,
    ...mode,
    endpoints: {
      local: { available: false, sameOrigin: false },
      central: { available: true, sameOrigin: true, baseUrl: "" },
    },
  } as const;
}

/** Handle `GET /api/backend-mode` without requiring a bearer credential. */
export function handleCentralBackendModeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CentralBackendModeRouteDeps = {},
): void {
  if (req.method !== "GET") {
    sendJson(res, 405, {
      ok: false,
      scope: CENTRAL_CONTROL_PLANE_SCOPE,
      service: CENTRAL_SERVICE_ID,
      error: "Method not allowed",
      allow: "Use GET to read backend mode discovery.",
    });
    return;
  }
  sendJson(res, 200, resolveCentralBackendMode(deps));
}
