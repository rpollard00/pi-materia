import {
  type CatalogItem,
  type CatalogItemContent,
  type CatalogItemKind,
  type CatalogItemProvenance,
  type CatalogItemSummary,
  type CatalogItemWriteResult,
  type CatalogQuery,
  type CreateCatalogItemInput,
  type DeleteCatalogItemInput,
  type UpdateCatalogItemInput,
  isCatalogItemKind,
} from "../../application/controlPlane.js";
import { createAuditMetadata, type AuditMetadata } from "../../domain/audit.js";
import {
  CatalogConflictError,
  CatalogNotFoundError,
  CatalogVersionMismatchError,
  hashCentralContent,
  type CentralCatalogRepository,
} from "../controlPlane/centralCatalogRepository.js";
import { nowIso } from "../controlPlane/shared.js";
import { insertCentralAuditRecord } from "./auditRecords.js";
import type { CentralSqliteDatabase } from "./sqliteDatabase.js";

interface CatalogRow {
  readonly id: string;
  readonly kind: CatalogItemKind;
  readonly name: string | null;
  readonly description: string | null;
  readonly version: number;
  readonly updatedAt: string;
  readonly contentHash: string;
  readonly contentJson: string;
  readonly provenanceJson: string | null;
}

interface StoredCatalogItem {
  readonly id: string;
  readonly kind: CatalogItemKind;
  readonly name?: string;
  readonly description?: string;
  readonly version: number;
  readonly updatedAt: string;
  readonly contentHash: string;
  readonly content: CatalogItemContent;
  readonly provenance?: CatalogItemProvenance;
}

export interface SqliteCentralCatalogRepositoryOptions {
  /** Stable clock for timestamps (tests); defaults to {@link nowIso}. */
  readonly clock?: () => string;
}

const CATALOG_COLUMNS = `
  id,
  kind,
  name,
  description,
  version,
  updated_at AS updatedAt,
  content_hash AS contentHash,
  content_json AS contentJson,
  provenance_json AS provenanceJson
`;

/**
 * Create a durable central catalog repository over an initialized SQLite
 * database. Every mutation and its audit row are committed atomically.
 */
