import { errorMessage, isPlainObject, readJsonBody, sendJson } from './http.js';
export async function handleGetConfigRoute(res, deps) {
    if (!deps.getConfig) {
        sendJson(res, 503, { ok: false, error: 'Config API is unavailable for this server.' });
        return;
    }
    try {
        const loaded = await deps.getConfig();
        sendJson(res, 200, isPlainObject(loaded) ? { ok: true, ...loaded } : { ok: true, config: loaded });
    }
    catch (error) {
        sendJson(res, 500, { ok: false, error: errorMessage(error) });
    }
}
export async function handlePostConfigRoute(req, res, deps) {
    if (!deps.saveConfig) {
        sendJson(res, 503, { ok: false, error: 'Config save API is unavailable for this server.' });
        return;
    }
    try {
        const body = await readJsonBody(req);
        if (!isPlainObject(body) || !isPlainObject(body.config))
            throw new Error('Expected JSON body with object field "config".');
        const target = typeof body.target === 'string' ? body.target : 'user';
        if (!['user', 'project', 'explicit'].includes(target))
            throw new Error('Invalid save target. Expected user, project, or explicit.');
        const written = await deps.saveConfig(body.config, target);
        sendJson(res, 200, { ok: true, target, written });
    }
    catch (error) {
        sendJson(res, 400, { ok: false, error: errorMessage(error) });
    }
}
