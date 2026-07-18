import {
  type CreateModelPolicyInput,
  type DeleteModelPolicyInput,
  type ModelPolicyDocument,
  type ModelPolicyWriteResult,
  type SetActiveModelPolicyInput,
  type UpdateModelPolicyInput,
  isValidModelPolicyDocument,
} from "../../application/controlPlane.js";
import { createAuditMetadata, type AuditMetadata } from "../../domain/audit.js";
import {
  ModelPolicyConflictError,
  ModelPolicyNotFoundError,
  ModelPolicyVersionMismatchError,
  type CentralModelPolicyRepository,
} from "../controlPlane/centralModelPolicyRepository.js";
import { nowIso } from "../controlPlane/shared.js";
import { insertCentralAuditRecord } from "./auditRecords.js";
import type { CentralSqliteDatabase } from "./sqliteDatabase.js";

interface ModelPolicyRow {
  readonly id: string;
  readonly version: number;
  readonly updatedAt: string;
  readonly documentJson: string;
}

interface StoredModelPolicy {
  readonly id: string;
  readonly version: number;
  readonly updatedAt: string;
  readonly document: ModelPolicyDocument;
}

export interface SqliteModelPolicyRepositoryOptions {
  /** Stable clock for timestamps (tests); defaults to {@link nowIso}. */
  readonly clock?: () => string;
}

const POLICY_COLUMNS = `
  id,
  version,
  updated_at AS updatedAt,
  document_json AS documentJson
`;

/**
 * Create a durable central model-policy repository over an initialized SQLite
 * database. Policy state, the singleton active designation, and audit records
 * are updated in the same transaction.
 */
