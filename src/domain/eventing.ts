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
  // Absent event is not an error — it's just absent.
  // null is NOT treated as absent: when the event property exists in the parsed
  // JSON but is null, that's an invalid non-array value per §2.2/§2.4.
  if (value === undefined) return ok([]);

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

// ── Sink Interface ─────────────────────────────────────────────────────

/**
 * Common interface for every event sink.
 *
 * Sinks receive enriched events in dispatch order. If a sink throws or rejects,
 * the failure is captured as a diagnostic but does not propagate to the bus or
 * other sinks (per docs/runtime-eventing.md §4.2).
 */
export interface EventSink {
  /** Unique sink identifier (matches config sink id). */
  readonly id: string;
  /** Whether this sink is currently enabled for delivery. */
  readonly enabled: boolean;
  /** Deliver a single enriched event to this sink. */
  deliver(event: EnrichedEvent): Promise<void>;
  /** Optional flush — called when the bus wants sinks to finalize pending writes. */
  flush?(): Promise<void>;
  /**
   * Optional — present on sinks that deliver asynchronously (e.g. webhook).
   *
   * When present, the event bus treats the sink as async: {@link deliver}
   * returns before the actual delivery is known, so the bus records an
   * initial `queued` result and reconciles it with the real outcome drained
   * here during {@link EventBus.flush}. Sinks without this method are treated
   * as synchronous (their {@link deliver} result is final at dispatch time).
   */
  drainResults?(): AsyncDispatchResult[];
}

// ── Dispatch Outcomes ───────────────────────────────────────────────────

/**
 * The lifecycle state of a single event's delivery to a single sink.
 *
 * Used by {@link DispatchSinkResult} so the dispatch artifact can distinguish
 * real outcomes for async sinks (webhook) instead of falsely recording a
 * delivery the moment {@link EventSink.deliver} returns.
 */
export type DispatchStatus =
  /** HTTP/webhook delivery completed successfully (2xx) or a sync sink delivered. */
  | "delivered"
  /** Delivery failed after exhausting retries, or hit a non-retryable error. */
  | "failed"
  /** The sink intentionally did not deliver (disabled or filtered out by eventFilter). */
  | "skipped"
  /** Handed to an async sink but the real outcome is not yet known (pre-flush). */
  | "queued"
  /** The sink configuration is unusable (missing/invalid URL, etc.) — not retried. */
  | "misconfigured";

/**
 * Machine-readable reason codes for non-delivered statuses.
 *
 * These align with the webhook activation diagnostic reasons in
 * docs/runtime-eventing.md §9.6 where applicable so artifact consumers can
 * correlate dispatch failures with startup diagnostics.
 */
export type DispatchFailureReason =
  | "disabled"
  | "filtered_out"
  | "http_error"
  | "timeout"
  | "network_error"
  | "unknown_error"
  | "deliver_threw"
  | "target_url_missing"
  | "target_url_invalid";

/**
 * A single sink delivery failure captured during dispatch (legacy shape).
 *
 * @deprecated Prefer the richer {@link DispatchSinkResult} on
 * {@link DispatchOutcome.sinks}. This type is retained for backward-compatible
 * artifact consumers and is derived from `sinks[]` by the event bus.
 */
export interface DispatchFailure {
  /** Sink id that failed. */
  sinkId: string;
  /** Error message (redacted — never includes secrets or tokens). */
  error: string;
}

/**
 * Per-sink result for a single event, the authoritative dispatch detail.
 *
 * Aggregated in {@link DispatchOutcome.sinks}. The legacy `deliveredTo` and
 * `failures` fields are derived from this list.
 */
export interface DispatchSinkResult {
  /** Sink id this result describes. */
  sinkId: string;
  /** Final lifecycle status of the delivery. */
  status: DispatchStatus;
  /** HTTP response status code when available (webhook sinks). */
  statusCode?: number;
  /** Machine-readable reason for non-delivered statuses. */
  reason?: DispatchFailureReason;
  /** Redacted error/detail message for failed/misconfigured statuses. */
  error?: string;
}

