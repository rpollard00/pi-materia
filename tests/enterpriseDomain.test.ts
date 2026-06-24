import { describe, expect, test } from "bun:test";
import {
  AUDIT_OUTCOMES,
  CENTRAL_PERMISSIONS,
  CENTRAL_PERMISSION_NAMESPACES,
  WILDCARD_PERMISSION,
  createAuditMetadata,
  createAuthContext,
  isAuditOutcome,
  isAuthMethodKind,
  isKnownCentralPermission,
  isPermission,
  isScopeLevel,
  isScopePath,
  permissionMatches,
  principalHasPermission,
  resolveEffectivePermissions,
  validateAuthContext,
  validateAuditMetadata,
  validatePrincipal,
  validateRole,
  validateRoleBinding,
  validateScopePath,
  scopeLevelOf,
  isScopeAncestorOrEqual,
  scopePathEquals,
  formatScopePath,
  type AuditMetadata,
  type AuthContext,
  type Permission,
  type Principal,
  type Role,
  type RoleBinding,
  type ScopePath,
} from "../src/domain/index.js";

describe("enterprise scope domain", () => {
  test("classifies the deepest scope level", () => {
    expect(scopeLevelOf({ tenantId: "t1" })).toBe("tenant");
    expect(scopeLevelOf({ tenantId: "t1", workspaceId: "w1" })).toBe("workspace");
    expect(scopeLevelOf({ tenantId: "t1", workspaceId: "w1", repositoryId: "r1" })).toBe("repository");
    expect(scopeLevelOf({ tenantId: "t1", workspaceId: "w1", repositoryId: "r1", projectScopeId: "p1" })).toBe("project");
  });

  test("treats a binding scope as ancestor-or-equal of deeper descendant paths", () => {
    const tenant = { tenantId: "t1" };
    const workspace = { tenantId: "t1", workspaceId: "w1" };
    const project = { tenantId: "t1", workspaceId: "w1", repositoryId: "r1", projectScopeId: "p1" };

    expect(isScopeAncestorOrEqual(tenant, project)).toBe(true);
    expect(isScopeAncestorOrEqual(workspace, project)).toBe(true);
    expect(isScopeAncestorOrEqual(project, project)).toBe(true);
    expect(isScopeAncestorOrEqual(project, workspace)).toBe(false);
    expect(isScopeAncestorOrEqual({ tenantId: "t1", workspaceId: "other" }, project)).toBe(false);
    expect(isScopeAncestorOrEqual({ tenantId: "t2" }, project)).toBe(false);
  });

  test("compares and formats scope paths", () => {
    const a: ScopePath = { tenantId: "t1", workspaceId: "w1" };
    const b: ScopePath = { tenantId: "t1", workspaceId: "w1" };
    expect(scopePathEquals(a, b)).toBe(true);
    expect(scopePathEquals(a, { tenantId: "t1" })).toBe(false);
    expect(formatScopePath({ tenantId: "t1", workspaceId: "w1", repositoryId: "r1" })).toBe("tenant:t1 workspace:w1 repository:r1");
    expect(formatScopePath({ tenantId: "t1" })).toBe("tenant:t1");
  });

  test("guards scope levels and paths", () => {
    expect(isScopeLevel("tenant")).toBe(true);
    expect(isScopeLevel("galaxy")).toBe(false);
    expect(isScopePath({ tenantId: "t1" })).toBe(true);
    expect(isScopePath({ tenantId: "t1", workspaceId: "w1" })).toBe(true);
    expect(isScopePath({ workspaceId: "w1" })).toBe(false);
    expect(isScopePath({ tenantId: "t1", workspaceId: 5 })).toBe(false);
  });

  test("validates scope paths", () => {
    expect(validateScopePath({ tenantId: "t1", workspaceId: "w1" }).ok).toBe(true);
    const missing = validateScopePath({ workspaceId: "w1" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues.map((issue) => issue.path)).toContain("scope.tenantId");
    const bad = validateScopePath({ tenantId: "t1", repositoryId: 7 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.map((issue) => issue.path)).toContain("scope.repositoryId");
  });
});

describe("enterprise permission evaluation", () => {
  const roles = new Map<string, Role>([
    ["admin", { id: "admin", permissions: [WILDCARD_PERMISSION] }],
    ["catalog-reader", { id: "catalog-reader", permissions: ["catalog.read"] }],
    ["catalog-writer", { id: "catalog-writer", permissions: ["catalog.*"] }],
    ["scoped-writer", { id: "scoped-writer", permissions: ["catalog.write"] }],
  ]);
  const resolveRole = (id: string) => roles.get(id);

  test("matches exact, global wildcard, and namespace wildcard permissions", () => {
    expect(permissionMatches("catalog.read", "catalog.read")).toBe(true);
    expect(permissionMatches("*", "anything.at.all")).toBe(true);
    expect(permissionMatches("catalog.*", "catalog.read")).toBe(true);
    expect(permissionMatches("catalog.*", "catalog.write")).toBe(true);
    expect(permissionMatches("catalog.*", "model-policy.read")).toBe(false);
    expect(permissionMatches("catalog.read", "catalog.write")).toBe(false);
    expect(permissionMatches("model-policy.read", "catalog.read")).toBe(false);
  });

  test("resolves effective permissions across global and scoped bindings", () => {
    const principal: Principal = {
      id: "u1",
      tenantId: "t1",
      roleBindings: [
        { roleId: "catalog-reader" },
        { roleId: "scoped-writer", scope: { tenantId: "t1", workspaceId: "w1" } },
      ],
    };

    // No target scope: every binding applies (global evaluation).
    const global = resolveEffectivePermissions(principal, { resolveRole });
    expect([...global.permissions].sort()).toEqual(["catalog.read", "catalog.write"]);
    expect(global.includesWildcard).toBe(false);

    // Within workspace w1: scoped-writer applies.
    const inWorkspace = resolveEffectivePermissions(principal, { resolveRole, scope: { tenantId: "t1", workspaceId: "w1" } });
    expect([...inWorkspace.permissions].sort()).toEqual(["catalog.read", "catalog.write"]);

    // In a different workspace: scoped-writer does not apply, only the reader.
    const otherWorkspace = resolveEffectivePermissions(principal, { resolveRole, scope: { tenantId: "t1", workspaceId: "w2" } });
    expect([...otherWorkspace.permissions]).toEqual(["catalog.read"]);
  });

  test("principalHasPermission honors wildcard, namespace wildcard, scope, and tenant boundaries", () => {
    const admin: Principal = { id: "a", tenantId: "t1", roleBindings: [{ roleId: "admin" }] };
    expect(principalHasPermission({ principal: admin, permission: "catalog.write", resolveRole })).toBe(true);

    const writer: Principal = { id: "w", tenantId: "t1", roleBindings: [{ roleId: "catalog-writer" }] };
    expect(principalHasPermission({ principal: writer, permission: "catalog.read", resolveRole })).toBe(true);
    expect(principalHasPermission({ principal: writer, permission: "model-policy.read", resolveRole })).toBe(false);

    const scoped: Principal = {
      id: "s",
      tenantId: "t1",
      roleBindings: [{ roleId: "scoped-writer", scope: { tenantId: "t1", workspaceId: "w1" } }],
    };
    expect(principalHasPermission({ principal: scoped, permission: "catalog.write", resolveRole, scope: { tenantId: "t1", workspaceId: "w1", repositoryId: "r1" } })).toBe(true);
    expect(principalHasPermission({ principal: scoped, permission: "catalog.write", resolveRole, scope: { tenantId: "t1", workspaceId: "w2" } })).toBe(false);
    expect(principalHasPermission({ principal: scoped, permission: "catalog.write", resolveRole, scope: { tenantId: "t2" } })).toBe(false);
  });

  test("skips bindings for unknown roles", () => {
    const principal: Principal = { id: "u", tenantId: "t1", roleBindings: [{ roleId: "does-not-exist" }] };
    expect(principalHasPermission({ principal, permission: "catalog.read", resolveRole })).toBe(false);
    expect(resolveEffectivePermissions(principal, { resolveRole }).roleIds).toEqual([]);
  });

  test("exposes curated central permission names", () => {
    expect(isKnownCentralPermission("catalog.read")).toBe(true);
    expect(isKnownCentralPermission("catalog.delete")).toBe(false);
    expect(isPermission("custom.permission")).toBe(true);
    expect(CENTRAL_PERMISSION_NAMESPACES).toEqual(["catalog", "model-policy", "admin", "telemetry"]);
    expect(CENTRAL_PERMISSIONS).toContain("telemetry.ingest");
  });
});

describe("enterprise identity validation", () => {
  test("validates roles, bindings, and principals", () => {
    const role = validateRole({ id: "reader", name: "Reader", permissions: ["catalog.read"] });
    expect(role.ok).toBe(true);
    if (!role.ok) return;
    expect(role.value.permissions).toEqual(["catalog.read"]);

    expect(validateRole({ id: "", permissions: ["catalog.read"] }).ok).toBe(false);
    expect(validateRole({ id: "r", permissions: ["ok", 3] }).ok).toBe(false);
    expect(validateRole({ id: "r", permissions: "catalog.read" }).ok).toBe(false);

    const binding = validateRoleBinding({ roleId: "reader", scope: { tenantId: "t1" } });
    expect(binding.ok).toBe(true);
    expect(validateRoleBinding({ scope: { tenantId: "t1" } }).ok).toBe(false);

    const principal = validatePrincipal({ id: "u1", tenantId: "t1", roleBindings: [{ roleId: "reader" }] });
    expect(principal.ok).toBe(true);

    expect(validatePrincipal({ id: "u1", roleBindings: [] }).ok).toBe(false);
    expect(validatePrincipal({ id: "u1", tenantId: "t1", roleBindings: "reader" }).ok).toBe(false);
  });
});

describe("enterprise auth context", () => {
  const validPrincipal: Principal = { id: "u1", tenantId: "t1", roleBindings: [] };

  test("guards auth method kinds", () => {
    expect(isAuthMethodKind("dev-token")).toBe(true);
    expect(isAuthMethodKind("oauth")).toBe(true);
    expect(isAuthMethodKind("saml")).toBe(false);
  });

  test("validates a complete auth context", () => {
    const created = createAuthContext({ principal: validPrincipal, method: { kind: "dev-token", adapter: "dev-token" } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.principal.id).toBe("u1");
    expect(created.value.method.kind).toBe("dev-token");

    const withClaims = validateAuthContext({
      principal: validPrincipal,
      method: { kind: "oauth", adapter: "oidc" },
      scope: { tenantId: "t1", workspaceId: "w1" },
      expiresAt: "2026-12-31T00:00:00.000Z",
      claims: { sub: "subject-1" },
    });
    expect(withClaims.ok).toBe(true);
  });

  test("rejects auth contexts with missing principal or bad method", () => {
    expect(validateAuthContext({ method: { kind: "dev-token" } }).ok).toBe(false);
    expect(validateAuthContext({ principal: validPrincipal }).ok).toBe(false);
    expect(validateAuthContext({ principal: validPrincipal, method: { kind: "saml" } }).ok).toBe(false);
    expect(validateAuthContext({ principal: validPrincipal, method: { kind: "dev-token" }, scope: { workspaceId: "w1" } }).ok).toBe(false);
  });
});

describe("enterprise audit metadata", () => {
  test("creates and validates audit records", () => {
    expect(AUDIT_OUTCOMES).toEqual(["success", "denied", "error"]);
    expect(isAuditOutcome("denied")).toBe(true);
    expect(isAuditOutcome("maybe")).toBe(false);

    const created = createAuditMetadata({
      action: "catalog.write",
      resourceType: "loadout",
      resourceId: "loadout-1",
      principalId: "u1",
      authMethod: "dev-token",
      scope: { tenantId: "t1" },
      occurredAt: "2026-06-24T00:00:00.000Z",
      outcome: "success",
      source: "catalog-admin",
      metadata: { origin: "central" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const value = created.value as AuditMetadata;
    expect(value.action).toBe("catalog.write");
    expect(value.metadata).toEqual({ origin: "central" });

    expect(createAuditMetadata({ action: "", occurredAt: "now" }).ok).toBe(false);
    expect(createAuditMetadata({ action: "x", occurredAt: "now", authMethod: "saml" }).ok).toBe(false);
    expect(createAuditMetadata({ action: "x", occurredAt: "now", outcome: "maybe" }).ok).toBe(false);
    expect(createAuditMetadata({ action: "x", occurredAt: "now", scope: {} }).ok).toBe(false);
  });
});

// Compile-time smoke: the contracts compose into an AuthContext the way adapters will produce them.
function _compileTimeComposition(): AuthContext {
  const binding: RoleBinding = { roleId: "catalog-reader", scope: { tenantId: "t1" } };
  const principal: Principal = { id: "u1", tenantId: "t1", subject: "token-sub", roleBindings: [binding] };
  const permission: Permission = "catalog.read";
  void permission;
  return { principal, method: { kind: "dev-token", adapter: "dev-token" } };
}
void _compileTimeComposition;
