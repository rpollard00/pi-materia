import { afterEach, describe, expect, test } from "bun:test";
import {
  CENTRAL_CONTROL_PLANE_SCOPE,
  CENTRAL_SERVICE_ID,
  DEFAULT_DEV_TOKEN_ADMIN,
  DEFAULT_DEV_TOKEN_READER,
  DEFAULT_DEV_TOKEN_SINK,
  createInMemoryCentralPorts,
  createMateriaCentralServer,
  type MateriaCentralServer,
} from "../src/central/index.js";
import type { ControlPlanePorts } from "../src/application/index.js";
import type { EnrichedEvent } from "../src/domain/eventing.js";

/**
 * Central monitoring read APIs (docs/enterprise-control-plane.md §15, §16.16).
 *
 * Covers the read surface that exposes in-memory central telemetry/status
 * snapshots for future central monitoring views:
 * - `GET /api/status` — the status snapshot (event/runtime counts).
 * - `GET /api/telemetry/events` — query ingested events with filters.
 *
 * Central monitoring is a cross-runtime aggregate; it is **not** a replacement
 * for local session/artifact monitoring, and the local artifact monitor is
 * unchanged. These tests do not touch any local monitor code path.
 */

const servers: Array<MateriaCentralServer["server"]> = [];

const SINK_AUTH = { Authorization: `Bearer ${DEFAULT_DEV_TOKEN_SINK}` };
const READER_AUTH = { Authorization: `Bearer ${DEFAULT_DEV_TOKEN_READER}` };
const ADMIN_AUTH = { Authorization: `Bearer ${DEFAULT_DEV_TOKEN_ADMIN}` };

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function startTestServer(options: { label?: string; ports?: ControlPlanePorts } = {}): Promise<string> {
  const created = createMateriaCentralServer({
    port: 0,
    ...(options.label !== undefined ? { label: options.label } : {}),
    ...(options.ports ? { ports: options.ports } : {}),
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

/** Build a valid enriched event with optional overrides. */
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
    severity: "info",
    message: "working",
    payload: { ok: true },
    ...overrides,
  };
}

/** Ingest a batch of events through the HTTP sink surface using the sink token. */
async function ingest(baseUrl: string, events: EnrichedEvent[], runtimeId = "rt-A"): Promise<void> {
  const response = await fetch(`${baseUrl}/api/telemetry/ingest`, {
    method: "POST",
    headers: { ...SINK_AUTH, "content-type": "application/json" },
    body: JSON.stringify({ events, runtimeId }),
  });
  expect(response.status).toBe(200);
}

interface EventsResponse {
  ok: boolean;
  scope: string;
  service: string;
  events: EnrichedEvent[];
  count: number;
}

async function readEvents(baseUrl: string, query = "", auth = READER_AUTH): Promise<{ status: number; body: EventsResponse }> {
  const response = await fetch(`${baseUrl}/api/telemetry/events${query}`, { headers: auth });
  const body = (await response.json()) as EventsResponse;
  return { status: response.status, body };
}

// ───────────────────────────────────────────────────────────────────────
// GET /api/telemetry/events — read surface
// ───────────────────────────────────────────────────────────────────────

describe("central monitoring read — GET /api/telemetry/events", () => {
  test("returns an empty result before any ingestion", async () => {
    const baseUrl = await startTestServer();
    const { status, body } = await readEvents(baseUrl);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.scope).toBe(CENTRAL_CONTROL_PLANE_SCOPE);
    expect(body.service).toBe(CENTRAL_SERVICE_ID);
    expect(body.events).toEqual([]);
    expect(body.count).toBe(0);
  });

  test("returns ingested events (cross-runtime aggregate)", async () => {
    const baseUrl = await startTestServer();
    await ingest(baseUrl, [
      enrichedEvent({ eventId: "e1", sequence: 1 }),
      enrichedEvent({ eventId: "e2", sequence: 2, castId: "cast-2" }),
    ], "rt-A");
    await ingest(baseUrl, [enrichedEvent({ eventId: "e3", sequence: 1, castId: "cast-3" })], "rt-B");

    const { status, body } = await readEvents(baseUrl);
    expect(status).toBe(200);
    expect(body.events.map((event) => event.eventId)).toEqual(["e1", "e2", "e3"]);
    expect(body.count).toBe(3);
    // Stored events carry their normalized enriched shape (unknowns dropped at ingest).
    expect("strayField" in body.events[0]).toBe(false);
  });

  test("filters by runtimeId", async () => {
    const baseUrl = await startTestServer();
    await ingest(baseUrl, [enrichedEvent({ eventId: "a1", sequence: 1 })], "rt-A");
    await ingest(baseUrl, [enrichedEvent({ eventId: "b1", sequence: 1 })], "rt-B");

    const a = await readEvents(baseUrl, "?runtimeId=rt-A");
    expect(a.body.events.map((event) => event.eventId)).toEqual(["a1"]);
    const b = await readEvents(baseUrl, "?runtimeId=rt-B");
    expect(b.body.events.map((event) => event.eventId)).toEqual(["b1"]);
    const none = await readEvents(baseUrl, "?runtimeId=rt-other");
    expect(none.body.events).toEqual([]);
    expect(none.body.count).toBe(0);
  });

  test("filters by castId", async () => {
    const baseUrl = await startTestServer();
    await ingest(baseUrl, [
      enrichedEvent({ eventId: "a1", castId: "cast-1", sequence: 1 }),
      enrichedEvent({ eventId: "a2", castId: "cast-1", sequence: 2 }),
      enrichedEvent({ eventId: "b1", castId: "cast-2", sequence: 1 }),
    ]);

    const cast1 = await readEvents(baseUrl, "?castId=cast-1");
    expect(cast1.body.events.map((event) => event.eventId)).toEqual(["a1", "a2"]);
    expect(cast1.body.count).toBe(2);
  });

  test("filters by sinceSequence (inclusive lower bound)", async () => {
    const baseUrl = await startTestServer();
    await ingest(baseUrl, [
      enrichedEvent({ eventId: "a1", sequence: 1 }),
      enrichedEvent({ eventId: "a2", sequence: 2 }),
      enrichedEvent({ eventId: "a3", sequence: 3 }),
    ]);

    const since2 = await readEvents(baseUrl, "?sinceSequence=2");
    expect(since2.body.events.map((event) => event.eventId)).toEqual(["a2", "a3"]);
  });

  test("limits the result count", async () => {
    const baseUrl = await startTestServer();
    await ingest(baseUrl, [
      enrichedEvent({ eventId: "a1", sequence: 1 }),
      enrichedEvent({ eventId: "a2", sequence: 2 }),
      enrichedEvent({ eventId: "a3", sequence: 3 }),
    ]);

    const limited = await readEvents(baseUrl, "?limit=2");
    expect(limited.body.events).toHaveLength(2);
    expect(limited.body.count).toBe(2);
    expect(limited.body.events.map((event) => event.eventId)).toEqual(["a1", "a2"]);
  });

  test("combines filters", async () => {
    const baseUrl = await startTestServer();
    await ingest(baseUrl, [
      enrichedEvent({ eventId: "a1", castId: "cast-1", sequence: 1 }),
      enrichedEvent({ eventId: "a2", castId: "cast-1", sequence: 2 }),
      enrichedEvent({ eventId: "b1", castId: "cast-2", sequence: 1 }),
    ], "rt-A");
    await ingest(baseUrl, [enrichedEvent({ eventId: "c1", castId: "cast-1", sequence: 5 })], "rt-B");

    const combined = await readEvents(baseUrl, "?runtimeId=rt-A&castId=cast-1&sinceSequence=2");
    expect(combined.body.events.map((event) => event.eventId)).toEqual(["a2"]);
  });

  test("limit=0 returns an empty page without erroring", async () => {
    const baseUrl = await startTestServer();
    await ingest(baseUrl, [enrichedEvent({ eventId: "a1", sequence: 1 })]);
    const zero = await readEvents(baseUrl, "?limit=0");
    expect(zero.status).toBe(200);
    expect(zero.body.events).toEqual([]);
    expect(zero.body.count).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Validation
// ───────────────────────────────────────────────────────────────────────

describe("central monitoring read — query validation", () => {
  test("rejects a non-numeric sinceSequence with 400", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/telemetry/events?sinceSequence=abc`, { headers: READER_AUTH });
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(response.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("sinceSequence");
  });

  test("rejects a negative limit with 400", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/telemetry/events?limit=-1`, { headers: READER_AUTH });
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(response.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("limit");
  });

  test("rejects a non-integer limit with 400", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/telemetry/events?limit=1.5`, { headers: READER_AUTH });
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(response.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("limit");
  });
});

// ───────────────────────────────────────────────────────────────────────
// Authorization (§13)
// ───────────────────────────────────────────────────────────────────────

describe("central monitoring read — authorization", () => {
  test("reader token (telemetry.read) is allowed", async () => {
    const baseUrl = await startTestServer();
    await ingest(baseUrl, [enrichedEvent({ eventId: "e1" })]);
    const { status, body } = await readEvents(baseUrl, "", READER_AUTH);
    expect(status).toBe(200);
    expect(body.count).toBe(1);
  });

  test("admin token (wildcard) is allowed", async () => {
    const baseUrl = await startTestServer();
    await ingest(baseUrl, [enrichedEvent({ eventId: "e1" })]);
    const { status, body } = await readEvents(baseUrl, "", ADMIN_AUTH);
    expect(status).toBe(200);
    expect(body.count).toBe(1);
  });

  test("sink token (telemetry.ingest only) is forbidden from reading", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/telemetry/events`, { headers: SINK_AUTH });
    const body = (await response.json()) as { ok: boolean; error: string; permission: string };
    expect(response.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.permission).toBe("telemetry.read");
  });

  test("missing credential is unauthorized", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/telemetry/events`);
    const body = (await response.json()) as { ok: boolean; error: string; reason: string };
    expect(response.status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("missing");
  });
});

// ───────────────────────────────────────────────────────────────────────
// Routing precedence (route matching precedes auth — §13)
// ───────────────────────────────────────────────────────────────────────

describe("central monitoring read — routing", () => {
  test("POST is method-not-allowed without invoking auth", async () => {
    const baseUrl = await startTestServer();
    // No auth header, but route+method resolution precedes auth → 405.
    const response = await fetch(`${baseUrl}/api/telemetry/events`, { method: "POST" });
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(response.status).toBe(405);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Method not allowed");
  });

  test("events sub-paths are not found (404, not 401)", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/telemetry/events/extra`, { headers: READER_AUTH });
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(response.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Not found");
  });

  test("ingest route is unaffected by the new read branch", async () => {
    const baseUrl = await startTestServer();
    // GET on ingest remains method-not-allowed (405), not treated as a read.
    const response = await fetch(`${baseUrl}/api/telemetry/ingest`);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(response.status).toBe(405);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Method not allowed");
  });
});

