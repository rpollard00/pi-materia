import { MATERIA_THINKING_LEVELS, isMateriaThinkingLevel } from '../../domain/thinking.js';
import { errorMessage, isPlainObject, readJsonBody, sendJson } from './http.js';
function sendProfileRoleGenerationError(res, status, code, message) {
    sendJson(res, status, { ok: false, error: { code, message } });
}
function normalizeRoleGenerationModelPreference(model) {
    const trimmed = typeof model === 'string' ? model.trim() : null;
    return trimmed || null;
}
function isProviderQualifiedModelId(value) {
    return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
function normalizeRoleGenerationThinkingPreference(thinking) {
    const trimmed = typeof thinking === 'string' ? thinking.trim() : null;
    return isMateriaThinkingLevel(trimmed) ? trimmed : null;
}
function normalizePreference(preference) {
    return {
        model: normalizeRoleGenerationModelPreference(preference.model),
        thinking: normalizeRoleGenerationThinkingPreference(preference.thinking),
    };
}
function parsePreferencePayload(body) {
    if (!isPlainObject(body))
        return { ok: false, code: 'invalid_request', message: 'Expected JSON object body.' };
    const update = {};
    if ('model' in body) {
        if (!(typeof body.model === 'string' || body.model === null))
            return { ok: false, code: 'invalid_model', message: 'Expected field "model" to be a string or null.' };
        const model = normalizeRoleGenerationModelPreference(body.model);
        if (model && !isProviderQualifiedModelId(model))
            return { ok: false, code: 'invalid_model', message: 'Invalid role-generation model. Expected a provider-qualified model id such as "provider/model".' };
        update.model = model;
    }
    if ('thinking' in body) {
        if (!(typeof body.thinking === 'string' || body.thinking === null))
            return { ok: false, code: 'invalid_thinking', message: 'Expected field "thinking" to be one of off, minimal, low, medium, high, xhigh, or null.' };
        const trimmedThinking = typeof body.thinking === 'string' ? body.thinking.trim() : null;
        if (typeof body.thinking === 'string' && !isMateriaThinkingLevel(trimmedThinking))
            return { ok: false, code: 'invalid_thinking', message: `Invalid role-generation thinking. Expected one of: ${MATERIA_THINKING_LEVELS.join(', ')}.` };
        update.thinking = trimmedThinking;
    }
    return { ok: true, update };
}
export async function handleProfileRoleGenerationRoute(req, res, deps) {
    if (req.method === 'GET') {
        if (!deps.getRoleGenerationPreference) {
            sendProfileRoleGenerationError(res, 503, 'unavailable', 'Role-generation profile API is unavailable for this server.');
            return;
        }
        try {
            const preference = normalizePreference(await deps.getRoleGenerationPreference());
            sendJson(res, 200, { ok: true, ...preference });
        }
        catch (error) {
            sendProfileRoleGenerationError(res, 500, 'read_failed', errorMessage(error));
        }
        return;
    }
    if (req.method !== 'PATCH' && req.method !== 'POST') {
        sendProfileRoleGenerationError(res, 405, 'method_not_allowed', 'Use GET to read or PATCH/POST to update role-generation profile preferences.');
        return;
    }
    if (!deps.setRoleGenerationPreference) {
        sendProfileRoleGenerationError(res, 503, 'unavailable', 'Role-generation profile API is unavailable for this server.');
        return;
    }
    try {
        const parsed = parsePreferencePayload(await readJsonBody(req));
        if (!parsed.ok) {
            sendProfileRoleGenerationError(res, 400, parsed.code, parsed.message);
            return;
        }
        const preference = normalizePreference(await deps.setRoleGenerationPreference(parsed.update));
        sendJson(res, 200, { ok: true, ...preference });
    }
    catch (error) {
        const message = errorMessage(error);
        const invalidJson = message === 'Invalid JSON body' || message === 'Request body too large';
        sendProfileRoleGenerationError(res, invalidJson ? 400 : 500, invalidJson ? 'invalid_request' : 'save_failed', message);
    }
}
