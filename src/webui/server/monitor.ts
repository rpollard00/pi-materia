import { sendJson } from './http.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MateriaWebUiSessionSnapshot } from './session.js';

export interface MateriaMonitorRouteDeps {
  getSnapshot?: () => MateriaWebUiSessionSnapshot | Promise<MateriaWebUiSessionSnapshot>;
}

const fallbackSnapshot = { ok: true, scope: 'session', service: 'pi-materia-webui' };

async function getMonitorSnapshot(deps: MateriaMonitorRouteDeps) {
  return deps.getSnapshot ? await deps.getSnapshot() : fallbackSnapshot;
}

export async function handleMonitorSnapshotRoute(res: ServerResponse, deps: MateriaMonitorRouteDeps) {
  const snapshot = await getMonitorSnapshot(deps);
  sendJson(res, 200, snapshot);
}

export async function handleMonitorEventsRoute(req: IncomingMessage, res: ServerResponse, deps: MateriaMonitorRouteDeps) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  const writeSnapshot = async () => {
    const snapshot = await getMonitorSnapshot(deps);
    res.write(`event: monitor\ndata: ${JSON.stringify(snapshot)}\n\n`);
  };
  await writeSnapshot();
  const interval = setInterval(() => { void writeSnapshot().catch(() => undefined); }, 1500);
  req.on('close', () => clearInterval(interval));
}
