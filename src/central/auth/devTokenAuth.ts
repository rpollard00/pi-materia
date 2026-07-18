import { createHash, timingSafeEqual } from "node:crypto";
import { validateAuthContext, type AuthContext, type AuthMethodKind } from "../../domain/auth.js";
import { validatePrincipal, type RoleBinding } from "../../domain/identity.js";
import type { ScopePath } from "../../domain/scope.js";
import {
  type AuthAdapter,
  type AuthRequest,
  type AuthResolution,
  readBearerToken,
} from "./authAdapter.js";
import { DEFAULT_CENTRAL_ROLES } from "./roles.js";

/**
 * Static bearer-token auth adapter for the central control-plane server.
 *
 * The first auth adapter implementation (docs/enterprise-control-plane.md §13).
 * It maps a bearer token presented in the `Authorization` header to a
 * preconfigured principal. Deployment tokens are loaded from environment or
 * secret files by the server composition layer. The default token set below is
 * strictly development-only; OAuth/OIDC remains a future implementation of the
 * same adapter boundary (`./authAdapter.ts`).
 *
 * The adapter never parses token formats (no JWT/OAuth library); it securely
 * compares the presented bearer token against a configured allow-list and
 * resolves the bound principal. Role bindings on the principal reference role
 * ids resolved by the role registry (`./roles.ts`).
 */

/** Definition of the principal bound to a dev token. Role ids are resolved by the registry. */
export interface DevTokenPrincipal {
  principalId: string;
  subject?: string;
  name?: string;
  tenantId: string;
  roleBindings: readonly RoleBinding[];
  /** Scope resolved onto the auth context (optional; used for scope-aware RBAC and audit). */
  scope?: ScopePath;
}

/** Maps a static bearer-token string to its bound principal definition. */
export type DevTokenPrincipalConfig = Readonly<Record<string, DevTokenPrincipal>>;

/**
 * Documented development-only default tokens. These exist so the central server
 * is usable out of the box (`npm run dev:central:server`) and so tests have
 * stable fixtures. **Never use these in production.** Their role bindings map to
 * the default central roles (`./roles.ts`):
 * - `dev-token-admin` → `central-admin` (wildcard)
 * - `dev-token-reader` → `central-reader` (read-only across surfaces)
 * - `dev-token-sink` → `central-telemetry-sink` (telemetry ingest only)
 */
export const DEFAULT_DEV_TOKEN_ADMIN = "dev-token-admin";
export const DEFAULT_DEV_TOKEN_READER = "dev-token-reader";
export const DEFAULT_DEV_TOKEN_SINK = "dev-token-sink";

/** Default tenant id used by the development token set. */
export const DEFAULT_DEV_TOKEN_TENANT_ID = "default";

export function defaultDevTokenPrincipals(): DevTokenPrincipalConfig {
  return {
    [DEFAULT_DEV_TOKEN_ADMIN]: {
      principalId: "dev-admin",
      subject: "dev-admin",
      name: "Development Admin",
      tenantId: DEFAULT_DEV_TOKEN_TENANT_ID,
      roleBindings: [{ roleId: "central-admin" }],
    },
    [DEFAULT_DEV_TOKEN_READER]: {
      principalId: "dev-reader",
      subject: "dev-reader",
      name: "Development Reader",
      tenantId: DEFAULT_DEV_TOKEN_TENANT_ID,
      roleBindings: [{ roleId: "central-reader" }],
    },
    [DEFAULT_DEV_TOKEN_SINK]: {
      principalId: "dev-sink",
      subject: "dev-sink",
      name: "Development Telemetry Sink",
      tenantId: DEFAULT_DEV_TOKEN_TENANT_ID,
      roleBindings: [{ roleId: "central-telemetry-sink" }],
    },
  };
}

export interface DevTokenAuthAdapterOptions {
  /** Token → principal config. Callers must opt into any development defaults. */
  tokens: DevTokenPrincipalConfig;
}

interface ResolvedDevToken {
  readonly digest: Buffer;
  readonly context: AuthContext;
}

/**
 * Create the static bearer-token auth adapter. Bound principals are validated
 * and turned into frozen {@link AuthContext} records up front. The configured
 * tokens themselves are discarded after hashing; request-time matching compares
 * fixed-size SHA-256 digests with Node's constant-time primitive and scans the
 * complete allow-list. Invalid configuration throws without echoing a secret.
 */
export function createDevTokenAuthAdapter(options: DevTokenAuthAdapterOptions): AuthAdapter {
  const resolved: ResolvedDevToken[] = [];

  for (const [index, [token, principalDef]] of Object.entries(options.tokens).entries()) {
    if (token.length === 0) throw new Error("Bearer-token auth: empty token string is not allowed");
    if (!/^\S+$/.test(token)) {
      throw new Error(`Bearer-token auth: credential ${index + 1} contains unsupported whitespace`);
    }
    const principalResult = validatePrincipal({
      id: principalDef.principalId,
      tenantId: principalDef.tenantId,
      ...(principalDef.subject !== undefined ? { subject: principalDef.subject } : {}),
      ...(principalDef.name !== undefined ? { name: principalDef.name } : {}),
      roleBindings: [...principalDef.roleBindings],
    });
    if (!principalResult.ok) {
      throw new Error(
        `Bearer-token auth: invalid principal for credential ${index + 1}: ${principalResult.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    const contextResult = validateAuthContext({
      principal: principalResult.value,
      method: { kind: "dev-token", adapter: "dev-token" },
      ...(principalDef.scope !== undefined ? { scope: principalDef.scope } : {}),
    });
    if (!contextResult.ok) {
      throw new Error(
        `Bearer-token auth: invalid auth context for credential ${index + 1}: ${contextResult.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    resolved.push({ digest: tokenDigest(token), context: contextResult.value });
  }

  return {
    adapterId: "dev-token",
    resolve(request: AuthRequest): AuthResolution {
      const token = readBearerToken(request.headers);
      if (token === undefined) return { status: "unauthenticated", reason: "missing" };
      if (token === null) return { status: "unauthenticated", reason: "malformed" };

      const candidateDigest = tokenDigest(token);
      let match: ResolvedDevToken | undefined;
      // Do not return early: every configured digest is compared on every
      // credential-bearing request, regardless of which principal matches.
      for (const configured of resolved) {
        if (timingSafeEqual(candidateDigest, configured.digest)) match = configured;
      }
      if (match === undefined) return { status: "unauthenticated", reason: "unknown" };
      return { status: "authenticated", context: match.context };
    },
  };
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * The auth method kind a dev-token adapter reports on resolved contexts. Used by
 * the server to populate admin metadata (`authMethods`) and by audit records.
 */
export const DEV_TOKEN_METHOD_KIND: AuthMethodKind = "dev-token";

/** True when the supplied default-role set covers the role ids used by the default dev tokens. */
export function defaultDevTokensReferenceDefaultRoles(): boolean {
  const referenced = new Set(
    Object.values(defaultDevTokenPrincipals()).flatMap((principal) => principal.roleBindings.map((binding) => binding.roleId)),
  );
  const defined = new Set(DEFAULT_CENTRAL_ROLES.map((role) => role.id));
  for (const roleId of referenced) {
    if (!defined.has(roleId)) return false;
  }
  return true;
}
