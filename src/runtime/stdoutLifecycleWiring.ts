/**
 * Runtime wiring for the pi stdout lifecycle stream.
 *
 * This module is the bridge between pi-materia's resolved cast/runtime data
 * (pipeline, eventing config, loadout identity) and the mode-agnostic
 * {@link ../infrastructure/stdoutLifecycle.ts | stdout lifecycle emitter}. It
 * owns the *payload construction* and *mode gating* for stdout lifecycle
 * events, keeping that concern out of the large orchestration module
 * (`nativeLifecycle.ts`) and out of the emitter itself (which stays
 * payload-shape-aware but mode-agnostic).
 *
 * Responsibilities:
 *   - resolve the active eventing preset into the controller's singular
 *     `cast_start.eventing.preset` field,
 *   - map the resolved per-socket detail onto the controller's
 *     `cast_start.sockets[]` contract,
 *   - construct a mode-gated emitter (RPC only) and forward the event.
 *
 * This is an ADDITIONAL sink alongside the existing artifact `events.jsonl`
 * writes (`appendEvent`); it never replaces or mutates them. Emission is
 * best-effort: a broken stdout pipe cannot fail or stall a cast.
 */

import {
  createStdoutLifecycleEmitter,
  shouldEmitStdoutLifecycle,
  type StdoutLifecycleEmitter,
  type StdoutLifecycleSocket,
  type StdoutWriter,
} from "../infrastructure/stdoutLifecycle.js";
import type { PiMateriaConfig } from "../types.js";
// Type-only: erased at runtime, so this thin module never pulls the large
// orchestration graph of nativeLifecycle.ts into its bundle. `socketDetails`
// is computed by the caller via `buildPipelineSocketDetails(pipeline)` and
// passed in here as plain data.
import type { PipelineSocketDetail } from "./nativeLifecycle.js";

// ── Run-Mode Detection ─────────────────────────────────────────────────

/** pi CLI run mode, mirroring `Mode` in pi's `cli/args.ts`. */
export type PiRunMode = "text" | "json" | "rpc" | "unknown";

/** The CLI modes pi accepts for `--mode`. */
const PI_MODE_VALUES: readonly PiRunMode[] = ["text", "json", "rpc"];

/**
 * Detect the active pi run mode from `process.argv`.
 *
 * pi SDK 0.75.x (this project's pinned version) does NOT expose the run mode
 * on `ExtensionContext` (that arrives in 0.80+), and it sets no env var for
 * it. The mode is selected in `main.ts` from the parsed `--mode` CLI flag, so
 * the only extension-visible signal is the invocation itself. This helper
 * reads `--mode <value>` (space form) and `--mode=<value>` the same way pi
 * parses them.
 *
 * Returns "rpc" only for an explicit `pi --mode rpc` invocation; any other
 * value, a missing/invalid `--mode`, or no `--mode` at all (the interactive
 * TUI default) yields a non-"rpc" result, which keeps stdout quiet outside
 * RPC mode.
 */
export function detectPiRunMode(argv: readonly string[] = process.argv): PiRunMode {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--mode") {
      const value = argv[i + 1];
      return PI_MODE_VALUES.includes(value as PiRunMode) ? (value as PiRunMode) : "unknown";
    }
    if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      return PI_MODE_VALUES.includes(value as PiRunMode) ? (value as PiRunMode) : "unknown";
    }
  }
  return "unknown";
}

// ── Inputs ──────────────────────────────────────────────────────────────

/**
 * Resolved data required to emit a controller-compatible `cast_start`.
 *
 * All fields are plain data the caller already holds at the cast_start
 * lifecycle point (see `startNativeCast`).
 */
export interface StdoutCastStartInput {
  /**
   * Active pi run mode. When omitted, {@link detectPiRunMode} is consulted so
   * emission fires only for `pi --mode rpc`. Tests inject this directly to
   * assert RPC vs non-RPC gating deterministically.
   */
  mode?: string;
  /** Cast id; must be echoed unchanged on the matching `cast_end`. */
  castId: string;
  /** Resolved pi-materia config; read for the active eventing preset(s). */
  config: PiMateriaConfig;
  /** Per-socket detail already computed via `buildPipelineSocketDetails(pipeline)`. */
  socketDetails: ReadonlyArray<PipelineSocketDetail>;
  /** Active loadout display name (optional but useful to the controller). */
  loadoutName?: string;
  /** Stable loadout id used to execute the cast (optional). */
  loadoutId?: string;
}

/** Options shared by stdout lifecycle wiring emitters. */
export interface StdoutLifecycleEmitOptions {
  /**
   * Injectable stdout writer. Defaults to raw fd 1 (see
   * `defaultStdoutWriter`). Tests inject a capturing buffer.
   */
  writer?: StdoutWriter;
}

// ── Preset Resolution ───────────────────────────────────────────────────

/** Sentinel preset reported when no eventing preset is configured. */
export const DEFAULT_STDOUT_EVENTING_PRESET = "default";

