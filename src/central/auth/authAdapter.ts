import type { AuthContext } from "../../domain/auth.js";

/**
 * Auth adapter boundary for the central control-plane server.
 *
 * Central HTTP transport concern (not domain): adapters read a credential from
 * an inbound HTTP request and resolve it into the domain {@link AuthContext}.
 * The development-token adapter is the first implementation
 * (`./devTokenAuth.ts`). OAuth/OIDC is a documented **future** auth adapter
 * boundary — a future adapter would implement this same interface and produce
 * the same `AuthContext`/`Principal` contracts, without changing the domain or
 * the route guard (`./rbac.ts`). No OAuth library or flow lives here
 * (docs/enterprise-control-plane.md §13, §4).
 */

/**
 * Minimal request shape an adapter reads from. Decoupled from `IncomingMessage`
 * so adapters and guards are testable without a live HTTP server. Node HTTP
 * request headers satisfy this shape directly (`req.headers`).
 */
export interface AuthRequestHeaders {
  /** Header name lookup is case-insensitive in Node; adapters should tolerate either casing. */
  readonly authorization?: string | readonly string[] | undefined;
  readonly [header: string]: string | readonly string[] | undefined;
}

export interface AuthRequest {
  headers: AuthRequestHeaders;
}

/** Why an adapter could not resolve an authenticated context. */
export type AuthFailureReason = "missing" | "malformed" | "unknown" | "expired";

/**
 * Discriminated result of resolving a credential. `authenticated` carries the
 * domain {@link AuthContext}; otherwise the adapter reports a coarse failure
 * reason so the guard can emit the right 4xx envelope
 * (`missing`/`malformed`/`unknown` → 401, `expired` → 401).
 */
export type AuthResolution =
  | { readonly status: "authenticated"; readonly context: AuthContext }
  | { readonly status: "unauthenticated"; readonly reason: AuthFailureReason };

/**
 * Boundary every auth adapter implements. `adapterId` identifies the adapter
 * (e.g. `"dev-token"`, future `"oidc"`); the dev-token adapter reports method
 * kind `"dev-token"` on the contexts it produces.
 */
export interface AuthAdapter {
  readonly adapterId: string;
  resolve(request: AuthRequest): AuthResolution;
}

export const BEARER_SCHEME = "Bearer";

/**
 * Read a bearer token from an `Authorization` header value.
 *
 * Returns `undefined` when the header is absent (`missing`), `null` when the
 * header is present but not a parseable bearer credential (`malformed`), and the
 * trimmed token string otherwise. Scheme matching is case-insensitive per
 * RFC 6750; the token is returned as-is (it is compared against a configured
 * allow-list, never parsed as a JWT or other format by the dev-token adapter).
 */
export function readBearerToken(headers: AuthRequestHeaders): string | null | undefined {
  const raw = headers.authorization ?? headers.Authorization;
  if (raw === undefined || raw === null) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length === 0) return null;
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(value);
  if (match === null) return null;
  return match[1];
}
