import { type ModelPolicyPort } from "../../application/controlPlane.js";
import { requirePermission, type CentralAuth } from "../auth/index.js";
import { CENTRAL_CONTROL_PLANE_SCOPE, CENTRAL_SERVICE_ID } from "../controlPlane/shared.js";
import { sendJson } from "./http.js";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface CentralModelCatalogRouteDeps {
  modelPolicy: ModelPolicyPort;
  auth: CentralAuth;
}

const MODEL_CATALOG_PATH_PREFIX = "/api/model-catalog";

/**
 * Central model-catalog HTTP route.
 *
 * Serves the **optional** central model-catalog metadata
 * (docs/enterprise-control-plane.md §11, §16.13): presentation metadata about
 * models the central control plane knows about, independent of local Pi model
 * availability. This metadata never constrains selection on its own — model
 * selection is constrained by model-policy documents (`/api/model-policy`); the
 * catalog is purely informational for central/UI views.
 *
 * Routes:
 * - `GET /api/model-policy/../model-catalog` is **not** a path; the catalog
 *   lives at `GET /api/model-catalog`.
 *
 * Authorization follows §13: `model-policy.read` gates the catalog read (it is
 * part of the model surface). Returns a 200 with `catalog: undefined` semantics
 * by omitting the `catalog` field when no central model catalog is configured.
 */
export async function handleCentralModelCatalogRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CentralModelCatalogRouteDeps,
): Promise<void> {
  const url = new URL(req.url ?? "", "http://localhost");
  const segments = url.pathname
    .slice(MODEL_CATALOG_PATH_PREFIX.length)
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  // Only the collection root is supported.
  if (segments.length !== 0) {
    sendJson(res, 404, { ok: false, scope: CENTRAL_CONTROL_PLANE_SCOPE, service: CENTRAL_SERVICE_ID, error: "Not found" });
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, {
      ok: false,
      scope: CENTRAL_CONTROL_PLANE_SCOPE,
      service: CENTRAL_SERVICE_ID,
      error: "Method not allowed",
      allow: "Use GET to read the central model catalog.",
    });
    return;
  }

  if (requirePermission({ auth: deps.auth, req, res, permission: "model-policy.read" }) === undefined) return;
  const catalog = await deps.modelPolicy.getModelCatalog();
  sendJson(res, 200, {
    ok: true,
    scope: CENTRAL_CONTROL_PLANE_SCOPE,
    service: CENTRAL_SERVICE_ID,
    ...(catalog !== undefined ? { catalog } : {}),
  });
}
