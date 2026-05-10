import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorMessage, isPlainObject, readJsonBody, sendJson } from './http.js';

export type MateriaSetActiveLoadoutFailureCode = 'invalid_name' | 'unknown_loadout' | 'active_cast_conflict' | 'unavailable';

export type MateriaSetActiveLoadoutResult =
  | {
    ok: true;
    /** Canonical persisted active loadout name after the backend/session authority has applied the change. */
    activeLoadout: string;
    /** Optional freshly reloaded config/state for deterministic WebUI refreshes. */
    config?: unknown;
    message?: string;
  }
  | {
    ok: false;
    code: MateriaSetActiveLoadoutFailureCode;
    /** User-displayable failure message. */
    message: string;
    /** Current canonical active loadout name when known. */
    activeLoadout?: string;
    /** Optional freshly reloaded config/state for deterministic WebUI refreshes. */
    config?: unknown;
  };

export type MateriaSetActiveLoadoutCallback = (name: string) => Promise<MateriaSetActiveLoadoutResult>;

export interface ActiveLoadoutRouteDeps {
  setActiveLoadout?: MateriaSetActiveLoadoutCallback;
}

function activeLoadoutFailureStatus(code: MateriaSetActiveLoadoutFailureCode): number {
  if (code === 'invalid_name') return 400;
  if (code === 'unknown_loadout') return 404;
  if (code === 'active_cast_conflict') return 409;
  return 503;
}

function sendActiveLoadoutError(res: ServerResponse, status: number, code: string, message: string, extras: Record<string, unknown> = {}) {
  sendJson(res, status, { ok: false, error: { code, message }, ...extras });
}

export async function handleActiveLoadoutRoute(req: IncomingMessage, res: ServerResponse, deps: ActiveLoadoutRouteDeps) {
  if (req.method !== 'POST') {
    sendActiveLoadoutError(res, 405, 'method_not_allowed', 'Use POST to set the active loadout.');
    return;
  }
  if (!deps.setActiveLoadout) {
    sendActiveLoadoutError(res, 503, 'unavailable', 'Active loadout API is unavailable for this server.');
    return;
  }
  try {
    const body = await readJsonBody(req);
    if (!isPlainObject(body) || typeof body.name !== 'string' || !body.name.trim()) {
      sendActiveLoadoutError(res, 400, 'invalid_name', 'Expected JSON body with non-empty string field "name".');
      return;
    }
    const result = await deps.setActiveLoadout(body.name.trim());
    if (!result.ok) {
      sendActiveLoadoutError(res, activeLoadoutFailureStatus(result.code), result.code, result.message, {
        ...(result.activeLoadout ? { activeLoadout: result.activeLoadout } : {}),
        ...(result.config !== undefined ? { config: result.config } : {}),
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      activeLoadout: result.activeLoadout,
      ...(result.config !== undefined ? { config: result.config } : {}),
      message: result.message ?? `Active loadout changed to ${result.activeLoadout}.`,
    });
  } catch (error) {
    const message = errorMessage(error);
    const invalidJson = message === 'Invalid JSON body' || message === 'Request body too large';
    sendActiveLoadoutError(res, invalidJson ? 400 : 500, invalidJson ? 'invalid_request' : 'active_loadout_failed', message);
  }
}
