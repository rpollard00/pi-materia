import { ok, type DomainIssue, type DomainResult } from "./result.js";

/**
 * Enterprise resource scope contracts.
 *
 * Pure domain layer: no HTTP, OAuth, persistence, or UI dependencies. These
 * contracts describe the tenant -> workspace -> repository -> project containment
 * hierarchy used for scope-aware RBAC and audit provenance in the central control
 * plane. They do not change the existing local-only workflow or the config-layer
 * scopes (`default | user | project | explicit`); `ProjectScope` here is an
 * enterprise resource entity, not a config source. See
 * docs/enterprise-control-plane.md.
 */

export type ScopeLevel = "tenant" | "workspace" | "repository" | "project";

/** Enterprise tenant: the top of the scope hierarchy and tenancy boundary. */
export interface Tenant {
  id: string;
  name?: string;
  description?: string;
}

/** Workspace: a grouping within a tenant. */
export interface Workspace {
  id: string;
  tenantId: string;
  name?: string;
  description?: string;
}

/** Repository: a versioned definition/code repository tracked by the control plane. */
export interface Repository {
  id: string;
  tenantId: string;
  workspaceId?: string;
  name?: string;
  remoteUrl?: string;
  defaultBranch?: string;
}

/** Project-local scope: a local repository working context. Local-only remains first-class. */
export interface ProjectScope {
  id: string;
  tenantId: string;
  workspaceId?: string;
  repositoryId?: string;
  /** Local project path within the repository, when applicable. */
  path?: string;
  name?: string;
}

/** Containment path used for scope-aware permission evaluation and audit provenance. */
export interface ScopePath {
  tenantId: string;
  workspaceId?: string;
  repositoryId?: string;
  projectScopeId?: string;
}

export const ROOT_SCOPE_LEVEL: ScopeLevel = "tenant";
export const DEEPEST_SCOPE_LEVEL: ScopeLevel = "project";

/** Deepest scope level defined by the path. */
export function scopeLevelOf(path: ScopePath): ScopeLevel {
  if (path.projectScopeId !== undefined) return "project";
  if (path.repositoryId !== undefined) return "repository";
  if (path.workspaceId !== undefined) return "workspace";
  return "tenant";
}

/** True when `ancestor` contains (or equals) `descendant` in the scope hierarchy. */
export function isScopeAncestorOrEqual(ancestor: ScopePath, descendant: ScopePath): boolean {
  if (ancestor.tenantId !== descendant.tenantId) return false;
  if (ancestor.workspaceId !== undefined && ancestor.workspaceId !== descendant.workspaceId) return false;
  if (ancestor.repositoryId !== undefined && ancestor.repositoryId !== descendant.repositoryId) return false;
  if (ancestor.projectScopeId !== undefined && ancestor.projectScopeId !== descendant.projectScopeId) return false;
  return true;
}

export function scopePathEquals(left: ScopePath, right: ScopePath): boolean {
  return left.tenantId === right.tenantId
    && left.workspaceId === right.workspaceId
    && left.repositoryId === right.repositoryId
    && left.projectScopeId === right.projectScopeId;
}

export function formatScopePath(path: ScopePath): string {
  const segments: string[] = [`tenant:${path.tenantId}`];
  if (path.workspaceId !== undefined) segments.push(`workspace:${path.workspaceId}`);
  if (path.repositoryId !== undefined) segments.push(`repository:${path.repositoryId}`);
  if (path.projectScopeId !== undefined) segments.push(`project:${path.projectScopeId}`);
  return segments.join(" ");
}

export function isScopeLevel(value: unknown): value is ScopeLevel {
  return value === "tenant" || value === "workspace" || value === "repository" || value === "project";
}

export function isScopePath(value: unknown): value is ScopePath {
  if (!isPlainObject(value)) return false;
  if (!isNonEmptyString(value.tenantId)) return false;
  if (!optionalNonEmptyString(value.workspaceId)) return false;
  if (!optionalNonEmptyString(value.repositoryId)) return false;
  return optionalNonEmptyString(value.projectScopeId);
}

export function validateScopePath(value: unknown, path = "scope"): DomainResult<ScopePath> {
  if (!isPlainObject(value)) return { ok: false, issues: [{ path, message: "scope path must be an object" }] };
  const issues: DomainIssue[] = [];
  if (!isNonEmptyString(value.tenantId)) issues.push({ path: `${path}.tenantId`, message: "tenantId is required" });
  requireOptionalNonEmptyString(value.workspaceId, `${path}.workspaceId`, issues);
  requireOptionalNonEmptyString(value.repositoryId, `${path}.repositoryId`, issues);
  requireOptionalNonEmptyString(value.projectScopeId, `${path}.projectScopeId`, issues);
  if (issues.length > 0) return { ok: false, issues };
  return ok(freezeScopePath(value as unknown as ScopePath));
}

function freezeScopePath(scope: ScopePath): ScopePath {
  return Object.freeze({
    tenantId: scope.tenantId,
    ...(scope.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
    ...(scope.repositoryId !== undefined ? { repositoryId: scope.repositoryId } : {}),
    ...(scope.projectScopeId !== undefined ? { projectScopeId: scope.projectScopeId } : {}),
  });
}

function requireOptionalNonEmptyString(value: unknown, path: string, issues: DomainIssue[]): void {
  if (!optionalNonEmptyString(value)) issues.push({ path, message: "must be a non-empty string when provided" });
}

function optionalNonEmptyString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
