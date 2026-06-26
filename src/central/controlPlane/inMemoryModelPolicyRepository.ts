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
import { nowIso } from "./shared.js";

/**
 * In-memory central model-policy repository.
 *
 * Stores model-policy documents ({@link ModelPolicyDocument}) keyed by policy
 * id, with monotonic per-policy versions, RFC3339 updated timestamps, and an
 * "active" designation. Read methods back the central {@link ModelPolicyPort};
 * admin write methods back the central {@link AdminMetadataPort}, the only path
 * that may write central model-policy data (docs/enterprise-control-plane.md
 * §3.3, §11). Normal local/project editing paths never touch this repository;
 * the local control-plane admin port rejects central policy writes
 * (`src/infrastructure/localControlPlane/adminPort.ts`).
 *
 * In-memory only at this stage; no persistence. A future persistent store should
 * keep this interface. Document validation reuses the pure domain guard
 * `isValidModelPolicyDocument`; an invalid document is rejected rather than
 * partially stored.
 */

// ───────────────────────────────────────────────────────────────────────
// Write errors
// ───────────────────────────────────────────────────────────────────────

/** Base class for central model-policy repository write errors. */
export abstract class CentralModelPolicyWriteError extends Error {
  /** HTTP status a route layer may map this to. */
  abstract readonly statusCode: number;
}

/** Thrown when a create targets an id that already exists. */
export class ModelPolicyConflictError extends CentralModelPolicyWriteError {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "ModelPolicyConflictError";
  }
}

/** Thrown when an update/delete/activate targets an id that does not exist. */
export class ModelPolicyNotFoundError extends CentralModelPolicyWriteError {
  readonly statusCode = 404;
  constructor(message: string) {
    super(message);
    this.name = "ModelPolicyNotFoundError";
  }
}

/** Thrown when optimistic concurrency (expectedVersion) does not match. */
export class ModelPolicyVersionMismatchError extends CentralModelPolicyWriteError {
  readonly statusCode = 409;
  readonly currentVersion: string;
  constructor(message: string, currentVersion: string) {
    super(message);
    this.name = "ModelPolicyVersionMismatchError";
    this.currentVersion = currentVersion;
  }
}

// ───────────────────────────────────────────────────────────────────────
// Internal storage record
// ───────────────────────────────────────────────────────────────────────

interface StoredModelPolicy {
  readonly id: string;
  /** Constraint fields carried on the document. */
  readonly document: ModelPolicyDocument;
  /** Monotonic per-policy version counter; surfaced as `version: String(counter)`. */
  versionCounter: number;
  /** RFC3339 timestamp of the last central update. */
  updatedAt: string;
}

// ───────────────────────────────────────────────────────────────────────
// Repository interface
// ───────────────────────────────────────────────────────────────────────

/**
 * Central model-policy repository: the read surface for the central
 * {@link ModelPolicyPort} and the admin write surface for the central
 * {@link AdminMetadataPort}. Methods are async so the same interface can back a
 * future persistent store.
 */
export interface CentralModelPolicyRepository {
  /** Number of policy documents currently stored. */
  size(): number;
  // Reads (back ModelPolicyPort)
  list(): Promise<ModelPolicyDocument[]>;
  get(id: string): Promise<ModelPolicyDocument | undefined>;
  getActivePolicyId(): Promise<string | undefined>;
  /** Read the active policy document, or undefined when none is active. */
  getActive(): Promise<ModelPolicyDocument | undefined>;
  // Admin writes (back AdminMetadataPort — the only central model-policy write path)
  create(input: CreateModelPolicyInput): Promise<ModelPolicyWriteResult>;
  update(input: UpdateModelPolicyInput): Promise<ModelPolicyWriteResult>;
  remove(input: DeleteModelPolicyInput): Promise<ModelPolicyWriteResult>;
  setActive(input: SetActiveModelPolicyInput): Promise<ModelPolicyWriteResult>;
}

export interface InMemoryModelPolicyRepositoryOptions {
  /** Stable clock for timestamps (tests); defaults to {@link nowIso}. */
  clock?: () => string;
  /** Initial policy documents applied through `create()` at construction. */
  seed?: readonly CreateModelPolicyInput[];
}

/**
 * Create an in-memory central model-policy repository.
 *
 * Stores policy documents keyed by id. Versions are monotonic per policy
 * (`"1"`, `"2"`, …). Exactly one policy may be designated active at a time;
 * `setActive` replaces the previous active designation. Deleting the active
 * policy clears the active designation.
 */
