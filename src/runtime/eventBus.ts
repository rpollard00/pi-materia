import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  AsyncDispatchResult,
  DispatchFailure,
  DispatchOutcome,
  DispatchSinkResult,
  EnrichedEvent,
  EventSink,
} from "../domain/eventing.js";

// ── Event Bus ───────────────────────────────────────────────────────────

/**
 * Internal event dispatch mechanism.
 *
 * The event bus routes enriched events to all registered sinks in registration
 * order. Sink failures are captured as diagnostics but do not propagate to the
 * bus or other sinks (per docs/runtime-eventing.md §4.1–4.2).
 *
 * The bus does not persist events directly — each sink decides what to do with
 * delivered events. Dispatch outcomes (successes and failures) are recorded to
 * the dispatch artifact via the {@link EventBus.flushOutcome} or
 * {@link EventBus.outcomes} accessor.
 */
export class EventBus {
  readonly #sinks: EventSink[] = [];
  readonly #outcomes: DispatchOutcome[] = [];

  /** Register a sink. Sinks receive events in registration order. */
  register(sink: EventSink): void {
    this.#sinks.push(sink);
  }

  /** All currently registered sinks (read-only snapshot). */
  get sinks(): readonly EventSink[] {
    return [...this.#sinks];
  }

  /** Accumulated dispatch outcomes (read-only snapshot). */
  get outcomes(): readonly DispatchOutcome[] {
    return [...this.#outcomes];
  }

  /**
   * Dispatch a single enriched event to all enabled sinks.
   *
   * Each sink is tried independently. A sink failure is captured as a
   * {@link DispatchSinkResult} with status `failed` but does not abort
   * dispatch to other sinks or cause the dispatch call to throw.
   *
   * Synchronous sinks (those without {@link EventSink.drainResults}) resolve
   * to a final `delivered` / `failed` status immediately. Async sinks (e.g.
   * webhook) resolve to a provisional `queued` status here; their real outcome
   * is reconciled from {@link EventSink.drainResults} during {@link flush}.
   *
   * Returns the {@link DispatchOutcome} for this event. The outcome is also
   * recorded internally and can be flushed to the dispatch artifact. Its
   * `deliveredTo` / `failures` legacy fields are derived from `sinks[]`.
   */
  async dispatch(event: EnrichedEvent): Promise<DispatchOutcome> {
    const sinkResults: DispatchSinkResult[] = [];

    for (const sink of this.#sinks) {
      if (!sink.enabled) {
        sinkResults.push({ sinkId: sink.id, status: "skipped", reason: "disabled" });
        continue;
      }
      const isAsync = typeof sink.drainResults === "function";
      try {
        await sink.deliver(event);
        sinkResults.push(
          isAsync
            ? { sinkId: sink.id, status: "queued" }
            : { sinkId: sink.id, status: "delivered" },
        );
      } catch (error) {
        sinkResults.push({
          sinkId: sink.id,
          status: "failed",
          reason: "deliver_threw",
          error: redactErrorMessage(error),
        });
      }
    }

    const outcome: DispatchOutcome = this.#buildOutcome(event.eventId, sinkResults);
    this.#outcomes.push(outcome);
    return outcome;
  }

  /**
   * Build a {@link DispatchOutcome} from per-sink results, deriving the
   * legacy `deliveredTo` / `failures` views.
   */
  #buildOutcome(eventId: string, sinks: DispatchSinkResult[]): DispatchOutcome {
    const deliveredTo: string[] = [];
    const failures: DispatchFailure[] = [];
    for (const r of sinks) {
      if (r.status === "delivered") {
        deliveredTo.push(r.sinkId);
      } else if (r.status === "failed" || r.status === "misconfigured") {
        failures.push({ sinkId: r.sinkId, error: r.error ?? defaultFailureMessage(r) });
      }
    }
    return {
      eventId,
      sinks,
      deliveredTo,
      failures,
      occurredAt: new Date().toISOString(),
    };
  }

  /**
   * Call `flush()` on every sink that supports it, then reconcile any
   * provisional `queued` results with the real async outcomes drained from
   * each sink.
   *
   * Flush failures are captured per-sink but do not throw. This is best-effort
   * finalization intended for terminal cast phases. After this resolves,
   * buffered outcomes reflect actual webhook delivery results (delivered /
   * failed / skipped / misconfigured) rather than a provisional `queued`.
   */
  async flush(): Promise<void> {
    for (const sink of this.#sinks) {
      if (!sink.flush) continue;
      try {
        await sink.flush();
      } catch {
        // Flush failures are non-fatal. The cast runtime may log them
        // separately via the existing events.jsonl diagnostics path.
      }
    }
    this.#reconcileAsyncResults();
  }

  /**
   * Drain per-event results from every async sink and fold the real outcomes
   * back into buffered {@link DispatchOutcome}s, replacing provisional
   * `queued` entries and re-deriving the legacy `deliveredTo` / `failures`.
   *
   * This is the bridge that makes the dispatch artifact reflect actual
   * webhook HTTP outcomes (per docs/runtime-eventing.md §5.2). Results that
   * do not match a still-buffered outcome (e.g. the outcome was already
   * drained/written) are dropped — best-effort.
   */
  #reconcileAsyncResults(): void {
    const byEvent = new Map<string, AsyncDispatchResult[]>();
    for (const sink of this.#sinks) {
      if (!sink.drainResults) continue;
      for (const r of sink.drainResults()) {
        let arr = byEvent.get(r.eventId);
        if (!arr) {
          arr = [];
          byEvent.set(r.eventId, arr);
        }
        arr.push(r);
      }
    }
    if (byEvent.size === 0) return;

    for (const outcome of this.#outcomes) {
      const results = byEvent.get(outcome.eventId);
      if (!results) continue;
      const sinks = outcome.sinks;
      if (!sinks) continue;
      let changed = false;
      for (let i = 0; i < sinks.length; i++) {
        const entry = sinks[i];
        if (entry.status !== "queued") continue;
        const match = results.find((r) => r.sinkId === entry.sinkId);
        if (!match) continue;
        sinks[i] = {
          sinkId: match.sinkId,
          status: match.status,
          statusCode: match.statusCode,
          reason: match.reason,
          error: match.error,
        };
        changed = true;
      }
      if (changed) {
        this.#rederiveLegacyFields(outcome);
        outcome.occurredAt = new Date().toISOString();
      }
    }
  }