export function createSqliteModelPolicyRepository(
  database: CentralSqliteDatabase,
  options: SqliteModelPolicyRepositoryOptions = {},
): CentralModelPolicyRepository {
  const clock = options.clock ?? nowIso;

  function find(id: string): StoredModelPolicy | undefined {
    const row = database.prepare(
      `SELECT ${POLICY_COLUMNS} FROM model_policies WHERE id = ?`,
    ).get<ModelPolicyRow>(id);
    return row === undefined ? undefined : fromRow(row);
  }

  function requireExisting(id: string): StoredModelPolicy {
    const policy = find(id);
    if (policy !== undefined) return policy;
    throw new ModelPolicyNotFoundError(`Central model policy "${id}" was not found`);
  }

  function readActiveId(): string | undefined {
    return database.prepare(
      "SELECT policy_id AS policyId FROM active_model_policy WHERE singleton = 1",
    ).get<{ policyId: string }>()?.policyId;
  }

  function designateActive(id: string, updatedAt: string): void {
    database.prepare(`
      INSERT INTO active_model_policy (singleton, policy_id, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        policy_id = excluded.policy_id,
        updated_at = excluded.updated_at
    `).run(id, updatedAt);
  }

  function create(input: CreateModelPolicyInput): ModelPolicyWriteResult {
    validateCreateInput(input);
    return database.transaction(() => {
      if (find(input.id) !== undefined) {
        throw new ModelPolicyConflictError(`Central model policy "${input.id}" already exists`);
      }
      const normalized = normalizeDocument(input.id, input.document);
      const updatedAt = clock();
      const policy: StoredModelPolicy = {
        id: input.id,
        version: 1,
        updatedAt,
        document: normalized,
      };
      database.prepare(`
        INSERT INTO model_policies (id, version, updated_at, document_json)
        VALUES (?, ?, ?, ?)
      `).run(policy.id, policy.version, policy.updatedAt, JSON.stringify(policy.document));
      if (input.setActive === true) designateActive(policy.id, updatedAt);
      const audit = buildAudit("created", policy, input.principalId, updatedAt);
      insertCentralAuditRecord(database, audit);
      return writeResult("created", policy, readActiveId(), audit);
    });
  }

  function update(input: UpdateModelPolicyInput): ModelPolicyWriteResult {
    validateUpdateInput(input);
    return database.transaction(() => {
      const current = requireExisting(input.id);
      assertExpectedVersion(current, input.expectedVersion);
      const normalized = input.document === undefined
        ? undefined
        : normalizeDocument(input.id, input.document);
      const updatedAt = clock();
      const policy: StoredModelPolicy = {
        id: current.id,
        version: current.version + 1,
        updatedAt,
        document: normalized ?? current.document,
      };
      const result = database.prepare(`
        UPDATE model_policies
        SET version = ?, updated_at = ?, document_json = ?
        WHERE id = ? AND version = ?
      `).run(
        policy.version,
        policy.updatedAt,
        JSON.stringify(policy.document),
        current.id,
        current.version,
      );
      if (result.changes === 0) {
        const latest = find(current.id);
        if (latest === undefined) throw new ModelPolicyNotFoundError(`Central model policy "${current.id}" was not found`);
        throw versionMismatch(latest, String(current.version));
      }
      if (input.setActive === true) designateActive(policy.id, updatedAt);
      const audit = buildAudit("updated", policy, input.principalId, updatedAt);
      insertCentralAuditRecord(database, audit);
      return writeResult("updated", policy, readActiveId(), audit);
    });
  }

  function remove(input: DeleteModelPolicyInput): ModelPolicyWriteResult {
    validateDeleteInput(input);
    return database.transaction(() => {
      const current = requireExisting(input.id);
      assertExpectedVersion(current, input.expectedVersion);
      const result = database.prepare(
        "DELETE FROM model_policies WHERE id = ? AND version = ?",
      ).run(current.id, current.version);
      // Bun includes the active-policy ON DELETE CASCADE in `changes`, while
      // node:sqlite reports the directly deleted row. Any positive count means
      // the guarded policy row was deleted.
      if (result.changes === 0) {
        const latest = find(current.id);
        if (latest === undefined) throw new ModelPolicyNotFoundError(`Central model policy "${current.id}" was not found`);
        throw versionMismatch(latest, String(current.version));
      }
      const occurredAt = clock();
      const audit = buildAudit("deleted", current, input.principalId, occurredAt);
      insertCentralAuditRecord(database, audit);
      return deleteResult(readActiveId(), audit);
    });
  }

  function setActive(input: SetActiveModelPolicyInput): ModelPolicyWriteResult {
    validateSetActiveInput(input);
    return database.transaction(() => {
      const policy = requireExisting(input.id);
      const occurredAt = clock();
      designateActive(policy.id, occurredAt);
      const audit = buildAudit("activated", policy, input.principalId, occurredAt);
      insertCentralAuditRecord(database, audit);
      return writeResult("activated", policy, policy.id, audit);
    });
  }

  return {
    size(): number {
      const row = database.prepare("SELECT COUNT(*) AS count FROM model_policies").get<{ count: number }>();
      return Number(row?.count ?? 0);
    },
    async list(): Promise<ModelPolicyDocument[]> {
      return database.prepare(
        `SELECT ${POLICY_COLUMNS} FROM model_policies ORDER BY id ASC`,
      ).all<ModelPolicyRow>().map(fromRow).map(toDocument);
    },
    async get(id: string): Promise<ModelPolicyDocument | undefined> {
      const policy = find(id);
      return policy === undefined ? undefined : toDocument(policy);
    },
    async getActivePolicyId(): Promise<string | undefined> {
      return readActiveId();
    },
    async getActive(): Promise<ModelPolicyDocument | undefined> {
      const activeId = readActiveId();
      if (activeId === undefined) return undefined;
      const policy = find(activeId);
      return policy === undefined ? undefined : toDocument(policy);
    },
    async create(input: CreateModelPolicyInput): Promise<ModelPolicyWriteResult> {
      return create(input);
    },
    async update(input: UpdateModelPolicyInput): Promise<ModelPolicyWriteResult> {
      return update(input);
    },
    async remove(input: DeleteModelPolicyInput): Promise<ModelPolicyWriteResult> {
      return remove(input);
    },
    async setActive(input: SetActiveModelPolicyInput): Promise<ModelPolicyWriteResult> {
      return setActive(input);
    },
  };
}

function fromRow(row: ModelPolicyRow): StoredModelPolicy {
  const document = parseDocument(row.documentJson);
  return {
    id: row.id,
    version: Number(row.version),
    updatedAt: row.updatedAt,
    document: normalizeDocument(row.id, document),
  };
}

function toDocument(policy: StoredModelPolicy): ModelPolicyDocument {
  return {
    ...policy.document,
    id: policy.id,
    version: String(policy.version),
    updatedAt: policy.updatedAt,
  };
}

