import { CENTRAL_CONTROL_PLANE_SCOPE, CENTRAL_SERVICE_ID } from "../controlPlane/shared.js";
import { sendJson } from "./http.js";
import type { ServerResponse } from "node:http";
import type { TelemetryStatusPort } from "../../application/controlPlane.js";

export interface CentralStatusRouteDeps {
  telemetry: TelemetryStatusPort;
}

/**
 * Central status route. Returns the control-plane status snapshot produced by
 * the telemetry/status port, wrapped so clients can distinguish it from a
 * local-session snapshot (docs/enterprise-control-plane.md §15). Central
 * monitoring aggregates across runtimes and is not a replacement for local
 * session/artifact monitoring.
 */
export async function handleCentralStatusRoute(res: ServerResponse, deps: CentralStatusRouteDeps): Promise<void> {
  const status = await deps.telemetry.status();
  sendJson(res, 200, {
    ok: true,
    scope: CENTRAL_CONTROL_PLANE_SCOPE,
    service: CENTRAL_SERVICE_ID,
    status,
  });
}
