import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorMessage, isPlainObject, readJsonBody, sendJson } from './http.js';

export interface MateriaRoleGenerationPreference {
  model: string | null;
}

export type MateriaGetRoleGenerationPreferenceCallback = () => Promise<MateriaRoleGenerationPreference>;
export type MateriaSetRoleGenerationPreferenceCallback = (model: string | null) => Promise<MateriaRoleGenerationPreference>;

export interface ProfileRoleGenerationRouteDeps {
  getRoleGenerationPreference?: MateriaGetRoleGenerationPreferenceCallback;
  setRoleGenerationPreference?: MateriaSetRoleGenerationPreferenceCallback;
}

function sendProfileRoleGenerationError(res: ServerResponse, status: number, code: string, message: string) {
  sendJson(res, status, { ok: false, error: { code, message } });
}

function normalizeRoleGenerationModelPreference(model: string | null | undefined): string | null {
  const trimmed = typeof model === 'string' ? model.trim() : null;
  return trimmed || null;
}

function isProviderQualifiedModelId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function parseModelPayload(body: unknown): { ok: true; model: string | null } | { ok: false; message: string } {
  if (!isPlainObject(body) || !("model" in body)) return { ok: false, message: 'Expected JSON body with string or null field "model".' };
  if (!(typeof body.model === 'string' || body.model === null)) return { ok: false, message: 'Expected JSON body with string or null field "model".' };
  const model = normalizeRoleGenerationModelPreference(body.model);
  if (model && !isProviderQualifiedModelId(model)) return { ok: false, message: 'Invalid role-generation model. Expected a provider-qualified model id such as "provider/model".' };
  return { ok: true, model };
}

export async function handleProfileRoleGenerationRoute(req: IncomingMessage, res: ServerResponse, deps: ProfileRoleGenerationRouteDeps) {
  if (req.method === 'GET') {
    if (!deps.getRoleGenerationPreference) {
      sendProfileRoleGenerationError(res, 503, 'unavailable', 'Role-generation profile API is unavailable for this server.');
      return;
    }
    try {
      const preference = await deps.getRoleGenerationPreference();
      sendJson(res, 200, { ok: true, model: normalizeRoleGenerationModelPreference(preference.model) });
    } catch (error) {
      sendProfileRoleGenerationError(res, 500, 'read_failed', errorMessage(error));
    }
    return;
  }

  if (req.method !== 'PATCH' && req.method !== 'POST') {
    sendProfileRoleGenerationError(res, 405, 'method_not_allowed', 'Use GET to read or PATCH to update role-generation profile preferences.');
    return;
  }
  if (!deps.setRoleGenerationPreference) {
    sendProfileRoleGenerationError(res, 503, 'unavailable', 'Role-generation profile API is unavailable for this server.');
    return;
  }

  try {
    const parsed = parseModelPayload(await readJsonBody(req));
    if (!parsed.ok) {
      sendProfileRoleGenerationError(res, 400, 'invalid_model', parsed.message);
      return;
    }
    const preference = await deps.setRoleGenerationPreference(parsed.model);
    sendJson(res, 200, { ok: true, model: normalizeRoleGenerationModelPreference(preference.model) });
  } catch (error) {
    const message = errorMessage(error);
    const invalidJson = message === 'Invalid JSON body' || message === 'Request body too large';
    sendProfileRoleGenerationError(res, invalidJson ? 400 : 500, invalidJson ? 'invalid_request' : 'save_failed', message);
  }
}
