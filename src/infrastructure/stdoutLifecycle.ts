/**
 * Stdout lifecycle event emitter for pi RPC mode.
 *
 * Mirrors a curated subset of pi-materia lifecycle events onto pi's stdout
 * JSONL stream so an external controller (e.g. agent_router) observing
 * `pi --mode rpc` can:
 *   - establish the eventing preset from `cast_start.eventing.preset`,
 *   - observe the socket graph from `cast_start.sockets`,
 *   - detect cast completion from a single terminal `cast_end`.
 *
 * Design constraints (see the "Emit cast/socket/materia lifecycle events on
 * the pi stdout RPC stream" story):
 *
 * - This is an ADDITIONAL sink alongside the existing artifact events.jsonl
 *   writes (`appendEvent`). It does not replace or modify them; the artifact
 *   record remains the source of truth.
 * - Only the curated lifecycle types {@link StdoutLifecycleEventType} are
 *   emitted. Socket-level and noisy diagnostic/internal events
 *   (`socket_start`, `socket_complete`, `stale_agent_end_ignored`, etc.) are
 *   deliberately excluded — they are not in the controller's recognized set
 *   and would just be noise on stdout.
 * - Emission is best-effort: any serialization or write failure is swallowed
 *   and never propagates to the caller, so a broken stdout pipe cannot fail a
 *   cast or stall the pipeline.
 * - The writer is injectable so callers (and tests) can supply a raw fd-1
 *   writer or a capturing buffer. The emitter is otherwise mode-agnostic; the
 *   wiring layer gates emission with {@link shouldEmitStdoutLifecycle} based
 *   on the active pi `ctx.mode`, so TUI/interactive/json/print modes stay
 *   quiet.
 */

// ── Curated Lifecycle Types ─────────────────────────────────────────────

/**
 * Lifecycle event types permitted on the stdout stream.
 *
 * This is a deliberately narrow set — the controller's stdout contract
 * (agent_router `PiMateriaStdoutEventTypes`) recognizes exactly these.
 * Socket-level and diagnostic events are intentionally excluded.
 */
export type StdoutLifecycleEventType =
  | "cast_start"
  | "cast_end"
  | "materia_start"
  | "materia_end";

/** The curated lifecycle types this emitter is permitted to publish. */
export const STDOUT_LIFECYCLE_EVENT_TYPES: readonly StdoutLifecycleEventType[] = [
  "cast_start",
  "cast_end",
  "materia_start",
  "materia_end",
] as const;

const ALLOWED_TYPES: ReadonlySet<string> = new Set(STDOUT_LIFECYCLE_EVENT_TYPES);

/**
 * Type guard for the curated stdout lifecycle event types.
 *
 * Returns false for socket/diagnostic/internal types (e.g.
 * `socket_start`, `socket_complete`, `stale_agent_end_ignored`) so they can
 * never reach stdout through this emitter.
 */
export function isStdoutLifecycleType(type: unknown): type is StdoutLifecycleEventType {
  return typeof type === "string" && ALLOWED_TYPES.has(type);
}

// ── Controller-Compatible Payload Contracts ─────────────────────────────
//
// These interfaces are the single source of truth for the shapes the
// agent-controller stdout contract expects. The wiring layer (in
// runtime/nativeLifecycle.ts) constructs payloads matching these; the
// emitter only validates the discriminating `type` field, serializes, and
// writes — it never mutates payload fields.

/** A single resolved pipeline socket as exposed on `cast_start.sockets`. */
export interface StdoutLifecycleSocket {
  /** Socket id within the loadout pipeline (e.g. "Socket-1"). */
  socketName: string;
  /** "agent" for materia agent sockets; "materia" reserved for non-agent materia sockets. */
  type: "agent" | "materia";
  /** Display name of the resolved materia bound to this socket. */
  materiaName: string;
  /** Whether the socket's materia is multi-turn (requires /materia continue). */
  multiTurn: boolean;
}

/** cast_start — emitted exactly once when the cast initializes. */
export interface StdoutCastStartEvent {
  type: "cast_start";
  castId: string;
  /** Active eventing preset(s); the controller keys off `preset`. */
  eventing: { preset: string };
  /** Resolved per-socket pipeline graph the controller counts agent sockets from. */
  sockets: StdoutLifecycleSocket[];
  /** Active loadout name (optional but useful). */
  loadout?: string;
  /** Stable loadout id used to execute the cast (optional). */
  loadoutId?: string;
}

/** cast_end — emitted exactly once when the whole cast terminates. */
export interface StdoutCastEndEvent {
  type: "cast_end";
  /** Must match the `cast_start` castId. */
  castId: string;
  /** Distinguishes success from failure. */
  ok: boolean;
  /** Optional error message for `ok: false` paths. */
  error?: string;
}

/** materia_start — informational; emitted when a materia (socket) begins. */
export interface StdoutMateriaStartEvent {
  type: "materia_start";
  materiaName: string;
  socketName: string;
}

/** materia_end — informational; emitted when a materia (socket) completes. */
export interface StdoutMateriaEndEvent {
  type: "materia_end";
  materiaName: string;
  socketName: string;
}

