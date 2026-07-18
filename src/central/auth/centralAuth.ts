import {
  DEFAULT_DEV_TOKEN_ADMIN,
  DEFAULT_DEV_TOKEN_READER,
  DEFAULT_DEV_TOKEN_SINK,
  createDevTokenAuthAdapter,
  defaultDevTokenPrincipals,
  DEV_TOKEN_METHOD_KIND,
  type DevTokenPrincipal,
  type DevTokenPrincipalConfig,
} from "./devTokenAuth.js";
import { DEFAULT_CENTRAL_ROLE_REGISTRY, createRoleRegistry, type RoleRegistry } from "./roles.js";
import {
  validateCentralServerCredentials,
  type CentralCredentialConfig,
  type CentralServerAuthMode,
} from "../config/index.js";
import type { Role } from "../../domain/identity.js";
import type { CentralAuth } from "./rbac.js";

/**
 * Composition helpers for the central server's static bearer authentication.
 *
 * The guard depends only on the auth adapter boundary. This composition layer
 * binds deployment credentials to the fixed admin, reader, and telemetry roles,
 * validates every role reference, and gates the built-in credentials behind an
 * explicit development mode.
 */

export interface CentralAuthOptions {
  /** Production is the secure default; development explicitly enables built-ins. */
  mode: CentralServerAuthMode;
  /** Role-specific deployment credentials loaded from env or secret files. */
  credentials?: CentralCredentialConfig;
  /** Optional custom development fixtures. Never accepted in production mode. */
  devTokens?: DevTokenPrincipalConfig;
  /** Role definitions; defaults to the central default role registry. */
  roles?: readonly Role[];
}

const DEPLOYMENT_PRINCIPALS = {
  admin: {
    principalId: "central-admin",
    subject: "central-admin",
    name: "Central Admin",
    roleId: "central-admin",
  },
  reader: {
    principalId: "central-reader",
    subject: "central-reader",
    name: "Central Reader",
    roleId: "central-reader",
  },
  telemetry: {
    principalId: "central-telemetry-ingest",
    subject: "central-telemetry-ingest",
    name: "Central Telemetry Ingest",
    roleId: "central-telemetry-sink",
  },
} as const;

const BUILT_IN_DEV_TOKENS = new Set([
  DEFAULT_DEV_TOKEN_ADMIN,
  DEFAULT_DEV_TOKEN_READER,
  DEFAULT_DEV_TOKEN_SINK,
]);

/**
 * Build central auth from an explicit security mode. Production requires all
 * three deployment credentials. Development uses configured credentials when
 * any are supplied, otherwise it opts into the documented built-in token set.
 */
export function createDefaultCentralAuth(options: CentralAuthOptions): CentralAuth {
  const credentials = options.credentials ?? {};
  validateCentralServerCredentials(options.mode, credentials);

  if (options.mode === "production" && options.devTokens !== undefined) {
    throw new Error("Central production authentication cannot use development token principals.");
  }
  if (options.devTokens !== undefined && hasConfiguredCredentials(credentials)) {
    throw new Error("Central authentication accepts either deployment credentials or custom development tokens, not both.");
  }
  if (options.mode === "production") rejectBuiltInDevelopmentValues(credentials);

  const roleRegistry = options.roles !== undefined ? createRoleRegistry(options.roles) : DEFAULT_CENTRAL_ROLE_REGISTRY;
  const tokens = options.devTokens
    ?? (hasConfiguredCredentials(credentials)
      ? deploymentTokenPrincipals(credentials)
      : defaultDevTokenPrincipals());

  validatePrincipalRoleBindings(tokens, roleRegistry);
  return {
    adapter: createDevTokenAuthAdapter({ tokens }),
    roleRegistry,
    methodKind: DEV_TOKEN_METHOD_KIND,
  };
}

function deploymentTokenPrincipals(credentials: CentralCredentialConfig): DevTokenPrincipalConfig {
  const entries: Array<readonly [string, DevTokenPrincipal]> = [];
  if (credentials.adminToken !== undefined) {
    entries.push([credentials.adminToken, deploymentPrincipal(DEPLOYMENT_PRINCIPALS.admin)]);
  }
  if (credentials.readToken !== undefined) {
    entries.push([credentials.readToken, deploymentPrincipal(DEPLOYMENT_PRINCIPALS.reader)]);
  }
  if (credentials.telemetryToken !== undefined) {
    entries.push([credentials.telemetryToken, deploymentPrincipal(DEPLOYMENT_PRINCIPALS.telemetry)]);
  }
  return Object.fromEntries(entries);
}

function deploymentPrincipal(definition: (typeof DEPLOYMENT_PRINCIPALS)[keyof typeof DEPLOYMENT_PRINCIPALS]): DevTokenPrincipal {
  return {
    principalId: definition.principalId,
    subject: definition.subject,
    name: definition.name,
    tenantId: "default",
    roleBindings: [{ roleId: definition.roleId }],
  };
}

function validatePrincipalRoleBindings(tokens: DevTokenPrincipalConfig, registry: RoleRegistry): void {
  for (const principal of Object.values(tokens)) {
    for (const binding of principal.roleBindings) {
      if (registry.resolve(binding.roleId) === undefined) {
        throw new Error(
          `Central auth principal "${principal.principalId}" references unknown role "${binding.roleId}".`,
        );
      }
    }
  }
}

function hasConfiguredCredentials(credentials: CentralCredentialConfig): boolean {
  return credentials.adminToken !== undefined
    || credentials.readToken !== undefined
    || credentials.telemetryToken !== undefined;
}

function rejectBuiltInDevelopmentValues(credentials: CentralCredentialConfig): void {
  for (const token of [credentials.adminToken, credentials.readToken, credentials.telemetryToken]) {
    if (token !== undefined && BUILT_IN_DEV_TOKENS.has(token)) {
      throw new Error("Central production authentication cannot use a built-in development credential value.");
    }
  }
}
