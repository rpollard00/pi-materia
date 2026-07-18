import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CENTRAL_SCHEMA_VERSION,
  CentralMigrationError,
  initializeCentralSqliteDatabase,
  openCentralSqliteDatabase,
  readCentralSchemaMigrations,
  runCentralSchemaMigrations,
  type CentralSchemaMigration,
} from "../src/central/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDatabasePath(name = "central.sqlite"): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-materia-central-migrations-"));
  temporaryDirectories.push(directory);
  return path.join(directory, name);
}

describe("central SQLite adapter and schema migrations", () => {
  test("creates the control-plane schema with foreign keys, WAL, and query indexes", async () => {
    const databasePath = await temporaryDatabasePath();
    const initialized = await initializeCentralSqliteDatabase({
      path: databasePath,
      clock: () => "2026-07-18T00:00:00.000Z",
    });
    const { database, migrationResult } = initialized;
    try {
      expect(migrationResult.currentVersion).toBe(CENTRAL_SCHEMA_VERSION);
      expect(migrationResult.applied.map((migration) => migration.version)).toEqual([1]);

      const foreignKeys = database.prepare("PRAGMA foreign_keys").get<{ foreign_keys: number }>();
      const journal = database.prepare("PRAGMA journal_mode").get<{ journal_mode: string }>();
      expect(foreignKeys?.foreign_keys).toBe(1);
      expect(journal?.journal_mode.toLowerCase()).toBe("wal");

      const tables = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      ).all<{ name: string }>().map((row) => row.name);
      expect(tables).toEqual(expect.arrayContaining([
        "schema_migrations",
        "catalog_items",
        "model_policies",
        "active_model_policy",
        "audit_records",
        "telemetry_events",
      ]));

      const indexes = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
      ).all<{ name: string }>().map((row) => row.name);
      expect(indexes).toEqual(expect.arrayContaining([
        "telemetry_events_runtime_id_idx",
        "telemetry_events_cast_id_idx",
        "telemetry_events_sequence_idx",
        "telemetry_events_occurred_at_idx",
      ]));

      expect(() => database.prepare(
        "INSERT INTO active_model_policy (singleton, policy_id, updated_at) VALUES (1, 'missing', ?)",
      ).run("2026-07-18T00:00:00.000Z")).toThrow(/foreign key/i);
    } finally {
      database.close();
    }
  });

  test("records versions and repeated database startup is idempotent", async () => {
    const databasePath = await temporaryDatabasePath();
    const first = await initializeCentralSqliteDatabase({ path: databasePath });
    const firstRecords = readCentralSchemaMigrations(first.database);
    expect(firstRecords).toHaveLength(CENTRAL_SCHEMA_VERSION);
    expect(firstRecords[0]?.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    first.database.close();

    const second = await initializeCentralSqliteDatabase({ path: databasePath });
    try {
      expect(second.migrationResult).toEqual({
        previousVersion: CENTRAL_SCHEMA_VERSION,
        currentVersion: CENTRAL_SCHEMA_VERSION,
        applied: [],
      });
      expect(readCentralSchemaMigrations(second.database)).toEqual(firstRecords);
    } finally {
      second.database.close();
    }
  });

  test("orders declared migrations by version and applies each transactionally", async () => {
    const databasePath = await temporaryDatabasePath();
    const database = await openCentralSqliteDatabase(databasePath);
    const migrations: CentralSchemaMigration[] = [
      { version: 2, name: "add-second", sql: "CREATE TABLE second_table (id INTEGER PRIMARY KEY)" },
      { version: 1, name: "add-first", sql: "CREATE TABLE first_table (id INTEGER PRIMARY KEY)" },
    ];
    try {
      const result = runCentralSchemaMigrations(database, { migrations });
      expect(result.applied.map((migration) => migration.version)).toEqual([1, 2]);
      expect(readCentralSchemaMigrations(database).map((migration) => migration.name)).toEqual([
        "add-first",
        "add-second",
      ]);
    } finally {
      database.close();
    }
  });

  test("rolls back a failed migration and reports its path, version, name, and cause", async () => {
    const databasePath = await temporaryDatabasePath();
    const migrations: CentralSchemaMigration[] = [
      { version: 1, name: "stable", sql: "CREATE TABLE stable_table (id INTEGER PRIMARY KEY)" },
      {
        version: 2,
        name: "broken",
        sql: "CREATE TABLE must_rollback (id INTEGER PRIMARY KEY); INSERT INTO table_that_does_not_exist VALUES (1)",
      },
    ];

    let failure: unknown;
    try {
      await initializeCentralSqliteDatabase({ path: databasePath, migrations });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CentralMigrationError);
    expect(failure).toMatchObject({
      databasePath,
      stage: "apply",
      migrationVersion: 2,
      migrationName: "broken",
    });
    expect((failure as Error).message).toContain("rolled back");
    expect((failure as Error).message).toContain("table_that_does_not_exist");

    const database = await openCentralSqliteDatabase(databasePath);
    try {
      const tables = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      ).all<{ name: string }>().map((row) => row.name);
      expect(tables).toContain("stable_table");
      expect(tables).not.toContain("must_rollback");
      expect(readCentralSchemaMigrations(database).map((migration) => migration.version)).toEqual([1]);
    } finally {
      database.close();
    }
  });

  test("rejects edited applied migrations before running pending SQL", async () => {
    const databasePath = await temporaryDatabasePath();
    const original: CentralSchemaMigration[] = [
      { version: 1, name: "original", sql: "CREATE TABLE original_table (id INTEGER PRIMARY KEY)" },
    ];
    const first = await initializeCentralSqliteDatabase({ path: databasePath, migrations: original });
    first.database.close();

    const database = await openCentralSqliteDatabase(databasePath);
    try {
      expect(() => runCentralSchemaMigrations(database, {
        migrations: [{ version: 1, name: "edited", sql: original[0].sql }],
      })).toThrow(/must never be edited/i);
    } finally {
      database.close();
    }
  });
});
