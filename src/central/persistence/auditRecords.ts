import type { AuditMetadata } from "../../domain/audit.js";
import type { CentralSqliteDatabase } from "./sqliteDatabase.js";

/**
 * Append an audit record using the caller's transaction.
 *
 * Resource rows deliberately are not referenced by foreign keys, so write
 * history remains available after catalog items or policies are deleted.
 */
export function insertCentralAuditRecord(
  database: CentralSqliteDatabase,
  audit: AuditMetadata | undefined,
): void {
  if (audit === undefined) return;
  database.prepare(`
    INSERT INTO audit_records (
      principal_id,
      auth_method,
      action,
      resource_type,
      resource_id,
      scope_json,
      occurred_at,
      outcome,
      reason,
      source,
      metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    audit.principalId ?? null,
    audit.authMethod ?? null,
    audit.action,
    audit.resourceType ?? null,
    audit.resourceId ?? null,
    audit.scope === undefined ? null : JSON.stringify(audit.scope),
    audit.occurredAt,
    audit.outcome ?? null,
    audit.reason ?? null,
    audit.source ?? null,
    audit.metadata === undefined ? null : JSON.stringify(audit.metadata),
  );
}
