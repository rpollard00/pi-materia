/**
 * Integration coverage for the RPC stdout lifecycle stream.
 *
 * `stdoutLifecycle.test.ts` and `stdoutLifecycleWiring.test.ts` cover the
 * emitter and the wiring layer in isolation using static socket-detail
 * fixtures. This file closes the remaining gap: it exercises the SAME data
 * flow `nativeLifecycle.ts` uses at runtime — a REAL `ResolvedMateriaPipeline`
 * → `buildPipelineSocketDetails(...)` → the stdout wiring → an injected
 * writer — and asserts the controller-compatible sequence the story's
 * acceptance criteria require:
 *
 *   - exactly one `cast_start` carrying `eventing.preset` + `sockets[]` for a
 *     multi-socket (Elena-style) loadout with mixed `multiTurn` booleans,
 *   - `materia_start` / `materia_end` emitted socket-scoped and correlatable
 *     to `cast_start.sockets[]`,
 *   - exactly one terminal `cast_end` after the whole pipeline (never one per
 *     socket), with the `materia_*` events bracketed in between,
 *   - `socket_start` / `socket_complete` / `agent_end` never reaching stdout
 *     (artifact-only / native-callback-owned), and
 *   - non-RPC (TUI/interactive/json/print) modes staying quiet for the same
 *     real pipeline.
 *
 * An injected writer (not `process.stdout`) is used throughout so the tests
 * are deterministic and never touch the real stdout stream.
 */

import { describe, expect, test } from "bun:test";
import { buildPipelineSocketDetails } from "../src/runtime/nativeLifecycle.js";
import * as stdoutLifecycleWiring from "../src/runtime/stdoutLifecycleWiring.js";
import {
  STDOUT_LIFECYCLE_EVENT_TYPES,
  isStdoutLifecycleType,
  type StdoutLifecycleEvent,
  type StdoutWriter,
} from "../src/infrastructure/stdoutLifecycle.js";
import type {
  PiMateriaConfig,
  ResolvedMateriaAgentSocket,
  ResolvedMateriaPipeline,
  ResolvedMateriaUtilitySocket,
} from "../src/types.js";

// ── Fixtures: a real multi-socket ResolvedMateriaPipeline (Elena-style) ──

function createAgentSocket(id: string, materiaId: string, multiTurn = false): ResolvedMateriaAgentSocket {
  return {
    id,
    socket: { materia: materiaId },
    materia: {
      type: "agent",
      prompt: `You are ${materiaId}.`,
      tools: {},
      multiTurn,
    },
  };
}

function createUtilitySocket(id: string, materiaId: string): ResolvedMateriaUtilitySocket {
  return {
    id,
    socket: { materia: materiaId },
    materiaId,
    materia: {
      type: "utility",
      utility: materiaId,
    },
  };
}

function createPipeline(
  sockets: Record<string, ResolvedMateriaAgentSocket | ResolvedMateriaUtilitySocket>,
): ResolvedMateriaPipeline {
  const entryId = Object.keys(sockets)[0] ?? "Socket-1";
  return {
    entry: sockets[entryId],
    sockets,
  };
}

/**
 * Elena-style multi-socket loadout: a single-turn planner, two multi-turn
 * agent sockets, and a utility catalog socket. This is the "multi-socket
 * loadout with multiple agent sockets" the story's acceptance criteria call
 * out, with mixed `multiTurn` booleans.
 */
function elenaPipeline(): ResolvedMateriaPipeline {
  return createPipeline({
    "Socket-1": createAgentSocket("Socket-1", "Planner", false),
    "Socket-2": createAgentSocket("Socket-2", "Buildera", true),
    "Socket-3": createAgentSocket("Socket-3", "Reviewer", true),
    "Socket-4": createUtilitySocket("Socket-4", "Catalog"),
  });
}

function configWithPresets(presets?: string[]): PiMateriaConfig {
  return {
    materia: {},
    ...(presets ? { eventing: { presets } } : {}),
  } as PiMateriaConfig;
}

