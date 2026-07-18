import { createHash } from "node:crypto";
import {
  CentralSqliteDatabase,
  openCentralSqliteDatabase,
  type OpenCentralSqliteDatabaseOptions,
} from "./sqliteDatabase.js";
import { CENTRAL_SCHEMA_MIGRATIONS } from "./schemaMigrations.js";

export interface CentralSchemaMigration {
  /** Positive, contiguous schema version. */
  readonly version: number;
  /** Stable diagnostic name. Renaming an applied migration is rejected. */
  readonly name: string;
  /** SQL run as one transaction before the version record is inserted. */
  readonly sql: string;
}

export interface CentralSchemaMigrationRecord {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface CentralMigrationResult {
  readonly previousVersion: number;
  readonly currentVersion: number;
  /** Migrations applied by this invocation; empty on an idempotent repeat. */
  readonly applied: readonly CentralSchemaMigrationRecord[];
}

export interface RunCentralSchemaMigrationsOptions {
  readonly migrations?: readonly CentralSchemaMigration[];
  /** Stable clock injection for tests. */
  readonly clock?: () => string;
}

export interface InitializeCentralSqliteDatabaseOptions extends OpenCentralSqliteDatabaseOptions {
  readonly migrations?: readonly CentralSchemaMigration[];
  readonly clock?: () => string;
}

export interface InitializedCentralSqliteDatabase {
  readonly database: CentralSqliteDatabase;
  readonly migrationResult: CentralMigrationResult;
}

export type CentralMigrationFailureStage = "definitions" | "metadata" | "compatibility" | "apply";

/** Actionable migration failure including the database and failed version. */
export class CentralMigrationError extends Error {
  readonly databasePath: string;
  readonly stage: CentralMigrationFailureStage;
  readonly migrationVersion?: number;
  readonly migrationName?: string;

