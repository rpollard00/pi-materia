import { sendJson } from './http.js';
export function handleHealthRoute(res, deps) {
    sendJson(res, 200, { ok: true, scope: 'session', service: 'pi-materia-webui', sessionKey: deps.sessionKey });
}
