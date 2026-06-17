import type { DomainResult } from "./result.js";
import { err, ok } from "./result.js";

// ── Constants ──────────────────────────────────────────────────────────

/** Reserved top-level side-channel field name. */
export const EVENT_SIDECHANNEL_FIELD = "event" as const;

/** Allowed severity levels for materia-emitted events. */
export const EVENT_SEVERITY_LEVELS = [
  "debug",
  "info",
  "warning",
  "error",
  "critical",
] as const;

export type EventSeverity = (typeof EVENT_SEVERITY_LEVELS)[number];

// ── Materia-Emitted Event Shapes ───────────────────────────────────────

/**
 * Optional provenance that a materia may self-report.
 * The runtime adds authoritative metadata during enrichment regardless.
 */
export interface MateriaEventSource {
  materia?: string;
  socketId?: string;
}

/**
 * Shape of a single event object in the `event` side-channel array.
 * Emitted by agent or utility materia in their JSON output.
 */
export interface MateriaEventObject {
  /** Required — dot-separated event kind (e.g. "result.pr_created", "status.progress"). */
  type: string;
  /** Severity level — defaults to "info" when not explicitly provided. */
  severity?: EventSeverity;
  /** Human-readable summary. */
  message?: string;
  /** Type-specific payload data. */
  payload?: Record<string, unknown>;
  /** Optional self-reported provenance. */
  source?: MateriaEventSource;
}

// ── Runtime-Enriched Event Shape ───────────────────────────────────────

/**
 * Full runtime event after enrichment.
 * All materia-emitted fields are preserved; runtime metadata is added.
 */
export interface EnrichedEvent extends MateriaEventObject {
  // Runtime-enriched fields
  /** Unique per-event identifier (UUID). */
  eventId: string;
  /** ISO 8601 timestamp of when the event was processed. */
  occurredAt: string;
  /** Monotonic per-cast sequence number (1-based). */
  sequence: number;
  /** Current cast identifier. */
  castId: string;
  /** Socket that produced this event. */
  socketId: string;
  /** Materia id. */
  materia: string;
  /** Materia display label (when available). */
  materiaLabel?: string;
  /** Socket visit counter. */
  visit: number;
  /** Current work item key (when in a loop region). */
  itemKey?: string;
  /** Current work item label (when in a loop region). */
  itemLabel?: string;
}

// ── Validation ─────────────────────────────────────────────────────────

/**
 * Validates a materia-emitted `event` side-channel array.
 *
 * Rules (per docs/runtime-eventing.md §2.3–2.4):
 * - Must be an array (when present).
 * - Each element must be a plain object.
 * - Each element must have a non-empty string `type`.
 * - `severity` (if present) must be a valid EventSeverity.
 * - `message` (if present) must be a string.
 * - `payload` (if present) must be a plain object.
 * - `source` (if present) must be a plain object with optional string materia/socketId.
 * - Unknown fields are allowed (forward-compatible).
 * - Empty arrays are legal no-ops.
 *
 * Returns a DomainResult with the validated MateriaEventObject[] on success,
 * or issues describing validation failures.
 */
export function validateMateriaEventArray(
  value: unknown,
): DomainResult<MateriaEventObject[]> {
  // Absent or null event is not an error — it's just absent.
  if (value === undefined || value === null) return ok([]);

  if (!Array.isArray(value)) {
    return err(
      "$.event",
      `event side-channel must be an array when present; got ${typeof value}`,
    );
  }

  const events: MateriaEventObject[] = [];
  const issues: { path: string; message: string }[] = [];

  for (let i = 0; i < value.length; i++) {
    const elem = value[i];
    const path = `$.event[${i}]`;

    if (!isPlainObject(elem)) {
      issues.push({ path, message: `event element must be a plain object; got ${typeof elem}` });
      continue;
    }

    const elementIssues = validateSingleEventObject(elem, path);
    if (elementIssues.length > 0) {
      issues.push(...elementIssues);
      continue;
    }

    // Safe cast after validation.
    events.push(elem as unknown as MateriaEventObject);
  }

  if (issues.length > 0) return { ok: false, issues };
  return ok(events);
}

function validateSingleEventObject(
  obj: Record<string, unknown>,
  path: string,
): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];

  // ── type (required) ──────────────────────────────────────────────
  if (!Object.prototype.hasOwnProperty.call(obj, "type")) {
    issues.push({
      path: `${path}.type`,
      message: 'event object requires a "type" field',
    });
  } else if (typeof obj.type !== "string" || obj.type.trim().length === 0) {
    issues.push({
      path: `${path}.type`,
      message: `event type must be a non-empty string; got ${typeof obj.type}`,
    });
  }

  // ── severity (optional, must be valid if present) ────────────────
  if (Object.prototype.hasOwnProperty.call(obj, "severity")) {
    if (typeof obj.severity !== "string" || !isEventSeverity(obj.severity)) {
      issues.push({
        path: `${path}.severity`,
        message: `severity must be one of ${EVENT_SEVERITY_LEVELS.map((s) => JSON.stringify(s)).join(", ")}; got ${JSON.stringify(obj.severity)}`,
      });
    }
  }

  // ── message (optional, must be string if present) ────────────────
  if (Object.prototype.hasOwnProperty.call(obj, "message")) {
    if (typeof obj.message !== "string") {
      issues.push({
        path: `${path}.message`,
        message: `message must be a string when present; got ${typeof obj.message}`,
      });
    }
  }

  // ── payload (optional, must be plain object if present) ──────────
  if (Object.prototype.hasOwnProperty.call(obj, "payload")) {
    if (!isPlainObject(obj.payload)) {
      issues.push({
        path: `${path}.payload`,
        message: `payload must be a plain object when present; got ${typeof obj.payload}`,
      });
    }
  }

  // ── source (optional, must be plain object if present) ───────────
  if (Object.prototype.hasOwnProperty.call(obj, "source")) {
    if (!isPlainObject(obj.source)) {
      issues.push({
        path: `${path}.source`,
        message: `source must be a plain object when present; got ${typeof obj.source}`,
      });
    } else {
      // Validate nested source fields if present.
      const src = obj.source as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(src, "materia") && typeof src.materia !== "string") {
        issues.push({
          path: `${path}.source.materia`,
          message: `source.materia must be a string when present; got ${typeof src.materia}`,
        });
      }
      if (Object.prototype.hasOwnProperty.call(src, "socketId") && typeof src.socketId !== "string") {
        issues.push({
          path: `${path}.source.socketId`,
          message: `source.socketId must be a string when present; got ${typeof src.socketId}`,
        });
      }
    }
  }

  return issues;
}

