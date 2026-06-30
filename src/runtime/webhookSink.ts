import type { EventingWebhookSinkConfig, EventBodyFieldMapping, EventFilter } from "../types.js";
import type {
  AsyncDispatchResult,
  DispatchFailureReason,
  DispatchOutcome,
  EnrichedEvent,
  EventSink,
} from "../domain/eventing.js";

const timeoutReason = "webhook-timeout";

// ── Webhook Sink ────────────────────────────────────────────────────────

/**
 * Configurable webhook event sink.
 *
 * Delivers enriched events to an external HTTP endpoint with configurable
 * URL, method, headers, body mapping, event filtering, timeout, retry, and
 * exponential backoff.
 *
 * Delivery is **non-blocking** (per docs/runtime-eventing.md §6.5):
 * {@link deliver} enqueues the event for background processing and returns
 * immediately. The actual HTTP delivery happens asynchronously via an
 * internal serial queue. Call {@link flush} to wait for all pending
 * deliveries to complete (useful at cast terminal phases and in tests).
 *
 * The sink tracks consecutive failures and disables itself when
 * `discardingAfter` is reached. Async dispatch outcomes are stored
 * internally and can be retrieved with {@link drainOutcomes}.
 */
export class WebhookSink implements EventSink {
  readonly id: string;
  readonly #config: EventingWebhookSinkConfig;
  #active: boolean;
  #consecutiveFailures = 0;

  /** Internal serial queue — events are processed one at a time in FIFO order. */
  #queue: EnrichedEvent[] = [];
  /** Promise for the currently-running drain cycle (null when idle). */
  #drainPromise: Promise<void> | null = null;
  /** Async dispatch results produced by background deliveries and skips. */
  #asyncResults: AsyncDispatchResult[] = [];

  constructor(config: EventingWebhookSinkConfig) {
    this.id = config.id;
    this.#config = config;
    this.#active = config.enabled !== false;
  }

  get enabled(): boolean {
    return this.#active;
  }

  /** Exposed for tests — return the number of consecutive delivery failures. */
  get consecutiveFailures(): number {
    return this.#consecutiveFailures;
  }

  // ── EventSink contract ─────────────────────────────────────────────