// ───────────────────────────────────────────────────────────────────────
// Status snapshot read surface (unchanged, still a monitoring read API)
// ───────────────────────────────────────────────────────────────────────

describe("central monitoring read — GET /api/status", () => {
  test("status snapshot reflects ingested event/runtime counts", async () => {
    const baseUrl = await startTestServer();
    await ingest(baseUrl, [enrichedEvent({ eventId: "e1" }), enrichedEvent({ eventId: "e2" })], "rt-A");
    await ingest(baseUrl, [enrichedEvent({ eventId: "e3" })], "rt-B");

    const response = await fetch(`${baseUrl}/api/status`, { headers: READER_AUTH });
    const body = (await response.json()) as {
      ok: boolean;
      scope: string;
      service: string;
      status: { mode: string; capturedAt: string; healthy: boolean; eventCount: number; runtimeCount: number };
    };
    expect(response.status).toBe(200);
    expect(body.scope).toBe(CENTRAL_CONTROL_PLANE_SCOPE);
    expect(body.service).toBe(CENTRAL_SERVICE_ID);
    expect(body.status.mode).toBe("central-admin");
    expect(body.status.healthy).toBe(true);
    expect(body.status.eventCount).toBe(3);
    expect(body.status.runtimeCount).toBe(2);
  });

  test("status read also requires telemetry.read (sink forbidden)", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/status`, { headers: SINK_AUTH });
    const body = (await response.json()) as { ok: boolean; permission: string };
    expect(response.status).toBe(403);
    expect(body.permission).toBe("telemetry.read");
  });
});
