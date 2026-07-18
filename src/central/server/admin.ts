import type {
  AdminMetadataPort,
  AdminMetadataSnapshot,
  AdminRoleSummary,
} from "../../application/controlPlane.js";
import type { AuthContext } from "../../domain/auth.js";
import { resolveEffectivePermissions } from "../../domain/identity.js";
import { requirePermission, type CentralAuth } from "../auth/index.js";
import { CENTRAL_CONTROL_PLANE_SCOPE, CENTRAL_SERVICE_ID } from "../controlPlane/shared.js";
import { CENTRAL_BUILD_SCHEMA_VERSION, CENTRAL_BUILD_VERSION } from "./buildMetadata.js";
import { sendJson } from "./http.js";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface CentralAdminRouteDeps {
  admin: AdminMetadataPort;
  auth: CentralAuth;
  /** Build version override for embedded/test server composition. */
  buildVersion?: string;
  /** Schema version override for embedded/test server composition. */
  schemaVersion?: number;
}

const ADMIN_PATH_PREFIX = "/api/admin";
const SCOPE = CENTRAL_CONTROL_PLANE_SCOPE;
const SERVICE = CENTRAL_SERVICE_ID;

/**
 * Central administrative metadata route.
 *
 * `GET /api/admin` returns central server identity, build/schema information,
 * configured authentication methods, role definitions, secret-free static
 * principal summaries, and the caller's effective permissions. The route is
 * read-only and requires `admin.read`;
 * `admin.write` is intentionally reserved for future mutation endpoints.
 *
 * Route and method matching happen before authentication. Unknown admin
 * sub-paths therefore return 404 and unsupported root methods return 405 even
 * without credentials, matching the other central route groups.
 */
export async function handleCentralAdminRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CentralAdminRouteDeps,
): Promise<void> {
  const pathname = new URL(req.url ?? "", "http://localhost").pathname;
  const suffix = pathname.slice(ADMIN_PATH_PREFIX.length);

  if (suffix !== "" && suffix !== "/") {
    sendNotFound(res);
    return;
  }
  if (req.method !== "GET") {
    sendMethodNotAllowed(res);
    return;
  }
  const context = requirePermission({ auth: deps.auth, req, res, permission: "admin.read" });
  if (context === undefined) return;

  const metadata = await deps.admin.getMetadata();
  sendJson(res, 200, {
    ok: true,
    scope: SCOPE,
    service: SERVICE,
    metadata: composeAdminMetadata(metadata, deps, context),
  });
}

function composeAdminMetadata(
  metadata: AdminMetadataSnapshot,
  deps: CentralAdminRouteDeps,
  context: AuthContext,
): AdminMetadataSnapshot {
  const roles: AdminRoleSummary[] = [...deps.auth.roleRegistry.roles.values()]
    .map((role) => ({
      roleId: role.id,
      ...(role.name !== undefined ? { name: role.name } : {}),
      permissions: [...role.permissions],
    }))
    .sort((left, right) => left.roleId.localeCompare(right.roleId));
  const principals = deps.auth.principalSummaries ?? metadata.principals;
  const access = resolveEffectivePermissions(context.principal, {
    resolveRole: deps.auth.roleRegistry.resolve,
  });

  return {
    ...metadata,
    server: {
      ...metadata.server,
      service: SERVICE,
      buildVersion: deps.buildVersion ?? CENTRAL_BUILD_VERSION,
      schemaVersion: deps.schemaVersion ?? CENTRAL_BUILD_SCHEMA_VERSION,
      // The guard's adapter is authoritative for the HTTP server's configured
      // method; do not report stale metadata from an injected port.
      authMethods: [deps.auth.methodKind],
    },
    ...(principals !== undefined ? { principals } : {}),
    roles,
    access: {
      principalId: context.principal.id,
      roleIds: [...access.roleIds].sort(),
      permissions: [...access.permissions].sort(),
    },
  };
}

function sendNotFound(res: ServerResponse): void {
  sendJson(res, 404, { ok: false, scope: SCOPE, service: SERVICE, error: "Not found" });
}

function sendMethodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, {
    ok: false,
    scope: SCOPE,
    service: SERVICE,
    error: "Method not allowed",
    allow: "Use GET to read central admin metadata.",
  });
}
