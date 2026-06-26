import { createHash } from "node:crypto";
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
import { nowIso } from "./shared.js";

/**
 * In-memory central catalog repository.
 *
 * Stores versioned loadout and materia definitions with stable ids, monotonic
 * per-item versions, RFC3339 updated timestamps, provenance, and content hashes.
 * Read APIs back {@link CatalogAccessPort}; admin write APIs back the central
 * {@link AdminMetadataPort}, the only path that may write central catalog data
 * (docs/enterprise-control-plane.md §3.3, §10). Normal local/project editing
 * paths never touch this repository: they edit local config files through the
 * local config save path, and the local control-plane admin port rejects central
 * catalog writes (see `src/infrastructure/localControlPlane/adminPort.ts`).
 *
 * In-memory only at this stage; no persistence. A future persistent store should
 * keep this interface. Content validation here is structural (id/kind/content
 * shape); full materia/loadout domain-shape normalization is layered above when
 * central definitions are promoted into local scopes (§12, §14).
 */

// ───────────────────────────────────────────────────────────────────────
// Write errors (forward-compatible with a future catalog route layer)
// ───────────────────────────────────────────────────────────────────────

/** Base class for central catalog repository write errors. */
export abstract class CentralCatalogWriteError extends Error {
  /** HTTP status a future route layer may map this to. */
  abstract readonly statusCode: number;
}

/** Thrown when a create targets an id/kind that already exists. */
export class CatalogConflictError extends CentralCatalogWriteError {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "CatalogConflictError";
  }
}

/** Thrown when an update/delete targets an id/kind that does not exist. */
export class CatalogNotFoundError extends CentralCatalogWriteError {
  readonly statusCode = 404;
  constructor(message: string) {
    super(message);
    this.name = "CatalogNotFoundError";
  }
}

/** Thrown when optimistic concurrency (expectedVersion) does not match. */
export class CatalogVersionMismatchError extends CentralCatalogWriteError {
  readonly statusCode = 409;
  readonly currentVersion: string;
  constructor(message: string, currentVersion: string) {
    super(message);
    this.name = "CatalogVersionMismatchError";
    this.currentVersion = currentVersion;
  }
}

// ───────────────────────────────────────────────────────────────────────
// Internal storage record
// ───────────────────────────────────────────────────────────────────────

interface CentralCatalogItemRecord {
  readonly id: string;
  readonly kind: CatalogItemKind;
  readonly name?: string;
  readonly description?: string;
  /** Monotonic per-item version counter; surfaced as `version: String(counter)`. */
  versionCounter: number;
  /** RFC3339 timestamp of the last central update. */
  updatedAt: string;
  readonly contentHash: string;
  readonly content: CatalogItemContent;
  readonly provenance?: CatalogItemProvenance;
}

// ───────────────────────────────────────────────────────────────────────
// Repository interface
// ───────────────────────────────────────────────────────────────────────

/**
 * Central catalog repository: the read surface for {@link CatalogAccessPort}
 * and the admin write surface for the central {@link AdminMetadataPort}.
 * Methods are async so the same interface can back a future persistent store.
 */
export interface CentralCatalogRepository {
  /** Number of catalog items currently stored. */
  size(): number;
  // Reads (back CatalogAccessPort)
  list(query?: CatalogQuery): Promise<CatalogItemSummary[]>;
  get(id: string, kind?: CatalogItemKind): Promise<CatalogItem | undefined>;
  head(id: string, kind?: CatalogItemKind): Promise<CatalogItemSummary | undefined>;
  // Admin writes (back AdminMetadataPort — the only central catalog write path)
  create(input: CreateCatalogItemInput): Promise<CatalogItemWriteResult>;
  update(input: UpdateCatalogItemInput): Promise<CatalogItemWriteResult>;
  delete(input: DeleteCatalogItemInput): Promise<CatalogItemWriteResult>;
}

export interface InMemoryCentralCatalogRepositoryOptions {
  /** Stable clock for timestamps (tests); defaults to {@link nowIso}. */
  clock?: () => string;
  /** Initial catalog items applied through `create()` at construction. */
  seed?: readonly CreateCatalogItemInput[];
}

/**
 * Create an in-memory central catalog repository.
 *
 * Stores items keyed by `${kind}:${id}` so a materia and a loadout definition
 * cannot collide even when they share an id. Versions are monotonic per item
 * (`"1"`, `"2"`, …). Content hashes are deterministic (`sha256:<hex>` of a
 * key-stable serialization of the definition), so local copies can compare
 * against central for drift (§14) regardless of object key order.
 */