/** Capturing writer that records every JSONL line as a parsed event. */
function capturingWriter(sink: StdoutLifecycleEvent[]): StdoutWriter {
  return (chunk) => {
    const trimmed = String(chunk).trim();
    if (trimmed.length > 0) sink.push(JSON.parse(trimmed) as StdoutLifecycleEvent);
  };
}

/** Raw-line capturing writer: records the exact bytes written (incl. trailing LF). */
function rawLineWriter(sink: string[]): StdoutWriter {
  return (chunk) => {
    sink.push(String(chunk));
  };
}

const ELENA_DETAILS = () => buildPipelineSocketDetails(elenaPipeline());

// ── cast_start: real pipeline → controller-compatible sockets[] ─────────

describe("RPC stdout lifecycle (real pipeline integration)", () => {
  test("a real multi-socket pipeline produces a controller-compatible cast_start.sockets[]", async () => {
    const captured: StdoutLifecycleEvent[] = [];

    const ok = await stdoutLifecycleWiring.emitCastStartStdout(
      { mode: "rpc", castId: "cast-elena", config: configWithPresets(["agent-controller"]), socketDetails: ELENA_DETAILS() },
      { writer: capturingWriter(captured) },
    );

    expect(ok).toBe(true);
    expect(captured).toHaveLength(1);
    const event = captured[0] as { type: string; sockets: unknown[] };
    expect(event.type).toBe("cast_start");
    // sockets[] mirrors the resolved pipeline graph the controller counts
    // agent sockets from and reads multiTurn from — type maps isAgent,
    // materiaName is the resolved display name, multiTurn passes through.
    expect(event.sockets).toEqual([
      { socketName: "Socket-1", type: "agent", materiaName: "Planner", multiTurn: false },
      { socketName: "Socket-2", type: "agent", materiaName: "Buildera", multiTurn: true },
      { socketName: "Socket-3", type: "agent", materiaName: "Reviewer", multiTurn: true },
      { socketName: "Socket-4", type: "materia", materiaName: "Catalog", multiTurn: false },
    ]);
  });

  test("cast_start carries the eventing.preset the controller keys its guards off of", async () => {
    const captured: StdoutLifecycleEvent[] = [];
    await stdoutLifecycleWiring.emitCastStartStdout(
      { mode: "rpc", castId: "cast-elena", config: configWithPresets(["agent-controller"]), socketDetails: ELENA_DETAILS() },
      { writer: capturingWriter(captured) },
    );
    expect((captured[0] as { eventing: { preset: string } }).eventing.preset).toBe("agent-controller");
  });

  test("the controller can count agent sockets and multiTurn flags from cast_start.sockets[]", async () => {
    const captured: StdoutLifecycleEvent[] = [];
    await stdoutLifecycleWiring.emitCastStartStdout(
      { mode: "rpc", castId: "cast-elena", config: configWithPresets(["agent-controller"]), socketDetails: ELENA_DETAILS() },
      { writer: capturingWriter(captured) },
    );
    const sockets = (captured[0] as { sockets: Array<{ type: string; multiTurn: boolean }> }).sockets;
    // Three agent sockets (Planner, Buildera, Reviewer) + one utility socket.
    expect(sockets.filter((s) => s.type === "agent")).toHaveLength(3);
    // multiTurn booleans are preserved so the controller can apply its
    // preset-gated guards.
    expect(sockets.filter((s) => s.multiTurn)).toHaveLength(2);
  });

  test("the real-pipeline cast_start is emitted as a single strict-LF JSONL line a consumer can parse", async () => {
    const lines: string[] = [];
    await stdoutLifecycleWiring.emitCastStartStdout(
      { mode: "rpc", castId: "cast-elena", config: configWithPresets(["agent-controller"]), socketDetails: ELENA_DETAILS() },
      { writer: rawLineWriter(lines) },
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith("\n")).toBe(true);
    expect(lines[0].includes("\r")).toBe(false);
    const parsed = JSON.parse(lines[0]) as { type: string; sockets: unknown[] };
    expect(parsed.type).toBe("cast_start");
    expect(parsed.sockets).toHaveLength(4);
  });

  // ── Exactly one cast_start and one terminal cast_end per cast ───────

  test("a cast emits exactly one cast_start then exactly one terminal cast_end", async () => {
    const captured: StdoutLifecycleEvent[] = [];
    const writer = capturingWriter(captured);

    await stdoutLifecycleWiring.emitCastStartStdout(
      { mode: "rpc", castId: "cast-elena", config: configWithPresets(["agent-controller"]), socketDetails: ELENA_DETAILS() },
      { writer },
    );
    // The three artifact cast_end paths (validation / failCast / finishCast)
    // are mutually exclusive; exactly one fires per cast.
    await stdoutLifecycleWiring.emitCastEndStdout({ mode: "rpc", castId: "cast-elena", ok: true }, { writer });

    expect(captured.filter((e) => e.type === "cast_start")).toHaveLength(1);
    expect(captured.filter((e) => e.type === "cast_end")).toHaveLength(1);
    // castId pairs the start/end so the controller can correlate them.
    const start = captured.find((e) => e.type === "cast_start") as { castId: string };
    const end = captured.find((e) => e.type === "cast_end") as { castId: string };
    expect(start.castId).toBe("cast-elena");
    expect(end.castId).toBe("cast-elena");
  });

  test("a multi-socket cast emits ONE cast_end after the whole pipeline (not one per socket)", async () => {
    const captured: StdoutLifecycleEvent[] = [];
    const writer = capturingWriter(captured);

    await stdoutLifecycleWiring.emitCastStartStdout(
      { mode: "rpc", castId: "cast-elena", config: configWithPresets(["agent-controller"]), socketDetails: ELENA_DETAILS() },
      { writer },
    );
    // Each socket brackets its own materia execution with materia_start/end,
    // but cast_end is cast-level (finishCast/failCast/validation), so it
    // fires exactly once regardless of socket count.
    for (const detail of ELENA_DETAILS()) {
      await stdoutLifecycleWiring.emitMateriaStartStdout(
        { mode: "rpc", materiaName: detail.materiaName, socketName: detail.socketId },
        { writer },
      );
      await stdoutLifecycleWiring.emitMateriaEndStdout(
        { mode: "rpc", materiaName: detail.materiaName, socketName: detail.socketId },
        { writer },
      );
    }
    await stdoutLifecycleWiring.emitCastEndStdout({ mode: "rpc", castId: "cast-elena", ok: true }, { writer });

    expect(captured.filter((e) => e.type === "cast_start")).toHaveLength(1);
    expect(captured.filter((e) => e.type === "cast_end")).toHaveLength(1);
    // One materia_start + one materia_end per socket (4 sockets), all
    // bracketed by the single cast_start / cast_end pair.
    expect(captured.filter((e) => e.type === "materia_start")).toHaveLength(4);
    expect(captured.filter((e) => e.type === "materia_end")).toHaveLength(4);
  });

  // ── materia_start / materia_end: socket-scoped, correlate to cast_start ──

  test("materia_start/materia_end mirror cast_start.sockets[] materiaName/socketName per socket", async () => {
    const captured: StdoutLifecycleEvent[] = [];
    const writer = capturingWriter(captured);

    await stdoutLifecycleWiring.emitCastStartStdout(
      { mode: "rpc", castId: "cast-elena", config: configWithPresets(["agent-controller"]), socketDetails: ELENA_DETAILS() },
      { writer },
    );
    for (const detail of ELENA_DETAILS()) {
      await stdoutLifecycleWiring.emitMateriaStartStdout(
        { mode: "rpc", materiaName: detail.materiaName, socketName: detail.socketId },
        { writer },
      );
      await stdoutLifecycleWiring.emitMateriaEndStdout(
        { mode: "rpc", materiaName: detail.materiaName, socketName: detail.socketId },
        { writer },
      );
    }

    const castStartSockets = (captured.find((e) => e.type === "cast_start") as {
      sockets: Array<{ socketName: string; materiaName: string }>;
    }).sockets;
    const materiaStarts = captured.filter((e) => e.type === "materia_start") as Array<{
      materiaName: string;
      socketName: string;
    }>;
    const materiaEnds = captured.filter((e) => e.type === "materia_end") as Array<{
      materiaName: string;
      socketName: string;
    }>;

    // Each materia_start/end must pair back to a cast_start socket by both
    // (socketName, materiaName) so the controller can correlate the materia
    // lifecycle with the socket graph.
    for (const socket of castStartSockets) {
      expect(materiaStarts.some((m) => m.socketName === socket.socketName && m.materiaName === socket.materiaName)).toBe(true);
      expect(materiaEnds.some((m) => m.socketName === socket.socketName && m.materiaName === socket.materiaName)).toBe(true);
    }
  });

  // ── No socket_start / socket_complete / agent_end on stdout ──────────

  test("socket_start and socket_complete are never emitted to stdout (artifact-only)", () => {
    // The curated stdout type set deliberately excludes socket-level events:
    // they are not in the controller's recognized set and would be noise.
    expect(STDOUT_LIFECYCLE_EVENT_TYPES).not.toContain("socket_start");
    expect(STDOUT_LIFECYCLE_EVENT_TYPES).not.toContain("socket_complete");
    expect(isStdoutLifecycleType("socket_start")).toBe(false);
    expect(isStdoutLifecycleType("socket_complete")).toBe(false);
  });

  test("agent_end is NOT a stdout lifecycle event (per-socket agent_end is owned by pi's native callback)", () => {
    // agent_end already reaches stdout through pi's native agent_end callback
    // (src/index.ts), NOT through this emitter. The curated stdout lifecycle
    // set must stay disjoint from it so per-socket agent_end behavior is
    // unchanged: one agent_end per agent socket, independent of the
    // cast_start / cast_end framing.
    expect(STDOUT_LIFECYCLE_EVENT_TYPES).not.toContain("agent_end");
    expect(isStdoutLifecycleType("agent_end")).toBe(false);
  });

  test("the wiring surface exposes no socket_start/socket_complete/agent_end emitter", () => {
    // Structural guard: only cast_start/cast_end/materia_start/materia_end
    // are wired. There must never be an emitter for the non-curated types.
    const api = stdoutLifecycleWiring as Record<string, unknown>;
    expect(api.emitCastStartStdout).toBeTypeOf("function");
    expect(api.emitCastEndStdout).toBeTypeOf("function");
    expect(api.emitMateriaStartStdout).toBeTypeOf("function");
    expect(api.emitMateriaEndStdout).toBeTypeOf("function");
    expect(api.emitSocketStartStdout).toBeUndefined();
    expect(api.emitSocketCompleteStdout).toBeUndefined();
    expect(api.emitAgentEndStdout).toBeUndefined();
  });

  // ── Non-RPC gating stays quiet for the same real pipeline ───────────

  test("the same multi-socket pipeline emits nothing in TUI/interactive mode", async () => {
    const captured: StdoutLifecycleEvent[] = [];
    const writer = capturingWriter(captured);

    await stdoutLifecycleWiring.emitCastStartStdout(
      { mode: "tui", castId: "cast-elena", config: configWithPresets(["agent-controller"]), socketDetails: ELENA_DETAILS() },
      { writer },
    );
    await stdoutLifecycleWiring.emitMateriaStartStdout({ mode: "tui", materiaName: "Buildera", socketName: "Socket-2" }, { writer });
    await stdoutLifecycleWiring.emitMateriaEndStdout({ mode: "tui", materiaName: "Buildera", socketName: "Socket-2" }, { writer });
    await stdoutLifecycleWiring.emitCastEndStdout({ mode: "tui", castId: "cast-elena", ok: true }, { writer });

    expect(captured).toHaveLength(0);
  });

  for (const mode of ["tui", "json", "print"] as const) {
    test(`cast_start stays quiet for a real pipeline in ${mode} mode`, async () => {
      const captured: StdoutLifecycleEvent[] = [];
      const ok = await stdoutLifecycleWiring.emitCastStartStdout(
        { mode, castId: "cast-elena", config: configWithPresets(["agent-controller"]), socketDetails: ELENA_DETAILS() },
        { writer: capturingWriter(captured) },
      );
      expect(ok).toBe(false);
      expect(captured).toHaveLength(0);
    });
  }
});
