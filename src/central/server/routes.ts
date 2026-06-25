import { requirePermission, type CentralAuth } from "../auth/index.js";
import { CENTRAL_SERVICE_ID } from "../controlPlane/shared.js";
import { handleCentralCatalogRoute } from "./catalog.js";
import { handleCentralHealthRoute } from "./health.js";
import { handleCentralModelCatalogRoute } from "./modelCatalog.js";
import { handleCentralModelPolicyRoute } from "./modelPolicy.js";
import { sendJson } from "./http.js";
import { handleCentralStatusRoute } from "./status.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ControlPlanePorts } from "../../application/controlPlane.js";

export interface MateriaCentralRouteDeps {
  ports: ControlPlanePorts;
  /** Auth configuration used by route guards (dev-token adapter today). */
  auth: CentralAuth;
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
 * Route authorization follows docs/enterprise-control-plane.md §13: central
 * route groups are gated by the domain principal/permission contracts. Health
 * is intentionally public (liveness). Other central routes require a permission
 * resolved through the dev-token adapter today (future OAuth adapter produces
 * the same contracts). Route matching precedes auth, so unknown routes still
 * return 404 rather than leaking existence through a 401.
 *
 * Catalog read/admin-write routes are wired below (§16.6), guarded with
 * `catalog.read` / `catalog.write`. Model-policy read/admin-write routes and
 * the optional model-catalog read route are wired below (§16.13), guarded with
 * `model-policy.read` / `model-policy.write`. Telemetry-ingestion and the
 * broader admin route handlers arrive in later work items (§16.15, §16.16); add
 * them as ordered branches, each calling {@link requirePermission} with the
 * matching permission (`admin.read`/`write`, `telemetry.read`/`telemetry.ingest`).
 */
export async function handleMateriaCentralRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MateriaCentralRouteDeps,
): Promise<void> {
  const mode = deps.ports.telemetry.mode().mode;

  // Health is public so liveness/readiness probes work without credentials.
  if (req.url?.startsWith("/api/health")) {
    handleCentralHealthRoute(res, { mode, ...(deps.label !== undefined ? { label: deps.label } : {}) });
    return;
  }

  // Central monitoring/status read surface (§15, §16.16). Requires telemetry.read.
  if (req.url?.startsWith("/api/status")) {
    if (requirePermission({ auth: deps.auth, req, res, permission: "telemetry.read" }) === undefined) return;
    await handleCentralStatusRoute(res, { telemetry: deps.ports.telemetry });
    return;
  }

  // Central catalog read + admin write surface (§16.6). Kind is part of the
  // path so materia and loadout definitions sharing an id do not collide.
  // Reads require catalog.read; admin writes require catalog.write. Sub-path
  // and method routing (and 404/405 precedence over auth) live in the handler.
  const catalogPath = new URL(req.url ?? "", "http://localhost").pathname;
  if (catalogPath === "/api/catalog" || catalogPath.startsWith("/api/catalog/")) {
    await handleCentralCatalogRoute(req, res, { catalog: deps.ports.catalog, admin: deps.ports.admin, auth: deps.auth });
    return;
  }

  // Central model-policy read + admin write surface (§16.13). Serves policy
  // documents independently from local Pi model availability. Reads require
  // model-policy.read; admin writes require model-policy.write. Sub-path and
  // method routing (and 404/405 precedence over auth) live in the handler.
  if (catalogPath === "/api/model-policy" || catalogPath.startsWith("/api/model-policy/")) {
    await handleCentralModelPolicyRoute(req, res, {
      modelPolicy: deps.ports.modelPolicy,
      admin: deps.ports.admin,
      auth: deps.auth,
    });
    return;
  }

  // Optional central model-catalog metadata (§16.13). Presentation metadata
  // only; never constrains selection. Requires model-policy.read.
  if (catalogPath === "/api/model-catalog" || catalogPath.startsWith("/api/model-catalog/")) {
    await handleCentralModelCatalogRoute(req, res, { modelPolicy: deps.ports.modelPolicy, auth: deps.auth });
    return;
  }

  // Future route groups (each guarded with requirePermission):
  //   /api/admin/*          → admin.read / admin.write           (§16.6)
  //   /api/telemetry/ingest → telemetry.ingest                   (§16.15)

  sendJson(res, 404, {
    ok: false,
    scope: "control-plane",
    service: CENTRAL_SERVICE_ID,
    error: "Not found",
  });
}
