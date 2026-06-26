import { afterEach, describe, expect, test } from "bun:test";
import {
  CENTRAL_CONTROL_PLANE_SCOPE,
  CENTRAL_SERVICE_ID,
  DEFAULT_DEV_TOKEN_ADMIN,
  createInMemoryCentralPorts,
  createMateriaCentralServer,
  type MateriaCentralServer,
} from "../src/central/index.js";
import type { ControlPlanePorts, TelemetryIngestInput } from "../src/application/index.js";
import type { EnrichedEvent } from "../src/domain/eventing.js";

const servers: Array<MateriaCentralServer["server"]> = [];

/** Reader token grants telemetry.read (and the other read perms); used for status reads. */
const READER_AUTH = { Authorization: `Bearer ${DEFAULT_DEV_TOKEN_ADMIN}` };

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startTestServer(options: { label?: string; ports?: ControlPlanePorts } = {}): Promise<string> {
  const created = createMateriaCentralServer({ port: 0, ...(options.label !== undefined ? { label: options.label } : {}), ...(options.ports ? { ports: options.ports } : {}) });
  await new Promise<void>((resolve, reject) => {
    created.server.once("error", reject);
    created.server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push(created.server);
  const address = created.server.address();
  if (!address || typeof address !== "object") throw new Error("central test server did not bind to a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

function enrichedEvent(overrides: Partial<EnrichedEvent> = {}): EnrichedEvent {
  return {
    type: "status.progress",
    eventId: "evt-1",
    occurredAt: "2026-06-24T00:00:00.000Z",
    sequence: 1,
    castId: "cast-1",
    socketId: "Socket-1",
    materia: "builder",
    visit: 1,
    ...overrides,
  };
}

describe("central server skeleton — in-memory control-plane ports", () => {
  test("reports central-admin topology with all central capabilities", () => {
    const ports = createInMemoryCentralPorts({ label: "dev" });
    const mode = ports.telemetry.mode();
    expect(mode.mode).toBe("central-admin");
    expect(mode.hasCentral).toBe(true);
    expect(mode.hasLocalSession).toBe(false);
    expect(mode.capabilities).toEqual({ catalog: true, modelPolicy: true, telemetry: true, admin: true });
    expect(mode.label).toBe("dev");
    expect(ports.catalog.mode().mode).toBe("central-admin");
    expect(ports.modelPolicy.mode().mode).toBe("central-admin");
    expect(ports.admin.mode().mode).toBe("central-admin");
  });

  test("status snapshot starts empty and reflects ingestion counts", async () => {
    const ports = createInMemoryCentralPorts();
    const before = await ports.telemetry.status();
    expect(before.mode).toBe("central-admin");
    expect(before.eventCount).toBe(0);
    expect(before.runtimeCount).toBe(0);
    expect(before.healthy).toBe(true);

    const input: TelemetryIngestInput = {
      runtimeId: "rt-A",
      events: [enrichedEvent({ eventId: "e1", sequence: 1 }), enrichedEvent({ eventId: "e2", sequence: 2 })],
    };
    const result = await ports.telemetry.ingest(input);
    expect(result.accepted).toBe(2);

    const after = await ports.telemetry.status();
    expect(after.eventCount).toBe(2);
    expect(after.runtimeCount).toBe(1);
  });

  test("catalog starts empty and model-policy repository starts empty", async () => {
    const ports = createInMemoryCentralPorts();
    // Catalog repository is wired (§16.6) but starts empty until admin writes land items.
    expect(await ports.catalog.list()).toEqual([]);
    expect(await ports.catalog.get("anything")).toBeUndefined();
    expect(await ports.catalog.head("anything")).toBeUndefined();
    // Model-policy repository is wired (§16.13) but starts empty with no active policy.
    expect(await ports.modelPolicy.getActivePolicy()).toBeUndefined();
    expect(await ports.modelPolicy.getActivePolicyId()).toBeUndefined();
    expect(await ports.modelPolicy.listPolicies()).toEqual([]);
    expect(await ports.modelPolicy.getPolicy("anything")).toBeUndefined();
  });

  test("admin metadata reports dev-token auth and catalog writes route through the repository", async () => {
    const ports = createInMemoryCentralPorts({ label: "dev", startedAt: "2026-06-24T00:00:00.000Z" });
    const metadata = await ports.admin.getMetadata();
    expect(metadata.server.mode).toBe("central-admin");
    expect(metadata.server.authMethods).toEqual(["dev-token"]);
    expect(metadata.server.label).toBe("dev");
    expect(metadata.server.startedAt).toBe("2026-06-24T00:00:00.000Z");
    expect(metadata.server.capabilities).toEqual({ catalog: true, modelPolicy: true, telemetry: true, admin: true });

    // authMethods is configurable so a future OAuth adapter can advertise its kind.
    const oauthPorts = createInMemoryCentralPorts({ authMethods: ["dev-token", "oauth"] });
    const oauthMetadata = await oauthPorts.admin.getMetadata();
    expect(oauthMetadata.server.authMethods).toEqual(["dev-token", "oauth"]);

    // Admin writes now route through the central catalog repository (§16.6).
    const created = await ports.admin.createCatalogItem({ id: "x", kind: "loadout", content: { definition: { sockets: [] } } });
    expect(created.action).toBe("created");
    expect(created.summary.id).toBe("x");
    expect(created.summary.kind).toBe("loadout");
    expect(created.summary.version).toBe("1");

    // update/delete on an unknown item surface a not-found error.
    await expect(ports.admin.updateCatalogItem({ id: "missing" })).rejects.toThrow(/not found/);
    await expect(ports.admin.deleteCatalogItem({ id: "missing" })).rejects.toThrow(/not found/);
  });

  test("queryEvents honors cast, sequence, and limit filters", async () => {
    const ports = createInMemoryCentralPorts();
    await ports.telemetry.ingest({
      runtimeId: "rt-A",
      events: [
        enrichedEvent({ eventId: "a1", castId: "cast-1", sequence: 1 }),
        enrichedEvent({ eventId: "a2", castId: "cast-1", sequence: 2 }),
        enrichedEvent({ eventId: "b1", castId: "cast-2", sequence: 1 }),
      ],
    });
    expect(await ports.telemetry.queryEvents({ castId: "cast-1" })).toHaveLength(2);
    expect(await ports.telemetry.queryEvents({ sinceSequence: 2 })).toHaveLength(1);
    expect(await ports.telemetry.queryEvents({ limit: 1 })).toHaveLength(1);
    expect(await ports.telemetry.queryEvents({ runtimeId: "rt-A" })).toHaveLength(3);
    expect(await ports.telemetry.queryEvents({ runtimeId: "rt-other" })).toEqual([]);
  });
});

describe("central server skeleton — HTTP routes", () => {
  test("GET /api/health returns a control-plane-scoped central envelope", async () => {
    const baseUrl = await startTestServer({ label: "skeleton" });
    const response = await fetch(`${baseUrl}/api/health`);
    const body = (await response.json()) as { ok: boolean; scope: string; service: string; mode: string; label?: string };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.scope).toBe(CENTRAL_CONTROL_PLANE_SCOPE);
    expect(body.service).toBe(CENTRAL_SERVICE_ID);
    expect(body.mode).toBe("central-admin");
    expect(body.label).toBe("skeleton");
  });

  test("GET /api/status returns a central-admin status snapshot", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/status`, { headers: READER_AUTH });
    const body = (await response.json()) as {
      ok: boolean;
      scope: string;
      service: string;
      status: { mode: string; capturedAt: string; healthy: boolean; eventCount: number; runtimeCount: number };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.scope).toBe(CENTRAL_CONTROL_PLANE_SCOPE);
    expect(body.service).toBe(CENTRAL_SERVICE_ID);
    expect(body.status.mode).toBe("central-admin");
    expect(body.status.healthy).toBe(true);
    expect(typeof body.status.capturedAt).toBe("string");
    expect(body.status.eventCount).toBe(0);
    expect(body.status.runtimeCount).toBe(0);
  });

  test("does not expose local-session-only routes", async () => {
    const baseUrl = await startTestServer();
    for (const path of ["/api/session", "/api/quests", "/api/loadout/active", "/api/monitor/events"]) {
      const response = await fetch(`${baseUrl}${path}`);
      const body = (await response.json()) as { ok: boolean; scope: string; service: string; error: string };
      expect(response.status).toBe(404);
      expect(body.ok).toBe(false);
      expect(body.scope).toBe(CENTRAL_CONTROL_PLANE_SCOPE);
      expect(body.service).toBe(CENTRAL_SERVICE_ID);
      expect(body.error).toBe("Not found");
    }
  });

  test("starts without any local repository session dependency", async () => {
    // No session config is passed; the server must still bind and serve health.
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { mode: string };
    expect(body.mode).toBe("central-admin");
  });

  test("accepts injected control-plane ports", async () => {
    const ports = createInMemoryCentralPorts({ label: "injected" });
    await ports.telemetry.ingest({ runtimeId: "rt-1", events: [enrichedEvent()] });
    const baseUrl = await startTestServer({ ports });

    const response = await fetch(`${baseUrl}/api/status`, { headers: READER_AUTH });
    const body = (await response.json()) as { status: { eventCount: number; runtimeCount: number } };
    expect(response.status).toBe(200);
    expect(body.status.eventCount).toBe(1);
    expect(body.status.runtimeCount).toBe(1);
  });

  test("server-level guard isolates handler errors into a 500 envelope", async () => {
    const basePorts = createInMemoryCentralPorts();
    const throwingPorts: ControlPlanePorts = {
      ...basePorts,
      telemetry: {
        ...basePorts.telemetry,
        async status() {
          throw new Error("boom");
        },
      },
    };
    const baseUrl = await startTestServer({ ports: throwingPorts });

    const response = await fetch(`${baseUrl}/api/status`, { headers: READER_AUTH });
    const body = (await response.json()) as { ok: boolean; scope: string; service: string; error: string };

    expect(response.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.scope).toBe(CENTRAL_CONTROL_PLANE_SCOPE);
    expect(body.service).toBe(CENTRAL_SERVICE_ID);
    expect(body.error).toBe("boom");

    // The server stays up and healthy after an isolated handler error.
    const health = await fetch(`${baseUrl}/api/health`);
    expect(health.status).toBe(200);
  });
});

describe("central server — CORS for cross-origin WebUI reads", () => {
  test("OPTIONS preflight returns 204 with permissive CORS headers", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/model-policy`, { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect((response.headers.get("access-control-allow-headers") ?? "").toLowerCase()).toContain("authorization");
    expect((response.headers.get("access-control-allow-methods") ?? "").toUpperCase()).toContain("GET");
  });

  test("GET responses carry CORS headers so cross-origin WebUI reads succeed", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toBeTruthy();
  });
});