  /** Re-derive `deliveredTo` / `failures` from an outcome's `sinks[]`. */
  #rederiveLegacyFields(outcome: DispatchOutcome): void {
    const sinks = outcome.sinks;
    if (!sinks) return;
    const deliveredTo: string[] = [];
    const failures: DispatchFailure[] = [];
    for (const r of sinks) {
      if (r.status === "delivered") {
        deliveredTo.push(r.sinkId);
      } else if (r.status === "failed" || r.status === "misconfigured") {
        failures.push({ sinkId: r.sinkId, error: r.error ?? defaultFailureMessage(r) });
      }
    }
    outcome.deliveredTo = deliveredTo;
    outcome.failures = failures;
  }

  /**
   * Drain accumulated dispatch outcomes and return them.
   *
   * Useful when you need to persist outcomes elsewhere and clear the buffer
   * (e.g. periodic writes to the dispatch artifact).
   */
  drainOutcomes(): DispatchOutcome[] {
    const drained = [...this.#outcomes];
    this.#outcomes.length = 0;
    return drained;
  }
}

// ── Local Event Recording Sink ──────────────────────────────────────────

/**
 * Built-in sink that records enriched events to the cast artifact directory.
 *
 * Events are written to `{runDir}/events/events.jsonl` — one JSON object per
 * line. This is **separate** from the existing `{runDir}/events.jsonl` which
 * records operational lifecycle events for the WebUI and catalog
 * (per docs/runtime-eventing.md §5.3).
 */
export class LocalEventRecordingSink implements EventSink {
  readonly id = "local-recording";
  readonly enabled = true;

  readonly #eventsDir: string;
  readonly #eventsPath: string;

  constructor(runDir: string) {
    this.#eventsDir = path.join(runDir, "events");
    this.#eventsPath = path.join(this.#eventsDir, "events.jsonl");
  }

  /** Path to the events artifact file. */
  get eventsPath(): string {
    return this.#eventsPath;
  }

  /** Path to the events artifact directory. */
  get eventsDir(): string {
    return this.#eventsDir;
  }

  async deliver(event: EnrichedEvent): Promise<void> {
    await this.#ensureDir();
    await appendFile(this.#eventsPath, `${JSON.stringify(event)}\n`);
  }

  async #ensureDir(): Promise<void> {
    await mkdir(this.#eventsDir, { recursive: true });
  }
}

// ── Dispatch Outcome Persistence ────────────────────────────────────────

/**
 * Persist dispatch outcomes to the dispatch artifact.
 *
 * Appends each outcome as a JSON line to `{runDir}/events/dispatch.jsonl`.
 * This is separate from the events artifact and records per-event delivery
 * tracking (per docs/runtime-eventing.md §5.2).
 */
export async function appendDispatchOutcomes(
  runDir: string,
  outcomes: readonly DispatchOutcome[],
): Promise<void> {
  if (outcomes.length === 0) return;
  const dir = path.join(runDir, "events");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "dispatch.jsonl");
  const lines = outcomes.map((o) => JSON.stringify(o)).join("\n") + "\n";
  await appendFile(file, lines);
}

/**
 * Convenience: flush bus outcomes to the dispatch artifact and clear the
 * internal outcome buffer.
 */
export async function flushBusOutcomes(
  bus: EventBus,
  runDir: string,
): Promise<void> {
  const outcomes = bus.drainOutcomes();
  await appendDispatchOutcomes(runDir, outcomes);
}

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Create a ready-to-use event bus wired with the local recording sink.
 *
 * The local recording sink writes enriched events to
 * `{runDir}/events/events.jsonl`. Additional sinks (e.g. webhook) can be
 * registered later via {@link EventBus.register}.
 */
export function createEventBus(runDir: string): EventBus {
  const bus = new EventBus();
  bus.register(new LocalEventRecordingSink(runDir));
  return bus;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Redact an error into a safe message string.
 *
 * Converts any thrown value into a short diagnostic message suitable for
 * dispatch outcomes and artifact recording. Never includes raw stack traces
 * or potentially sensitive error details.
 */
function redactErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Only include the message, never the stack. Stack traces may contain
    // file paths or configuration details.
    const msg = error.message.trim();
    return msg.length > 200 ? `${msg.slice(0, 197)}...` : msg;
  }
  if (typeof error === "string") {
    const trimmed = error.trim();
    return trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed;
  }
  return "Unknown sink error";
}

/**
 * Default redacted message for a failed/misconfigured sink result that lacks
 * an explicit `error` string, so legacy `failures[]` entries stay informative.
 */
function defaultFailureMessage(result: DispatchSinkResult): string {
  switch (result.status) {
    case "misconfigured":
      return result.reason === "target_url_missing"
        ? `Sink "${result.sinkId}" has no target URL`
        : `Sink "${result.sinkId}" target URL is invalid`;
    case "failed":
      return `Sink "${result.sinkId}" delivery failed`;
    default:
      return `Sink "${result.sinkId}" was not delivered`;
  }
}
