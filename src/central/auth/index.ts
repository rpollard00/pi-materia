/**
 * Central control-plane auth and RBAC.
 *
 * Development-token principal resolution plus permission checks for central
 * catalog/model-policy/admin/telemetry routes. OAuth/OIDC is a documented future
 * auth adapter boundary (`authAdapter.ts`) — not an implementation here
 * (docs/enterprise-control-plane.md §13).
 */

// Auth adapter boundary (the future OAuth/OIDC plug-in point).
export {
  BEARER_SCHEME,
  readBearerToken,
  type AuthAdapter,
  type AuthFailureReason,
  type AuthRequest,
  type AuthRequestHeaders,
  type AuthResolution,
} from "./authAdapter.js";

// Default central role registry.
export {
  DEFAULT_CENTRAL_ROLE_REGISTRY,
  DEFAULT_CENTRAL_ROLES,
  createRoleRegistry,
  type RoleRegistry,
} from "./roles.js";

// Development-token adapter.
export {
  DEFAULT_DEV_TOKEN_ADMIN,
  DEFAULT_DEV_TOKEN_READER,
  DEFAULT_DEV_TOKEN_SINK,
  DEFAULT_DEV_TOKEN_TENANT_ID,
  DEV_TOKEN_METHOD_KIND,
  createDevTokenAuthAdapter,
  defaultDevTokenPrincipals,
  defaultDevTokensReferenceDefaultRoles,
  type DevTokenAuthAdapterOptions,
  type DevTokenPrincipal,
  type DevTokenPrincipalConfig,
} from "./devTokenAuth.js";

// RBAC guard + 401/403 envelopes.
export {
  FORBIDDEN_ERROR,
  UNAUTHORIZED_ERROR,
  checkPermission,
  requirePermission,
  sendForbidden,
  sendUnauthorized,
  type CentralAuth,
  type RequirePermissionInput,
  type RequirePermissionResult,
} from "./rbac.js";

// Composition helper for the default CentralAuth.
export {
  createDefaultCentralAuth,
  type CentralAuthOptions,
} from "./centralAuth.js";
