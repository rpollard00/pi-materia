import { WILDCARD_PERMISSION, validateRole, type Role } from "../../domain/identity.js";

/**
 * Central control-plane role registry.
 *
 * Roles are the bridge between role bindings on a {@link Principal} and the
 * permissions checked by the route guard (`./rbac.ts`). The registry holds the
 * authoritative permission lists per role id; principals only carry role
 * bindings (see `docs/enterprise-control-plane.md §13`). This module is a
 * transport-level default for the central server; it imports the pure domain
 * `Role`/validation contracts but performs no IO.
 */

/**
 * Default development role set for the central control plane. Covers the four
 * route namespaces (catalog, model-policy, admin, telemetry) from
 * `CENTRAL_PERMISSIONS` with read/write/ingest groupings plus a wildcard admin.
 * Production deployments may supply their own registry via the server auth
 * options; these defaults exist so the central server is usable out of the box
 * for development.
 */
export const DEFAULT_CENTRAL_ROLES: readonly Role[] = [
  {
    id: "central-admin",
    name: "Central Admin",
    description: "Full read/write across all central control-plane surfaces.",
    permissions: [WILDCARD_PERMISSION],
  },
  {
    id: "central-reader",
    name: "Central Reader",
    description: "Read-only access to catalog, model-policy, admin, and telemetry surfaces.",
    permissions: ["catalog.read", "model-policy.read", "admin.read", "telemetry.read"],
  },
  {
    id: "central-catalog-writer",
    name: "Central Catalog Writer",
    description: "Read plus central catalog write access.",
    permissions: ["catalog.read", "catalog.write", "model-policy.read", "telemetry.read"],
  },
  {
    id: "central-telemetry-sink",
    name: "Central Telemetry Sink",
    description: "Telemetry ingestion only; for local runtimes emitting events.",
    permissions: ["telemetry.ingest"],
  },
];

/** Read-only role id → role lookup used by permission evaluation. */
export interface RoleRegistry {
  readonly roles: ReadonlyMap<string, Role>;
  resolve(roleId: string): Role | undefined;
}

/**
 * Build a role registry from role definitions. Roles are validated and frozen;
 * invalid definitions throw (configuration errors should surface immediately,
 * not at request time). Later definitions for a duplicate id win.
 */
export function createRoleRegistry(roles: readonly Role[]): RoleRegistry {
  const map = new Map<string, Role>();
  for (const role of roles) {
    const result = validateRole(role);
    if (!result.ok) {
      throw new Error(`Invalid central role definition ${role.id}: ${result.issues.map((issue) => issue.message).join("; ")}`);
    }
    map.set(result.value.id, result.value);
  }
  return {
    roles: map,
    resolve: (roleId: string) => map.get(roleId),
  };
}

/** Default central role registry instance. */
export const DEFAULT_CENTRAL_ROLE_REGISTRY: RoleRegistry = createRoleRegistry(DEFAULT_CENTRAL_ROLES);
