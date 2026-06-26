import { defaultCapabilities, deriveControlPlaneMode, } from "../../application/controlPlane.js";
import { sendJson } from "./http.js";
/**
 * WebUI backend mode discovery
 * (docs/enterprise-control-plane.md §2, §7, §8).
 *
 * The local-session WebUI server exposes a single discovery endpoint
 * (`GET /api/backend-mode`) so the frontend can determine whether it is
 * connected to same-origin local session APIs, a configured central control
 * plane (by absolute base URL), or both. The response carries per-surface
 * capability metadata so the frontend can render central
 * catalog/model-policy/admin state separately from local runtime/session
 * state.
 *
 * This module is intentionally pure and transport-free: {@link resolveBackendMode}
 * builds the DTO from connection topology, and {@link handleBackendModeRoute}
 * only serializes it. Quest-board and other local-session routes are unchanged
 * by this discovery surface; central routes live on the separate central server
 * and are never mixed into the local dispatcher.
 */
/** Service id surfaced on local-session envelopes (matches health/session). */
export const WEBUI_BACKEND_SERVICE = "pi-materia-webui";
/**
 * Normalizes and validates a configured central API base URL.
 *
 * A central URL is "configured" only when it is a non-empty http(s) URL with a
 * resolvable origin. Anything else (empty, non-string, non-http scheme,
 * unparseable) is treated as "no central control plane configured" so the
 * default `local-only` workflow is preserved exactly
 * (docs/enterprise-control-plane.md §1, §2).
 */
export function resolveCentralApiBaseUrl(value) {
    if (value === undefined || value === null)
        return undefined;
    const trimmed = String(value).trim();
    if (!trimmed)
        return undefined;
    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
            return undefined;
        return trimmed;
    }
    catch {
        return undefined;
    }
}
/** Resolve the origin string of a configured central URL, when valid. */
export function resolveCentralOrigin(centralApiBaseUrl) {
    const url = resolveCentralApiBaseUrl(centralApiBaseUrl);
    if (url === undefined)
        return undefined;
    try {
        return new URL(url).origin;
    }
    catch {
        return undefined;
    }
}
/**
 * True when the configured central control plane is same-origin as the given
 * local origin. The backend cannot observe the browser origin, so callers pass
 * `localOrigin` only when it is known (e.g. tests). When `localOrigin` is
 * absent the result is conservatively `false`; the frontend recomputes
 * authoritatively from `window.location.origin`.
 */
export function isCentralSameOrigin(centralApiBaseUrl, localOrigin) {
    if (!localOrigin)
        return false;
    const centralOrigin = resolveCentralOrigin(centralApiBaseUrl);
    if (!centralOrigin)
        return false;
    try {
        return new URL(localOrigin).origin === centralOrigin;
    }
    catch {
        return false;
    }
}
/**
 * Build the backend mode discovery DTO from connection topology. Pure and
 * side-effect free; safe for adapters, the launcher, and tests to reuse.
 */
export function resolveBackendMode(options = {}) {
    const hasLocalSession = options.hasLocalSession ?? true;
    const centralApiBaseUrl = resolveCentralApiBaseUrl(options.centralApiBaseUrl);
    const hasCentral = centralApiBaseUrl !== undefined;
    const mode = deriveControlPlaneMode({ hasLocalSession, hasCentral });
    const capabilities = defaultCapabilities(hasCentral);
    return {
        ok: true,
        scope: "session",
        service: WEBUI_BACKEND_SERVICE,
        mode,
        hasLocalSession,
        hasCentral,
        capabilities,
        endpoints: {
            local: { available: hasLocalSession, sameOrigin: true, baseUrl: "" },
            central: centralApiBaseUrl !== undefined
                ? {
                    available: true,
                    sameOrigin: isCentralSameOrigin(centralApiBaseUrl, options.localOrigin),
                    baseUrl: centralApiBaseUrl,
                }
                : { available: false, sameOrigin: false },
        },
        ...(centralApiBaseUrl !== undefined ? { centralApiBaseUrl } : {}),
        ...(options.label !== undefined ? { label: options.label } : {}),
    };
}
/** Serialize the backend mode discovery DTO for `GET /api/backend-mode`. */
export function handleBackendModeRoute(res, deps = {}) {
    sendJson(res, 200, resolveBackendMode(deps));
}
