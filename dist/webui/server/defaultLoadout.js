import { errorMessage, isPlainObject, readJsonBody, sendJson } from './http.js';
function failureStatus(code) {
    if (code === 'invalid_name')
        return 400;
    if (code === 'unknown_loadout')
        return 404;
    return 503;
}
function sendDefaultLoadoutError(res, status, code, message, extras = {}) {
    sendJson(res, status, { ok: false, error: { code, message }, ...extras });
}
export async function handleDefaultLoadoutRoute(req, res, deps) {
    if (req.method !== 'POST') {
        sendDefaultLoadoutError(res, 405, 'method_not_allowed', 'Use POST to set the default loadout.');
        return;
    }
    if (!deps.setDefaultLoadout) {
        sendDefaultLoadoutError(res, 503, 'unavailable', 'Default loadout API is unavailable for this server.');
        return;
    }
    try {
        const body = await readJsonBody(req);
        if (!isPlainObject(body) || !(typeof body.name === 'string' || body.name === null)) {
            sendDefaultLoadoutError(res, 400, 'invalid_name', 'Expected JSON body with string or null field "name".');
            return;
        }
        const name = typeof body.name === 'string' ? body.name.trim() : null;
        if (body.name !== null && !name) {
            sendDefaultLoadoutError(res, 400, 'invalid_name', 'Default loadout name cannot be empty.');
            return;
        }
        const result = await deps.setDefaultLoadout(name);
        if (!result.ok) {
            sendDefaultLoadoutError(res, failureStatus(result.code), result.code, result.message, {
                ...(result.defaultLoadoutId !== undefined ? { defaultLoadoutId: result.defaultLoadoutId } : {}),
            });
            return;
        }
        sendJson(res, 200, {
            ok: true,
            defaultLoadoutId: result.defaultLoadoutId,
            message: result.message ?? (result.defaultLoadoutId ? `Default loadout set to ${result.defaultLoadoutId}.` : 'Default loadout cleared.'),
        });
    }
    catch (error) {
        const message = errorMessage(error);
        const invalidJson = message === 'Invalid JSON body' || message === 'Request body too large';
        sendDefaultLoadoutError(res, invalidJson ? 400 : 500, invalidJson ? 'invalid_request' : 'default_loadout_failed', message);
    }
}
