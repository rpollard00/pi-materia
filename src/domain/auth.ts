import { ok, type DomainIssue, type DomainResult } from "./result.js";
import { type Principal, type RoleBinding, validatePrincipal } from "./identity.js";
import { type ScopePath, validateScopePath } from "./scope.js";

/**
 * Authentication context domain contracts.
 *
 * Pure domain layer: no HTTP, OAuth library, persistence, or UI dependencies.
 * `AuthContext` is the single contract every auth adapter produces. The
 * development-token adapter is the first implementation; OAuth/OIDC is modeled
 * here only as a future adapter boundary (see docs/enterprise-control-plane.md
 * §13). This module intentionally does not implement OAuth flows, token parsing,
 * or network transport — adapters live outside the domain and produce the same
 * `AuthContext` / `Principal` contracts.
 */

/** How the AuthContext was established. `oauth` is reserved for the future adapter. */
export type AuthMethodKind = "dev-token" | "oauth";

export interface AuthMethod {
  kind: AuthMethodKind;
  /** Adapter identifier that produced the context, e.g. "dev-token" or a future "oidc". */
  adapter?: string;
}

/** Resolved authentication context for a request. Produced by auth adapters; consumed by RBAC and audit. */
export interface AuthContext {
  principal: Principal;
  method: AuthMethod;
  /** Scope at which the context was resolved; used for request-scoped RBAC and audit. */
  scope?: ScopePath;
  /** RFC3339 expiry timestamp when the underlying credential expires. */
  expiresAt?: string;
  /** Opaque adapter claims (e.g. token subject/issuer). Must never carry secrets. */
  claims?: Readonly<Record<string, unknown>>;
}

/**
 * Standardized OAuth/OIDC claims shape that a future OAuth adapter would parse and
 * map into `Principal` / `AuthContext`. This is a pure data boundary contract, not
 * an OAuth implementation; no flow, token parsing, or transport lives here.
 */
export interface OidcClaims {
  readonly sub?: string;
  readonly iss?: string;
  readonly aud?: string | readonly string[];
  readonly email?: string;
  readonly name?: string;
  readonly [claim: string]: unknown;
}

/** Input a future OAuth adapter maps into an AuthContext, alongside its OidcClaims. */
export interface OidcAuthResolution {
  readonly claims: OidcClaims;
  readonly tenantId: string;
  readonly roleBindings?: readonly RoleBinding[];
  readonly scope?: ScopePath;
}

export function isAuthMethodKind(value: unknown): value is AuthMethodKind {
  return value === "dev-token" || value === "oauth";
}

export function createAuthContext(init: AuthContext): DomainResult<AuthContext> {
  return validateAuthContext(init);
}

export function validateAuthMethod(value: unknown, path = "authMethod"): DomainResult<AuthMethod> {
  if (!isPlainObject(value)) return { ok: false, issues: [{ path, message: "auth method must be an object" }] };
  const issues: DomainIssue[] = [];
  if (!isAuthMethodKind(value.kind)) issues.push({ path: `${path}.kind`, message: "kind must be dev-token or oauth" });
  if (value.adapter !== undefined && !isNonEmptyString(value.adapter)) issues.push({ path: `${path}.adapter`, message: "adapter must be a non-empty string when provided" });
  if (issues.length > 0) return { ok: false, issues };
  const method = value as unknown as AuthMethod;
  return ok(Object.freeze({ kind: method.kind, ...(method.adapter !== undefined ? { adapter: method.adapter } : {}) }) as AuthMethod);
}

export function validateAuthContext(value: unknown, path = "authContext"): DomainResult<AuthContext> {
  if (!isPlainObject(value)) return { ok: false, issues: [{ path, message: "auth context must be an object" }] };
  const issues: DomainIssue[] = [];

  let principal: Principal | undefined;
  if (value.principal === undefined) {
    issues.push({ path: `${path}.principal`, message: "principal is required" });
  } else {
    const principalResult = validatePrincipal(value.principal, `${path}.principal`);
    if (!principalResult.ok) issues.push(...principalResult.issues);
    else principal = principalResult.value;
  }

  let method: AuthMethod | undefined;
  if (value.method === undefined) {
    issues.push({ path: `${path}.method`, message: "method is required" });
  } else {
    const methodResult = validateAuthMethod(value.method, `${path}.method`);
    if (!methodResult.ok) issues.push(...methodResult.issues);
    else method = methodResult.value;
  }

  let scope: ScopePath | undefined;
  if (value.scope !== undefined) {
    const scopeResult = validateScopePath(value.scope, `${path}.scope`);
    if (!scopeResult.ok) issues.push(...scopeResult.issues);
    else scope = scopeResult.value;
  }
  if (value.expiresAt !== undefined && !isNonEmptyString(value.expiresAt)) issues.push({ path: `${path}.expiresAt`, message: "expiresAt must be a non-empty string when provided" });
  if (value.claims !== undefined && !isPlainObject(value.claims)) issues.push({ path: `${path}.claims`, message: "claims must be an object when provided" });

  if (issues.length > 0 || principal === undefined || method === undefined) return { ok: false, issues };

  const context = value as unknown as AuthContext;
  return ok(Object.freeze({
    principal,
    method,
    ...(scope !== undefined ? { scope } : {}),
    ...(context.expiresAt !== undefined ? { expiresAt: context.expiresAt } : {}),
    ...(context.claims !== undefined ? { claims: Object.freeze({ ...context.claims }) } : {}),
  }) as AuthContext);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
