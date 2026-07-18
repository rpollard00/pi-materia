import type { EnrichedEvent } from "../../domain/eventing.js";
import { isEventSeverity } from "../../domain/eventing.js";
import type { TelemetryIngestInput } from "../../application/controlPlane.js";
import { isScopePath, type ScopePath } from "../../domain/scope.js";

/**
 * Normalization for the central telemetry ingestion endpoint.
 *
 * Builds on the existing event bus + webhook **sink** contracts
 * (docs/enterprise-control-plane.md §15, §16.15; [Runtime eventing](../../runtime-eventing.md)):
 * the canonical payload a local pi-materia runtime emits is the runtime-enriched
 * event shape ({@link EnrichedEvent}). A runtime delivers these to the central
 * control plane via the existing webhook sink (typically with the `passthrough`
 * body template, which POSTs the full enriched event), and the central ingestion
 * endpoint normalizes the inbound JSON back into that shape before storing.
 *
 * This is a **sink**, not a control channel: it records and serves events but
 * never issues lifecycle/claim/state commands back into pi-materia or
 * `agent_router` (§6). It does not synchronize local cast/session state.
 *
 * Normalization is a pure function over untrusted JSON: it validates the batch
 * envelope, validates each candidate event against the required enriched-event
 * fields, keeps only known fields (whitelist normalization — unknown fields are
 * dropped), and reports how many candidates were rejected. The HTTP route
 * (src/central/server/telemetry.ts) calls {@link normalizeTelemetryIngestBody}
 * and then hands the normalized {@link TelemetryIngestInput} to the
 * {@link TelemetryStatusPort} port, so the configured durable or in-memory
 * adapter only ever receives normalized events.
 */

// ───────────────────────────────────────────────────────────────────────
// Result types
// ───────────────────────────────────────────────────────────────────────

/** Normalized telemetry ingest: the port input plus a rejected-event count. */
export interface NormalizedTelemetryIngest {
  /** Port input built from the normalized batch. */
  readonly input: TelemetryIngestInput;
  /** Candidate events that failed normalization and were dropped. */
  readonly rejected: number;
}

export type NormalizeTelemetryIngestResult =
  | { readonly ok: true; readonly value: NormalizedTelemetryIngest }
  | { readonly ok: false; readonly error: string };

export interface NormalizeTelemetryIngestOptions {
  /** Fallback originating runtime id (e.g. from a query param); envelope value wins. */
  readonly runtimeId?: string;
  /** Fallback originating scope; envelope value wins. */
  readonly scope?: ScopePath;
}

// ───────────────────────────────────────────────────────────────────────
// Batch normalization
// ───────────────────────────────────────────────────────────────────────

/**
 * Normalize an inbound telemetry ingest body into a port input.
 *
 * Accepts three shapes so the endpoint interoperates with the webhook sink's
 * per-event `passthrough` POST and with explicit batch POSTs:
 * - A **single enriched event** object (webhook passthrough: one event per POST).
 * - An **array** of enriched events.
 * - A **batch envelope** `{ events: EnrichedEvent[], runtimeId?, scope? }`.
 *
 * Envelope `runtimeId`/`scope` override the option fallbacks. Per-event
 * normalization is lenient: valid events are normalized and accepted; malformed
 * candidates are dropped and counted in `rejected` so one bad event never blocks
 * the rest of a batch (telemetry ingestion is best-effort). The envelope itself
 * must be structurally valid or the whole request is rejected (`ok: false`).
 */
export function normalizeTelemetryIngestBody(
  body: unknown,
  options: NormalizeTelemetryIngestOptions = {},
): NormalizeTelemetryIngestResult {
  let candidates: unknown[];
  let envelopeRuntimeId: string | undefined;
  let envelopeScope: ScopePath | undefined;

  if (Array.isArray(body)) {
    candidates = body;
  } else if (isPlainObject(body)) {
    if (Array.isArray(body.events)) {
      candidates = body.events;
      envelopeRuntimeId = readRuntimeId(body.runtimeId);
      envelopeScope = readScope(body.scope);
    } else if (looksLikeEnrichedEvent(body)) {
      candidates = [body];
    } else {
      return fail(
        "telemetry ingest body must be an enriched event, an array of events, or an envelope with an `events` array.",
      );
    }
  } else {
    return fail("telemetry ingest body must be a JSON object or array.");
  }

  const events: EnrichedEvent[] = [];
  let rejected = 0;
  for (const candidate of candidates) {
    const normalized = normalizeEnrichedEvent(candidate);
    if (normalized === undefined) {
      rejected++;
      continue;
    }
    events.push(normalized);
  }

  const runtimeId = envelopeRuntimeId ?? options.runtimeId;
  const scope = envelopeScope ?? options.scope;

  const input: TelemetryIngestInput = {
    events,
    ...(runtimeId !== undefined ? { runtimeId } : {}),
    ...(scope !== undefined ? { scope } : {}),
  };

  return { ok: true, value: { input, rejected } };
}