/**
 * A {@link DispatchSinkResult} tied to a specific event.
 *
 * Async sinks (webhook) drain a flat list of these so the event bus can
 * reconcile each result back to the originating buffered outcome by
 * {@link DispatchOutcome.eventId}.
 */
export interface AsyncDispatchResult extends DispatchSinkResult {
  /** The event this result applies to. */
  eventId: string;
}

/**
 * Per-event dispatch outcome recorded to the dispatch artifact.
 *
 * Tracks which sinks received the event and any failures. The authoritative
 * detail lives in {@link sinks}; {@link deliveredTo} and {@link failures} are
 * backward-compatible derived views.
 */
export interface DispatchOutcome {
  /** The event's unique identifier. */
  eventId: string;
  /**
   * Authoritative per-sink results. Always populated by the event bus for
   * outcomes produced via {@link EventBus.dispatch}; manually-constructed
   * outcomes (e.g. test fixtures) may omit it.
   */
  sinks?: DispatchSinkResult[];
  /** Sink ids that successfully received this event (derived from `sinks`). */
  deliveredTo: string[];
  /** Sink failures (if any) — derived from `sinks`. */
  failures: DispatchFailure[];
  /** ISO 8601 timestamp of dispatch completion / finalization. */
  occurredAt: string;
}

// ── Result Accumulation & Final Outcome ───────────────────────────────

/**
 * Prefix shared by all result.* event types.
 *
 * Materia-emitted events with types starting with this prefix are tracked
 * by the {@link ResultAccumulator} for final outcome derivation.
 */
export const RESULT_EVENT_PREFIX = "result." as const;

/**
 * Well-known result event type constants.
 *
 * These are the documented result types from docs/runtime-eventing.md §10–11.
 * Materia may emit other result.* types; the accumulator tracks any type
 * starting with {@link RESULT_EVENT_PREFIX} but uses these constants for
 * outcome derivation.
 */
export const RESULT_EVENT_TYPES = {
  PR_CREATED: "result.pr_created",
  BRANCH_PUSHED: "result.branch_pushed",
  NO_CHANGES_NEEDED: "result.no_changes_needed",
  NEEDS_HUMAN: "result.needs_human",
} as const;

/**
 * Final controller-facing outcome derived from accumulated result events.
 *
 * Precedence order (docs/runtime-eventing.md §10.2):
 *   1. pr_created → `"pull_request_opened"`
 *   2. branch_pushed → `"branch_pushed"`
 *   3. no_changes_needed → `"no_changes_needed"`
 *   4. needs_human → `"needs_human"`
 *   5. Default (no explicit success result) → `"patch_created"`
 */
export type CastFinalOutcome =
  | "pull_request_opened"
  | "branch_pushed"
  | "no_changes_needed"
  | "needs_human"
  | "patch_created";

/**
 * Accumulates result.* events during a cast and derives the final
 * controller-facing outcome from the accumulated signals.
 *
 * ### Precedence Rules (docs/runtime-eventing.md §10.2–10.3)
 *
 * 1. {@link RESULT_EVENT_TYPES.PR_CREATED} → `"pull_request_opened"`
 * 2. {@link RESULT_EVENT_TYPES.BRANCH_PUSHED} → `"branch_pushed"`
 * 3. {@link RESULT_EVENT_TYPES.NO_CHANGES_NEEDED} → `"no_changes_needed"`
 * 4. {@link RESULT_EVENT_TYPES.NEEDS_HUMAN} → `"needs_human"`
 * 5. Default → `"patch_created"`
 *
 * ### Last-Wins Behavior
 *
 * If the same result type is emitted multiple times (e.g., two
 * `result.pr_created` events for different PRs), the **last** event of
 * that type wins for that type's signal. The precedence ladder then
 * resolves across types.
 *
 * If both `result.needs_human` and `result.pr_created` are emitted, the
 * precedence ladder means `pr_created` wins. This is intentional: if the
 * materia managed to create a PR and then encountered a human-blocking
 * issue, the PR exists and should be reported.
 *
 * ### Usage
 *
 * Create one accumulator per cast. Feed result events via {@link record}
 * as they are enriched. Call {@link deriveOutcome} at cast completion to
 * get the final outcome for lifecycle events and webhook delivery.
 */
