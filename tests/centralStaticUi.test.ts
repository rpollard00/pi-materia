import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CENTRAL_CONTROL_PLANE_SCOPE,
  CENTRAL_SERVICE_ID,
  createMateriaCentralServer,
  type MateriaCentralServer,
} from "../src/central/index.js";

/**
 * Static central-admin UI serving from the central server. The browser shell
 * is same-origin with the central API, so the standalone server serves the
 * built client for GET/HEAD requests outside `/api/*` without changing any
 * API route behavior (docs/enterprise-control-plane.md §2, §8).
 */

const servers: Array<MateriaCentralServer["server"]> = [];

let staticDir: string;

beforeEach(() => {
  staticDir = mkdtempSync(join(tmpdir(), "pi-materia-central-static-"));
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  rmSync(staticDir, { recursive: true, force: true });
});

function writeClientBuild(dir: string): void {
  writeFileSync(join(dir, "central-admin.html"), "<!doctype html><title>central admin</title>");
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>local webui</title>");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", "central-admin.js"), "console.log('central-admin');");
}

async function startTestServer(options: { staticDir?: string } = {}): Promise<string> {
  const created = createMateriaCentralServer({
    port: 0,
    authMode: "development",
    ...(options.staticDir !== undefined ? { staticDir: options.staticDir } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    created.server.once("error", reject);
    created.server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push(created.server);
  const address = created.server.address();
  if (!address || typeof address !== "object") throw new Error("central test server did not bind to a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

describe("central server — central-admin static UI", () => {
  test("serves the central-admin shell at /", async () => {
    writeClientBuild(staticDir);
    const baseUrl = await startTestServer({ staticDir });
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("central admin");
  });

  test("serves the shell for client-side routes and the explicit html path", async () => {
    writeClientBuild(staticDir);
    const baseUrl = await startTestServer({ staticDir });
    for (const path of ["/central-admin", "/central-admin.html", "/catalog/items"]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("central admin");
    }
  });

  test("serves built assets with their content types", async () => {
    writeClientBuild(staticDir);
    const baseUrl = await startTestServer({ staticDir });
    const response = await fetch(`${baseUrl}/assets/central-admin.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(await response.text()).toContain("console.log");
  });

  test("supports HEAD requests without a body", async () => {
    writeClientBuild(staticDir);
    const baseUrl = await startTestServer({ staticDir });
    const response = await fetch(`${baseUrl}/`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe("");
  });

  test("contains path traversal inside the static directory", async () => {
    writeClientBuild(staticDir);
    // A marker outside the served directory must never be reachable.
    const outsideDir = mkdtempSync(join(tmpdir(), "pi-materia-central-outside-"));
    writeFileSync(join(outsideDir, "secret.txt"), "outside-secret-content");
    try {
      const baseUrl = await startTestServer({ staticDir });
      for (const path of [
        `/%2e%2e/${outsideDir.split("/").pop()}/secret.txt`,
        "/%2e%2e/%2e%2e/etc/passwd",
      ]) {
        const response = await fetch(`${baseUrl}${path}`);
        const body = await response.text();
        expect(body).not.toContain("outside-secret-content");
        expect(body).not.toContain("root:");
        // Traversal collapses into the sandbox and falls back to the shell.
        expect(response.status).toBe(200);
        expect(body).toContain("central admin");
      }
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("returns a build hint when the client build is missing", async () => {
    const baseUrl = await startTestServer({ staticDir });
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("npm run build:webui");
  });

  test("API routes keep their JSON behavior and are not shadowed by statics", async () => {
    writeClientBuild(staticDir);
    const baseUrl = await startTestServer({ staticDir });

    const health = await fetch(`${baseUrl}/api/health`);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as { ok: boolean; service: string };
    expect(healthBody.ok).toBe(true);
    expect(healthBody.service).toBe(CENTRAL_SERVICE_ID);

    // Local-session routes stay absent (404 JSON envelope, not the UI shell).
    const session = await fetch(`${baseUrl}/api/session`);
    expect(session.status).toBe(404);
    const sessionBody = (await session.json()) as { ok: boolean; scope: string; error: string };
    expect(sessionBody.ok).toBe(false);
    expect(sessionBody.scope).toBe(CENTRAL_CONTROL_PLANE_SCOPE);
    expect(sessionBody.error).toBe("Not found");
  });

  test("non-GET requests outside the API keep the JSON 404 envelope", async () => {
    writeClientBuild(staticDir);
    const baseUrl = await startTestServer({ staticDir });
    const response = await fetch(`${baseUrl}/central-admin`, { method: "POST" });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { ok: boolean; scope: string; error: string };
    expect(body.ok).toBe(false);
    expect(body.scope).toBe(CENTRAL_CONTROL_PLANE_SCOPE);
    expect(body.error).toBe("Not found");
  });

  test("never serves the local-session WebUI entry point", async () => {
    writeClientBuild(staticDir);
    const baseUrl = await startTestServer({ staticDir });
    // index.html exists in the build directory (it is the local WebUI shell),
    // but the central server must only expose the central-admin shell.
    const response = await fetch(`${baseUrl}/index.html`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("central admin");
  });
});