  /**
   * Enqueue an event for background delivery.
   *
   * Returns immediately — the HTTP request (with retries, timeouts, and
   * backoff) happens asynchronously. This method never throws; delivery
   * outcomes are recorded as async dispatch results.
   *
   * Disabled and filtered-out events never reach the network: a `skipped`
   * result (with reason `disabled` or `filtered_out`) is recorded synchronously
   * so the dispatch artifact still reflects that the sink intentionally did
   * not deliver.
   */
  async deliver(event: EnrichedEvent): Promise<void> {
    if (!this.#active) {
      this.#asyncResults.push({
        eventId: event.eventId,
        sinkId: this.id,
        status: "skipped",
        reason: "disabled",
      });
      return;
    }

    // Apply event filter synchronously before enqueuing.
    if (!matchesFilter(this.#config.eventFilter, event.type)) {
      this.#asyncResults.push({
        eventId: event.eventId,
        sinkId: this.id,
        status: "skipped",
        reason: "filtered_out",
      });
      return;
    }

    this.#queue.push(event);
    if (!this.#drainPromise) {
      this.#drainPromise = this.#drain();
    }
  }

  /**
   * Wait for all pending background deliveries to complete.
   *
   * After {@link flush} resolves, {@link consecutiveFailures} and
   * {@link enabled} reflect the final state of all queued deliveries.
   * Call at cast terminal phases or in tests before asserting outcomes.
   */
  async flush(): Promise<void> {
    while (this.#drainPromise) {
      const p = this.#drainPromise;
      this.#drainPromise = null;
      await p;
    }
  }

  /**
   * Return accumulated async dispatch results and clear the internal buffer.
   * Call after {@link flush} to collect background delivery results.
   *
   * Each result carries the {@link AsyncDispatchResult.eventId} so the event
   * bus can reconcile it back to the originating dispatch outcome.
   */
  drainResults(): AsyncDispatchResult[] {
    const drained = [...this.#asyncResults];
    this.#asyncResults = [];
    return drained;
  }

  /**
   * Backward-compatible adapter: return results as legacy {@link DispatchOutcome}s.
   *
   * @deprecated Prefer {@link drainResults}, which preserves the rich
   * `status` / `statusCode` / `reason` detail. This adapter exists for callers
   * that still expect the original `deliveredTo` / `failures` shape.
   */
  drainOutcomes(): DispatchOutcome[] {
    return this.drainResults().map((r) => toLegacyOutcome(r));
  }

  // ── Background drain loop ──────────────────────────────────────────

  /**
   * Process the queue sequentially until it is empty.
   *
   * When the queue drains, `#drainPromise` is reset to `null`. If more
   * events were enqueued during the drain, a new drain cycle is started
   * before resetting.
   */
  async #drain(): Promise<void> {
    try {
      while (this.#queue.length > 0) {
        const event = this.#queue.shift()!;
        const result = await this.#deliverOne(event);
        this.#asyncResults.push(result);
      }
    } finally {
      // Check if more events were added while we were draining.
      if (this.#queue.length > 0) {
        this.#drainPromise = this.#drain();
      } else {
        this.#drainPromise = null;
      }
    }
  }

  /**
   * Deliver a single event to the configured webhook endpoint.
   *
   * Handles retries, backoff, timeouts, and failure tracking. Returns an
   * {@link AsyncDispatchResult} describing the result. Never throws — failures
   * are reflected in the returned result.
   */
  async #deliverOne(event: EnrichedEvent): Promise<AsyncDispatchResult> {
    const url = this.#config.url;

    // Validate the target URL up front. A misconfigured sink never reaches
    // the network so it is reported as `misconfigured` (not retried).
    const urlValidation = validateWebhookUrl(url);
    if (!urlValidation.ok) {
      return {
        eventId: event.eventId,
        sinkId: this.id,
        status: "misconfigured",
        reason: urlValidation.reason,
        error: urlValidation.message,
      };
    }

    const method = this.#config.method ?? "POST";
    const timeoutMs = this.#config.timeoutMs ?? 10000;
    const maxRetries = this.#config.maxRetries ?? 3;
    const retryBackoffMs = this.#config.retryBackoffMs ?? 1000;
    const maxBackoffMs = this.#config.maxBackoffMs ?? 30000;
    const discardingAfter = this.#config.discardingAfter ?? 10;

    const headers = buildHeaders(this.#config.headers);
    const body = buildBody(
      this.#config.bodyTemplate ?? "mapped",
      this.#config.bodyMapping,
      event,
      this.#config.typeMap,
      this.#config.severityMap,
    );

    let lastStatusCode: number | undefined;
    let lastError: unknown;
    let lastReason: DispatchFailureReason = "unknown_error";

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(new DOMException(timeoutReason, "TimeoutError")),
          timeoutMs,
        );
        // Don't keep the process alive waiting for a webhook timeout.
        timeout.unref();

        const response = await fetch(url, {
          method,
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.ok) {
          // Drain the body so the connection can be reused (best-effort).
          await response.text().catch(() => {});
          this.#consecutiveFailures = 0;
          return {
            eventId: event.eventId,
            sinkId: this.id,
            status: "delivered",
            statusCode: response.status,
          };
        }

        lastStatusCode = response.status;
        lastError = new Error(
          `Webhook sink "${this.id}" received HTTP ${response.status} from ${redactUrl(url)}`,
        );
        lastReason = "http_error";

        // 5xx responses may be transient — retry.
        if (response.status >= 500 && attempt < maxRetries) {
          await response.text().catch(() => {});
          await backoff(attempt, retryBackoffMs, maxBackoffMs);
          continue;
        }

        // 4xx and other non-ok statuses are not retryable.
        await response.text().catch(() => {});
        break;
      } catch (error) {
        if (isWebhookTimeout(error)) {
          lastError = new Error(
            `Webhook sink "${this.id}" timed out after ${timeoutMs}ms (${redactUrl(url)})`,
          );
          lastReason = "timeout";
        } else if (error instanceof Error) {
          // Redact: never include the original error's full message verbatim
          // since it might contain connection details. Use a safe summary.
          lastError = new Error(
            `Webhook sink "${this.id}" delivery error: ${safeErrorMessage(error.message)}`,
          );
          lastReason = "network_error";
        } else {
          lastError = new Error(
            `Webhook sink "${this.id}" unknown delivery error`,
          );
          lastReason = "unknown_error";
        }

        if (attempt < maxRetries) {
          await backoff(attempt, retryBackoffMs, maxBackoffMs);
          continue;
        }
        break;
      }
    }

    this.#consecutiveFailures++;
    if (this.#consecutiveFailures >= discardingAfter) {
      this.#active = false;
    }

    const errorMsg =
      lastError instanceof Error
        ? lastError.message
        : `Webhook sink "${this.id}" delivery failed`;

    return {
      eventId: event.eventId,
      sinkId: this.id,
      status: "failed",
      statusCode: lastStatusCode,
      reason: lastReason,
      error: safeErrorMessage(errorMsg),
    };
  }
}

// ── Event Filtering ─────────────────────────────────────────────────────

