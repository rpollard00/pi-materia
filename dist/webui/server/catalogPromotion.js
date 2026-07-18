import { validateCatalogLocalActionRequest, } from '../../application/catalogActions.js';
import { isCatalogLocalAction, } from '../../domain/catalogActions.js';
import { CentralHttpClientError, CentralHttpConflictError, CentralHttpTimeoutError } from '../../central/client/errors.js';
import { errorMessage, isPlainObject, readJsonBody, sendJson } from './http.js';
/** Local-session-only path prefix for explicit central-to-local promotions. */
export const CATALOG_PROMOTION_PATH_PREFIX = '/api/catalog/promotions';
/**
 * Handle one of the three explicit local promotion routes:
 *
 * - `POST /api/catalog/promotions/copy`
 * - `POST /api/catalog/promotions/update`
 * - `POST /api/catalog/promotions/replace`
 *
 * The action comes from the route so a caller cannot accidentally turn a
 * confirmation request into a different operation. Target scope remains a
 * required body field; there is deliberately no implicit user/project target.
 */
export async function handleCatalogPromotionRoute(req, res, deps) {
    const action = readRouteAction(req.url);
    if (action === undefined) {
        sendPromotionError(res, 404, 'not_found', 'Catalog promotion route not found.');
        return;
    }
    if (req.method !== 'POST') {
        sendPromotionError(res, 405, 'method_not_allowed', `Use POST to ${action} a central catalog definition locally.`);
        return;
    }
    // Requiring both callbacks guarantees that an enabled promotion route always
    // performs the post-write config refresh promised by this local API.
    if (!deps.promoteCatalog || !deps.getConfig) {
        sendPromotionError(res, 503, 'unavailable', 'Catalog promotion API is unavailable for this local session.');
        return;
    }
    let request;
    try {
        request = parsePromotionRequest(await readJsonBody(req), action);
    }
    catch (error) {
        sendPromotionError(res, 400, 'invalid_request', errorMessage(error));
        return;
    }
    try {
        const result = await deps.promoteCatalog(request);
        if (result.status === 'needs_confirmation') {
            sendJson(res, 409, {
                ok: false,
                result,
                error: { code: 'overwrite_confirmation_required', message: result.reason },
                conflict: conflictDetails(request, result, 'overwrite_confirmation_required', true),
                provenance: provenanceDetails(result.origin, result.previousOrigin),
            });
            return;
        }
        if (result.status === 'rejected') {
            const status = result.code === 'not_found' ? 404 : 409;
            sendJson(res, status, {
                ok: false,
                result,
                error: { code: result.code, message: result.reason },
                ...(status === 409 ? { conflict: conflictDetails(request, result, result.code, false) } : {}),
                ...(result.previousOrigin !== undefined
                    ? { provenance: provenanceDetails(undefined, result.previousOrigin) }
                    : {}),
            });
            return;
        }
        // The write has already committed. Reload before responding so the WebUI
        // receives canonical normalized config, source ownership, and resolved drift
        // rather than optimistically patching stale browser state.
        let config;
        try {
            config = await deps.getConfig();
        }
        catch (error) {
            // Do not report the completed write as failed (which could invite an unsafe
            // retry). Surface the refresh failure explicitly while preserving the
            // successful action/provenance response.
            sendJson(res, 200, {
                ok: true,
                result,
                provenance: provenanceDetails(result.origin, result.previousOrigin),
                configRefresh: { ok: false, error: errorMessage(error) },
            });
            return;
        }
        const drift = readPromotedDefinitionDrift(config, result.kind, result.localKey);
        sendJson(res, 200, {
            ok: true,
            result,
            provenance: provenanceDetails(result.origin, result.previousOrigin),
            config,
            ...(drift !== undefined ? { drift } : {}),
            configRefresh: { ok: true },
        });
    }
    catch (error) {
        sendPromotionFailure(res, error, request);
    }
}
function readRouteAction(rawUrl) {
    const pathname = new URL(rawUrl ?? '', 'http://localhost').pathname;
    if (!pathname.startsWith(`${CATALOG_PROMOTION_PATH_PREFIX}/`))
        return undefined;
    const suffix = pathname.slice(CATALOG_PROMOTION_PATH_PREFIX.length + 1);
    if (suffix.length === 0 || suffix.includes('/') || !isCatalogLocalAction(suffix))
        return undefined;
    return suffix;
}
function parsePromotionRequest(body, action) {
    if (!isPlainObject(body))
        throw new TypeError('Catalog promotion request body must be a JSON object.');
    if (body.action !== undefined && body.action !== action) {
        throw new TypeError(`Catalog promotion body action must match route action '${action}'.`);
    }
    const request = {
        action,
        kind: body.kind,
        catalogItemId: body.catalogItemId,
        localKey: body.localKey,
        target: body.target,
        ...(Object.prototype.hasOwnProperty.call(body, 'confirmOverwrite')
            ? { confirmOverwrite: body.confirmOverwrite }
            : {}),
    };
    validateCatalogLocalActionRequest(request);
    return request;
}
function conflictDetails(request, result, code, confirmOverwriteRequired) {
    return {
        code,
        action: request.action,
        kind: request.kind,
        catalogItemId: request.catalogItemId,
        localKey: request.localKey,
        target: request.target,
        confirmOverwriteRequired,
        ...(result.previousOrigin !== undefined ? { currentOrigin: result.previousOrigin } : {}),
        ...(result.status === 'needs_confirmation' ? { proposedOrigin: result.origin } : {}),
    };
}
function provenanceDetails(origin, previousOrigin) {
    return {
        ...(origin !== undefined ? { origin } : {}),
        ...(previousOrigin !== undefined ? { previousOrigin } : {}),
    };
}
function readPromotedDefinitionDrift(config, kind, localKey) {
    if (!isPlainObject(config) || !isPlainObject(config.catalogDrift))
        return undefined;
    const collection = kind === 'loadout' ? config.catalogDrift.loadouts : config.catalogDrift.materia;
    return isPlainObject(collection) ? collection[localKey] : undefined;
}
function sendPromotionFailure(res, error, request) {
    if (error instanceof CentralHttpConflictError) {
        sendJson(res, 409, {
            ok: false,
            error: { code: error.code ?? 'central_conflict', message: error.message },
            conflict: {
                code: error.code ?? 'central_conflict',
                action: request.action,
                kind: request.kind,
                catalogItemId: request.catalogItemId,
                localKey: request.localKey,
                target: request.target,
                ...(error.currentVersion !== undefined ? { currentVersion: error.currentVersion } : {}),
            },
        });
        return;
    }
    if (error instanceof CentralHttpTimeoutError) {
        sendPromotionError(res, 504, 'central_timeout', error.message);
        return;
    }
    if (error instanceof CentralHttpClientError) {
        sendJson(res, 502, {
            ok: false,
            error: {
                code: error.status === 401
                    ? 'central_unauthorized'
                    : error.status === 403
                        ? 'central_forbidden'
                        : 'central_unavailable',
                message: error.message,
            },
            upstreamStatus: error.status,
        });
        return;
    }
    if (error instanceof TypeError) {
        sendPromotionError(res, 400, 'invalid_request', error.message);
        return;
    }
    sendPromotionError(res, 500, 'promotion_failed', errorMessage(error));
}
function sendPromotionError(res, status, code, message) {
    sendJson(res, status, { ok: false, error: { code, message } });
}