/** Discriminated union of all stdout lifecycle events. */
export type StdoutLifecycleEvent =
  | StdoutCastStartEvent
  | StdoutCastEndEvent
  | StdoutMateriaStartEvent
  | StdoutMateriaEndEvent;

// ── Serialization ───────────────────────────────────────────────────────

/**
 * Serialize a lifecycle event as a single strict JSONL line.
 *
 * Produces `JSON.stringify(event)` followed by exactly one trailing `\n`
 * (LF, never platform `\r\n`) so the stream is parsable line-by-line by a
 * JSONL consumer on any platform. May throw if `event` contains a value
 * `JSON.stringify` cannot represent (e.g. circular references); callers that
 * cannot tolerate that should use {@link StdoutLifecycleEmitter.emit}, which
 * swallows such errors best-effort.
 */
export function serializeStdoutLifecycleLine(event: StdoutLifecycleEvent): string {
  return `${JSON.stringify(event)}\n`;
}

// ── Mode Gating ─────────────────────────────────────────────────────────

/**
 * Whether stdout lifecycle emission should be active for the given pi run mode.
 *
 * Matches the pi `ExtensionMode` values (`"tui" | "rpc" | "json" | "print"`).
 * Only RPC mode emits — in TUI/interactive/json/print modes these events
 * would be pure noise on stdout. Kept as a pure function so the gating rule
 * lives in one place and is testable without the pi SDK.
 */
export function shouldEmitStdoutLifecycle(mode: string): boolean {
  return mode === "rpc";
}

// ── Writer ──────────────────────────────────────────────────────────────

/**
 * A function that writes a chunk to the underlying stdout stream.
 *
 * Implementations may be synchronous (returning `void`) or asynchronous
 * (returning a `Promise`). The default writer is bound to raw fd 1.
 */
export type StdoutWriter = (chunk: string) => void | Promise<void>;

/**
 * Default writer: synchronous write to `process.stdout` (fd 1).
 *
 * Referenced lazily (inside the function body) so importing this module, or
 * constructing an emitter that is never triggered, never touches the real
 * stdout stream. Backpressure (a `false` return value) is acceptable for the
 * low-volume lifecycle framing this emitter produces.
 */
export const defaultStdoutWriter: StdoutWriter = (chunk) => {
  process.stdout.write(chunk);
};

// ── Emitter ─────────────────────────────────────────────────────────────

export interface StdoutLifecycleEmitterOptions {
  /**
   * Injectable writer. Defaults to {@link defaultStdoutWriter} (raw fd 1).
   * Tests inject a capturing function.
   */
  writer?: StdoutWriter;
  /**
   * Master switch. When false, {@link StdoutLifecycleEmitter.emit} is a
   * silent no-op. The wiring layer sets this from
   * {@link shouldEmitStdoutLifecycle} so non-RPC modes stay quiet. Defaults
   * to true so the emitter assumes emission is wanted unless told otherwise.
   */
  enabled?: boolean;
}

/**
 * Best-effort lifecycle emitter for the pi stdout JSONL stream.
 *
 * Stateless w.r.t. cast lifecycle — callers decide when (and whether) to
 * emit each curated type. The emitter validates the `type` is curated,
 * serializes via {@link serializeStdoutLifecycleLine}, and writes one line.
 * Any failure (disabled, non-curated type, serialization error, writer
 * error) is swallowed and reported as a `false` return value; the method
 * never throws.
 */
export class StdoutLifecycleEmitter {
  readonly #writer: StdoutWriter;
  readonly #enabled: boolean;

  constructor(options: StdoutLifecycleEmitterOptions = {}) {
    this.#writer = options.writer ?? defaultStdoutWriter;
    this.#enabled = options.enabled ?? true;
  }

  /** Whether emission is active for this emitter. */
  get enabled(): boolean {
    return this.#enabled;
  }

  /**
   * Emit a single curated lifecycle event as one JSONL line on stdout.
   *
   * @returns `true` when a line was written; `false` when skipped (emitter
   *   disabled, non-curated type) or when a best-effort failure occurred
   *   (serialization or write error). Never throws.
   */
  async emit(event: StdoutLifecycleEvent): Promise<boolean> {
    if (!this.#enabled) return false;
    if (!isStdoutLifecycleType(event.type)) return false;

    let line: string;
    try {
      line = serializeStdoutLifecycleLine(event);
    } catch {
      // Unserializable payload (e.g. circular refs) — best-effort skip.
      return false;
    }

    try {
      const result = this.#writer(line);
      if (result instanceof Promise) await result;
    } catch {
      // A broken stdout pipe must never fail or stall the cast. The line did
      // not make it onto the stream, so report the best-effort failure.
      return false;
    }
    return true;
  }
}

/**
 * Construct a {@link StdoutLifecycleEmitter}.
 *
 * Convenience factory; the wiring layer typically calls this once per cast
 * with `enabled: shouldEmitStdoutLifecycle(ctx.mode)` and stores the
 * instance for the cast's lifetime (mirroring the cast event bus pattern).
 */
export function createStdoutLifecycleEmitter(options?: StdoutLifecycleEmitterOptions): StdoutLifecycleEmitter {
  return new StdoutLifecycleEmitter(options);
}
