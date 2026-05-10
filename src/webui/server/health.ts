import { sendJson } from './http.js';
import type { ServerResponse } from 'node:http';

export interface MateriaHealthRouteDeps {
  sessionKey?: string;
}

export function handleHealthRoute(res: ServerResponse, deps: MateriaHealthRouteDeps) {
  sendJson(res, 200, { ok: true, scope: 'session', service: 'pi-materia-webui', sessionKey: deps.sessionKey });
}
