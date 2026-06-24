import type { ControlPlanePorts } from "../../application/controlPlane.js";
import { createLocalAdminMetadataPort } from "./adminPort.js";
import { createLocalCatalogAccessPort } from "./catalogPort.js";
import { createLocalModelPolicyPort } from "./modelPolicyPort.js";
import type { LocalControlPlaneAdapterOptions } from "./shared.js";
import { createLocalTelemetryStatusPort } from "./telemetryPort.js";

export * from "./shared.js";
export { createLocalCatalogAccessPort } from "./catalogPort.js";
export { createLocalModelPolicyPort } from "./modelPolicyPort.js";
export { createLocalTelemetryStatusPort } from "./telemetryPort.js";
export { createLocalAdminMetadataPort } from "./adminPort.js";
export { createLocalConfigCatalogStore, type LocalConfigCatalogStoreOptions } from "./catalogStore.js";

/**
 * Build the local control-plane ports, wrapping existing local config/model/
 * monitoring behavior behind the application control-plane abstraction.
 *
 * Every port reports `local-only` mode and exposes existing local data through
 * the new DTOs. This composes the four ports without changing quest-board routes
 * or semantics, and without coupling to any central control plane
 * (docs/enterprise-control-plane.md §4, §7, §16.3).
 */
export function createLocalControlPlanePorts(options: LocalControlPlaneAdapterOptions = {}): ControlPlanePorts {
  return {
    catalog: createLocalCatalogAccessPort(options),
    modelPolicy: createLocalModelPolicyPort(options),
    telemetry: createLocalTelemetryStatusPort(options),
    admin: createLocalAdminMetadataPort(options),
  };
}
