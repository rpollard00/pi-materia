import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createMateriaWebUiServer,
  isCentralSameOrigin,
  resolveBackendMode,
  resolveCentralApiBaseUrl,
  resolveCentralOrigin,
  type BackendModeResponse,
} from "../src/webui/server/index.js";

type StartedServer = ReturnType<typeof createMateriaWebUiServer>["server"];
const servers: StartedServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startTestServer(mode?: { centralApiBaseUrl?: string; hasLocalSession?: boolean; label?: string }) {
  const staticDir = await mkdtemp(path.join(tmpdir(), "pi-materia-webui-mode-"));
  const created = createMateriaWebUiServer({
    staticDir,
    ...(mode !== undefined ? { mode } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    created.server.once("error", reject);
    created.server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push(created.server);
  const address = created.server.address();
  if (!address || typeof address !== "object") throw new Error("test server did not bind to a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

describe("resolveCentralApiBaseUrl", () => {
  test("accepts trimmed http(s) URLs and rejects everything else", () => {
    expect(resolveCentralApiBaseUrl(undefined)).toBeUndefined();
    expect(resolveCentralApiBaseUrl("   ")).toBeUndefined();
    expect(resolveCentralApiBaseUrl("not a url")).toBeUndefined();
    expect(resolveCentralApiBaseUrl("ftp://example.com")).toBeUndefined();
    expect(resolveCentralApiBaseUrl("example.com")).toBeUndefined();
    expect(resolveCentralApiBaseUrl("http://localhost:8080")).toBe("http://localhost:8080");
    expect(resolveCentralApiBaseUrl("  https://central.example.com/api  ")).toBe("https://central.example.com/api");
  });

  test("resolves the origin of a valid central url", () => {
    expect(resolveCentralOrigin("https://central.example.com/api")).toBe("https://central.example.com");
    expect(resolveCentralOrigin(undefined)).toBeUndefined();
    expect(resolveCentralOrigin("garbage")).toBeUndefined();
  });
});

describe("isCentralSameOrigin", () => {
  test("only matches when local and central share an origin", () => {
    expect(isCentralSameOrigin("https://central.example.com", undefined)).toBe(false);
    expect(isCentralSameOrigin("https://central.example.com", "http://localhost:3000")).toBe(false);
    expect(isCentralSameOrigin("http://localhost:8080", "http://localhost:3000")).toBe(false);
    expect(isCentralSameOrigin("http://localhost:3000/central", "http://localhost:3000")).toBe(true);
    expect(isCentralSameOrigin(undefined, "http://localhost:3000")).toBe(false);
    expect(isCentralSameOrigin("garbage", "http://localhost:3000")).toBe(false);
  });
});

describe("resolveBackendMode", () => {
  test("defaults to local-only with a same-origin local session and no central", () => {
    const response = resolveBackendMode();
    expect(response).toEqual({
      ok: true,
      scope: "session",
      service: "pi-materia-webui",
      mode: "local-only",
      hasLocalSession: true,
      hasCentral: false,
      capabilities: { catalog: false, modelPolicy: false, telemetry: false, admin: false },
      endpoints: {
        local: { available: true, sameOrigin: true, baseUrl: "" },
        central: { available: false, sameOrigin: false },
      },
    } satisfies BackendModeResponse);
  });

  test("reports central-connected mode with capabilities when a central url is configured", () => {
    const response = resolveBackendMode({ centralApiBaseUrl: "https://central.example.com" });
    expect(response.mode).toBe("central-connected");
    expect(response.hasCentral).toBe(true);
    expect(response.hasLocalSession).toBe(true);
    expect(response.centralApiBaseUrl).toBe("https://central.example.com");
    expect(response.capabilities).toEqual({ catalog: true, modelPolicy: true, telemetry: true, admin: true });
    expect(response.endpoints.local).toEqual({ available: true, sameOrigin: true, baseUrl: "" });
    expect(response.endpoints.central).toEqual({ available: true, sameOrigin: false, baseUrl: "https://central.example.com" });
  });

  test("ignores invalid central urls and stays local-only", () => {
    const response = resolveBackendMode({ centralApiBaseUrl: "ftp://nope" });
    expect(response.mode).toBe("local-only");
    expect(response.hasCentral).toBe(false);
    expect(response.centralApiBaseUrl).toBeUndefined();
    expect(response.capabilities.catalog).toBe(false);
  });

  test("reports central-admin topology when no local session is attached", () => {
    const response = resolveBackendMode({ hasLocalSession: false, centralApiBaseUrl: "https://central.example.com" });
    expect(response.mode).toBe("central-admin");
    expect(response.hasLocalSession).toBe(false);
    expect(response.endpoints.local.available).toBe(false);
  });

  test("surfaces a local-origin same-origin hint and an optional label", () => {
    const response = resolveBackendMode({
      centralApiBaseUrl: "http://localhost:3000/central",
      localOrigin: "http://localhost:3000",
      label: "test-build",
    });
    expect(response.endpoints.central.sameOrigin).toBe(true);
    expect(response.label).toBe("test-build");
  });
});

describe("GET /api/backend-mode", () => {
  test("defaults to local-only when no mode is configured", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/backend-mode`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as BackendModeResponse;
    expect(body).toMatchObject({ ok: true, scope: "session", service: "pi-materia-webui", mode: "local-only", hasLocalSession: true, hasCentral: false });
    expect(body.capabilities).toEqual({ catalog: false, modelPolicy: false, telemetry: false, admin: false });
  });

  test("reports central-connected capabilities when a central url is configured", async () => {
    const baseUrl = await startTestServer({ centralApiBaseUrl: "https://central.example.com", label: "ci" });
    const response = await fetch(`${baseUrl}/api/backend-mode`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as BackendModeResponse;
    expect(body).toMatchObject({
      mode: "central-connected",
      hasCentral: true,
      hasLocalSession: true,
      centralApiBaseUrl: "https://central.example.com",
      label: "ci",
    });
    expect(body.capabilities).toEqual({ catalog: true, modelPolicy: true, telemetry: true, admin: true });
    expect(body.endpoints?.local).toEqual({ available: true, sameOrigin: true, baseUrl: "" });
    expect(body.endpoints?.central).toEqual({ available: true, sameOrigin: false, baseUrl: "https://central.example.com" });
  });

  test("rejects non-GET methods with 405", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/backend-mode`, { method: "POST" });
    expect(response.status).toBe(405);
  });

  test("does not collide with /api/models", async () => {
    // Route prefix is /api/backend-mode (not /api/mode) precisely so it cannot
    // shadow /api/models under startsWith dispatching.
    const baseUrl = await startTestServer();
    const modeResponse = await fetch(`${baseUrl}/api/backend-mode`);
    expect(modeResponse.status).toBe(200);
    const modelsResponse = await fetch(`${baseUrl}/api/models`);
    expect(modelsResponse.status).toBe(200);
    const modelsBody = await modelsResponse.json();
    expect(modelsBody).toMatchObject({ ok: true, models: [] });
  });
});
