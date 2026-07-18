import { afterEach, describe, expect, test } from "bun:test";
import {
  CENTRAL_CONTROL_PLANE_SCOPE,
  CENTRAL_SERVICE_ID,
  DEFAULT_DEV_TOKEN_ADMIN,
  DEFAULT_DEV_TOKEN_READER,
  DEFAULT_DEV_TOKEN_SINK,
  createInMemoryCentralPorts,
  createMateriaCentralServer,
  normalizeEnrichedEvent,
  normalizeTelemetryIngestBody,
  type MateriaCentralServer,
} from "../src/central/index.js";
import type { ControlPlanePorts } from "../src/application/index.js";
import type { EnrichedEvent } from "../src/domain/eventing.js";

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
    authMode: "development",
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

// ───────────────────────────────────────────────────────────────────────
// Pure normalization
// ───────────────────────────────────────────────────────────────────────

describe("central telemetry ingest — normalizeTelemetryIngestBody", () => {
  test("normalizes a single enriched-event body (webhook passthrough shape)", () => {
    const result = normalizeTelemetryIngestBody(enrichedEvent({ eventId: "e1" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.input.events).toHaveLength(1);
    expect(result.value.input.events[0].eventId).toBe("e1");
    expect(result.value.rejected).toBe(0);
  });

  test("normalizes an array body and preserves known optional fields", () => {
    const result = normalizeTelemetryIngestBody([
      enrichedEvent({ eventId: "e1", severity: "warning", message: "m", payload: { a: 1 }, materiaLabel: "Builder", itemKey: "k", itemLabel: "l", source: { materia: "builder", socketId: "Socket-1" } }),
      enrichedEvent({ eventId: "e2" }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.input.events).toHaveLength(2);
    const first = result.value.input.events[0];
    expect(first.severity).toBe("warning");
    expect(first.message).toBe("m");
    expect(first.payload).toEqual({ a: 1 });
    expect(first.materiaLabel).toBe("Builder");
    expect(first.itemKey).toBe("k");
    expect(first.itemLabel).toBe("l");
    expect(first.source).toEqual({ materia: "builder", socketId: "Socket-1" });
  });

  test("normalizes an envelope body and extracts runtimeId/scope", () => {
    const result = normalizeTelemetryIngestBody({
      events: [enrichedEvent({ eventId: "e1" }), enrichedEvent({ eventId: "e2" })],
      runtimeId: "rt-A",
      scope: { tenantId: "t1", workspaceId: "w1" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.input.events).toHaveLength(2);
    expect(result.value.input.runtimeId).toBe("rt-A");
    expect(result.value.input.scope).toEqual({ tenantId: "t1", workspaceId: "w1" });
  });

  test("envelope runtimeId/scope override option fallbacks; option used when envelope omits them", () => {
    const withEnvelope = normalizeTelemetryIngestBody(
      { events: [enrichedEvent()], runtimeId: "rt-env" },
      { runtimeId: "rt-fallback" },
    );
    expect(withEnvelope.ok).toBe(true);
    if (withEnvelope.ok) expect(withEnvelope.value.input.runtimeId).toBe("rt-env");

    const withoutEnvelope = normalizeTelemetryIngestBody([enrichedEvent()], { runtimeId: "rt-fallback" });
    expect(withoutEnvelope.ok).toBe(true);
    if (withoutEnvelope.ok) expect(withoutEnvelope.value.input.runtimeId).toBe("rt-fallback");
  });

  test("drops malformed candidates and counts them as rejected", () => {
    const result = normalizeTelemetryIngestBody([
      enrichedEvent({ eventId: "good" }),
      { type: "missing enriched fields" }, // no eventId/castId/...
      null,
      "not-an-object",
      enrichedEvent({ eventId: "good-2" }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.input.events.map((event) => event.eventId)).toEqual(["good", "good-2"]);
    expect(result.value.rejected).toBe(3);
  });

  test("rejects a non-object/non-array body", () => {
    const result = normalizeTelemetryIngestBody("hello");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("must be a JSON object or array");
  });

  test("rejects an envelope-like object without an events array and not an event", () => {
    const result = normalizeTelemetryIngestBody({ runtimeId: "rt-A", note: "no events" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("envelope with an `events` array");
  });

  test("accepts an empty events array as a no-op batch", () => {
    const result = normalizeTelemetryIngestBody({ events: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.input.events).toEqual([]);
    expect(result.value.rejected).toBe(0);
  });
});

describe("central telemetry ingest — normalizeEnrichedEvent", () => {
  test("drops unknown fields and malformed optional fields, keeps valid ones", () => {
    const normalized = normalizeEnrichedEvent({
      ...enrichedEvent({ eventId: "e1" }),
      unknownExtra: "dropped",
      severity: "not-a-real-severity", // malformed → dropped
      payload: "not-an-object", // malformed → dropped
      source: "not-an-object", // malformed → dropped
      message: 42, // malformed → dropped
      materiaLabel: "Kept",
    });
    expect(normalized).toBeDefined();
    if (normalized === undefined) return;
    expect(normalized.eventId).toBe("e1");
    expect(normalized.materiaLabel).toBe("Kept");
    expect("unknownExtra" in normalized).toBe(false);
    expect("severity" in normalized).toBe(false);
    expect("payload" in normalized).toBe(false);
    expect("source" in normalized).toBe(false);
    expect("message" in normalized).toBe(false);
  });

  test("returns undefined when a required enriched field is missing or invalid", () => {
    expect(normalizeEnrichedEvent(undefined)).toBeUndefined();
    expect(normalizeEnrichedEvent(null)).toBeUndefined();
    expect(normalizeEnrichedEvent("x")).toBeUndefined();
    expect(normalizeEnrichedEvent({ ...enrichedEvent(), eventId: "" })).toBeUndefined();
    expect(normalizeEnrichedEvent({ ...enrichedEvent(), type: "   " })).toBeUndefined();
    expect(normalizeEnrichedEvent({ ...enrichedEvent(), sequence: "not-a-number" })).toBeUndefined();
    expect(normalizeEnrichedEvent({ ...enrichedEvent(), sequence: Number.NaN })).toBeUndefined();
    expect(normalizeEnrichedEvent({ ...enrichedEvent(), castId: 5 })).toBeUndefined();
    expect(normalizeEnrichedEvent({ ...enrichedEvent(), visit: true })).toBeUndefined();
  });

  test("reduces nested source to its known fields", () => {
    const normalized = normalizeEnrichedEvent({
      ...enrichedEvent(),
      source: { materia: "builder", socketId: "Socket-1", junk: "ignored" },
    });
    expect(normalized).toBeDefined();
    if (normalized === undefined) return;
    expect(normalized.source).toEqual({ materia: "builder", socketId: "Socket-1" });
  });
});

// ───────────────────────────────────────────────────────────────────────
// HTTP ingestion endpoint
// ───────────────────────────────────────────────────────────────────────

describe("central server — POST /api/telemetry/ingest", () => {
  test("accepts a normalized batch with the sink token and reflects counts in status", async () => {
    const ports = createInMemoryCentralPorts();
    const baseUrl = await startTestServer({ ports });

    const response = await fetch(`${baseUrl}/api/telemetry/ingest`, {
      method: "POST",
      headers: { ...SINK_AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          enrichedEvent({ eventId: "e1", sequence: 1 }),
          enrichedEvent({ eventId: "e2", sequence: 2 }),
        ],
        runtimeId: "rt-A",
      }),
    });
    const body = (await response.json()) as {
      ok: boolean;
      scope: string;
      service: string;
      result: { accepted: number; ingestedAt: string };
      rejected: number;
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.scope).toBe(CENTRAL_CONTROL_PLANE_SCOPE);
    expect(body.service).toBe(CENTRAL_SERVICE_ID);
    expect(body.result.accepted).toBe(2);
    expect(body.rejected).toBe(0);
    expect(typeof body.result.ingestedAt).toBe("string");

    const status = await fetch(`${baseUrl}/api/status`, { headers: READER_AUTH });
    const statusBody = (await status.json()) as { status: { eventCount: number; runtimeCount: number } };
    expect(statusBody.status.eventCount).toBe(2);
    expect(statusBody.status.runtimeCount).toBe(1);
  });

  test("accepts a single passthrough event and stores it normalized (unknowns dropped)", async () => {
    const ports = createInMemoryCentralPorts();
    const baseUrl = await startTestServer({ ports });

    const response = await fetch(`${baseUrl}/api/telemetry/ingest`, {
      method: "POST",
      headers: { ...SINK_AUTH, "content-type": "application/json" },
      body: JSON.stringify({ ...enrichedEvent({ eventId: "solo" }), strayField: "dropped" }),
    });
    const body = (await response.json()) as { ok: boolean; result: { accepted: number }; rejected: number };
    expect(response.status).toBe(200);
    expect(body.result.accepted).toBe(1);
    expect(body.rejected).toBe(0);

    const events = await ports.telemetry.queryEvents({});
    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe("solo");
    expect("strayField" in events[0]).toBe(false);
  });

  test("drops malformed events and reports the rejected count", async () => {
    const ports = createInMemoryCentralPorts();
    const baseUrl = await startTestServer({ ports });

    const response = await fetch(`${baseUrl}/api/telemetry/ingest`, {
      method: "POST",
      headers: { ...SINK_AUTH, "content-type": "application/json" },
      body: JSON.stringify([
        enrichedEvent({ eventId: "ok" }),
        { type: "no enriched fields" },
        42,
      ]),
    });
    const body = (await response.json()) as { ok: boolean; result: { accepted: number }; rejected: number };
    expect(response.status).toBe(200);
    expect(body.result.accepted).toBe(1);
    expect(body.rejected).toBe(2);
    expect(await ports.telemetry.queryEvents({})).toHaveLength(1);
  });

  test("honors runtimeId from the query param when the body omits it", async () => {
    const ports = createInMemoryCentralPorts();
    const baseUrl = await startTestServer({ ports });

    const response = await fetch(`${baseUrl}/api/telemetry/ingest?runtimeId=rt-query`, {
      method: "POST",
      headers: { ...SINK_AUTH, "content-type": "application/json" },
      body: JSON.stringify({ events: [enrichedEvent({ eventId: "q1" })] }),
    });
    expect(response.status).toBe(200);
    expect(await ports.telemetry.queryEvents({ runtimeId: "rt-query" })).toHaveLength(1);
    expect(await ports.telemetry.queryEvents({ runtimeId: "rt-other" })).toEqual([]);
  });

  test("admin token (wildcard) is also accepted", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/telemetry/ingest`, {
      method: "POST",
      headers: { ...ADMIN_AUTH, "content-type": "application/json" },
      body: JSON.stringify({ events: [enrichedEvent()] }),
    });
    expect(response.status).toBe(200);
  });

  test("reader token (telemetry.read only) is forbidden from ingesting", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/telemetry/ingest`, {
      method: "POST",
      headers: { ...READER_AUTH, "content-type": "application/json" },
      body: JSON.stringify({ events: [enrichedEvent()] }),
    });
    const body = (await response.json()) as { ok: boolean; error: string; permission: string };
    expect(response.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.permission).toBe("telemetry.ingest");
  });

  test("missing credential is unauthorized", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/telemetry/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [enrichedEvent()] }),
    });
    const body = (await response.json()) as { ok: boolean; error: string; reason: string };
    expect(response.status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("missing");
  });

  test("returns 400 for a structurally invalid body", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/telemetry/ingest`, {
      method: "POST",
      headers: { ...SINK_AUTH, "content-type": "application/json" },
      body: JSON.stringify({ note: "neither event nor envelope" }),
    });
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(response.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("events");
  });

  test("returns 400 for invalid JSON", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/telemetry/ingest`, {
      method: "POST",
      headers: { ...SINK_AUTH, "content-type": "application/json" },
      body: "{not json",
    });
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(response.status).toBe(400);
    expect(body.ok).toBe(false);
  });

  test("GET is method-not-allowed (route matching precedes auth)", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/telemetry/ingest`);
    const body = (await response.json()) as { ok: boolean; error: string };
    // No auth header, but route+method resolution precedes auth → 405.
    expect(response.status).toBe(405);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Method not allowed");
  });

  test("unknown telemetry sub-path is not found", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/telemetry/unknown`, { headers: SINK_AUTH });
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(response.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Not found");
  });
});
