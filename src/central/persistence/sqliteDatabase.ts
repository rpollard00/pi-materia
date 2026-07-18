import { mkdir } from "node:fs/promises";
import path from "node:path";

/** Primitive values accepted by both Node's and Bun's synchronous SQLite APIs. */
export type CentralSqliteBindValue = string | number | bigint | Uint8Array | null;
export type CentralSqliteBindParameter = CentralSqliteBindValue | Readonly<Record<string, CentralSqliteBindValue>>;

export interface CentralSqliteRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

/** Runtime-neutral prepared statement surface used by central persistence adapters. */
export interface CentralSqliteStatement {
  run(...parameters: CentralSqliteBindParameter[]): CentralSqliteRunResult;
  get<T = Record<string, unknown>>(...parameters: CentralSqliteBindParameter[]): T | undefined;
  all<T = Record<string, unknown>>(...parameters: CentralSqliteBindParameter[]): T[];
}

export type CentralSqliteDriver = "node:sqlite" | "bun:sqlite";

export interface OpenCentralSqliteDatabaseOptions {
  readonly path: string;
  /** Lock wait used by SQLite before returning SQLITE_BUSY. Defaults to 5 seconds. */
  readonly busyTimeoutMs?: number;
  /** Durable file journal mode. Defaults to WAL; in-memory databases remain `memory`. */
  readonly journalMode?: "WAL" | "DELETE";
}

interface NativeRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

interface NativeStatement {
  run(...parameters: unknown[]): NativeRunResult;
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
}

interface NativeDatabase {
  exec(sql: string): void;
  prepare(sql: string): NativeStatement;
  close(): void;
}

interface NativeDatabaseConstructor {
  new(path: string): NativeDatabase;
}

interface NativeSqliteModule {
  readonly Database?: NativeDatabaseConstructor;
  readonly DatabaseSync?: NativeDatabaseConstructor;
}

/** Failure to load, open, or configure the central SQLite adapter. */
export class CentralSqliteOpenError extends Error {
  readonly databasePath: string;

  constructor(databasePath: string, message: string, cause?: unknown) {
    super(`Could not open central SQLite database "${databasePath}": ${message}`, cause === undefined ? undefined : { cause });
    this.name = "CentralSqliteOpenError";
    this.databasePath = databasePath;
  }
}

/**
 * Small adapter over the synchronous SQLite implementations shipped by Node and
 * Bun. Production Node uses `node:sqlite`; the Bun branch keeps the project's
 * Bun test runner on the same SQL and transaction semantics without coupling
 * repositories to either runtime-specific module.
 */
export class CentralSqliteDatabase {
  readonly path: string;
  readonly driver: CentralSqliteDriver;
  #native: NativeDatabase;
  #closed = false;
  #transactionDepth = 0;

  constructor(databasePath: string, driver: CentralSqliteDriver, native: NativeDatabase) {
    this.path = databasePath;
    this.driver = driver;
    this.#native = native;
  }

  get isOpen(): boolean {
    return !this.#closed;
  }

  exec(sql: string): void {
    this.assertOpen();
    this.#native.exec(sql);
  }

  prepare(sql: string): CentralSqliteStatement {
    this.assertOpen();
    const statement = this.#native.prepare(sql);
    return {
      run: (...parameters) => statement.run(...parameters),
      get: <T>(...parameters: CentralSqliteBindParameter[]) => statement.get(...parameters) as T | undefined,
      all: <T>(...parameters: CentralSqliteBindParameter[]) => statement.all(...parameters) as T[],
    };
  }

  /**
   * Run a synchronous unit of work transactionally. Nested calls use
   * savepoints, allowing repositories to compose operations safely.
   */
  transaction<T>(operation: () => T): T {
    this.assertOpen();
    const depth = this.#transactionDepth;
    const savepoint = `central_tx_${depth}`;
    this.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.#transactionDepth += 1;
    try {
      const result = operation();
      if (isPromiseLike(result)) {
        throw new TypeError("Central SQLite transactions must use a synchronous callback");
      }
      this.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try {
        this.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Central SQLite transaction and rollback both failed");
      }
      throw error;
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#native.close();
    this.#closed = true;
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error(`Central SQLite database "${this.path}" is closed`);
  }
}

/**
 * Open and configure a central SQLite database.
 *
 * Foreign-key enforcement is enabled per connection. File databases default to
 * write-ahead logging with NORMAL synchronization and a bounded busy timeout;
 * SQLite correctly retains its `memory` journal for `:memory:` databases.
 */
export async function openCentralSqliteDatabase(
  options: OpenCentralSqliteDatabaseOptions | string,
): Promise<CentralSqliteDatabase> {
  const resolved = typeof options === "string" ? { path: options } : options;
  const databasePath = resolved.path.trim();
  if (!databasePath) throw new CentralSqliteOpenError(resolved.path, "path must be a non-empty string");

  const busyTimeoutMs = resolved.busyTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new CentralSqliteOpenError(databasePath, "busyTimeoutMs must be a non-negative safe integer");
  }

  try {
    await ensureDatabaseDirectory(databasePath);
  } catch (error) {
    throw new CentralSqliteOpenError(databasePath, `could not create its parent directory (${errorMessage(error)})`, error);
  }

  const useBunDriver = hasBunRuntime();
  const driver: CentralSqliteDriver = useBunDriver ? "bun:sqlite" : "node:sqlite";
  let native: NativeDatabase | undefined;
  try {
    // A variable specifier prevents one runtime from resolving the other
    // runtime's builtin during module loading.
    const moduleName = driver;
    const sqlite = await import(moduleName) as NativeSqliteModule;
    const Constructor = useBunDriver ? sqlite.Database : sqlite.DatabaseSync;
    if (Constructor === undefined) throw new Error(`${driver} did not expose a synchronous Database constructor`);
    native = new Constructor(databasePath);
    const database = new CentralSqliteDatabase(databasePath, driver, native);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`PRAGMA journal_mode = ${resolved.journalMode ?? "WAL"}`);
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);

    const foreignKeys = database.prepare("PRAGMA foreign_keys").get<Record<string, number>>();
    if (foreignKeys === undefined || Number(Object.values(foreignKeys)[0]) !== 1) {
      throw new Error("SQLite refused to enable PRAGMA foreign_keys");
    }
    return database;
  } catch (error) {
    try {
      native?.close();
    } catch {
      // Preserve the actionable open/configuration error.
    }
    const runtimeHint = useBunDriver
      ? "the bun:sqlite builtin must be available"
      : "Node.js 22.5 or newer with the node:sqlite builtin is required";
    throw new CentralSqliteOpenError(databasePath, `${errorMessage(error)}; ${runtimeHint}`, error);
  }
}

async function ensureDatabaseDirectory(databasePath: string): Promise<void> {
  if (databasePath === ":memory:" || databasePath.startsWith("file:")) return;
  await mkdir(path.dirname(path.resolve(databasePath)), { recursive: true });
}

function hasBunRuntime(): boolean {
  return "Bun" in globalThis;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
