import { CENTRAL_SERVICE_ID } from "../controlPlane/shared.js";
import { handleCentralHealthRoute } from "./health.js";
import { sendJson } from "./http.js";
import { handleCentralStatusRoute } from "./status.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ControlPlanePorts } from "../../application/controlPlane.js";

export interface MateriaCentralRouteDeps {
  ports: ControlPlanePorts;
  /** Mode reported on health envelopes; defaults to the ports' reported mode. */
  label?: string;
}

/**
 * Ordered dispatcher for the central control-plane HTTP surface.
 *
 * Intentionally separate from the local-session WebUI dispatcher
 * (src/webui/server/routes.ts): central routes live on the central server only,
 * and local-session routes (`/api/session`, `/api/quests`, `/api/loadout/*`,
 * `/api/monitor/*`) are **not** exposed here — the central server has no local
 * repository session (docs/enterprise-control-plane.md §3.3, §8, §9).
 *
 * Only health/status routes are wired at the skeleton stage. Catalog,
 * model-policy, telemetry-ingestion, and admin routes arrive in later work
 * items (§16.6, §16.13, §16.15, §16.16) and should be added as ordered branches
 * below, mirroring this dispatcher's style.
 */
export async function handleMateriaCentralRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MateriaCentralRouteDeps,
): Promise<void> {
  const mode = deps.ports.telemetry.mode().mode;

  if (req.url?.startsWith("/api/health")) {
    handleCentralHealthRoute(res, { mode, ...(deps.label !== undefined ? { label: deps.label } : {}) });
    return;
  }

  if (req.url?.startsWith("/api/status")) {
    await handleCentralStatusRoute(res, { telemetry: deps.ports.telemetry });
    return;
  }

  sendJson(res, 404, {
    ok: false,
    scope: "control-plane",
    service: CENTRAL_SERVICE_ID,
    error: "Not found",
  });
}
