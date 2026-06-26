import { ok, type DomainIssue, type DomainResult } from "./result.js";
import { type AuthMethodKind, isAuthMethodKind } from "./auth.js";
import { type ScopePath, validateScopePath } from "./scope.js";

/**
 * Audit metadata domain contracts.
 *
 * Pure domain layer: no HTTP, persistence, or UI dependencies. `AuditMetadata`
 * describes who/what/where/when for control-plane actions (catalog writes, RBAC
 * decisions, etc.). It is an informational record shape, not a persistence or
 * transport implementation. See docs/enterprise-control-plane.md.
 */

export const AUDIT_OUTCOMES = ["success", "denied", "error"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export interface AuditMetadata {
  /** Stable id of the audit record. */
  id?: string;
  principalId?: string;
  authMethod?: AuthMethodKind;
  action: string;
  resourceType?: string;
  resourceId?: string;
  scope?: ScopePath;
  occurredAt: string;
  outcome?: AuditOutcome;
  reason?: string;
  /** Component that produced the record, e.g. "rbac" or "catalog-admin". */
  source?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

/** Input for creating an audit record (no generated id field). */
export interface CreateAuditMetadataInput {
  principalId?: string;
  authMethod?: AuthMethodKind;
  action: string;
  resourceType?: string;
  resourceId?: string;
  scope?: ScopePath;
  occurredAt: string;
  outcome?: AuditOutcome;
  reason?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export function isAuditOutcome(value: unknown): value is AuditOutcome {
  return value === "success" || value === "denied" || value === "error";
}

export function createAuditMetadata(input: CreateAuditMetadataInput): DomainResult<AuditMetadata> {
  return validateAuditMetadata(input, "audit");
}

export function validateAuditMetadata(value: unknown, path = "audit"): DomainResult<AuditMetadata> {
  if (!isPlainObject(value)) return { ok: false, issues: [{ path, message: "audit metadata must be an object" }] };
  const issues: DomainIssue[] = [];
  if (value.id !== undefined && !isNonEmptyString(value.id)) issues.push({ path: `${path}.id`, message: "id must be a non-empty string when provided" });
  if (value.principalId !== undefined && !isNonEmptyString(value.principalId)) issues.push({ path: `${path}.principalId`, message: "principalId must be a non-empty string when provided" });
  if (value.authMethod !== undefined && !isAuthMethodKind(value.authMethod)) issues.push({ path: `${path}.authMethod`, message: "authMethod must be dev-token or oauth when provided" });
  if (!isNonEmptyString(value.action)) issues.push({ path: `${path}.action`, message: "action is required" });
  if (value.resourceType !== undefined && !isNonEmptyString(value.resourceType)) issues.push({ path: `${path}.resourceType`, message: "resourceType must be a non-empty string when provided" });
  if (value.resourceId !== undefined && !isNonEmptyString(value.resourceId)) issues.push({ path: `${path}.resourceId`, message: "resourceId must be a non-empty string when provided" });
  if (!isNonEmptyString(value.occurredAt)) issues.push({ path: `${path}.occurredAt`, message: "occurredAt is required" });
  if (value.outcome !== undefined && !isAuditOutcome(value.outcome)) issues.push({ path: `${path}.outcome`, message: "outcome must be success, denied, or error when provided" });
  if (value.reason !== undefined && !isNonEmptyString(value.reason)) issues.push({ path: `${path}.reason`, message: "reason must be a non-empty string when provided" });
  if (value.source !== undefined && !isNonEmptyString(value.source)) issues.push({ path: `${path}.source`, message: "source must be a non-empty string when provided" });
  if (value.metadata !== undefined && !isPlainObject(value.metadata)) issues.push({ path: `${path}.metadata`, message: "metadata must be an object when provided" });

  let scope: ScopePath | undefined;
  if (value.scope !== undefined) {
    const scopeResult = validateScopePath(value.scope, `${path}.scope`);
    if (!scopeResult.ok) issues.push(...scopeResult.issues);
    else scope = scopeResult.value;
  }

  if (issues.length > 0) return { ok: false, issues };

  const audit = value as unknown as AuditMetadata;
  return ok(Object.freeze({
    action: audit.action,
    occurredAt: audit.occurredAt,
    ...(audit.id !== undefined ? { id: audit.id } : {}),
    ...(audit.principalId !== undefined ? { principalId: audit.principalId } : {}),
    ...(audit.authMethod !== undefined ? { authMethod: audit.authMethod } : {}),
    ...(audit.resourceType !== undefined ? { resourceType: audit.resourceType } : {}),
    ...(audit.resourceId !== undefined ? { resourceId: audit.resourceId } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(audit.outcome !== undefined ? { outcome: audit.outcome } : {}),
    ...(audit.reason !== undefined ? { reason: audit.reason } : {}),
    ...(audit.source !== undefined ? { source: audit.source } : {}),
    ...(audit.metadata !== undefined ? { metadata: Object.freeze({ ...audit.metadata }) } : {}),
  }) as AuditMetadata);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
