import type { EventingWebhookSinkConfig, EventBodyFieldMapping, EventFilter } from "../types.js";
import type {
  EnrichedEvent,
  EventSink,
  DispatchOutcome,
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
  /** Async dispatch outcomes produced by background deliveries. */
  #asyncOutcomes: DispatchOutcome[] = [];

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
   * failures are recorded as async dispatch outcomes.
   */
  async deliver(event: EnrichedEvent): Promise<void> {
    if (!this.#active) return;

    // Apply event filter synchronously before enqueuing.
    if (!matchesFilter(this.#config.eventFilter, event.type)) return;

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
   * Return accumulated async dispatch outcomes and clear the internal buffer.
   * Call after {@link flush} to collect background delivery results.
   */
  drainOutcomes(): DispatchOutcome[] {
    const drained = [...this.#asyncOutcomes];
    this.#asyncOutcomes = [];
    return drained;
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
        const outcome = await this.#deliverOne(event);
        this.#asyncOutcomes.push(outcome);
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
   * Handles retries, backoff, timeouts, and failure tracking. Returns a
   * {@link DispatchOutcome} describing the result. Never throws — failures
   * are reflected in the returned outcome.
   */
  async #deliverOne(event: EnrichedEvent): Promise<DispatchOutcome> {
    const url = this.#config.url;
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
    );

    let lastError: unknown;
    let finalFailure: string | undefined;

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
            deliveredTo: [this.id],
            failures: [],
            occurredAt: new Date().toISOString(),
          };
        }

        // 5xx responses may be transient — retry.
        if (response.status >= 500 && attempt < maxRetries) {
          await response.text().catch(() => {});
          lastError = new Error(
            `Webhook sink "${this.id}" received HTTP ${response.status} from ${redactUrl(url)}`,
          );
          finalFailure = `HTTP ${response.status}`;
          await backoff(attempt, retryBackoffMs, maxBackoffMs);
          continue;
        }

        // 4xx and other non-ok statuses are not retryable.
        await response.text().catch(() => {});
        lastError = new Error(
          `Webhook sink "${this.id}" received HTTP ${response.status} from ${redactUrl(url)}`,
        );
        finalFailure = `HTTP ${response.status}`;
        break;
      } catch (error) {
        if (isWebhookTimeout(error)) {
          lastError = new Error(
            `Webhook sink "${this.id}" timed out after ${timeoutMs}ms (${redactUrl(url)})`,
          );
          finalFailure = "timeout";
        } else if (error instanceof Error) {
          // Redact: never include the original error's full message verbatim
          // since it might contain connection details. Use a safe summary.
          lastError = new Error(
            `Webhook sink "${this.id}" delivery error: ${safeErrorMessage(error.message)}`,
          );
          finalFailure = safeErrorMessage(error.message);
        } else {
          lastError = new Error(
            `Webhook sink "${this.id}" unknown delivery error`,
          );
          finalFailure = "unknown error";
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
      deliveredTo: [],
      failures: [{ sinkId: this.id, error: safeErrorMessage(errorMsg) }],
      occurredAt: new Date().toISOString(),
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
): unknown {
  switch (template) {
    case "passthrough":
      return event;
    case "none":
      return {};
    case "mapped":
      return buildMappedBody(mapping, event);
  }
}

function buildMappedBody(
  mapping: EventBodyFieldMapping | undefined,
  event: EnrichedEvent,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  // Map each output field to the configured enriched event property.
  // The mapping value is the enriched event field name to read; the mapping
  // key is the output body field name. When the mapping value is omitted the
  // known default enriched-event field name is used (see defaults below).
  applyMapping("eventId", mapping?.eventId, "eventId", body, event);
  applyMapping("eventType", mapping?.eventType, "type", body, event);
  applyMapping("occurredAt", mapping?.occurredAt, "occurredAt", body, event);
  applyMapping("severity", mapping?.severity, "severity", body, event);
  applyMapping("message", mapping?.message, "message", body, event);
  applyMapping("payload", mapping?.payload, "payload", body, event);

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
 */
function applyMapping(
  outputKey: string,
  lookupKey: string | undefined,
  defaultKey: string,
  body: Record<string, unknown>,
  event: EnrichedEvent,
): void {
  const sourceField = lookupKey ?? defaultKey;
  const value = (event as unknown as Record<string, unknown>)[sourceField];
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