export function createSqliteCentralCatalogRepository(
  database: CentralSqliteDatabase,
  options: SqliteCentralCatalogRepositoryOptions = {},
): CentralCatalogRepository {
  const clock = options.clock ?? nowIso;

  function find(id: string, kind?: CatalogItemKind): StoredCatalogItem | undefined {
    const row = kind === undefined
      ? database.prepare(`SELECT ${CATALOG_COLUMNS} FROM catalog_items WHERE id = ? ORDER BY kind ASC LIMIT 1`).get<CatalogRow>(id)
      : database.prepare(`SELECT ${CATALOG_COLUMNS} FROM catalog_items WHERE kind = ? AND id = ?`).get<CatalogRow>(kind, id);
    return row === undefined ? undefined : fromRow(row);
  }

  function requireExisting(id: string, kind?: CatalogItemKind): StoredCatalogItem {
    const item = find(id, kind);
    if (item !== undefined) return item;
    const qualifier = kind !== undefined ? `"${kind}:${id}"` : `"${id}"`;
    throw new CatalogNotFoundError(`Central catalog item ${qualifier} was not found`);
  }

  function create(input: CreateCatalogItemInput): CatalogItemWriteResult {
    validateCreateInput(input);
    return database.transaction(() => {
      if (find(input.id, input.kind) !== undefined) {
        throw new CatalogConflictError(`Central catalog item "${input.kind}:${input.id}" already exists`);
      }
      const updatedAt = clock();
      const content = freezeContent(input.content);
      const provenance = normalizeProvenance(input.provenance ?? { source: "central" });
      const item: StoredCatalogItem = {
        id: input.id,
        kind: input.kind,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        version: 1,
        updatedAt,
        contentHash: hashCentralContent(content),
        content,
        provenance,
      };
      database.prepare(`
        INSERT INTO catalog_items (
          kind, id, name, description, version, updated_at,
          content_hash, content_json, provenance_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        item.kind,
        item.id,
        item.name ?? null,
        item.description ?? null,
        item.version,
        item.updatedAt,
        item.contentHash,
        JSON.stringify(item.content),
        JSON.stringify(item.provenance),
      );
      const audit = buildAudit("created", item, input.principalId, updatedAt);
      insertCentralAuditRecord(database, audit);
      return writeResult("created", item, audit);
    });
  }

  function update(input: UpdateCatalogItemInput): CatalogItemWriteResult {
    validateUpdateInput(input);
    return database.transaction(() => {
      const current = requireExisting(input.id, input.kind);
      assertExpectedVersion(current, input.expectedVersion);
      const updatedAt = clock();
      const content = input.content === undefined ? current.content : freezeContent(input.content);
      const provenance = input.provenance === undefined
        ? current.provenance
        : normalizeProvenance(input.provenance);
      const item: StoredCatalogItem = {
        id: current.id,
        kind: current.kind,
        ...(input.name !== undefined ? { name: input.name } : current.name !== undefined ? { name: current.name } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : current.description !== undefined
            ? { description: current.description }
            : {}),
        version: current.version + 1,
        updatedAt,
        contentHash: input.content === undefined ? current.contentHash : hashCentralContent(content),
        content,
        ...(provenance !== undefined ? { provenance } : {}),
      };
      const result = database.prepare(`
        UPDATE catalog_items
        SET name = ?, description = ?, version = ?, updated_at = ?,
            content_hash = ?, content_json = ?, provenance_json = ?
        WHERE kind = ? AND id = ? AND version = ?
      `).run(
        item.name ?? null,
        item.description ?? null,
        item.version,
        item.updatedAt,
        item.contentHash,
        JSON.stringify(item.content),
        item.provenance === undefined ? null : JSON.stringify(item.provenance),
        current.kind,
        current.id,
        current.version,
      );
      if (result.changes !== 1) {
        const latest = find(current.id, current.kind);
        if (latest === undefined) throw new CatalogNotFoundError(`Central catalog item "${current.kind}:${current.id}" was not found`);
        throw versionMismatch(latest, String(current.version));
      }
      const audit = buildAudit("updated", item, input.principalId, updatedAt);
      insertCentralAuditRecord(database, audit);
      return writeResult("updated", item, audit);
    });
  }

  function remove(input: DeleteCatalogItemInput): CatalogItemWriteResult {
    validateDeleteInput(input);
    return database.transaction(() => {
      const current = requireExisting(input.id, input.kind);
      assertExpectedVersion(current, input.expectedVersion);
      const result = database.prepare(
        "DELETE FROM catalog_items WHERE kind = ? AND id = ? AND version = ?",
      ).run(current.kind, current.id, current.version);
      if (result.changes !== 1) {
        const latest = find(current.id, current.kind);
        if (latest === undefined) throw new CatalogNotFoundError(`Central catalog item "${current.kind}:${current.id}" was not found`);
        throw versionMismatch(latest, String(current.version));
      }
      const occurredAt = clock();
      const audit = buildAudit("deleted", current, input.principalId, occurredAt);
      insertCentralAuditRecord(database, audit);
      return writeResult("deleted", current, audit);
    });
  }

  return {
    size(): number {
      const row = database.prepare("SELECT COUNT(*) AS count FROM catalog_items").get<{ count: number }>();
      return Number(row?.count ?? 0);
    },
    async list(query?: CatalogQuery): Promise<CatalogItemSummary[]> {
      const rows = database.prepare(
        `SELECT ${CATALOG_COLUMNS} FROM catalog_items ORDER BY kind ASC, id ASC`,
      ).all<CatalogRow>();
      return rows.map(fromRow).map(toSummary).filter((summary) => matchesQuery(summary, query));
    },
    async get(id: string, kind?: CatalogItemKind): Promise<CatalogItem | undefined> {
      const item = find(id, kind);
      return item === undefined ? undefined : toItem(item);
    },
    async head(id: string, kind?: CatalogItemKind): Promise<CatalogItemSummary | undefined> {
      const item = find(id, kind);
      return item === undefined ? undefined : toSummary(item);
    },
    async create(input: CreateCatalogItemInput): Promise<CatalogItemWriteResult> {
      return create(input);
    },
    async update(input: UpdateCatalogItemInput): Promise<CatalogItemWriteResult> {
      return update(input);
    },
    async delete(input: DeleteCatalogItemInput): Promise<CatalogItemWriteResult> {
      return remove(input);
    },
  };
}

function fromRow(row: CatalogRow): StoredCatalogItem {
  const content = freezeContent(parseJson<CatalogItemContent>(row.contentJson, "catalog content"));
  const provenance = row.provenanceJson === null
    ? undefined
    : normalizeProvenance(parseJson<CatalogItemProvenance>(row.provenanceJson, "catalog provenance"));
  return {
    id: row.id,
    kind: row.kind,
    ...(row.name !== null ? { name: row.name } : {}),
    ...(row.description !== null ? { description: row.description } : {}),
    version: Number(row.version),
    updatedAt: row.updatedAt,
    contentHash: row.contentHash,
    content,
    ...(provenance !== undefined ? { provenance } : {}),
  };
}

function toSummary(item: StoredCatalogItem): CatalogItemSummary {
  return {
    id: item.id,
    kind: item.kind,
    version: String(item.version),
    updatedAt: item.updatedAt,
    contentHash: item.contentHash,
    ...(item.name !== undefined ? { name: item.name } : {}),
    ...(item.description !== undefined ? { description: item.description } : {}),
    ...(item.provenance !== undefined ? { provenance: item.provenance } : {}),
  };
}

function toItem(item: StoredCatalogItem): CatalogItem {
  return { ...toSummary(item), content: item.content };
}

function matchesQuery(summary: CatalogItemSummary, query: CatalogQuery | undefined): boolean {
  if (query === undefined) return true;
  if (query.kind !== undefined && summary.kind !== query.kind) return false;
  if (query.search !== undefined && query.search.length > 0) {
    const needle = query.search.toLowerCase();
    if (!`${summary.id} ${summary.name ?? ""}`.toLowerCase().includes(needle)) return false;
  }
  return true;
}

function assertExpectedVersion(item: StoredCatalogItem, expectedVersion: string | undefined): void {
  if (expectedVersion !== undefined && expectedVersion !== String(item.version)) {
    throw versionMismatch(item, expectedVersion);
  }
}

function versionMismatch(item: StoredCatalogItem, expectedVersion: string): CatalogVersionMismatchError {
  return new CatalogVersionMismatchError(
    `Central catalog item "${item.kind}:${item.id}" version mismatch: expected "${expectedVersion}", current "${item.version}"`,
    String(item.version),
  );
}

function writeResult(
  action: "created" | "updated" | "deleted",
  item: StoredCatalogItem,
  audit: AuditMetadata | undefined,
): CatalogItemWriteResult {
  return { action, summary: toSummary(item), ...(audit !== undefined ? { audit } : {}) };
}

function buildAudit(
  action: "created" | "updated" | "deleted",
  item: StoredCatalogItem,
  principalId: string | undefined,
  occurredAt: string,
): AuditMetadata | undefined {
  const result = createAuditMetadata({
    action: `catalog-item.${action}`,
    resourceType: "catalog-item",
    resourceId: `${item.kind}:${item.id}`,
    occurredAt,
    outcome: "success",
    source: "catalog-admin",
    ...(principalId !== undefined ? { principalId } : {}),
    metadata: {
      kind: item.kind,
      id: item.id,
      version: String(item.version),
      contentHash: item.contentHash,
    },
  });
  return result.ok ? result.value : undefined;
}

function validateCreateInput(input: CreateCatalogItemInput): void {
  if (!isPlainObject(input)) throw new TypeError("createCatalogItem input must be an object");
  requireNonEmptyId(input.id);
  requireKind(input.kind);
  requireContent(input.content);
  requireOptionalString(input.name, "name");
  requireOptionalString(input.description, "description");
  requireOptionalProvenance(input.provenance);
  requireOptionalString(input.principalId, "principalId");
}

function validateUpdateInput(input: UpdateCatalogItemInput): void {
  if (!isPlainObject(input)) throw new TypeError("updateCatalogItem input must be an object");
  requireNonEmptyId(input.id);
  if (input.kind !== undefined) requireKind(input.kind);
  requireOptionalString(input.name, "name");
  requireOptionalString(input.description, "description");
  if (input.content !== undefined) requireContent(input.content);
  requireOptionalProvenance(input.provenance);
  requireOptionalString(input.principalId, "principalId");
  if (input.expectedVersion !== undefined && !isNonEmptyString(input.expectedVersion)) {
    throw new TypeError("expectedVersion must be a non-empty string when provided");
  }
}

function validateDeleteInput(input: DeleteCatalogItemInput): void {
  if (!isPlainObject(input)) throw new TypeError("deleteCatalogItem input must be an object");
  requireNonEmptyId(input.id);
  if (input.kind !== undefined) requireKind(input.kind);
  requireOptionalString(input.principalId, "principalId");
  if (input.expectedVersion !== undefined && !isNonEmptyString(input.expectedVersion)) {
    throw new TypeError("expectedVersion must be a non-empty string when provided");
  }
}

function requireNonEmptyId(id: unknown): void {
  if (!isNonEmptyString(id)) throw new TypeError("catalog item id must be a non-empty string");
}

function requireKind(kind: unknown): asserts kind is CatalogItemKind {
  if (!isCatalogItemKind(kind)) throw new TypeError("catalog item kind must be 'loadout' or 'materia'");
}

function requireContent(content: unknown): asserts content is CatalogItemContent {
  if (!isPlainObject(content)) throw new TypeError("catalog item content must be an object");
  if (!isPlainObject((content as { definition?: unknown }).definition)) {
    throw new TypeError("catalog item content.definition must be a plain object");
  }
}

function requireOptionalString(value: unknown, field: string): void {
  if (value !== undefined && !isNonEmptyString(value)) {
    throw new TypeError(`catalog item ${field} must be a non-empty string when provided`);
  }
}

function requireOptionalProvenance(value: unknown): void {
  if (value !== undefined && !isPlainObject(value)) {
    throw new TypeError("catalog item provenance must be an object when provided");
  }
}

function freezeContent(content: CatalogItemContent): CatalogItemContent {
  requireContent(content);
  return Object.freeze({ definition: deepFreeze(content.definition) });
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreeze)) as T;
  if (isPlainObject(value)) {
    const frozen = Object.keys(value).reduce<Record<string, unknown>>((result, key) => {
      result[key] = deepFreeze(value[key]);
      return result;
    }, {});
    return Object.freeze(frozen) as T;
  }
  return value;
}

function normalizeProvenance(provenance: CatalogItemProvenance): CatalogItemProvenance {
  if (!isPlainObject(provenance)) throw new Error("Stored catalog provenance is not an object");
  return { ...provenance };
}

function parseJson<T>(json: string, label: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    throw new Error(`Could not parse stored ${label}`, { cause: error });
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
