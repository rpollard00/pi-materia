import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  CentralHttpAbortError,
  CentralHttpConflictError,
  CentralHttpForbiddenError,
  CentralHttpNotFoundError,
  CentralHttpResponseValidationError,
  CentralHttpStatusError,
  CentralHttpTimeoutError,
  CentralHttpUnauthorizedError,
  DEFAULT_DEV_TOKEN_ADMIN,
  DEFAULT_DEV_TOKEN_READER,
  DEFAULT_DEV_TOKEN_SINK,
  createCentralHttpControlPlaneClient,
  createMateriaCentralServer,
  type MateriaCentralServer,
} from "../src/central/index.js";
import type { EnrichedEvent } from "../src/domain/eventing.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startCentralServer(): Promise<string> {
  const created: MateriaCentralServer = createMateriaCentralServer({ port: 0, authMode: "development" });
  await listen(created.server);
  servers.push(created.server);
  return serverBaseUrl(created.server);
}

async function startFakeServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<string> {
  const server = createServer((req, res) => void Promise.resolve(handler(req, res)));
  await listen(server);
  servers.push(server);
  return serverBaseUrl(server);
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function serverBaseUrl(server: ReturnType<typeof createServer>): string {
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("fake central server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function enrichedEvent(overrides: Partial<EnrichedEvent> = {}): EnrichedEvent {
  return {
    type: "status.progress",
    eventId: "event-1",
    occurredAt: "2026-07-18T00:00:00.000Z",
    sequence: 1,
    castId: "cast-1",
    socketId: "Socket-1",
    materia: "builder",
    visit: 1,
    severity: "info",
    ...overrides,
  };
}

function policy(id = "policy-input") {
  return {
    id,
    deny: [{ value: "forbidden/model" }],
    prefer: [{ value: "zai/glm-4.6" }],
    severity: "enforced" as const,
  };
}

describe("central HTTP control-plane client", () => {
  test("adapts catalog and model-policy reads/writes with optimistic conflicts", async () => {
    const apiUrl = await startCentralServer();
    const client = createCentralHttpControlPlaneClient({
      apiUrl,
      credentials: {
        readToken: DEFAULT_DEV_TOKEN_READER,
        adminToken: DEFAULT_DEV_TOKEN_ADMIN,
        telemetryToken: DEFAULT_DEV_TOKEN_SINK,
      },
      retryDelayMs: 0,
    });

    expect(client.catalog.mode()).toMatchObject({
      mode: "central-connected",
      hasLocalSession: true,
      hasCentral: true,
      centralApiBaseUrl: apiUrl,
    });

    const created = await client.admin.createCatalogItem({
      id: "build/one",
      kind: "materia",
      name: "Build One",
      content: { definition: { type: "agent" } },
    });
    expect(created.action).toBe("created");
    expect(created.summary.version).toBe("1");
    expect((await client.catalog.list({ kind: "materia", search: "Build" })).map((item) => item.id)).toEqual(["build/one"]);
    expect((await client.catalog.get("build/one", "materia"))?.content.definition).toEqual({ type: "agent" });
    expect((await client.catalog.head("build/one", "materia"))?.contentHash).toBe(created.summary.contentHash);
    expect(await client.catalog.get("missing", "materia")).toBeUndefined();

    await expect(client.admin.updateCatalogItem({
      id: "build/one",
      kind: "materia",
      name: "stale",
      expectedVersion: "99",
    })).rejects.toMatchObject({
      name: "CentralHttpConflictError",
      status: 409,
      code: "version_mismatch",
      currentVersion: "1",
    });

    const updated = await client.admin.updateCatalogItem({ id: "build/one", name: "Fresh", expectedVersion: "1" });
    expect(updated.summary).toMatchObject({ kind: "materia", name: "Fresh", version: "2" });

    const createdPolicy = await client.admin.createModelPolicy({
      id: "default",
      document: policy(),
      setActive: true,
    });
    expect(createdPolicy).toMatchObject({ action: "created", activePolicyId: "default" });
    expect((await client.modelPolicy.getActivePolicy())?.id).toBe("default");
    expect(await client.modelPolicy.getActivePolicyId()).toBe("default");
    expect((await client.modelPolicy.listPolicies()).map((entry) => entry.id)).toEqual(["default"]);
    expect((await client.modelPolicy.getPolicy("default"))?.deny).toEqual([{ value: "forbidden/model" }]);
    expect(await client.modelPolicy.getPolicy("missing")).toBeUndefined();
    expect(await client.modelPolicy.getModelCatalog()).toBeUndefined();

    await client.admin.updateModelPolicy({ id: "default", expectedVersion: "1", document: policy("replacement") });
    expect((await client.modelPolicy.getPolicy("default"))?.version).toBe("2");
    await client.admin.setActiveModelPolicy({ id: "default" });
    await client.admin.deleteModelPolicy({ id: "default", expectedVersion: "2" });

    await client.admin.deleteCatalogItem({ id: "build/one", expectedVersion: "2" });
    await expect(client.admin.deleteCatalogItem({ id: "build/one", kind: "materia" })).rejects.toBeInstanceOf(CentralHttpNotFoundError);
  });

  test("uses the telemetry credential for ingestion and reader credential for monitoring", async () => {
    const apiUrl = await startCentralServer();
    const client = createCentralHttpControlPlaneClient({
      apiUrl,
      readToken: DEFAULT_DEV_TOKEN_READER,
      adminToken: DEFAULT_DEV_TOKEN_ADMIN,
      telemetryToken: DEFAULT_DEV_TOKEN_SINK,
      retryDelayMs: 0,
    });

    const ingest = await client.telemetry.ingest({ events: [enrichedEvent()], runtimeId: "runtime-A" });
    expect(ingest.accepted).toBe(1);
    expect((await client.telemetry.status())).toMatchObject({ healthy: true, runtimeCount: 1, eventCount: 1 });
    expect((await client.telemetry.queryEvents({ runtimeId: "runtime-A", castId: "cast-1", limit: 1 }))[0]?.eventId).toBe("event-1");
  });

  test("maps authentication, permission, missing-resource, and conflict responses to typed failures", async () => {
    const apiUrl = await startCentralServer();
    const unauthenticated = createCentralHttpControlPlaneClient({ apiUrl, maxReadRetries: 0 });
    await expect(unauthenticated.catalog.list()).rejects.toBeInstanceOf(CentralHttpUnauthorizedError);

    const forbidden = createCentralHttpControlPlaneClient({
      apiUrl,
      readToken: DEFAULT_DEV_TOKEN_SINK,
      maxReadRetries: 0,
    });
    await expect(forbidden.catalog.list()).rejects.toBeInstanceOf(CentralHttpForbiddenError);

    const admin = createCentralHttpControlPlaneClient({
      apiUrl,
      readToken: DEFAULT_DEV_TOKEN_READER,
      adminToken: DEFAULT_DEV_TOKEN_ADMIN,
      maxReadRetries: 0,
    });
    await admin.admin.createCatalogItem({ id: "duplicate", kind: "loadout", content: { definition: {} } });
    await expect(admin.admin.createCatalogItem({
      id: "duplicate",
      kind: "loadout",
      content: { definition: {} },
    })).rejects.toBeInstanceOf(CentralHttpConflictError);

    const metadata = await admin.admin.getMetadata();
    expect(metadata.server).toMatchObject({
      service: "pi-materia-central",
      mode: "central-admin",
      authMethods: ["dev-token"],
    });
    expect(metadata.principals?.map((principal) => principal.principalId)).toEqual([
      "dev-admin",
      "dev-reader",
      "dev-sink",
    ]);
  });

  test("validates admin and DTO envelopes from a fake server and sends the reader bearer", async () => {
    let authorization: string | undefined;
    const apiUrl = await startFakeServer((req, res) => {
      authorization = req.headers.authorization;
      sendJson(res, 200, {
        ok: true,
        metadata: {
          server: {
            mode: "central-admin",
            authMethods: ["dev-token"],
            capabilities: { catalog: true, modelPolicy: true, telemetry: true, admin: true },
          },
          principals: [{ principalId: "reader", tenantId: "default", roleIds: ["central-reader"] }],
          roles: [{ roleId: "central-reader", permissions: ["catalog.read"] }],
        },
      });
    });
    const client = createCentralHttpControlPlaneClient({ apiUrl, readToken: "reader-secret", mode: "central-admin" });
    const metadata = await client.admin.getMetadata();
    expect(authorization).toBe("Bearer reader-secret");
    expect(metadata.server.mode).toBe("central-admin");
    expect(metadata.principals?.[0].principalId).toBe("reader");
    expect(client.admin.mode().hasLocalSession).toBe(false);
  });
});

describe("central HTTP transport reliability", () => {
  test("retries transient failures only for safe reads and keeps attempts bounded", async () => {
    let reads = 0;
    let writes = 0;
    const apiUrl = await startFakeServer((req, res) => {
      if (req.method === "GET") {
        reads++;
        if (reads < 3) {
          sendJson(res, 503, { ok: false, error: "temporarily unavailable" });
          return;
        }
        sendJson(res, 200, { ok: true, items: [] });
        return;
      }
      writes++;
      sendJson(res, 503, { ok: false, error: "write unavailable" });
    });
    const client = createCentralHttpControlPlaneClient({
      apiUrl,
      readToken: "reader",
      adminToken: "admin",
      maxReadRetries: 2,
      retryDelayMs: 0,
    });

    expect(await client.catalog.list()).toEqual([]);
    expect(reads).toBe(3);
    await expect(client.admin.createCatalogItem({
      id: "x",
      kind: "materia",
      content: { definition: {} },
    })).rejects.toBeInstanceOf(CentralHttpStatusError);
    expect(writes).toBe(1);
  });

  test("rejects malformed successful JSON envelopes", async () => {
    const apiUrl = await startFakeServer((_req, res) => sendJson(res, 200, { ok: true, items: "not-an-array" }));
    const client = createCentralHttpControlPlaneClient({ apiUrl, maxReadRetries: 0 });
    await expect(client.catalog.list()).rejects.toBeInstanceOf(CentralHttpResponseValidationError);
  });

  test("distinguishes request timeout from caller abort", async () => {
    const apiUrl = await startFakeServer((_req, res) => {
      setTimeout(() => sendJson(res, 200, { ok: true, items: [] }), 100);
    });

    const timed = createCentralHttpControlPlaneClient({ apiUrl, requestTimeoutMs: 10, maxReadRetries: 0 });
    await expect(timed.catalog.list()).rejects.toBeInstanceOf(CentralHttpTimeoutError);

    const controller = new AbortController();
    const aborted = createCentralHttpControlPlaneClient({
      apiUrl,
      requestTimeoutMs: 1_000,
      maxReadRetries: 0,
      signal: controller.signal,
    });
    const request = aborted.catalog.list();
    setTimeout(() => controller.abort(), 10);
    await expect(request).rejects.toBeInstanceOf(CentralHttpAbortError);
  });
});
