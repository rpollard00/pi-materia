import {
  type AdminMetadataPort,
  type AdminMetadataSnapshot,
  type CatalogItemWriteResult,
  type ControlPlaneServerInfo,
  type CreateCatalogItemInput,
  type CreateModelPolicyInput,
  type DeleteCatalogItemInput,
  type DeleteModelPolicyInput,
  type ModelPolicyWriteResult,
  type SetActiveModelPolicyInput,
  type UpdateCatalogItemInput,
  type UpdateModelPolicyInput,
} from "../../application/controlPlane.js";
import { type LocalControlPlaneAdapterOptions, localAdapterModeMetadata } from "./shared.js";

/**
 * Local admin metadata port.
 *
 * Reports local server/admin metadata (mode, capabilities, configured auth
 * surface = none in local-only mode). Central catalog admin writes are
 * intentionally unsupported: central catalog data is not writable through normal
 * local/project editing paths, and local definitions are edited through the local
 * config save path, never the control-plane admin port
 * (docs/enterprise-control-plane.md §3.3, §10, §13). Local session routes and
 * local config editing are not gated by central RBAC.
 */
export function createLocalAdminMetadataPort(options: LocalControlPlaneAdapterOptions): AdminMetadataPort {
  const mode = () => localAdapterModeMetadata(options);

  function rejectCentralWrite(action: string): never {
    throw new Error(
      `Central catalog ${action} is not available in local-only mode. Local definitions are edited through the local config save path, not the control-plane admin port.`,
    );
  }

  function rejectPolicyWrite(action: string): never {
    throw new Error(
      `Central model-policy ${action} is not available in local-only mode. Central model-policy data is administered on the central control plane, not the local control-plane admin port.`,
    );
  }

  return {
    mode,
    async getMetadata(): Promise<AdminMetadataSnapshot> {
      const server: ControlPlaneServerInfo = {
        mode: "local-only",
        authMethods: [],
        capabilities: mode().capabilities,
        ...(options.label !== undefined ? { label: options.label } : {}),
        ...(options.startedAt !== undefined ? { startedAt: options.startedAt } : {}),
      };
      return { server };
    },
    async createCatalogItem(_input: CreateCatalogItemInput): Promise<CatalogItemWriteResult> {
      rejectCentralWrite("create");
    },
    async updateCatalogItem(_input: UpdateCatalogItemInput): Promise<CatalogItemWriteResult> {
      rejectCentralWrite("update");
    },
    async deleteCatalogItem(_input: DeleteCatalogItemInput): Promise<CatalogItemWriteResult> {
      rejectCentralWrite("delete");
    },
    // Central model-policy admin writes are unsupported for the same reason as
    // catalog writes: central policy data is not writable from local-only mode,
    // and local model selection is not gated by central policy here (§11, §13).
    async createModelPolicy(_input: CreateModelPolicyInput): Promise<ModelPolicyWriteResult> {
      rejectPolicyWrite("create");
    },
    async updateModelPolicy(_input: UpdateModelPolicyInput): Promise<ModelPolicyWriteResult> {
      rejectPolicyWrite("update");
    },
    async deleteModelPolicy(_input: DeleteModelPolicyInput): Promise<ModelPolicyWriteResult> {
      rejectPolicyWrite("delete");
    },
    async setActiveModelPolicy(_input: SetActiveModelPolicyInput): Promise<ModelPolicyWriteResult> {
      rejectPolicyWrite("activate");
    },
  };
}
