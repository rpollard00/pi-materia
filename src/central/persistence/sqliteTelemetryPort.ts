import {
  centralAdminModeMetadata,
  type ControlPlaneModeMetadata,
  type ControlPlaneStatusSnapshot,
  type TelemetryEventFilter,
  type TelemetryIngestInput,
  type TelemetryIngestResult,
  type TelemetryStatusPort,
} from "../../application/controlPlane.js";
import type { EnrichedEvent } from "../../domain/eventing.js";
import { DEFAULT_CENTRAL_RETENTION_DAYS } from "../config/controlPlaneConfig.js";
import { nowIso } from "../controlPlane/shared.js";
import type {
  CentralSqliteBindValue,
  CentralSqliteDatabase,
} from "./sqliteDatabase.js";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
const MINIMUM_DATE_MILLISECONDS = -8_640_000_000_000_000;

interface TelemetryEventRow {
  readonly id: number;
  readonly eventJson: string;
}

/** Schedule an independent retention pass after an operation has completed. */
export type CentralTelemetryRetentionScheduler = (operation: () => void) => void;

export interface SqliteCentralTelemetryPortOptions {
  /** Human-readable label included in status/mode metadata. */
  readonly label?: string;
  /** Central API base URL included in mode metadata, when known. */
  readonly centralApiBaseUrl?: string;
  /** Number of ingestion days retained. Defaults to the central server default. */
  readonly retentionDays?: number;
  /** Stable clock for ingestion/status/retention tests; defaults to {@link nowIso}. */
  readonly clock?: () => string;
  /**
   * Retention work scheduler. The default uses an unref'ed zero-delay timer so
   * pruning never extends the ingestion request or keeps the process alive.
   */
  readonly scheduleRetention?: CentralTelemetryRetentionScheduler;
  /** Best-effort diagnostic hook for a failed asynchronous retention pass. */
  readonly onRetentionError?: (error: unknown) => void;
}

/** SQLite telemetry port with an explicit maintenance hook for startup/tests. */
export interface SqliteCentralTelemetryPort extends TelemetryStatusPort {
  /** Delete physically expired rows now and return the number removed. */
  enforceRetention(): number;
}

/**
 * Create a durable telemetry/status adapter over an initialized central SQLite
 * database.
 *
 * A batch is inserted in one transaction. Retention uses `ingested_at`, rather
 * than the runtime-supplied event timestamp, and is pruned in separately
 * scheduled work so cleanup cannot delay ingestion. Reads and status counts
 * also apply the cutoff in SQL, making expired rows immediately invisible even
 * when their best-effort physical cleanup has not run yet.
 */