/**
 * Simple wildcard glob match for dot-separated event types.
 *
 * - `*` within a segment matches any sequence of characters (does NOT cross dots).
 *   e.g. `debug_*` matches `debug_trace`, `debug_info`.
 * - `*` as an entire segment matches any single dot-separated segment.
 *   e.g. `result.*` matches `result.pr_created`, `result.anything`.
 * - `**` as an entire segment matches zero or more dot-separated segments.
 *   e.g. `lifecycle.**.failed` matches `lifecycle.cast.failed`, `lifecycle.deeply.nested.failed`.
 * - `**` alone matches everything (including empty string).
 * - Literal patterns without wildcards match exactly.
 */
function globMatch(pattern: string, eventType: string): boolean {
  // Fast path: exact match or universal wildcards.
  if (pattern === "**") return true;
  if (!hasWildcard(pattern)) return pattern === eventType;

  const patternSegments = pattern.split(".");
  const typeSegments = eventType.split(".");

  // Empty event type only matches empty pattern or "**" (handled above).
  if (eventType === "" && pattern !== "") return false;

  return globMatchSegments(patternSegments, typeSegments, 0, 0);
}

function globMatchSegments(
  pattern: string[],
  value: string[],
  pi: number,
  vi: number,
): boolean {
  while (pi < pattern.length) {
    const pseg = pattern[pi];

    if (pseg === "**") {
      // ** at the end matches everything remaining.
      if (pi === pattern.length - 1) return true;

      // Try matching the rest of the pattern at every remaining position.
      const nextPat = pattern[pi + 1];
      for (let v = vi; v < value.length; v++) {
        if (segmentMatch(nextPat, value[v])) {
          if (globMatchSegments(pattern, value, pi + 2, v + 1)) return true;
        }
      }
      return false;
    }

    if (vi >= value.length) return false;

    if (!segmentMatch(pseg, value[vi])) return false;

    pi++;
    vi++;
  }

  return vi >= value.length;
}

/**
 * Match a single pattern segment against a single value segment.
 *
 * - `*` as the entire segment matches any value segment.
 * - `*` within a segment (e.g. `debug_*`) acts as a within-segment wildcard.
 * - Exact literal match otherwise.
 */
function segmentMatch(patternSegment: string, valueSegment: string): boolean {
  if (patternSegment === "*" || patternSegment === "**") return true;
  if (!patternSegment.includes("*")) return patternSegment === valueSegment;

  // Within-segment wildcard: convert the glob to a regex.
  // Escape regex special chars except *, then replace * with .*
  const escaped = patternSegment.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
  return regex.test(valueSegment);
}

function hasWildcard(pattern: string): boolean {
  return pattern.includes("*");
}

/**
 * Returns `true` when the event type passes the filter.
 *
 * - If no filter is configured, all events pass.
 * - `include` patterns: at least one must match (OR).
 * - `exclude` patterns: if any match, the event is excluded (exclude wins).
 */
export function matchesFilter(
  filter: EventFilter | undefined,
  eventType: string,
): boolean {
  if (!filter) return true;

  // Exclude wins — check first.
  if (filter.exclude && filter.exclude.some((p) => globMatch(p, eventType))) {
    return false;
  }

  // If include is present, at least one pattern must match.
  if (filter.include && filter.include.length > 0) {
    return filter.include.some((p) => globMatch(p, eventType));
  }

  // No include filter means all events pass (subject to exclude above).
  return true;
}

// ── Body Construction ───────────────────────────────────────────────────

function buildBody(
  template: "passthrough" | "mapped" | "none",
  mapping: EventBodyFieldMapping | undefined,
  event: EnrichedEvent,
  typeMap?: Record<string, string>,
  severityMap?: Record<string, string>,
): unknown {
  switch (template) {
    case "passthrough":
      return event;
    case "none":
      return {};
    case "mapped":
      return buildMappedBody(mapping, event, typeMap, severityMap);
  }
}

function buildMappedBody(
  mapping: EventBodyFieldMapping | undefined,
  event: EnrichedEvent,
  typeMap?: Record<string, string>,
  severityMap?: Record<string, string>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  // Map each output field to the configured enriched event property.
  // The mapping value is the enriched event field name to read; the mapping
  // key is the output body field name. When the mapping value is omitted the
  // known default enriched-event field name is used (see defaults below).
  applyMapping("eventId", mapping?.eventId, "eventId", body, event);
  applyEventTypeMapping("eventType", mapping?.eventType, "type", body, event, typeMap);
  applyMapping("occurredAt", mapping?.occurredAt, "occurredAt", body, event);
  applyMapping("severity", mapping?.severity, "severity", body, event, severityMap);
  applyMapping("message", mapping?.message, "message", body, event);
  applyMapping("payload", mapping?.payload, "payload", body, event);
  applyMapping("runtimeRunId", mapping?.runtimeRunId, "castId", body, event);
  applyMapping("sequence", mapping?.sequence, "sequence", body, event);

  // Merge static fields last so they can override mapped fields.
  if (mapping?.static) {
    Object.assign(body, mapping.static);
  }

  return body;
}