function normalizeDocument(id: string, document: ModelPolicyDocument): ModelPolicyDocument {
  if (!isValidModelPolicyDocument(document)) {
    throw new TypeError("model policy document failed structural validation");
  }
  return { ...document, id };
}

function assertExpectedVersion(policy: StoredModelPolicy, expectedVersion: string | undefined): void {
  if (expectedVersion !== undefined && expectedVersion !== String(policy.version)) {
    throw versionMismatch(policy, expectedVersion);
  }
}

function versionMismatch(policy: StoredModelPolicy, expectedVersion: string): ModelPolicyVersionMismatchError {
  return new ModelPolicyVersionMismatchError(
    `Central model policy "${policy.id}" version mismatch: expected "${expectedVersion}", current "${policy.version}"`,
    String(policy.version),
  );
}

function writeResult(
  action: "created" | "updated" | "activated",
  policy: StoredModelPolicy,
  activePolicyId: string | undefined,
  audit: AuditMetadata | undefined,
): ModelPolicyWriteResult {
  return {
    action,
    policy: toDocument(policy),
    ...(activePolicyId !== undefined ? { activePolicyId } : {}),
    ...(audit !== undefined ? { audit } : {}),
  };
}

function deleteResult(
  activePolicyId: string | undefined,
  audit: AuditMetadata | undefined,
): ModelPolicyWriteResult {
  return {
    action: "deleted",
    ...(activePolicyId !== undefined ? { activePolicyId } : {}),
    ...(audit !== undefined ? { audit } : {}),
  };
}

function buildAudit(
  action: "created" | "updated" | "deleted" | "activated",
  policy: StoredModelPolicy,
  principalId: string | undefined,
  occurredAt: string,
): AuditMetadata | undefined {
  const result = createAuditMetadata({
    action: `model-policy.${action}`,
    resourceType: "model-policy",
    resourceId: policy.id,
    occurredAt,
    outcome: "success",
    source: "model-policy-admin",
    ...(principalId !== undefined ? { principalId } : {}),
    metadata: { id: policy.id, version: String(policy.version) },
  });
  return result.ok ? result.value : undefined;
}

function validateCreateInput(input: CreateModelPolicyInput): void {
  if (!isPlainObject(input)) throw new TypeError("createModelPolicy input must be an object");
  requireNonEmptyId(input.id);
  if (!isPlainObject(input.document)) throw new TypeError("createModelPolicy document must be an object");
  requireOptionalString(input.principalId, "principalId");
}

function validateUpdateInput(input: UpdateModelPolicyInput): void {
  if (!isPlainObject(input)) throw new TypeError("updateModelPolicy input must be an object");
  requireNonEmptyId(input.id);
  if (input.document !== undefined && !isPlainObject(input.document)) {
    throw new TypeError("updateModelPolicy document must be an object when provided");
  }
  requireOptionalString(input.principalId, "principalId");
  if (input.expectedVersion !== undefined && !isNonEmptyString(input.expectedVersion)) {
    throw new TypeError("expectedVersion must be a non-empty string when provided");
  }
}

function validateDeleteInput(input: DeleteModelPolicyInput): void {
  if (!isPlainObject(input)) throw new TypeError("deleteModelPolicy input must be an object");
  requireNonEmptyId(input.id);
  requireOptionalString(input.principalId, "principalId");
  if (input.expectedVersion !== undefined && !isNonEmptyString(input.expectedVersion)) {
    throw new TypeError("expectedVersion must be a non-empty string when provided");
  }
}

function validateSetActiveInput(input: SetActiveModelPolicyInput): void {
  if (!isPlainObject(input)) throw new TypeError("setActiveModelPolicy input must be an object");
  requireNonEmptyId(input.id);
  requireOptionalString(input.principalId, "principalId");
}

function requireNonEmptyId(id: unknown): void {
  if (!isNonEmptyString(id)) throw new TypeError("model policy id must be a non-empty string");
}

function requireOptionalString(value: unknown, field: string): void {
  if (value !== undefined && !isNonEmptyString(value)) {
    throw new TypeError(`model policy ${field} must be a non-empty string when provided`);
  }
}

function parseDocument(json: string): ModelPolicyDocument {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error("Could not parse stored model policy document", { cause: error });
  }
  if (!isValidModelPolicyDocument(value)) {
    throw new Error("Stored model policy document failed structural validation");
  }
  return value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
