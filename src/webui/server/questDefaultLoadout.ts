import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorMessage, isPlainObject, readJsonBody, sendJson } from './http.js';

export type MateriaSetQuestDefaultLoadoutFailureCode = 'invalid_name' | 'unknown_loadout' | 'unavailable';

export type MateriaSetQuestDefaultLoadoutResult =
  | {
    ok: true;
    questDefaultLoadoutId: string | null;
    message?: string;
  }
  | {
    ok: false;
    code: MateriaSetQuestDefaultLoadoutFailureCode;
    message: string;
    questDefaultLoadoutId?: string | null;
  };

export type MateriaSetQuestDefaultLoadoutCallback = (name: string | null) => Promise<MateriaSetQuestDefaultLoadoutResult>;

export interface QuestDefaultLoadoutRouteDeps {
  setQuestDefaultLoadout?: MateriaSetQuestDefaultLoadoutCallback;
}

function failureStatus(code: MateriaSetQuestDefaultLoadoutFailureCode): number {
  if (code === 'invalid_name') return 400;
  if (code === 'unknown_loadout') return 404;
  return 503;
}

function sendQuestDefaultLoadoutError(res: ServerResponse, status: number, code: string, message: string, extras: Record<string, unknown> = {}) {
  sendJson(res, status, { ok: false, error: { code, message }, ...extras });
}

export async function handleQuestDefaultLoadoutRoute(req: IncomingMessage, res: ServerResponse, deps: QuestDefaultLoadoutRouteDeps) {
  if (req.method !== 'POST') {
    sendQuestDefaultLoadoutError(res, 405, 'method_not_allowed', 'Use POST to set the quest default loadout.');
    return;
  }
  if (!deps.setQuestDefaultLoadout) {
    sendQuestDefaultLoadoutError(res, 503, 'unavailable', 'Quest default loadout API is unavailable for this server.');
    return;
  }
  try {
    const body = await readJsonBody(req);
    if (!isPlainObject(body) || !(typeof body.name === 'string' || body.name === null)) {
      sendQuestDefaultLoadoutError(res, 400, 'invalid_name', 'Expected JSON body with string or null field "name".');
      return;
    }
    const name = typeof body.name === 'string' ? body.name.trim() : null;
    if (body.name !== null && !name) {
      sendQuestDefaultLoadoutError(res, 400, 'invalid_name', 'Quest default loadout name cannot be empty.');
      return;
    }
    const result = await deps.setQuestDefaultLoadout(name);
    if (!result.ok) {
      sendQuestDefaultLoadoutError(res, failureStatus(result.code), result.code, result.message, {
        ...(result.questDefaultLoadoutId !== undefined ? { questDefaultLoadoutId: result.questDefaultLoadoutId } : {}),
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      questDefaultLoadoutId: result.questDefaultLoadoutId,
      message: result.message ?? (result.questDefaultLoadoutId ? `Quest default loadout set to ${result.questDefaultLoadoutId}.` : 'Quest default loadout cleared.'),
    });
  } catch (error) {
    const message = errorMessage(error);
    const invalidJson = message === 'Invalid JSON body' || message === 'Request body too large';
    sendQuestDefaultLoadoutError(res, invalidJson ? 400 : 500, invalidJson ? 'invalid_request' : 'quest_default_loadout_failed', message);
  }
}
