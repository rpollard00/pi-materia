import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createMateriaCentralServer,
  createSqliteCentralTelemetryPort,
  initializeCentralSqliteDatabase,
} from "../src/central/index.js";
import type { EnrichedEvent } from "../src/domain/eventing.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-materia-central-telemetry-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "central.sqlite");
}

function event(eventId: string, overrides: Partial<EnrichedEvent> = {}): EnrichedEvent {
  return {
    type: "status.progress",
    eventId,
    occurredAt: "2026-07-18T02:00:00.000Z",
    sequence: 1,
    castId: "cast-a",
    socketId: "Socket-1",
    materia: "buildja",
    visit: 1,
    severity: "info",
    message: "working",
    ...overrides,
  };
}

describe("SQLite central telemetry port", () => {
  test("persists event/runtime counts and existing query filters across restart", async () => {
    const databasePath = await temporaryDatabasePath();
    const first = await initializeCentralSqliteDatabase({ path: databasePath });
    const ingestedAt = new Date().toISOString();
    const telemetry = createSqliteCentralTelemetryPort(first.database, {
      clock: () => ingestedAt,
      // Keep maintenance deterministic; none of these fresh rows are expired.
      scheduleRetention: () => undefined,
    });

    await telemetry.ingest({
      runtimeId: "runtime-a",
      scope: { tenantId: "tenant-a", workspaceId: "workspace-a" },
      events: [
        event("a-1", { sequence: 1 }),
        event("a-2", { sequence: 2 }),
        event("a-other-cast", { sequence: 3, castId: "cast-b" }),
      ],
    });
    await telemetry.ingest({
      runtimeId: "runtime-b",
      events: [event("b-5", { sequence: 5 })],
    });

    expect((await telemetry.queryEvents({ runtimeId: "runtime-a" })).map((entry) => entry.eventId))
      .toEqual(["a-1", "a-2", "a-other-cast"]);
    expect((await telemetry.queryEvents({ castId: "cast-a", sinceSequence: 2, limit: 1 })).map((entry) => entry.eventId))
      .toEqual(["a-2"]);
    expect(await telemetry.status()).toMatchObject({ eventCount: 4, runtimeCount: 2 });

    const storedScope = first.database.prepare(
      "SELECT scope_json AS scopeJson FROM telemetry_events WHERE event_id = ?",
    ).get<{ scopeJson: string }>("a-1");
    expect(JSON.parse(storedScope?.scopeJson ?? "null")).toEqual({
      tenantId: "tenant-a",
      workspaceId: "workspace-a",
    });
    first.database.close();

    const second = await initializeCentralSqliteDatabase({ path: databasePath });
    try {
      const restartedServer = createMateriaCentralServer({ database: second.database, retentionDays: 30, authMode: "development" });
      expect((await restartedServer.ports.telemetry.queryEvents({ sinceSequence: 3 })).map((entry) => entry.eventId))
        .toEqual(["a-other-cast", "b-5"]);
      expect(await restartedServer.ports.telemetry.status()).toMatchObject({
        mode: "central-admin",
        healthy: true,
        eventCount: 4,
        runtimeCount: 2,
      });
    } finally {
      second.database.close();
    }
  });

  test("rolls back the whole batch when any event cannot be serialized", async () => {
    const initialized = await initializeCentralSqliteDatabase({ path: await temporaryDatabasePath() });
    try {
      const telemetry = createSqliteCentralTelemetryPort(initialized.database, {
        clock: () => "2026-07-18T03:00:00.000Z",
        scheduleRetention: () => undefined,
      });
      const cyclicPayload: Record<string, unknown> = {};
      cyclicPayload.self = cyclicPayload;
      const invalid = event("cyclic", { payload: cyclicPayload });

      await expect(telemetry.ingest({ events: [event("inserted-first"), invalid] })).rejects.toThrow();
      const count = initialized.database.prepare(
        "SELECT COUNT(*) AS count FROM telemetry_events",
      ).get<{ count: number }>();
      expect(Number(count?.count)).toBe(0);
    } finally {
      initialized.database.close();
    }
  });

  test("hides expired rows immediately and prunes them outside ingestion", async () => {
    const initialized = await initializeCentralSqliteDatabase({ path: await temporaryDatabasePath() });
    try {
      let now = "2026-07-01T00:00:00.000Z";
      const scheduled: Array<() => void> = [];
      const telemetry = createSqliteCentralTelemetryPort(initialized.database, {
        retentionDays: 2,
        clock: () => now,
        scheduleRetention: (operation) => scheduled.push(operation),
      });

      // Complete the startup pass, then leave the post-ingestion pass queued.
      expect(scheduled).toHaveLength(1);
      scheduled.shift()?.();
      await telemetry.ingest({ runtimeId: "runtime-old", events: [event("old")] });
      expect(scheduled).toHaveLength(1);

      now = "2026-07-04T00:00:00.000Z";
      expect(await telemetry.queryEvents()).toEqual([]);
      expect(await telemetry.status()).toMatchObject({ eventCount: 0, runtimeCount: 0 });
      const beforeCleanup = initialized.database.prepare(
        "SELECT COUNT(*) AS count FROM telemetry_events",
      ).get<{ count: number }>();
      expect(Number(beforeCleanup?.count)).toBe(1);

      scheduled.shift()?.();
      const afterCleanup = initialized.database.prepare(
        "SELECT COUNT(*) AS count FROM telemetry_events",
      ).get<{ count: number }>();
      expect(Number(afterCleanup?.count)).toBe(0);

      await telemetry.ingest({ runtimeId: "runtime-new", events: [event("new")] });
      expect(await telemetry.status()).toMatchObject({ eventCount: 1, runtimeCount: 1 });
    } finally {
      initialized.database.close();
    }
  });
});