  constructor(input: {
    databasePath: string;
    stage: CentralMigrationFailureStage;
    message: string;
    migration?: Pick<CentralSchemaMigration, "version" | "name">;
    cause?: unknown;
  }) {
    const migrationLabel = input.migration === undefined
      ? ""
      : ` Migration ${input.migration.version} ("${input.migration.name}").`;
    super(
      `Central SQLite migration failure for "${input.databasePath}".${migrationLabel} ${input.message}`,
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = "CentralMigrationError";
    this.databasePath = input.databasePath;
    this.stage = input.stage;
    if (input.migration !== undefined) {
      this.migrationVersion = input.migration.version;
      this.migrationName = input.migration.name;
    }
  }
}

const CREATE_MIGRATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
)
`;

/**
 * Apply pending central schema migrations in ascending version order.
 *
 * Each migration and its version record share one transaction. Existing
 * records are checked by stable name and SQL checksum so edited history,
 * version gaps, and databases newer than this build fail before any new SQL is
 * attempted.
 */
export function runCentralSchemaMigrations(
  database: CentralSqliteDatabase,
  options: RunCentralSchemaMigrationsOptions = {},
): CentralMigrationResult {
  const migrations = validateAndOrderMigrations(database.path, options.migrations ?? CENTRAL_SCHEMA_MIGRATIONS);
  ensureMigrationTable(database);
  const existing = readCentralSchemaMigrations(database);
  verifyAppliedMigrations(database.path, migrations, existing);

  const previousVersion = existing.at(-1)?.version ?? 0;
  const applied: CentralSchemaMigrationRecord[] = [];
  const appliedVersions = new Set(existing.map((record) => record.version));
  const clock = options.clock ?? (() => new Date().toISOString());

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;
    const record: CentralSchemaMigrationRecord = {
      version: migration.version,
      name: migration.name,
      checksum: migrationChecksum(migration),
      appliedAt: clock(),
    };
    try {
      database.transaction(() => {
        database.exec(migration.sql);
        database.prepare(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        ).run(record.version, record.name, record.checksum, record.appliedAt);
      });
    } catch (error) {
      throw new CentralMigrationError({
        databasePath: database.path,
        stage: "apply",
        migration,
        message: `The transaction was rolled back. Fix the migration or restore a compatible backup, then retry. Cause: ${errorMessage(error)}`,
        cause: error,
      });
    }
    applied.push(record);
  }

  return Object.freeze({
    previousVersion,
    currentVersion: migrations.at(-1)?.version ?? 0,
    applied: Object.freeze(applied.map((record) => Object.freeze(record))),
  });
}

/** Read the ordered migration history recorded in the database. */
export function readCentralSchemaMigrations(database: CentralSqliteDatabase): CentralSchemaMigrationRecord[] {
  try {
    return database.prepare(
      "SELECT version, name, checksum, applied_at AS appliedAt FROM schema_migrations ORDER BY version ASC",
    ).all<CentralSchemaMigrationRecord>();
  } catch (error) {
    throw new CentralMigrationError({
      databasePath: database.path,
      stage: "metadata",
      message: `Could not read schema_migrations. Verify the database file and migration metadata schema. Cause: ${errorMessage(error)}`,
      cause: error,
    });
  }
}

/** Open, configure, and migrate a database, closing it automatically on failure. */
export async function initializeCentralSqliteDatabase(
  options: InitializeCentralSqliteDatabaseOptions | string,
): Promise<InitializedCentralSqliteDatabase> {
  const resolved = typeof options === "string" ? { path: options } : options;
  const database = await openCentralSqliteDatabase(resolved);
  try {
    const migrationResult = runCentralSchemaMigrations(database, {
      ...(resolved.migrations !== undefined ? { migrations: resolved.migrations } : {}),
      ...(resolved.clock !== undefined ? { clock: resolved.clock } : {}),
    });
    return { database, migrationResult };
  } catch (error) {
    database.close();
    throw error;
  }
}

function ensureMigrationTable(database: CentralSqliteDatabase): void {
  try {
    database.transaction(() => database.exec(CREATE_MIGRATION_TABLE_SQL));
  } catch (error) {
    throw new CentralMigrationError({
      databasePath: database.path,
      stage: "metadata",
      message: `Could not create schema_migrations. Check file permissions and SQLite integrity. Cause: ${errorMessage(error)}`,
      cause: error,
    });
  }
}

function validateAndOrderMigrations(
  databasePath: string,
  declared: readonly CentralSchemaMigration[],
): readonly CentralSchemaMigration[] {
  const migrations = [...declared].sort((left, right) => left.version - right.version);
  const seenNames = new Set<string>();
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    const expectedVersion = index + 1;
    if (!Number.isSafeInteger(migration.version) || migration.version !== expectedVersion) {
      throw definitionError(
        databasePath,
        migration,
        `Migration versions must be unique and contiguous from 1; expected version ${expectedVersion}, received ${String(migration.version)}.`,
      );
    }
    if (!migration.name.trim()) {
      throw definitionError(databasePath, migration, "Migration name must be a non-empty string.");
    }
    if (seenNames.has(migration.name)) {
      throw definitionError(databasePath, migration, `Migration name "${migration.name}" is duplicated.`);
    }
    if (!migration.sql.trim()) {
      throw definitionError(databasePath, migration, "Migration SQL must be non-empty.");
    }
    seenNames.add(migration.name);
  }
  return migrations;
}

function verifyAppliedMigrations(
  databasePath: string,
  migrations: readonly CentralSchemaMigration[],
  existing: readonly CentralSchemaMigrationRecord[],
): void {
  const knownByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  for (let index = 0; index < existing.length; index += 1) {
    const record = existing[index];
    const expectedVersion = index + 1;
    if (record.version !== expectedVersion) {
      throw new CentralMigrationError({
        databasePath,
        stage: "compatibility",
        message: `Recorded migration history has a gap: expected version ${expectedVersion}, found ${record.version}. Restore an intact backup before retrying.`,
      });
    }
    const migration = knownByVersion.get(record.version);
    if (migration === undefined) {
      throw new CentralMigrationError({
        databasePath,
        stage: "compatibility",
        message: `Database schema version ${record.version} is newer than this server supports (${migrations.at(-1)?.version ?? 0}). Upgrade the server; do not downgrade the database.`,
      });
    }
    const expectedChecksum = migrationChecksum(migration);
    if (record.name !== migration.name || record.checksum !== expectedChecksum) {
      throw new CentralMigrationError({
        databasePath,
        stage: "compatibility",
        migration,
        message: `Recorded migration metadata does not match this build (stored name "${record.name}", checksum "${record.checksum}"). Applied migrations must never be edited; restore a compatible backup or use the matching server build.`,
      });
    }
  }
}

function migrationChecksum(migration: CentralSchemaMigration): string {
  return `sha256:${createHash("sha256")
    .update(`${migration.version}\0${migration.name}\0${migration.sql}`)
    .digest("hex")}`;
}

function definitionError(
  databasePath: string,
  migration: Pick<CentralSchemaMigration, "version" | "name">,
  message: string,
): CentralMigrationError {
  return new CentralMigrationError({ databasePath, stage: "definitions", migration, message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
