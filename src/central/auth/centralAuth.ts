import { createDevTokenAuthAdapter, DEV_TOKEN_METHOD_KIND, type DevTokenPrincipalConfig } from "./devTokenAuth.js";
import { DEFAULT_CENTRAL_ROLE_REGISTRY, createRoleRegistry } from "./roles.js";
import type { Role } from "../../domain/identity.js";
import type { CentralAuth } from "./rbac.js";

/**
 * Composition helpers for the central server's auth configuration.
 *
 * Kept separate from the guard (`./rbac.ts`) so the guard depends only on the
 * auth adapter boundary, not on the concrete dev-token implementation. The server
 * (`src/central/server/index.ts`) uses {@link createDefaultCentralAuth} when no
 * explicit auth configuration is supplied; production deployments compose their
 * own {@link CentralAuth} (with the future OAuth/OIDC adapter and a custom role
 * registry) and pass it in (docs/enterprise-control-plane.md §13).
 */

export interface CentralAuthOptions {
  /** Dev-token → principal config. Defaults to the documented dev-only token set. */
  devTokens?: DevTokenPrincipalConfig;
  /** Role definitions; defaults to the central default role registry. */
  roles?: readonly Role[];
}

/**
 * Build a default {@link CentralAuth} backed by the dev-token adapter and the
 * default central role registry. Suitable for local/development; replace with a
 * custom adapter/registry (and, later, OAuth/OIDC) for non-local deployments.
 */
export function createDefaultCentralAuth(options: CentralAuthOptions = {}): CentralAuth {
  const adapter = createDevTokenAuthAdapter(
    options.devTokens !== undefined ? { tokens: options.devTokens } : {},
  );
  const roleRegistry = options.roles !== undefined ? createRoleRegistry(options.roles) : DEFAULT_CENTRAL_ROLE_REGISTRY;
  return {
    adapter,
    roleRegistry,
    methodKind: DEV_TOKEN_METHOD_KIND,
  };
}
