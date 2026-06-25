import { type ModelPolicyPort } from "../../application/controlPlane.js";
import { type LocalControlPlaneAdapterOptions, localAdapterModeMetadata } from "./shared.js";

/**
 * Local model-policy port.
 *
 * No central model policy is configured in local-only mode. Returning an absent
 * active policy preserves existing local model selection behavior exactly
 * (docs/enterprise-control-plane.md §11). The local Pi model registry remains the
 * available-runtime source of truth and continues to be served through its
 * existing local route; this port only reports policy state.
 */
export function createLocalModelPolicyPort(options: LocalControlPlaneAdapterOptions): ModelPolicyPort {
  return {
    mode: () => localAdapterModeMetadata(options),
    async getActivePolicy() {
      return undefined;
    },
    async getActivePolicyId() {
      return undefined;
    },
    async listPolicies() {
      return [];
    },
    async getPolicy() {
      return undefined;
    },
    async getModelCatalog() {
      return undefined;
    },
  };
}
