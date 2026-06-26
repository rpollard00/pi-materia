import { ok, type DomainIssue, type DomainResult } from "./result.js";
import { isScopeAncestorOrEqual, validateScopePath, type ScopePath } from "./scope.js";

/**
 * Identity and authorization domain contracts.
 *
 * Pure domain layer: no HTTP, OAuth, persistence, or UI dependencies. These
 * contracts describe principals, roles, role bindings, and permissions, plus the
 * pure permission-evaluation logic consumed by the central control-plane RBAC
 * surface. Permission checks guard central routes only; local session behavior is
 * unchanged. See docs/enterprise-control-plane.md §13.
 */

/** Open permission string (e.g. "catalog.read"). Not limited to known values. */
export type Permission = string;

export const PERMISSION_NAMESPACE_SEPARATOR = ".";
export const WILDCARD_PERMISSION = "*";

/**
 * Curated permissions for the central control-plane route groups. This is an open
 * set; callers may define additional permission strings, and these constants exist
 * only so route guards reference stable names. See docs/enterprise-control-plane.md
 * §13 (catalog, model-policy, admin, telemetry routes).
 */
export const CENTRAL_PERMISSIONS = [
  "catalog.read",
  "catalog.write",
  "model-policy.read",
  "model-policy.write",
  "admin.read",
  "admin.write",
  "telemetry.read",
  "telemetry.ingest",
] as const;
export type CentralControlPlanePermission = (typeof CENTRAL_PERMISSIONS)[number];

/** A named bundle of permissions that may be granted to principals. */
export interface Role {
  id: string;
  name?: string;
  description?: string;
  permissions: readonly Permission[];
}

/** Grants a role to a principal, optionally scoped to a containment path. Undefined scope = global. */
export interface RoleBinding {
  roleId: string;
  scope?: ScopePath;
}

/** The authenticated actor. Belongs to exactly one tenant. */
export interface Principal {
  id: string;
  /** Stable login/subject identifier (e.g. token subject). */
  subject?: string;
  name?: string;
  email?: string;
  tenantId: string;
  roleBindings: readonly RoleBinding[];
}

export function isPermission(value: unknown): value is Permission {
  return isNonEmptyString(value);
}

export function isKnownCentralPermission(value: unknown): value is CentralControlPlanePermission {
  return typeof value === "string" && (CENTRAL_PERMISSIONS as readonly string[]).includes(value);
}

/** Names of the central control-plane route groups a permission namespace maps to. */
export const CENTRAL_PERMISSION_NAMESPACES = ["catalog", "model-policy", "admin", "telemetry"] as const;
export type CentralPermissionNamespace = (typeof CENTRAL_PERMISSION_NAMESPACES)[number];

/**
 * True when a granted permission satisfies a requested permission. Honors the global
 * wildcard `*` and the namespace wildcard `namespace.*` (e.g. `catalog.*` matches
 * `catalog.read` and `catalog.write` but not `model-policy.read`).
 */
export function permissionMatches(granted: Permission, requested: Permission): boolean {
  if (granted === WILDCARD_PERMISSION || granted === requested) return true;
  const wildcardSuffix = `${PERMISSION_NAMESPACE_SEPARATOR}${WILDCARD_PERMISSION}`;
  if (granted.endsWith(wildcardSuffix)) {
    const namespace = granted.slice(0, -wildcardSuffix.length);
    if (namespace.length === 0) return false;
    return requested === namespace || requested.startsWith(`${namespace}${PERMISSION_NAMESPACE_SEPARATOR}`);
  }
  return false;
}

export interface ResolvePermissionsOptions {
  /** Target resource scope. When omitted, all bindings apply (no scope filtering). */
  scope?: ScopePath;
  /** Resolves role id to Role. Unknown role ids contribute nothing. */
  resolveRole?: (roleId: string) => Role | undefined;
}

export interface ResolvedPermissions {
  /** Snapshot of granted permissions from applicable bindings. */
  readonly permissions: ReadonlySet<Permission>;
  /** True when any applicable role grants the global wildcard. */
  readonly includesWildcard: boolean;
  /** Role ids that contributed, applicable bindings only. */
  readonly roleIds: readonly string[];
}

/**
 * Resolve the effective permissions for a principal at an optional target scope.
 * A binding applies when it is global (no scope) or its scope is an
 * ancestor-or-equal of the target scope. Returns a fresh snapshot.
 */
export function resolveEffectivePermissions(principal: Principal, options: ResolvePermissionsOptions = {}): ResolvedPermissions {
  const permissions = new Set<Permission>();
  const roleIds: string[] = [];
  let includesWildcard = false;

  for (const binding of principal.roleBindings) {
    if (options.scope !== undefined && binding.scope !== undefined && !isScopeAncestorOrEqual(binding.scope, options.scope)) continue;
    const role = options.resolveRole?.(binding.roleId);
    if (role === undefined) continue;
    roleIds.push(role.id);
    for (const permission of role.permissions) {
      if (permission === WILDCARD_PERMISSION) includesWildcard = true;
      permissions.add(permission);
    }
  }

  return {
    permissions,
    includesWildcard,
    roleIds: Object.freeze(roleIds),
  };
}

