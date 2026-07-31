import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

/**
 * Static file serving for the standalone central-admin browser shell.
 *
 * The central-admin UI is strictly same-origin with the central API (it calls
 * relative `/api/*` paths and discovers topology via `/api/backend-mode`), so
 * the central server serves the built client itself. This handler never
 * exposes local-session content: the shell entry point is always
 * `central-admin.html`, and only GET/HEAD requests outside `/api/*` reach it
 * (docs/enterprise-control-plane.md §2, §8).
 */

/** Entry document for the standalone operator UI. */
export const CENTRAL_ADMIN_SHELL = "central-admin.html";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** True when the request targets the static UI surface rather than the API. */
export function isCentralStaticRequest(req: IncomingMessage): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const pathname = new URL(req.url ?? "", "http://localhost").pathname;
  return pathname !== "/api" && !pathname.startsWith("/api/");
}

/**
 * Resolve a request path inside `staticDir`, or undefined on traversal. The
 * local-session WebUI entry (`index.html`) shares the build directory but is
 * never served here: the central server has no local session, so it always
 * maps to the central-admin shell instead (§2 invariants).
 */
function safeStaticPath(staticDir: string, url: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.split("?")[0] ?? "/");
  } catch {
    return undefined;
  }
  const shellPaths = new Set(["/", "/index.html", `/${CENTRAL_ADMIN_SHELL}`]);
  const candidate = normalize(shellPaths.has(decoded) ? `/${CENTRAL_ADMIN_SHELL}` : decoded);
  const resolved = resolve(join(staticDir, candidate));
  return resolved === staticDir || resolved.startsWith(`${staticDir}${sep}`) ? resolved : undefined;
}

/**
 * Serve the central-admin shell or a built asset. Unknown non-asset paths fall
 * back to the shell (single-page client convention). A missing client build is
 * a plain 404 hint; API behavior is unaffected.
 */
export function serveCentralStatic(req: IncomingMessage, res: ServerResponse, staticDir: string): void {
  const filePath = safeStaticPath(staticDir, req.url ?? "/");
  if (!filePath) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  const resolved = existsSync(filePath) && statSync(filePath).isFile()
    ? filePath
    : join(staticDir, CENTRAL_ADMIN_SHELL);
  if (!existsSync(resolved)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Materia central-admin UI build not found. Run `npm run build:webui`.");
    return;
  }

  res.writeHead(200, { "content-type": contentTypes[extname(resolved)] ?? "application/octet-stream" });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(resolved).pipe(res);
}
