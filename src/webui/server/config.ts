import { errorMessage, isPlainObject, readJsonBody, sendJson } from './http.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type MateriaSaveTarget = 'user' | 'project' | 'explicit';
export type MateriaConfigPatch = Record<string, unknown>;

export interface MateriaConfigRouteDeps {
  getConfig?: () => Promise<unknown>;
  saveConfig?: (patch: MateriaConfigPatch, target: MateriaSaveTarget) => Promise<string>;
}

export async function handleGetConfigRoute(res: ServerResponse, deps: MateriaConfigRouteDeps) {
  if (!deps.getConfig) {
    sendJson(res, 503, { ok: false, error: 'Config API is unavailable for this server.' });
    return;
  }
  try {
    const loaded = await deps.getConfig();
    sendJson(res, 200, isPlainObject(loaded) ? { ok: true, ...loaded } : { ok: true, config: loaded });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: errorMessage(error) });
  }
}

export async function handlePostConfigRoute(req: IncomingMessage, res: ServerResponse, deps: MateriaConfigRouteDeps) {
  if (!deps.saveConfig) {
    sendJson(res, 503, { ok: false, error: 'Config save API is unavailable for this server.' });
    return;
  }
  try {
    const body = await readJsonBody(req);
    if (!isPlainObject(body) || !isPlainObject(body.config)) throw new Error('Expected JSON body with object field "config".');
    const target = typeof body.target === 'string' ? body.target : 'user';
    if (!['user', 'project', 'explicit'].includes(target)) throw new Error('Invalid save target. Expected user, project, or explicit.');
    rejectLegacyWebUiNodes(body.config);
    const written = await deps.saveConfig(body.config, target as MateriaSaveTarget);
    sendJson(res, 200, { ok: true, target, written });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: errorMessage(error) });
  }
}

function rejectLegacyWebUiNodes(config: unknown): void {
  if (!isPlainObject(config) || !isPlainObject(config.loadouts)) return;
  for (const loadout of Object.values(config.loadouts)) {
    if (loadout === null || !isPlainObject(loadout)) continue;
    if ('nodes' in loadout) throw new Error('Legacy WebUI loadout nodes are not supported; use sockets instead.');
    if (!isPlainObject(loadout.loops)) continue;
    for (const loop of Object.values(loadout.loops)) {
      if (isPlainObject(loop) && 'nodes' in loop) throw new Error('Legacy WebUI loop nodes are not supported; use sockets instead.');
    }
  }
}