export interface PermissionCheckInput {
  principal: Principal;
  permission: Permission;
  /** Resolves role id to Role. Required for non-wildcard evaluation. */
  resolveRole: (roleId: string) => Role | undefined;
  /** Optional target resource scope for scope-aware evaluation. */
  scope?: ScopePath;
}

/** True when the principal is granted `permission` at the optional target scope. */
export function principalHasPermission(input: PermissionCheckInput): boolean {
  const resolved = resolveEffectivePermissions(input.principal, { scope: input.scope, resolveRole: input.resolveRole });
  if (resolved.includesWildcard) return true;
  for (const granted of resolved.permissions) {
    if (permissionMatches(granted, input.permission)) return true;
  }
  return false;
}

export function validateRole(value: unknown, path = "role"): DomainResult<Role> {
  if (!isPlainObject(value)) return { ok: false, issues: [{ path, message: "role must be an object" }] };
  const issues: DomainIssue[] = [];
  if (!isNonEmptyString(value.id)) issues.push({ path: `${path}.id`, message: "role id is required" });
  requireOptionalNonEmptyString(value.name, `${path}.name`, issues);
  requireOptionalNonEmptyString(value.description, `${path}.description`, issues);
  if (!Array.isArray(value.permissions)) {
    issues.push({ path: `${path}.permissions`, message: "permissions must be an array" });
  } else {
    value.permissions.forEach((permission, index) => {
      if (!isNonEmptyString(permission)) issues.push({ path: `${path}.permissions.${index}`, message: "permission must be a non-empty string" });
    });
  }
  if (issues.length > 0) return { ok: false, issues };
  const role = value as unknown as Role;
  return ok(Object.freeze({
    id: role.id,
    ...(role.name !== undefined ? { name: role.name } : {}),
    ...(role.description !== undefined ? { description: role.description } : {}),
    permissions: Object.freeze([...role.permissions]),
  }));
}

export function validateRoleBinding(value: unknown, path = "roleBinding"): DomainResult<RoleBinding> {
  if (!isPlainObject(value)) return { ok: false, issues: [{ path, message: "role binding must be an object" }] };
  const issues: DomainIssue[] = [];
  if (!isNonEmptyString(value.roleId)) issues.push({ path: `${path}.roleId`, message: "roleId is required" });
  let scope: ScopePath | undefined;
  if (value.scope !== undefined) {
    const scopeResult = validateScopePath(value.scope, `${path}.scope`);
    if (!scopeResult.ok) issues.push(...scopeResult.issues);
    else scope = scopeResult.value;
  }
  if (issues.length > 0) return { ok: false, issues };
  return ok(Object.freeze({ roleId: value.roleId as string, ...(scope !== undefined ? { scope } : {}) }) as RoleBinding);
}

export function validatePrincipal(value: unknown, path = "principal"): DomainResult<Principal> {
  if (!isPlainObject(value)) return { ok: false, issues: [{ path, message: "principal must be an object" }] };
  const issues: DomainIssue[] = [];
  if (!isNonEmptyString(value.id)) issues.push({ path: `${path}.id`, message: "principal id is required" });
  if (!isNonEmptyString(value.tenantId)) issues.push({ path: `${path}.tenantId`, message: "tenantId is required" });
  requireOptionalNonEmptyString(value.subject, `${path}.subject`, issues);
  requireOptionalNonEmptyString(value.name, `${path}.name`, issues);
  requireOptionalNonEmptyString(value.email, `${path}.email`, issues);

  const roleBindings: RoleBinding[] = [];
  if (!Array.isArray(value.roleBindings)) {
    issues.push({ path: `${path}.roleBindings`, message: "roleBindings must be an array" });
  } else {
    value.roleBindings.forEach((binding, index) => {
      const result = validateRoleBinding(binding, `${path}.roleBindings.${index}`);
      if (result.ok) roleBindings.push(result.value);
      else issues.push(...result.issues);
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  const principal = value as unknown as Principal;
  return ok(Object.freeze({
    id: principal.id,
    tenantId: principal.tenantId,
    roleBindings: Object.freeze(roleBindings),
    ...(principal.subject !== undefined ? { subject: principal.subject } : {}),
    ...(principal.name !== undefined ? { name: principal.name } : {}),
    ...(principal.email !== undefined ? { email: principal.email } : {}),
  }) as Principal);
}

function requireOptionalNonEmptyString(value: unknown, path: string, issues: DomainIssue[]): void {
  if (value !== undefined && !isNonEmptyString(value)) issues.push({ path, message: "must be a non-empty string when provided" });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
