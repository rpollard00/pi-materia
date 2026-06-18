import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleMateriaWebUiRequest } from './routes.js';
// Compatibility facade: consumers and tests import public WebUI server helpers
// from this entry point while route/service implementations live in focused
// backend modules next to it.
export { buildMateriaModelCatalog } from './modelCatalog.js';
export { DEFAULT_RUNTIME_EVENT_LIMIT, RUNTIME_EVENTS_RELATIVE_PATH, readRuntimeEvents } from './runtimeEventReader.js';
const defaultStaticDir = resolve(fileURLToPath(new URL('../../../dist/webui/client', import.meta.url)));
export function createMateriaWebUiServer(options = {}) {
    const host = options.host ?? '127.0.0.1';
    const port = options.port ?? 0;
    const staticDir = resolve(options.staticDir ?? defaultStaticDir);
    const server = createServer(async (req, res) => {
        await handleMateriaWebUiRequest(req, res, { staticDir, session: options.session });
    });
    return { server, host, port, staticDir };
}
if (import.meta.url === `file://${process.argv[1]}`) {
    const port = Number.parseInt(process.env.MATERIA_WEBUI_PORT ?? '0', 10);
    const { server, host, staticDir } = createMateriaWebUiServer({ port: Number.isFinite(port) ? port : 0 });
    server.listen(port, host, () => {
        const address = server.address();
        const actualPort = typeof address === 'object' && address ? address.port : port;
        console.log(`Materia WebUI listening at http://${host}:${actualPort} (static: ${staticDir})`);
    });
}