/**
 * Write one event field into the body if a value is present.
 *
 * @param outputKey   Body field name.
 * @param lookupKey   Enriched event field name to read from (configured value).
 * @param defaultKey  Enriched event field name to use when lookupKey is undefined.
 * @param valueMap    Optional value transformation map (e.g. severityMap).
 */
function applyMapping(
  outputKey: string,
  lookupKey: string | undefined,
  defaultKey: string,
  body: Record<string, unknown>,
  event: EnrichedEvent,
  valueMap?: Record<string, string>,
): void {
  const sourceField = lookupKey ?? defaultKey;
  let value = (event as unknown as Record<string, unknown>)[sourceField];
  if (value !== undefined && valueMap && typeof value === "string") {
    const mapped = valueMap[value];
    if (mapped !== undefined) {
      value = mapped;
    }
  }
  if (value !== undefined) {
    body[outputKey] = value;
  }
}

/**
 * Write the eventType field with optional type mapping.
 *
 * When a `typeMap` is provided, the event's type is looked up in the map.
 * If a mapping exists, the mapped value is used (e.g. `lifecycle.cast.started`
 * becomes `runtime.accepted`). If no mapping exists, the original event type
 * is used as-is.
 */
function applyEventTypeMapping(
  outputKey: string,
  lookupKey: string | undefined,
  defaultKey: string,
  body: Record<string, unknown>,
  event: EnrichedEvent,
  typeMap?: Record<string, string>,
): void {
  const sourceField = lookupKey ?? defaultKey;
  let value = (event as unknown as Record<string, unknown>)[sourceField];
  if (value !== undefined && typeMap && typeof value === "string") {
    const mapped = typeMap[value];
    if (mapped !== undefined) {
      value = mapped;
    }
  }
  if (value !== undefined) {
    body[outputKey] = value;
  }
}

// ── Headers ─────────────────────────────────────────────────────────────

function buildHeaders(userHeaders: Record<string, string> | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...userHeaders,
  };
  return headers;
}

// ── Retry Backoff ───────────────────────────────────────────────────────

async function backoff(
  attempt: number,
  baseMs: number,
  maxMs: number,
): Promise<void> {
  // Exponential backoff: baseMs * 2^attempt, capped at maxMs.
  const delay = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

// ── URL Redaction ───────────────────────────────────────────────────────

/**
 * Redact a URL for safe inclusion in error messages.
 *
 * Strips query parameters and fragments that might contain tokens or secrets.
 * Only the origin + pathname are preserved.
 */
/**
 * Validate a webhook target URL before any network attempt.
 *
 * Mirrors the webhook activation diagnostic reasons (docs/runtime-eventing.md
 * §9.6): a missing or non-http(s) URL is reported as `misconfigured` rather
 * than surfacing as an opaque network failure.
 */
function validateWebhookUrl(url: string):
  | { ok: true }
  | { ok: false; reason: "target_url_missing" | "target_url_invalid"; message: string } {
  if (typeof url !== "string" || url.trim() === "") {
    return { ok: false, reason: "target_url_missing", message: `Webhook sink target URL is missing` };
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        ok: false,
        reason: "target_url_invalid",
        message: `Webhook sink target URL must be absolute http(s): ${redactUrl(url)}`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "target_url_invalid", message: `Webhook sink target URL is invalid` };
  }
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    // Not a valid URL — return a generic placeholder.
    return "invalid-url";
  }
}

// ── Error Helpers ───────────────────────────────────────────────────────

function isWebhookTimeout(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    error.name === "TimeoutError" &&
    error.message.includes(timeoutReason)
  );
}

/**
 * Sanitize an error message so it never leaks connection details or secrets.
 */
function safeErrorMessage(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length > 200) return `${trimmed.slice(0, 197)}...`;
  return trimmed;
}

/**
 * Convert a rich {@link AsyncDispatchResult} into the legacy
 * {@link DispatchOutcome} shape for backward-compatible callers.
 */
function toLegacyOutcome(r: AsyncDispatchResult): DispatchOutcome {
  const deliveredTo = r.status === "delivered" ? [r.sinkId] : [];
  const failures =
    r.status === "failed" || r.status === "misconfigured"
      ? [{ sinkId: r.sinkId, error: r.error ?? legacyDefaultError(r) }]
      : [];
  return {
    eventId: r.eventId,
    deliveredTo,
    failures,
    occurredAt: new Date().toISOString(),
  };
}

/** Default redacted error string for a legacy outcome when none was recorded. */
function legacyDefaultError(r: AsyncDispatchResult): string {
  if (r.status === "misconfigured") {
    return r.reason === "target_url_missing"
      ? `Webhook sink "${r.sinkId}" target URL is missing`
      : `Webhook sink "${r.sinkId}" target URL is invalid`;
  }
  return `Webhook sink "${r.sinkId}" delivery failed`;
}


