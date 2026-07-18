import type { CentralSchemaMigration } from "./migrations.js";

/**
 * Initial durable control-plane schema.
 *
 * JSON payloads preserve forward-compatible domain fields while extracted
 * columns provide stable keys and query indexes for repositories. Audit rows
 * intentionally do not reference mutable resources so deleting catalog or
 * policy state cannot erase its history.
 */
const INITIAL_CONTROL_PLANE_SCHEMA = `
CREATE TABLE catalog_items (
  kind TEXT NOT NULL CHECK (kind IN ('loadout', 'materia')),
  id TEXT NOT NULL,
  name TEXT,
  description TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  updated_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  provenance_json TEXT CHECK (provenance_json IS NULL OR json_valid(provenance_json)),
  PRIMARY KEY (kind, id)
);

CREATE INDEX catalog_items_updated_at_idx
  ON catalog_items (updated_at);
CREATE INDEX catalog_items_name_idx
  ON catalog_items (name);

CREATE TABLE model_policies (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  updated_at TEXT NOT NULL,
  document_json TEXT NOT NULL CHECK (json_valid(document_json))
);

CREATE INDEX model_policies_updated_at_idx
  ON model_policies (updated_at);

CREATE TABLE active_model_policy (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  policy_id TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (policy_id) REFERENCES model_policies (id) ON DELETE CASCADE
);

CREATE TABLE audit_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT,
  auth_method TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  scope_json TEXT CHECK (scope_json IS NULL OR json_valid(scope_json)),
  occurred_at TEXT NOT NULL,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('success', 'denied', 'error')),
  reason TEXT,
  source TEXT,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json))
);

CREATE INDEX audit_records_occurred_at_idx
  ON audit_records (occurred_at);
CREATE INDEX audit_records_principal_id_idx
  ON audit_records (principal_id, occurred_at);
CREATE INDEX audit_records_resource_idx
  ON audit_records (resource_type, resource_id, occurred_at);

CREATE TABLE telemetry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  runtime_id TEXT,
  scope_json TEXT CHECK (scope_json IS NULL OR json_valid(scope_json)),
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  sequence REAL NOT NULL,
  cast_id TEXT NOT NULL,
  socket_id TEXT NOT NULL,
  materia TEXT NOT NULL,
  visit REAL NOT NULL,
  severity TEXT,
  event_json TEXT NOT NULL CHECK (json_valid(event_json))
);

CREATE INDEX telemetry_events_runtime_id_idx
  ON telemetry_events (runtime_id, id);
CREATE INDEX telemetry_events_cast_id_idx
  ON telemetry_events (cast_id, id);
CREATE INDEX telemetry_events_sequence_idx
  ON telemetry_events (sequence, id);
CREATE INDEX telemetry_events_runtime_sequence_idx
  ON telemetry_events (runtime_id, sequence, id);
CREATE INDEX telemetry_events_occurred_at_idx
  ON telemetry_events (occurred_at, id);
CREATE INDEX telemetry_events_ingested_at_idx
  ON telemetry_events (ingested_at, id);
`;

/** Ordered migrations known to this central-server build. */
export const CENTRAL_SCHEMA_MIGRATIONS: readonly CentralSchemaMigration[] = Object.freeze([
  Object.freeze({
    version: 1,
    name: "initial-control-plane-schema",
    sql: INITIAL_CONTROL_PLANE_SCHEMA,
  }),
]);

/** Highest schema version understood by this central-server build. */
export const CENTRAL_SCHEMA_VERSION = CENTRAL_SCHEMA_MIGRATIONS.at(-1)?.version ?? 0;
