/**
 * Development-token resolver for central control-plane reads
 * (docs/enterprise-control-plane.md §13).
 *
 * The central server guards `/api/model-policy` and `/api/model-catalog` with
 * the `model-policy.read` permission, resolved today through the documented
 * **development-only** bearer token adapter. The WebUI client therefore needs
 * to present a dev-token to read central policy state. This module isolates
 * that dev-stage credential plumbing so the rest of the client stays
 * transport/auth-agnostic.
 *
 * OAuth/OIDC is a documented **future** auth adapter boundary that produces the
 * same principal/permission contracts; when it lands this resolver is replaced
 * by that adapter without touching the central client API surface. No OAuth
 * library is imported here.
 */

const STORAGE_KEY = 'pi-materia.central-dev-token';

/**
 * Read the browser-stored central dev-token. Returns `undefined` when storage
 * is unavailable (non-DOM/SSR) or no token has been set. Safe to call in
 * non-browser environments.
 */
export function readCentralDevToken(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const storage = (window as { localStorage?: Storage }).localStorage;
  if (!storage) return undefined;
  try {
    const value = storage.getItem(STORAGE_KEY);
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist a central dev-token to browser storage. An empty/blank value clears
 * the stored token. No-ops outside a browser/storage-capable environment.
 */
export function writeCentralDevToken(token: string): void {
  if (typeof window === 'undefined') return;
  const storage = (window as { localStorage?: Storage }).localStorage;
  if (!storage) return;
  const trimmed = token.trim();
  try {
    if (trimmed) storage.setItem(STORAGE_KEY, trimmed);
    else storage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage errors (private mode, quota): the token simply won't
    // persist across reloads.
  }
}

/**
 * Build the `Authorization` header value for a token, or `undefined` when no
 * token is present. Pure; safe for tests.
 */
export function centralAuthorizationHeader(token: string | undefined): string | undefined {
  if (!token || !token.trim()) return undefined;
  return `Bearer ${token.trim()}`;
}
