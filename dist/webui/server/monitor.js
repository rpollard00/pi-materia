import { sendJson } from './http.js';
const fallbackSnapshot = { ok: true, scope: 'session', service: 'pi-materia-webui' };
async function getMonitorSnapshot(deps) {
    return deps.getSnapshot ? await deps.getSnapshot() : fallbackSnapshot;
}
export async function handleMonitorSnapshotRoute(res, deps) {
    const snapshot = await getMonitorSnapshot(deps);
    sendJson(res, 200, snapshot);
}
export async function handleMonitorEventsRoute(req, res, deps) {
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
