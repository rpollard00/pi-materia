/**
 * Browser storage helpers for central static-bearer authentication
 * (docs/enterprise-control-plane.md §13).
 *
 * The original exported names mention development tokens and remain for API
 * compatibility. The standalone admin shell also uses the neutral bearer-token
 * aliases below with deployment-provided reader/admin credentials. A future
 * OAuth/OIDC adapter can replace this storage boundary without changing central
 * feature clients.
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

/** Neutral aliases used by the standalone central-admin authentication state. */
export const readCentralBearerToken = readCentralDevToken;
export const writeCentralBearerToken = writeCentralDevToken;