// ── Type Guards ─────────────────────────────────────────────────────────

export function isEventSeverity(value: string): value is EventSeverity {
  return (EVENT_SEVERITY_LEVELS as readonly string[]).includes(value);
}

/** Default severity used when a materia event omits it. */
export const DEFAULT_EVENT_SEVERITY: EventSeverity = "info";

// ── Result Type Helpers ─────────────────────────────────────────────────

/**
 * Shorthand that returns `true` when the `event` field value is valid (or absent).
 * Primarily used for quick presence checks before dispatching.
 */
export function isValidEventArray(value: unknown): value is MateriaEventObject[] {
  if (!Array.isArray(value)) return false;
  return value.every(isValidEventObject);
}

function isValidEventObject(value: unknown): value is MateriaEventObject {
  if (!isPlainObject(value)) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== "string" || obj.type.trim().length === 0) return false;
  if (Object.prototype.hasOwnProperty.call(obj, "severity") && !isEventSeverity(String(obj.severity))) return false;
  if (Object.prototype.hasOwnProperty.call(obj, "message") && typeof obj.message !== "string") return false;
  if (Object.prototype.hasOwnProperty.call(obj, "payload") && !isPlainObject(obj.payload)) return false;
  if (Object.prototype.hasOwnProperty.call(obj, "source") && !isPlainObject(obj.source)) return false;
  return true;
}

// ── Enrichment ──────────────────────────────────────────────────────────

/** Context required to enrich materia-emitted events with runtime metadata. */
export interface EnrichmentContext {
  /** Current cast identifier. */
  castId: string;
  /** Socket that produced these events. */
  socketId: string;
  /** Materia id. */
  materia: string;
  /** Materia display label (when available). */
  materiaLabel?: string;
  /** Socket visit counter. */
  visit: number;
  /** Current work item key (when in a loop region). */
  itemKey?: string;
  /** Current work item label (when in a loop region). */
  itemLabel?: string;
}

/**
 * Monotonic per-cast sequence counter.
 *
 * Sequence numbers are 1-based and shared across all event sources
 * (materia-emitted and runtime-owned) to ensure total ordering.
 */
export class SequenceCounter {
  private next = 1;

  /** Return the next sequence number and advance the counter. */
  nextValue(): number {
    return this.next++;
  }

  /** Return the current counter value without advancing. */
  peek(): number {
    return this.next;
  }

  /** Reset the counter to 1 (for testing). */
  reset(): void {
    this.next = 1;
  }
}

/**
 * Factory for {@link SequenceCounter} — exposed so cast-level infrastructure
 * can create and own the singleton counter without importing the class directly.
 */
export function createSequenceCounter(): SequenceCounter {
  return new SequenceCounter();
}

/**
 * Enrich validated materia-emitted events with runtime metadata.
 *
 * Each event receives a unique eventId (generated by the supplied `generateEventId`),
 * an ISO 8601 occurredAt timestamp, a monotonic per-cast sequence number, and the
 * provided cast/socket/materia context.
 *
 * The input array order is preserved exactly. The output {@link EnrichedEvent}
 * array is deterministic given the same inputs, sequence counter, and eventId
 * generator state.
 *
 * @param events            Validated materia-emitted events (may be empty).
 * @param ctx               Runtime context for enrichment.
 * @param seq               Shared per-cast sequence counter.
 * @param generateEventId   Produces a unique eventId string for each event.
 * @returns                 Enriched events in the same order as the input array.
 */
export function enrichEvents(
  events: readonly MateriaEventObject[],
  ctx: EnrichmentContext,
  seq: SequenceCounter,
  generateEventId: () => string,
): EnrichedEvent[] {
  const now = new Date().toISOString();

  return events.map((event): EnrichedEvent => {
    // Spread all materia-emitted fields first (including forward-compatible
    // unknown fields per §2.4), then layer runtime-enriched fields on top.
    // Runtime fields have no collision with user fields so order is safe.
    const enriched: EnrichedEvent = {
      ...event,
      severity: event.severity ?? DEFAULT_EVENT_SEVERITY,

      // Runtime-enriched fields
      eventId: generateEventId(),
      occurredAt: now,
      sequence: seq.nextValue(),
      castId: ctx.castId,
      socketId: ctx.socketId,
      materia: ctx.materia,
      ...(ctx.materiaLabel !== undefined ? { materiaLabel: ctx.materiaLabel } : {}),
      visit: ctx.visit,
      ...(ctx.itemKey !== undefined ? { itemKey: ctx.itemKey } : {}),
      ...(ctx.itemLabel !== undefined ? { itemLabel: ctx.itemLabel } : {}),
    };

    return enriched;
  });
}

// ── Utilities ───────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
