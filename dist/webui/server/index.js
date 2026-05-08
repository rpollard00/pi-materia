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
const MAX_ROLE_BRIEF_CHARS = 4_000;
function validateMateriaRoleBrief(brief) {
    if (typeof brief !== 'string')
        return { ok: false, code: 'invalid_brief', error: 'Expected brief to be a string.' };
    const trimmed = brief.trim();
    if (!trimmed)
        return { ok: false, code: 'invalid_brief', error: 'Role brief cannot be empty.' };
    if (trimmed.length > MAX_ROLE_BRIEF_CHARS)
        return { ok: false, code: 'invalid_brief', error: `Role brief is too long; limit is ${MAX_ROLE_BRIEF_CHARS} characters.` };
    return { ok: true, brief: trimmed };
}
function roleGenerationStatus(result) {
    if (result.code === 'invalid_brief')
        return 400;
    if (result.code === 'disabled')
        return 403;
    return 500;
}
function validateMateriaGeneratorConfig(value) {
    if (value === undefined)
        return undefined;
    if (value === null)
        return null;
    if (!isPlainObject(value))
        throw new Error('Expected generates to be an object or null.');
    const output = trimmedRequired(value.output, 'generates.output');
    const itemType = trimmedRequired(value.itemType, 'generates.itemType');
    if (value.listType !== 'array')
        throw new Error('Expected generates.listType to be "array".');
    return {
        output,
        items: optionalTrimmed(value.items, 'generates.items'),
        listType: 'array',
        itemType,
        as: optionalTrimmed(value.as, 'generates.as'),
        cursor: optionalTrimmed(value.cursor, 'generates.cursor'),
        done: optionalTrimmed(value.done, 'generates.done'),
    };
}
function trimmedRequired(value, field) {
    if (typeof value !== 'string' || !value.trim())
        throw new Error(`Expected ${field} to be a non-empty string.`);
    return value.trim();
}
function optionalTrimmed(value, field) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string' || !value.trim())
        throw new Error(`Expected ${field} to be a non-empty string when configured.`);
    return value.trim();
}
function sendRoleGenerationError(res, status, code, message) {
    sendJson(res, status, { ok: false, error: { code, message } });
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
        if (req.url?.startsWith('/api/generate/materia-role')) {
            if (req.method !== 'POST') {
                sendRoleGenerationError(res, 405, 'method_not_allowed', 'Use POST to generate a Materia role prompt.');
                return;
            }
            if (!options.session?.generateMateriaRole) {
                sendRoleGenerationError(res, 503, 'unavailable', 'Materia role generation API is unavailable for this server.');
                return;
            }
            try {
                const body = await readJsonBody(req);
                if (!isPlainObject(body) || !('brief' in body)) {
                    sendRoleGenerationError(res, 400, 'invalid_request', 'Expected JSON body with string field "brief".');
                    return;
                }
                const validation = validateMateriaRoleBrief(body.brief);
                if (!validation.ok) {
                    sendRoleGenerationError(res, 400, validation.code, validation.error);
                    return;
                }
                let generates;
                try {
                    generates = validateMateriaGeneratorConfig(body.generates);
                }
                catch (error) {
                    sendRoleGenerationError(res, 400, 'invalid_request', error instanceof Error ? error.message : String(error));
                    return;
                }
                const result = await options.session.generateMateriaRole({ brief: validation.brief, generates });
                if (!result.ok) {
                    sendRoleGenerationError(res, roleGenerationStatus(result), result.code, result.error);
                    return;
                }
                sendJson(res, 200, {
                    ok: true,
                    prompt: result.prompt,
                    model: result.model,
                    provider: result.provider,
                    api: result.api,
                    thinking: result.thinking,
                    isolated: result.isolated,
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const invalidJson = message === 'Invalid JSON body' || message === 'Request body too large';
                sendRoleGenerationError(res, invalidJson ? 400 : 500, invalidJson ? 'invalid_request' : 'generation_failed', message);
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