// ───────────────────────────────────────────────────────────────────────
// Single-event normalization
// ───────────────────────────────────────────────────────────────────────

/**
 * Validate and normalize a single inbound event into the canonical
 * {@link EnrichedEvent} shape.
 *
 * Required enriched fields must be present with valid types or the event is
 * rejected (`undefined`). Known optional fields are kept when valid and dropped
 * when malformed (lenient normalization); unknown fields are dropped. Nested
 * `source` is reduced to its known `{ materia?, socketId? }` fields.
 *
 * Returns `undefined` for any value that is not a structurally valid enriched
 * event, so callers can count it as rejected without distinguishing failure modes.
 */
export function normalizeEnrichedEvent(value: unknown): EnrichedEvent | undefined {
  if (!isPlainObject(value)) return undefined;

  // ── Required enriched fields ─────────────────────────────────────
  const type = value.type;
  if (typeof type !== "string" || type.trim().length === 0) return undefined;
  const eventId = value.eventId;
  if (typeof eventId !== "string" || eventId.length === 0) return undefined;
  const occurredAt = value.occurredAt;
  if (typeof occurredAt !== "string" || occurredAt.length === 0) return undefined;
  const sequence = value.sequence;
  if (typeof sequence !== "number" || !Number.isFinite(sequence)) return undefined;
  const castId = value.castId;
  if (typeof castId !== "string" || castId.length === 0) return undefined;
  const socketId = value.socketId;
  if (typeof socketId !== "string" || socketId.length === 0) return undefined;
  const materia = value.materia;
  if (typeof materia !== "string" || materia.length === 0) return undefined;
  const visit = value.visit;
  if (typeof visit !== "number" || !Number.isFinite(visit)) return undefined;

  const event: EnrichedEvent = {
    type,
    eventId,
    occurredAt,
    sequence,
    castId,
    socketId,
    materia,
    visit,
  };

  // ── Optional fields (kept when valid, dropped when malformed) ────
  const severity = value.severity;
  if (typeof severity === "string" && isEventSeverity(severity)) {
    event.severity = severity;
  }

  const message = value.message;
  if (typeof message === "string") {
    event.message = message;
  }

  const payload = value.payload;
  if (isPlainObject(payload)) {
    event.payload = payload;
  }

  const source = value.source;
  if (isPlainObject(source)) {
    const sourceObj: { materia?: string; socketId?: string } = {};
    if (typeof source.materia === "string") sourceObj.materia = source.materia;
    if (typeof source.socketId === "string") sourceObj.socketId = source.socketId;
    if (sourceObj.materia !== undefined || sourceObj.socketId !== undefined) {
      event.source = sourceObj;
    }
  }

  const materiaLabel = value.materiaLabel;
  if (typeof materiaLabel === "string") {
    event.materiaLabel = materiaLabel;
  }

  const itemKey = value.itemKey;
  if (typeof itemKey === "string") {
    event.itemKey = itemKey;
  }

  const itemLabel = value.itemLabel;
  if (typeof itemLabel === "string") {
    event.itemLabel = itemLabel;
  }

  return event;
}

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

/** True when a plain object looks like an enriched event (has `type` + `eventId`). */
function looksLikeEnrichedEvent(value: Record<string, unknown>): boolean {
  return typeof value.type === "string" && typeof value.eventId === "string";
}

/** Read a non-empty runtime id string, or undefined when absent/invalid. */
function readRuntimeId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value;
  return undefined;
}

/** Read a valid scope path, or undefined when absent/invalid (lenient). */
function readScope(value: unknown): ScopePath | undefined {
  if (value === undefined) return undefined;
  if (isScopePath(value)) return value;
  return undefined;
}

function fail(error: string): NormalizeTelemetryIngestResult {
  return { ok: false, error };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
