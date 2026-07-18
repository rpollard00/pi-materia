import type {
  CreateModelPolicyInput,
  DeleteModelPolicyInput,
  ModelPolicyDocument,
  ModelPolicyWriteResult,
  SetActiveModelPolicyInput,
  UpdateModelPolicyInput,
} from "../../application/controlPlane.js";

/** Base class for central model-policy repository write errors. */
export abstract class CentralModelPolicyWriteError extends Error {
  /** HTTP status used by the central transport adapter. */
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

/** Thrown when an update, delete, or activation targets an unknown id. */
export class ModelPolicyNotFoundError extends CentralModelPolicyWriteError {
  readonly statusCode = 404;
  constructor(message: string) {
    super(message);
    this.name = "ModelPolicyNotFoundError";
  }
}

/** Thrown when optimistic concurrency does not match the stored version. */
export class ModelPolicyVersionMismatchError extends CentralModelPolicyWriteError {
  readonly statusCode = 409;
  readonly currentVersion: string;
  constructor(message: string, currentVersion: string) {
    super(message);
    this.name = "ModelPolicyVersionMismatchError";
    this.currentVersion = currentVersion;
  }
}

/**
 * Persistence-neutral repository shared by model-policy read and admin ports.
 */
export interface CentralModelPolicyRepository {
  size(): number;
  list(): Promise<ModelPolicyDocument[]>;
  get(id: string): Promise<ModelPolicyDocument | undefined>;
  getActivePolicyId(): Promise<string | undefined>;
  getActive(): Promise<ModelPolicyDocument | undefined>;
  create(input: CreateModelPolicyInput): Promise<ModelPolicyWriteResult>;
  update(input: UpdateModelPolicyInput): Promise<ModelPolicyWriteResult>;
  remove(input: DeleteModelPolicyInput): Promise<ModelPolicyWriteResult>;
  setActive(input: SetActiveModelPolicyInput): Promise<ModelPolicyWriteResult>;
}
