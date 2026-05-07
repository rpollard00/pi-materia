import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const defaultStaticDir = resolve(fileURLToPath(new URL('../../../dist/webui/client', import.meta.url)));
const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
};
function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}
function safeStaticPath(staticDir, urlPath = '/') {
    const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
    const candidate = normalize(decoded === '/' ? '/index.html' : decoded);
    const resolved = resolve(join(staticDir, candidate));
    return resolved.startsWith(staticDir) ? resolved : undefined;
}
function readJsonBody(req) {
    return new Promise((resolveBody, reject) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 2_000_000) {
                req.destroy();
                reject(new Error('Request body too large'));
            }
        });
        req.on('end', () => {
            try {
                resolveBody(body ? JSON.parse(body) : {});
            }
            catch {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function serveStatic(req, res, staticDir) {
    const filePath = safeStaticPath(staticDir, req.url);
    if (!filePath) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }
    const resolved = existsSync(filePath) && statSync(filePath).isFile() ? filePath : join(staticDir, 'index.html');
    if (!existsSync(resolved)) {
        res.writeHead(404);
        res.end('Materia WebUI client build not found. Run `npm run build:webui`.');
        return;
    }
    res.writeHead(200, { 'content-type': contentTypes[extname(resolved)] ?? 'application/octet-stream' });
    createReadStream(resolved).pipe(res);
}
export function createMateriaWebUiServer(options = {}) {
    const host = options.host ?? '127.0.0.1';
    const port = options.port ?? 0;
    const staticDir = resolve(options.staticDir ?? defaultStaticDir);
    const server = createServer(async (req, res) => {
        if (req.url?.startsWith('/api/health')) {
            sendJson(res, 200, { ok: true, scope: 'session', service: 'pi-materia-webui', sessionKey: options.session?.key });
            return;
        }
        if (req.url?.startsWith('/api/monitor/events')) {
            res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache, no-transform',
                connection: 'keep-alive',
            });
            const writeSnapshot = async () => {
                const snapshot = options.session?.getSnapshot ? await options.session.getSnapshot() : { ok: true, scope: 'session', service: 'pi-materia-webui' };
                res.write(`event: monitor\ndata: ${JSON.stringify(snapshot)}\n\n`);
            };
            await writeSnapshot();
            const interval = setInterval(() => { void writeSnapshot().catch(() => undefined); }, 1500);
            req.on('close', () => clearInterval(interval));
            return;
        }
        if (req.url?.startsWith('/api/session') || req.url?.startsWith('/api/monitor')) {
            const snapshot = options.session?.getSnapshot ? await options.session.getSnapshot() : { ok: true, scope: 'session', service: 'pi-materia-webui' };
            sendJson(res, 200, snapshot);
            return;
        }
        if (req.url?.startsWith('/api/config') && req.method === 'GET') {
            if (!options.session?.getConfig) {
                sendJson(res, 503, { ok: false, error: 'Config API is unavailable for this server.' });
                return;
            }
            try {
                const loaded = await options.session.getConfig();
                sendJson(res, 200, isPlainObject(loaded) ? { ok: true, ...loaded } : { ok: true, config: loaded });
            }
            catch (error) {
                sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
            return;
        }
        if (req.url?.startsWith('/api/config') && req.method === 'POST') {
            if (!options.session?.saveConfig) {
                sendJson(res, 503, { ok: false, error: 'Config save API is unavailable for this server.' });
                return;
            }
            try {
                const body = await readJsonBody(req);
                if (!isPlainObject(body) || !isPlainObject(body.config))
                    throw new Error('Expected JSON body with object field "config".');
                const target = typeof body.target === 'string' ? body.target : 'user';
                if (!['user', 'project', 'explicit'].includes(target))
                    throw new Error('Invalid save target. Expected user, project, or explicit.');
                const written = await options.session.saveConfig(body.config, target);
                sendJson(res, 200, { ok: true, target, written });
            }
            catch (error) {
                sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
            return;
        }
        serveStatic(req, res, staticDir);
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