export function createInMemoryCentralCatalogRepository(
  options: InMemoryCentralCatalogRepositoryOptions = {},
): CentralCatalogRepository {
  const clock = options.clock ?? nowIso;
  const store = new Map<string, CentralCatalogItemRecord>();

  // ── reads ──────────────────────────────────────────────────────────

  function findByCompositeKey(id: string, kind: CatalogItemKind): CentralCatalogItemRecord | undefined {
    return store.get(compositeKey(kind, id));
  }

  function findLoose(id: string): CentralCatalogItemRecord | undefined {
    const matches: CentralCatalogItemRecord[] = [];
    for (const record of store.values()) {
      if (record.id === id) matches.push(record);
    }
    if (matches.length === 0) return undefined;
    // Deterministic when a kind is omitted and ids collide across kinds.
    matches.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
    return matches[0];
  }

  // ── writes ─────────────────────────────────────────────────────────

  function applyCreate(input: CreateCatalogItemInput): CatalogItemWriteResult {
    validateCreateInput(input);
    const kind = input.kind;
    const existing = findByCompositeKey(input.id, kind);
    if (existing !== undefined) {
      throw new CatalogConflictError(`Central catalog item "${kind}:${input.id}" already exists`);
    }
    const updatedAt = clock();
    const record: CentralCatalogItemRecord = {
      id: input.id,
      kind,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      versionCounter: 1,
      updatedAt,
      contentHash: hashContent(input.content),
      content: freezeContent(input.content),
      ...(input.provenance !== undefined ? { provenance: normalizeProvenance(input.provenance) } : { provenance: { source: "central" } }),
    };
    store.set(compositeKey(kind, record.id), record);
    return writeResult("created", record, input.principalId, updatedAt);
  }

  function applyUpdate(input: UpdateCatalogItemInput): CatalogItemWriteResult {
    validateUpdateInput(input);
    const record = requireExisting(input.id, input.kind);
    if (input.expectedVersion !== undefined && input.expectedVersion !== versionOf(record)) {
      throw new CatalogVersionMismatchError(
        `Central catalog item "${record.kind}:${record.id}" version mismatch: expected "${input.expectedVersion}", current "${versionOf(record)}"`,
        versionOf(record),
      );
    }
    const updatedAt = clock();
    record.versionCounter += 1;
    record.updatedAt = updatedAt;
    if (input.kind !== undefined && input.kind !== record.kind) {
      // Kind change is a logical move; re-key the store to keep kind:id unique.
      const oldKey = compositeKey(record.kind, record.id);
      (record as { kind: CatalogItemKind }).kind = input.kind;
      store.delete(oldKey);
      store.set(compositeKey(record.kind, record.id), record);
    }
    if (input.name !== undefined) (record as { name?: string }).name = input.name;
    if (input.description !== undefined) (record as { description?: string }).description = input.description;
    if (input.content !== undefined) {
      (record as { contentHash: string }).contentHash = hashContent(input.content);
      (record as { content: CatalogItemContent }).content = freezeContent(input.content);
    }
    if (input.provenance !== undefined) {
      (record as { provenance?: CatalogItemProvenance }).provenance = normalizeProvenance(input.provenance);
    }
    return writeResult("updated", record, input.principalId, updatedAt);
  }

  function applyDelete(input: DeleteCatalogItemInput): CatalogItemWriteResult {
    validateDeleteInput(input);
    const record = requireExisting(input.id, input.kind);
    if (input.expectedVersion !== undefined && input.expectedVersion !== versionOf(record)) {
      throw new CatalogVersionMismatchError(
        `Central catalog item "${record.kind}:${record.id}" version mismatch: expected "${input.expectedVersion}", current "${versionOf(record)}"`,
        versionOf(record),
      );
    }
    store.delete(compositeKey(record.kind, record.id));
    return writeResult("deleted", record, input.principalId, clock());
  }

  function requireExisting(id: string, kind: CatalogItemKind | undefined): CentralCatalogItemRecord {
    const record = kind !== undefined ? findByCompositeKey(id, kind) : findLoose(id);
    if (record === undefined) {
      const qualifier = kind !== undefined ? `"${kind}:${id}"` : `"${id}"`;
      throw new CatalogNotFoundError(`Central catalog item ${qualifier} was not found`);
    }
    return record;
  }

  // ── DTO projection ─────────────────────────────────────────────────

  function writeResult(
    action: "created" | "updated" | "deleted",
    record: CentralCatalogItemRecord,
    principalId: string | undefined,
    occurredAt: string,
  ): CatalogItemWriteResult {
    const audit = buildAudit(action, record, principalId, occurredAt);
    return {
      action,
      summary: toSummary(record),
      ...(audit !== undefined ? { audit } : {}),
    };
  }

  // Apply seed through the same create path so seeded items get validated,
  // versioned, hashed, and timestamped identically to runtime creates.
  if (options.seed !== undefined) {
    for (const item of options.seed) {
      applyCreate(item);
    }
  }

  return {
    size() {
      return store.size;
    },
    async list(query?: CatalogQuery): Promise<CatalogItemSummary[]> {
      const summaries = [...store.values()].sort(compareRecords).map(toSummary);
      return summaries.filter((summary) => matchesQuery(summary, query));
    },
    async get(id: string, kind?: CatalogItemKind): Promise<CatalogItem | undefined> {
      const record = kind !== undefined ? findByCompositeKey(id, kind) : findLoose(id);
      return record === undefined ? undefined : toItem(record);
    },
    async head(id: string, kind?: CatalogItemKind): Promise<CatalogItemSummary | undefined> {
      const record = kind !== undefined ? findByCompositeKey(id, kind) : findLoose(id);
      return record === undefined ? undefined : toSummary(record);
    },
    async create(input: CreateCatalogItemInput): Promise<CatalogItemWriteResult> {
      return applyCreate(input);
    },
    async update(input: UpdateCatalogItemInput): Promise<CatalogItemWriteResult> {
      return applyUpdate(input);
    },
    async delete(input: DeleteCatalogItemInput): Promise<CatalogItemWriteResult> {
      return applyDelete(input);
    },
  };
}

