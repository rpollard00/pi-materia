import { CENTRAL_CONTROL_PLANE_SCOPE, CENTRAL_SERVICE_ID } from "../controlPlane/shared.js";
import { sendJson } from "./http.js";
import type { ServerResponse } from "node:http";
import type { ControlPlaneMode } from "../../application/controlPlane.js";

export interface CentralHealthRouteDeps {
  mode?: ControlPlaneMode;
  label?: string;
}

/**
 * Central health route. Mirrors the local-session health envelope shape but is
 * scoped to the control plane and carries the central service id, so clients can
 * distinguish a central response from a local-session (`scope: "session"`)
 * response (docs/enterprise-control-plane.md §2, §8).
 */
export function handleCentralHealthRoute(res: ServerResponse, deps: CentralHealthRouteDeps): void {
  sendJson(res, 200, {
    ok: true,
    scope: CENTRAL_CONTROL_PLANE_SCOPE,
    service: CENTRAL_SERVICE_ID,
    mode: deps.mode ?? "central-admin",
    ...(deps.label !== undefined ? { label: deps.label } : {}),
  });
}
