import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function safeStaticPath(staticDir: string, urlPath = '/') {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const candidate = normalize(decoded === '/' ? '/index.html' : decoded);
  const resolved = resolve(join(staticDir, candidate));
  return resolved.startsWith(staticDir) ? resolved : undefined;
}

export function serveStatic(req: IncomingMessage, res: ServerResponse, staticDir: string) {
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