export class ResultAccumulator {
  /**
   * Ordered list of all result.* events emitted during the cast.
   *
   * All result events are preserved (docs/runtime-eventing.md §10.1).
   * Last-wins applies only when deriving a type's signal (§10.3), not to
   * discarding prior events from the accumulated history.
   */
  readonly #all: EnrichedEvent[] = [];

  /**
   * Last event per result type for signal derivation and type-specific lookup.
   *
   * When the same result type is emitted multiple times, the last event
   * of that type wins for that type's signal in {@link deriveOutcome} and
   * {@link get}. All events remain in {@link #all} for history/context.
   */
  readonly #lastPerType = new Map<string, EnrichedEvent>();

  /**
   * Record an enriched event if it is a result.* event.
   *
   * Non-result events (types not starting with `"result."`) are silently
   * ignored. Result events are appended to the full history and update
   * the last-per-type slot for signal derivation (last-wins).
   */
  record(event: EnrichedEvent | MateriaEventObject): void {
    if (!event.type.startsWith(RESULT_EVENT_PREFIX)) return;
    const enriched = event as EnrichedEvent;
    this.#all.push(enriched);
    this.#lastPerType.set(enriched.type, enriched);
  }

  /**
   * Derive the final controller-facing outcome from accumulated signals.
   *
   * Uses last-per-type precedence (docs/runtime-eventing.md §10.2–10.3):
   * PR > branch > no_changes > needs_human > patch_created (default).
   *
   * @returns The derived {@link CastFinalOutcome}.
   */
  deriveOutcome(): CastFinalOutcome {
    const types = new Set(this.#lastPerType.keys());

    // Precedence ladder: check in priority order.
    if (types.has(RESULT_EVENT_TYPES.PR_CREATED)) return "pull_request_opened";
    if (types.has(RESULT_EVENT_TYPES.BRANCH_PUSHED)) return "branch_pushed";
    if (types.has(RESULT_EVENT_TYPES.NO_CHANGES_NEEDED)) return "no_changes_needed";
    if (types.has(RESULT_EVENT_TYPES.NEEDS_HUMAN)) return "needs_human";

    // Default: work completed but no explicit success result.
    return "patch_created";
  }

  /**
   * Return a snapshot of all accumulated result events in insertion order.
   *
   * Returns every result.* event emitted during the cast, not just the
   * last-wins event per type (docs/runtime-eventing.md §10.1). Useful for
   * including the full accumulated history in lifecycle terminal events.
   */
  getResultEvents(): EnrichedEvent[] {
    return [...this.#all];
  }

  /**
   * Return the last recorded event for a specific result type, if any.
   *
   * When the same type is emitted multiple times, returns the most recent
   * event (last-wins for that type's signal).
   *
   * @param type — The exact result event type to look up.
   */
  get(type: string): EnrichedEvent | undefined {
    return this.#lastPerType.get(type);
  }

  /** Total number of result.* events accumulated (including duplicates of the same type). */
  get size(): number {
    return this.#all.length;
  }

  /** Whether any result.* events have been accumulated. */
  get hasResults(): boolean {
    return this.#all.length > 0;
  }

  /** Clear all accumulated data (for testing). */
  reset(): void {
    this.#all.length = 0;
    this.#lastPerType.clear();
  }
}

// ── Utilities ───────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
