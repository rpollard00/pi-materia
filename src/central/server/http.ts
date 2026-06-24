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