/**
 * Resolve the active eventing preset for the stdout `cast_start` payload.
 *
 * The agent-controller keys off `cast_start.eventing.preset ===
 * "agent-controller"` to enable its preset-gated guards, so that preset is
 * preferred whenever it is among the configured presets. Otherwise the first
 * configured preset wins, falling back to a `"default"` sentinel when no
 * preset is configured. The result is always a single string (the controller
 * contract field is singular).
 */
export function resolveStdoutEventingPreset(config: PiMateriaConfig): string {
  const presets = config.eventing?.presets;
  if (!Array.isArray(presets) || presets.length === 0) {
    return DEFAULT_STDOUT_EVENTING_PRESET;
  }
  if (presets.includes("agent-controller")) return "agent-controller";
  return presets[0];
}

// ── Socket Mapping ──────────────────────────────────────────────────────

/**
 * Map resolved per-socket detail onto the controller's `cast_start.sockets[]`
 * contract.
 *
 * Pure data transform: the artifact-side `socketId` becomes the controller's
 * `socketName`, the `isAgent` flag becomes the `"agent" | "materia"` socket
 * type, and `materiaName` / `multiTurn` pass through. The controller counts
 * agent sockets and reads `multiTurn` from this array.
 */
export function mapSocketDetailsToStdout(
  details: ReadonlyArray<PipelineSocketDetail>,
): StdoutLifecycleSocket[] {
  return details.map((detail) => ({
    socketName: detail.socketId,
    type: detail.isAgent ? "agent" : "materia",
    materiaName: detail.materiaName,
    multiTurn: detail.multiTurn,
  }));
}

// ── cast_start ──────────────────────────────────────────────────────────

/**
 * Emit the controller-compatible `cast_start` event to pi's stdout JSONL
 * stream.
 *
 * Emits exactly one line, and only when running under `pi --mode rpc` (no-op
 * in TUI/interactive/json/print modes). The payload carries the resolved
 * eventing preset, the per-socket pipeline graph, and loadout identity, and is
 * emitted at the same lifecycle point as the existing artifact `cast_start`
 * write. This is an ADDITIONAL sink — the artifact record remains the source
 * of truth.
 *
 * Best-effort: any serialization or write failure is swallowed and reported as
 * `false`; this method never throws, so a broken stdout pipe cannot fail a
 * cast or stall the pipeline.
 *
 * @returns `true` when a line was written; `false` when skipped (non-RPC mode)
 *   or when a best-effort failure occurred.
 */
export async function emitCastStartStdout(
  input: StdoutCastStartInput,
  options: StdoutLifecycleEmitOptions = {},
): Promise<boolean> {
  const mode = input.mode ?? detectPiRunMode();
  const emitter = createStdoutLifecycleEmitter({
    enabled: shouldEmitStdoutLifecycle(mode),
    ...(options.writer ? { writer: options.writer } : {}),
  });

  return emitter.emit({
    type: "cast_start",
    castId: input.castId,
    eventing: { preset: resolveStdoutEventingPreset(input.config) },
    sockets: mapSocketDetailsToStdout(input.socketDetails),
    ...(input.loadoutName !== undefined ? { loadout: input.loadoutName } : {}),
    ...(input.loadoutId !== undefined ? { loadoutId: input.loadoutId } : {}),
  });
}

// ── cast_end ────────────────────────────────────────────────────────────

/**
 * Resolved data required to emit the terminal `cast_end`.
 *
 * Only the cast identity and outcome are needed; `cast_end` carries no
 * pipeline graph. The `castId` MUST echo the matching `cast_start` so the
 * controller can pair the two.
 */
export interface StdoutCastEndInput {
  /**
   * Active pi run mode. When omitted, {@link detectPiRunMode} is consulted so
   * emission fires only for `pi --mode rpc`. Tests inject this directly to
   * assert RPC vs non-RPC gating deterministically.
   */
  mode?: string;
  /** Cast id; must match the `cast_start` castId. */
  castId: string;
  /** Cast outcome — `true` on success, `false` on failure/error. */
  ok: boolean;
  /** Optional error message for `ok: false` paths. */
  error?: string;
}

/**
 * Emit the terminal `cast_end` event to pi's stdout JSONL stream.
 *
 * Emits exactly one line, and only when running under `pi --mode rpc` (no-op
 * in TUI/interactive/json/print modes). The `castId` echoes the matching
 * `cast_start` so the controller can pair the two; `ok` distinguishes success
 * from failure and is present on both paths so the controller need not infer
 * it. This is an ADDITIONAL sink alongside the existing artifact `cast_end`
 * write — the artifact record remains the source of truth.
 *
 * Wired into every artifact `cast_end` path (success and all failure/error
 * paths), so a cast emits exactly one terminal `cast_end`, never one per
 * socket. The per-socket `agent_end` signal is separate (pi's native
 * agent_end callback) and is unchanged.
 *
 * Best-effort: any serialization or write failure is swallowed and reported as
 * `false`; this method never throws, so a broken stdout pipe cannot fail a
 * cast or stall the pipeline.
 *
 * @returns `true` when a line was written; `false` when skipped (non-RPC mode)
 *   or when a best-effort failure occurred.
 */
