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

  let aborted = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  const teardown = () => {
    aborted = true;
    if (interval !== undefined) {
      clearInterval(interval);
      interval = undefined;
    }
  };
  req.on('close', teardown);
  req.on('error', teardown);
  res.on('close', teardown);

  const writeSnapshot = async () => {
    if (aborted) return;
    try {
      const snapshot = await getMonitorSnapshot(deps);
      if (!aborted) res.write(`event: monitor\ndata: ${JSON.stringify(snapshot)}\n\n`);
    } catch {
      // Swallow snapshot/write failures so the interval stays alive;
      // the client will fall back to polling on its own.
    }
  };

  try {
    await writeSnapshot();
  } catch {
    // Initial write failed; client will fall back to polling.
  }

  if (!aborted) {
    interval = setInterval(() => { void writeSnapshot(); }, 1500);
  }
}
