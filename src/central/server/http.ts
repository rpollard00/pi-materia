import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Central server HTTP helpers.
 *
 * These mirror the established local-session WebUI server helper style
 * (src/webui/server/http.ts) deliberately, so central route handlers read the
 * same as local ones, but they are owned by the central module so the central
 * server has no import-time dependency on the local session WebUI server
 * (docs/enterprise-control-plane.md §4, §8 — central routes live on the
 * separate central server and must not be mixed into the local session
 * dispatcher).
 */

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  applyCentralCorsHeaders(res);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolveBody(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ───────────────────────────────────────────────────────────────────────
// CORS (docs/enterprise-control-plane.md §11)
// ───────────────────────────────────────────────────────────────────────

/**
 * Resolved CORS allow-origin value for the central server.
 *
 * The central control plane is read cross-origin by the WebUI (the UI is served
 * by the local session server while the central API lives elsewhere by
 * default), so the read surface must answer browser preflight and carry
 * `Access-Control-Allow-*` headers. The value is dev-friendly by default
 * (`*`) and overridable via `MATERIA_CENTRAL_CORS_ORIGIN` for non-local
 * deployments. This is a transport concern only; it does not weaken the RBAC
 * guards on central routes.
 */
export const CENTRAL_CORS_ALLOW_ORIGIN = (process.env.MATERIA_CENTRAL_CORS_ORIGIN ?? "*").trim() || "*";

const CENTRAL_CORS_ALLOW_HEADERS = "authorization, content-type";
const CENTRAL_CORS_ALLOW_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";

/** Write the central CORS response headers. Idempotent and side-effect free beyond headers. */
export function applyCentralCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", CENTRAL_CORS_ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", CENTRAL_CORS_ALLOW_HEADERS);
  res.setHeader("Access-Control-Allow-Methods", CENTRAL_CORS_ALLOW_METHODS);
  res.setHeader("Access-Control-Max-Age", "600");
}

/**
 * Handle a CORS preflight (`OPTIONS`) request. Returns `true` when the request
 * was a preflight that has been answered (and the caller should stop
 * processing); `false` otherwise. Answers `204 No Content` with CORS headers.
 */
export function handleCentralCorsPreflight(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== "OPTIONS") return false;
  applyCentralCorsHeaders(res);
  res.writeHead(204);
  res.end();
  return true;
}