export async function emitCastEndStdout(
  input: StdoutCastEndInput,
  options: StdoutLifecycleEmitOptions = {},
): Promise<boolean> {
  const mode = input.mode ?? detectPiRunMode();
  const emitter = createStdoutLifecycleEmitter({
    enabled: shouldEmitStdoutLifecycle(mode),
    ...(options.writer ? { writer: options.writer } : {}),
  });

  return emitter.emit({
    type: "cast_end",
    castId: input.castId,
    ok: input.ok,
    ...(input.error !== undefined ? { error: input.error } : {}),
  });
}

// ── materia_start / materia_end ─────────────────────────────────────────

/**
 * Resolved data required to emit an informational materia lifecycle event.
 *
 * The controller's contract for `materia_start` / `materia_end` is minimal —
 * just `type`, `materiaName`, and `socketName`. No cast identity is carried;
 * these events bracket a single socket's materia execution (one start / one
 * end per socket), and are informational. The `socketName` mirrors the
 * `socketName` field of {@link StdoutLifecycleSocket} (i.e. the socket id),
 * and `materiaName` mirrors `cast_start.sockets[].materiaName` (the resolved
 * display name) so a controller can correlate the two.
 */
export interface StdoutMateriaLifecycleInput {
  /**
   * Active pi run mode. When omitted, {@link detectPiRunMode} is consulted so
   * emission fires only for `pi --mode rpc`. Tests inject this directly to
   * assert RPC vs non-RPC gating deterministically.
   */
  mode?: string;
  /** Resolved materia display name (mirrors `cast_start.sockets[].materiaName`). */
  materiaName: string;
  /** Socket id within the loadout pipeline (mirrors `cast_start.sockets[].socketName`). */
  socketName: string;
}

/**
 * Build a mode-gated {@link StdoutLifecycleEmitter} for the materia lifecycle
 * events. The two materia events (`materia_start` / `materia_end`) differ only
 * in their `type`, so this shared helper keeps their wiring DRY. It does not
 * touch the cast-level ({@link emitCastStartStdout} / {@link emitCastEndStdout})
 * setup, whose payloads are distinct.
 */
function createMateriaStdoutEmitter(
  mode: string | undefined,
  options: StdoutLifecycleEmitOptions,
): StdoutLifecycleEmitter {
  return createStdoutLifecycleEmitter({
    enabled: shouldEmitStdoutLifecycle(mode ?? detectPiRunMode()),
    ...(options.writer ? { writer: options.writer } : {}),
  });
}

/**
 * Emit the informational `materia_start` event to pi's stdout JSONL stream.
 *
 * Emits one line per socket at the socket's materia start lifecycle point (the
 * same point as the artifact `socket_start` write), and only when running under
 * `pi --mode rpc` (no-op in TUI/interactive/json/print modes). This is an
 * ADDITIONAL sink — it does NOT replace or alter the artifact `socket_start`
 * event, which remains the source of truth for the socket record.
 *
 * Best-effort: any serialization or write failure is swallowed and reported as
 * `false`; this method never throws, so a broken stdout pipe cannot fail a
 * cast or stall the pipeline.
 *
 * @returns `true` when a line was written; `false` when skipped (non-RPC mode)
 *   or when a best-effort failure occurred.
 */
export async function emitMateriaStartStdout(
  input: StdoutMateriaLifecycleInput,
  options: StdoutLifecycleEmitOptions = {},
): Promise<boolean> {
  const emitter = createMateriaStdoutEmitter(input.mode, options);
  return emitter.emit({
    type: "materia_start",
    materiaName: input.materiaName,
    socketName: input.socketName,
  });
}

/**
 * Emit the informational `materia_end` event to pi's stdout JSONL stream.
 *
 * Emits one line per socket at the socket's materia completion lifecycle point
 * (the same point as the artifact `socket_complete` write), and only when
 * running under `pi --mode rpc` (no-op in TUI/interactive/json/print modes).
 * For multi-turn agent sockets this fires once when the socket finalizes, not
 * once per turn. This is an ADDITIONAL sink — it does NOT replace or alter the
 * artifact `socket_complete` event, which remains the source of truth for the
 * socket record.
 *
 * Best-effort: any serialization or write failure is swallowed and reported as
 * `false`; this method never throws, so a broken stdout pipe cannot fail a
 * cast or stall the pipeline.
 *
 * @returns `true` when a line was written; `false` when skipped (non-RPC mode)
 *   or when a best-effort failure occurred.
 */
export async function emitMateriaEndStdout(
  input: StdoutMateriaLifecycleInput,
  options: StdoutLifecycleEmitOptions = {},
): Promise<boolean> {
  const emitter = createMateriaStdoutEmitter(input.mode, options);
  return emitter.emit({
    type: "materia_end",
    materiaName: input.materiaName,
    socketName: input.socketName,
  });
}