// ───────────────────────────────────────────────────────────────────────
// Pure projection + hashing helpers (no repository state)
// ───────────────────────────────────────────────────────────────────────

function compositeKey(kind: CatalogItemKind, id: string): string {
  return `${kind}:${id}`;
}

function versionOf(record: CentralCatalogItemRecord): string {
  return String(record.versionCounter);
}

function toSummary(record: CentralCatalogItemRecord): CatalogItemSummary {
  return {
    id: record.id,
    kind: record.kind,
    version: versionOf(record),
    updatedAt: record.updatedAt,
    contentHash: record.contentHash,
    ...(record.name !== undefined ? { name: record.name } : {}),
    ...(record.description !== undefined ? { description: record.description } : {}),
    ...(record.provenance !== undefined ? { provenance: record.provenance } : {}),
  };
}

function toItem(record: CentralCatalogItemRecord): CatalogItem {
  return { ...toSummary(record), content: record.content };
}

function compareRecords(a: CentralCatalogItemRecord, b: CentralCatalogItemRecord): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

function matchesQuery(summary: CatalogItemSummary, query: CatalogQuery | undefined): boolean {
  if (!query) return true;
  if (query.kind !== undefined && summary.kind !== query.kind) return false;
  if (query.search) {
    const needle = query.search.toLowerCase();
    const haystack = `${summary.id} ${summary.name ?? ""}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/** Deterministic content hash, independent of object key order. */
export function hashCentralContent(content: CatalogItemContent): string {
  return hashContent(content);
}

function hashContent(content: CatalogItemContent): string {
  return `sha256:${createHash("sha256").update(stableStringify(content.definition)).digest("hex")}`;
}

function freezeContent(content: CatalogItemContent): CatalogItemContent {
  return Object.freeze({ definition: deepFreeze(content.definition) }) as CatalogItemContent;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreeze)) as unknown as T;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const frozen = Object.keys(record).reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = deepFreeze(record[key]);
      return acc;
    }, {});
    return Object.freeze(frozen) as unknown as T;
  }
  return value;
}

function normalizeProvenance(provenance: CatalogItemProvenance): CatalogItemProvenance {
  return { ...(provenance as Record<string, unknown>) } as CatalogItemProvenance;
}

function buildAudit(
  action: "created" | "updated" | "deleted",
  record: CentralCatalogItemRecord,
  principalId: string | undefined,
  occurredAt: string,
): AuditMetadata | undefined {
  const result = createAuditMetadata({
    action: `catalog-item.${action}`,
    resourceType: "catalog-item",
    resourceId: `${record.kind}:${record.id}`,
    occurredAt,
    outcome: "success",
    source: "catalog-admin",
    ...(principalId !== undefined ? { principalId } : {}),
    metadata: { kind: record.kind, id: record.id, version: versionOf(record), contentHash: record.contentHash },
  });
  return result.ok ? result.value : undefined;
}

// ───────────────────────────────────────────────────────────────────────
// Input validation (structural)
// ───────────────────────────────────────────────────────────────────────

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
  const definition = (content as { definition?: unknown }).definition;
  if (!isPlainObject(definition)) throw new TypeError("catalog item content.definition must be a plain object");
}

function requireOptionalString(value: unknown, field: string): void {
  if (value !== undefined && !isNonEmptyString(value)) throw new TypeError(`catalog item ${field} must be a non-empty string when provided`);
}

function requireOptionalProvenance(provenance: unknown): void {
  if (provenance === undefined) return;
  if (!isPlainObject(provenance)) throw new TypeError("catalog item provenance must be an object when provided");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ───────────────────────────────────────────────────────────────────────
// Stable serialization
// ───────────────────────────────────────────────────────────────────────

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys(record[key]);
        return acc;
      }, {});
  }
  return value;
}