export function createSqliteCentralTelemetryPort(
  database: CentralSqliteDatabase,
  options: SqliteCentralTelemetryPortOptions = {},
): SqliteCentralTelemetryPort {
  const retentionDays = options.retentionDays ?? DEFAULT_CENTRAL_RETENTION_DAYS;
  requireRetentionDays(retentionDays);
  const clock = options.clock ?? nowIso;
  const scheduleRetention = options.scheduleRetention ?? scheduleWithUnrefTimer;
  const modeMetadata: ControlPlaneModeMetadata = centralAdminModeMetadata({
    ...(options.label !== undefined ? { label: options.label } : {}),
    ...(options.centralApiBaseUrl !== undefined ? { centralApiBaseUrl: options.centralApiBaseUrl } : {}),
  });

  const insert = database.prepare(`
    INSERT INTO telemetry_events (
      event_id, runtime_id, scope_json, event_type, occurred_at, ingested_at,
      sequence, cast_id, socket_id, materia, visit, severity, event_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let retentionPending = false;

  function retentionCutoff(referenceTime: string): string {
    const referenceMilliseconds = Date.parse(referenceTime);
    if (!Number.isFinite(referenceMilliseconds)) {
      throw new Error(`Central telemetry clock returned an invalid RFC3339 timestamp: ${JSON.stringify(referenceTime)}`);
    }
    // Clamp extremely large configured intervals to SQLite's representable ISO
    // date floor instead of allowing Date arithmetic to produce an invalid date.
    const cutoffMilliseconds = Math.max(
      MINIMUM_DATE_MILLISECONDS,
      referenceMilliseconds - retentionDays * MILLISECONDS_PER_DAY,
    );
    return new Date(cutoffMilliseconds).toISOString();
  }

  function enforceRetention(): number {
    const cutoff = retentionCutoff(clock());
    return database.transaction(() => database.prepare(
      "DELETE FROM telemetry_events WHERE ingested_at < ?",
    ).run(cutoff).changes);
  }

  function reportRetentionError(error: unknown): void {
    try {
      options.onRetentionError?.(error);
    } catch {
      // Retention diagnostics must remain best-effort too.
    }
  }

  function requestRetention(): void {
    if (retentionPending) return;
    retentionPending = true;
    try {
      scheduleRetention(() => {
        try {
          enforceRetention();
        } catch (error) {
          reportRetentionError(error);
        } finally {
          retentionPending = false;
        }
      });
    } catch (error) {
      retentionPending = false;
      reportRetentionError(error);
    }
  }

  function queryEvents(filter?: TelemetryEventFilter): EnrichedEvent[] {
    requestRetention();
    const limit = normalizedLimit(filter?.limit);
    if (limit === 0) return [];
    if (filter?.sinceSequence !== undefined && Number.isNaN(filter.sinceSequence)) return [];
    if (filter?.sinceSequence === Number.POSITIVE_INFINITY) return [];

    const where = ["ingested_at >= ?"];
    const parameters: CentralSqliteBindValue[] = [retentionCutoff(clock())];
    if (filter?.runtimeId !== undefined) {
      where.push("runtime_id = ?");
      parameters.push(filter.runtimeId);
    }
    if (filter?.castId !== undefined) {
      where.push("cast_id = ?");
      parameters.push(filter.castId);
    }
    if (filter?.sinceSequence !== undefined && Number.isFinite(filter.sinceSequence)) {
      where.push("sequence >= ?");
      parameters.push(filter.sinceSequence);
    }

    const limitSql = limit === undefined ? "" : " LIMIT ?";
    if (limit !== undefined) parameters.push(limit);
    const rows = database.prepare(`
      SELECT id, event_json AS eventJson
      FROM telemetry_events
      WHERE ${where.join(" AND ")}
      ORDER BY id ASC${limitSql}
    `).all<TelemetryEventRow>(...parameters);
    return rows.map(fromRow);
  }

  // Apply retention after startup without delaying server composition/binding.
  requestRetention();

  return {
    mode: () => modeMetadata,
    async ingest(input: TelemetryIngestInput): Promise<TelemetryIngestResult> {
      const events = Array.isArray(input.events) ? input.events : [];
      const ingestedAt = clock();
      // Validate the timestamp before opening the write transaction. This also
      // ensures every inserted timestamp is usable by retention comparisons.
      retentionCutoff(ingestedAt);
      const scopeJson = input.scope === undefined ? null : JSON.stringify(input.scope);
      database.transaction(() => {
        for (const event of events) {
          insert.run(
            event.eventId,
            input.runtimeId ?? null,
            scopeJson,
            event.type,
            event.occurredAt,
            ingestedAt,
            event.sequence,
            event.castId,
            event.socketId,
            event.materia,
            event.visit,
            event.severity ?? null,
            JSON.stringify(event),
          );
        }
      });
      requestRetention();
      return { accepted: events.length, ingestedAt };
    },
    async status(): Promise<ControlPlaneStatusSnapshot> {
      requestRetention();
      const capturedAt = clock();
      const cutoff = retentionCutoff(capturedAt);
      const counts = database.prepare(`
        SELECT
          COUNT(*) AS eventCount,
          COUNT(DISTINCT runtime_id) AS runtimeCount
        FROM telemetry_events
        WHERE ingested_at >= ?
      `).get<{ eventCount: number; runtimeCount: number }>(cutoff);
      return {
        mode: "central-admin",
        capturedAt,
        healthy: true,
        eventCount: Number(counts?.eventCount ?? 0),
        runtimeCount: Number(counts?.runtimeCount ?? 0),
        ...(options.label !== undefined ? { label: options.label } : {}),
      };
    },
    async queryEvents(filter?: TelemetryEventFilter): Promise<EnrichedEvent[]> {
      return queryEvents(filter);
    },
    enforceRetention,
  };
}

function fromRow(row: TelemetryEventRow): EnrichedEvent {
  try {
    return JSON.parse(row.eventJson) as EnrichedEvent;
  } catch (error) {
    throw new Error(`Could not parse stored telemetry event row ${row.id}`, { cause: error });
  }
}

function normalizedLimit(limit: number | undefined): number | undefined {
  if (limit === undefined || !Number.isFinite(limit)) return undefined;
  return Math.max(0, Math.floor(limit));
}

function requireRetentionDays(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("central telemetry retentionDays must be a positive safe integer");
  }
}

function scheduleWithUnrefTimer(operation: () => void): void {
  const timer = setTimeout(operation, 0);
  timer.unref();
}