export function createInMemoryModelPolicyRepository(
  options: InMemoryModelPolicyRepositoryOptions = {},
): CentralModelPolicyRepository {
  const clock = options.clock ?? nowIso;
  const store = new Map<string, StoredModelPolicy>();
  let activeId: string | undefined;

  // ── reads ──────────────────────────────────────────────────────────

  function toDocument(record: StoredModelPolicy): ModelPolicyDocument {
    return withManagedFields(record.document, record);
  }

  // ── writes ─────────────────────────────────────────────────────────

  function applyCreate(input: CreateModelPolicyInput): ModelPolicyWriteResult {
    validateCreateInput(input);
    if (store.has(input.id)) {
      throw new ModelPolicyConflictError(`Central model policy "${input.id}" already exists`);
    }
    const updatedAt = clock();
    const record: StoredModelPolicy = {
      id: input.id,
      document: normalizeDocument(input.id, input.document),
      versionCounter: 1,
      updatedAt,
    };
    store.set(input.id, record);
    if (input.setActive === true) activeId = input.id;
    return writeResult("created", record, input.principalId, updatedAt);
  }

  function applyUpdate(input: UpdateModelPolicyInput): ModelPolicyWriteResult {
    validateUpdateInput(input);
    const record = requireExisting(input.id);
    if (input.expectedVersion !== undefined && input.expectedVersion !== versionOf(record)) {
      throw new ModelPolicyVersionMismatchError(
        `Central model policy "${record.id}" version mismatch: expected "${input.expectedVersion}", current "${versionOf(record)}"`,
        versionOf(record),
      );
    }
    const updatedAt = clock();
    record.versionCounter += 1;
    record.updatedAt = updatedAt;
    if (input.document !== undefined) {
      (record as { document: ModelPolicyDocument }).document = normalizeDocument(input.id, input.document);
    }
    if (input.setActive === true) activeId = input.id;
    return writeResult("updated", record, input.principalId, updatedAt);
  }

  function applyDelete(input: DeleteModelPolicyInput): ModelPolicyWriteResult {
    validateDeleteInput(input);
    const record = requireExisting(input.id);
    if (input.expectedVersion !== undefined && input.expectedVersion !== versionOf(record)) {
      throw new ModelPolicyVersionMismatchError(
        `Central model policy "${record.id}" version mismatch: expected "${input.expectedVersion}", current "${versionOf(record)}"`,
        versionOf(record),
      );
    }
    store.delete(input.id);
    if (activeId === input.id) activeId = undefined;
    return deleteResult(record, input.principalId, clock());
  }

  function applySetActive(input: SetActiveModelPolicyInput): ModelPolicyWriteResult {
    validateSetActiveInput(input);
    const record = requireExisting(input.id);
    activeId = input.id;
    return writeResult("activated", record, input.principalId, clock());
  }

  function requireExisting(id: string): StoredModelPolicy {
    const record = store.get(id);
    if (record === undefined) {
      throw new ModelPolicyNotFoundError(`Central model policy "${id}" was not found`);
    }
    return record;
  }

  // ── DTO projection ─────────────────────────────────────────────────

  function writeResult(
    action: "created" | "updated" | "activated",
    record: StoredModelPolicy,
    principalId: string | undefined,
    occurredAt: string,
  ): ModelPolicyWriteResult {
    const audit = buildAudit(action, record, principalId, occurredAt);
    return {
      action,
      policy: toDocument(record),
      ...(activeId !== undefined ? { activePolicyId: activeId } : {}),
      ...(audit !== undefined ? { audit } : {}),
    };
  }

  function deleteResult(
    record: StoredModelPolicy,
    principalId: string | undefined,
    occurredAt: string,
  ): ModelPolicyWriteResult {
    const audit = buildAudit("deleted", record, principalId, occurredAt);
    return {
      action: "deleted",
      ...(activeId !== undefined ? { activePolicyId: activeId } : {}),
      ...(audit !== undefined ? { audit } : {}),
    };
  }

  // Apply seed through the same create path so seeded policies get validated,
  // versioned, and timestamped identically to runtime creates.
  if (options.seed !== undefined) {
    for (const item of options.seed) {
      applyCreate(item);
    }
  }

  return {
    size() {
      return store.size;
    },
    async list(): Promise<ModelPolicyDocument[]> {
      return [...store.values()].sort(comparePolicies).map(toDocument);
    },
    async get(id: string): Promise<ModelPolicyDocument | undefined> {
      const record = store.get(id);
      return record === undefined ? undefined : toDocument(record);
    },
    async getActivePolicyId(): Promise<string | undefined> {
      return activeId;
    },
    async getActive(): Promise<ModelPolicyDocument | undefined> {
      if (activeId === undefined) return undefined;
      const record = store.get(activeId);
      return record === undefined ? undefined : toDocument(record);
    },
    async create(input: CreateModelPolicyInput): Promise<ModelPolicyWriteResult> {
      return applyCreate(input);
    },
    async update(input: UpdateModelPolicyInput): Promise<ModelPolicyWriteResult> {
      return applyUpdate(input);
    },
    async remove(input: DeleteModelPolicyInput): Promise<ModelPolicyWriteResult> {
      return applyDelete(input);
    },
    async setActive(input: SetActiveModelPolicyInput): Promise<ModelPolicyWriteResult> {
      return applySetActive(input);
    },
  };
}

// ───────────────────────────────────────────────────────────────────────
// Pure projection helpers (no repository state)
// ───────────────────────────────────────────────────────────────────────

function versionOf(record: StoredModelPolicy): string {
  return String(record.versionCounter);
}

/** Stamp store-managed provenance fields onto a stored document projection. */
function withManagedFields(document: ModelPolicyDocument, record: StoredModelPolicy): ModelPolicyDocument {
  return { ...document, id: record.id, version: versionOf(record), updatedAt: record.updatedAt };
}

/** Normalize an input document: validate shape, pin the authoritative id. */
function normalizeDocument(id: string, document: ModelPolicyDocument): ModelPolicyDocument {
  if (!isValidModelPolicyDocument(document)) {
    throw new TypeError("model policy document failed structural validation");
  }
  return { ...document, id };
}

function comparePolicies(a: StoredModelPolicy, b: StoredModelPolicy): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function buildAudit(
  action: "created" | "updated" | "deleted" | "activated",
  record: StoredModelPolicy,
  principalId: string | undefined,
  occurredAt: string,
): AuditMetadata | undefined {
  const result = createAuditMetadata({
    action: `model-policy.${action}`,
    resourceType: "model-policy",
    resourceId: record.id,
    occurredAt,
    outcome: "success",
    source: "model-policy-admin",
    ...(principalId !== undefined ? { principalId } : {}),
    metadata: { id: record.id, version: versionOf(record) },
  });
  return result.ok ? result.value : undefined;
}

// ───────────────────────────────────────────────────────────────────────
// Input validation (structural)
// ───────────────────────────────────────────────────────────────────────

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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
