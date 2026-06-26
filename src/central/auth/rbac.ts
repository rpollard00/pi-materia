import { principalHasPermission, type Permission } from "../../domain/identity.js";
import { type AuthContext, type AuthMethodKind } from "../../domain/auth.js";
import type { ScopePath } from "../../domain/scope.js";
import type { ServerResponse } from "node:http";
import { CENTRAL_CONTROL_PLANE_SCOPE, CENTRAL_SERVICE_ID } from "../controlPlane/shared.js";
import { sendJson } from "../server/http.js";
import {
  type AuthAdapter,
  type AuthFailureReason,
  type AuthRequest,
} from "./authAdapter.js";
import { type RoleRegistry } from "./roles.js";

/**
 * Central RBAC guard.
 *
 * Wires the auth adapter boundary (`./authAdapter.ts`), the role registry
 * (`./roles.ts`), and the pure domain permission-evaluation contracts
 * (`src/domain/identity.ts`) into a single request-time permission check used by
 * the central route dispatcher. The guard resolves the principal from the
 * request, evaluates the requested permission (optionally at a resource scope),
 * and emits a control-plane-scoped 401/403 envelope on failure. Permission
 * checks guard central routes only; local session/config/model selection is
 * unchanged (docs/enterprise-control-plane.md §13).
 */

/** Bundled auth configuration handed to route handlers and the dispatcher. */
export interface CentralAuth {
  /** Credential → principal resolver (dev-token adapter today; future OAuth adapter). */
  readonly adapter: AuthAdapter;
  /** Role id → role lookup used to evaluate role bindings. */
  readonly roleRegistry: RoleRegistry;
  /** Auth method kind the server reports in admin metadata and audit records. */
  readonly methodKind: AuthMethodKind;
}

export interface RequirePermissionInput {
  auth: CentralAuth;
  req: AuthRequest;
  res: ServerResponse;
  /** Permission required for the route (e.g. "telemetry.read", "catalog.write"). */
  permission: Permission;
  /** Optional target resource scope for scope-aware evaluation. */
  scope?: ScopePath;
}

export type RequirePermissionResult =
  | { readonly ok: true; readonly context: AuthContext }
  | { readonly ok: false; readonly status: 401 | 403; readonly reason: AuthFailureReason | "forbidden" };

export const UNAUTHORIZED_ERROR = "Unauthorized";
export const FORBIDDEN_ERROR = "Forbidden";

/** Emit a 401 envelope with a `WWW-Authenticate` challenge. */
export function sendUnauthorized(res: ServerResponse, reason: AuthFailureReason): void {
  res.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    // Bearer challenge; realm labels the surface, error maps the coarse failure.
    "www-authenticate": `Bearer realm="${CENTRAL_SERVICE_ID}", error="${reason}"`,
  });
  res.end(
    JSON.stringify({
      ok: false,
      scope: CENTRAL_CONTROL_PLANE_SCOPE,
      service: CENTRAL_SERVICE_ID,
      error: UNAUTHORIZED_ERROR,
      reason,
    }),
  );
}

/** Emit a 403 envelope when the principal is authenticated but lacks the permission. */
export function sendForbidden(res: ServerResponse, permission: Permission): void {
  sendJson(res, 403, {
    ok: false,
    scope: CENTRAL_CONTROL_PLANE_SCOPE,
    service: CENTRAL_SERVICE_ID,
    error: FORBIDDEN_ERROR,
    permission,
  });
}

/**
 * Resolve the request principal and require `permission`. On success returns the
 * resolved {@link AuthContext} (handlers use it for audit/provenance). On failure
 * writes the 401/403 response and returns `undefined`.
 *
 * - No/malformed/unknown/expired credential → 401.
 * - Authenticated principal without the permission at the optional scope → 403.
 */
export function requirePermission(input: RequirePermissionInput): AuthContext | undefined {
  const result = checkPermission(input);
  if (result.ok) return result.context;
  if (result.status === 401) {
    sendUnauthorized(input.res, result.reason as AuthFailureReason);
  } else {
    sendForbidden(input.res, input.permission);
  }
  return undefined;
}

/**
 * Pure permission decision (no response side effects). Exported so callers and
 * tests can evaluate a decision without committing to the HTTP envelope.
 */
export function checkPermission(input: Omit<RequirePermissionInput, "res">): RequirePermissionResult {
  const resolution = input.auth.adapter.resolve(input.req);
  if (resolution.status !== "authenticated") {
    return { ok: false, status: 401, reason: resolution.reason };
  }
  const allowed = principalHasPermission({
    principal: resolution.context.principal,
    permission: input.permission,
    resolveRole: input.auth.roleRegistry.resolve,
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
  });
  if (!allowed) return { ok: false, status: 403, reason: "forbidden" };
  return { ok: true, context: resolution.context };
}
