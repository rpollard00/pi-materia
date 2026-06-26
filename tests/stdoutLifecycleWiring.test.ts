import { describe, expect, test } from "bun:test";
import {
  DEFAULT_STDOUT_EVENTING_PRESET,
  detectPiRunMode,
  emitCastStartStdout,
  mapSocketDetailsToStdout,
  resolveStdoutEventingPreset,
  type StdoutCastStartInput,
} from "../src/runtime/stdoutLifecycleWiring.js";
import type { StdoutLifecycleEvent, StdoutWriter } from "../src/infrastructure/stdoutLifecycle.js";
import type { PiMateriaConfig } from "../src/types.js";

// ── Test fixtures ───────────────────────────────────────────────────────

/** Minimal config carrying only the eventing presets the wiring reads. */
function configWithPresets(presets?: string[]): PiMateriaConfig {
  return {
    materia: {},
    ...(presets ? { eventing: { presets } } : {}),
  } as PiMateriaConfig;
}

/** Capturing writer that records every JSONL line written. */
function capturingWriter(sink: StdoutLifecycleEvent[]): StdoutWriter {
  return (chunk) => {
    // Each write is exactly one JSONL line; parse for ergonomic assertions.
    const trimmed = String(chunk).trim();
    if (trimmed.length > 0) sink.push(JSON.parse(trimmed) as StdoutLifecycleEvent);
  };
}

/** A multi-socket detail set (agent + utility) mirroring buildPipelineSocketDetails output. */
const MULTI_SOCKET_DETAILS = [
  { socketId: "Socket-1", materiaName: "Buildga", isAgent: true, multiTurn: false },
  { socketId: "Socket-2", materiaName: "Reviewer", isAgent: true, multiTurn: true },
  { socketId: "Socket-3", materiaName: "Catalog", isAgent: false, multiTurn: false },
];

const baseInput = (overrides: Partial<StdoutCastStartInput> = {}): StdoutCastStartInput => ({
  mode: "rpc",
  castId: "cast-2026",
  config: configWithPresets(["agent-controller"]),
  socketDetails: MULTI_SOCKET_DETAILS,
  loadoutName: "Elena",
  loadoutId: "elena-v1",
  ...overrides,
});

// ── detectPiRunMode ─────────────────────────────────────────────────────

describe("detectPiRunMode", () => {
  test("recognizes `--mode rpc` (space form) anywhere in argv", () => {
    expect(detectPiRunMode(["node", "pi", "--mode", "rpc"])).toBe("rpc");
    expect(detectPiRunMode(["pi", "--extension", "x", "--mode", "rpc", "prompt"])).toBe("rpc");
  });

  test("recognizes `--mode=rpc` (equals form)", () => {
    expect(detectPiRunMode(["pi", "--mode=rpc"])).toBe("rpc");
  });

  test("reports text/json for those explicit modes", () => {
    expect(detectPiRunMode(["pi", "--mode", "text"])).toBe("text");
    expect(detectPiRunMode(["pi", "--mode", "json"])).toBe("json");
  });

  test("reports unknown when --mode is missing (interactive default) or invalid", () => {
    expect(detectPiRunMode(["pi"])).toBe("unknown");
    expect(detectPiRunMode(["pi", "--mode", "bogus"])).toBe("unknown");
    expect(detectPiRunMode(["pi", "--print", "-p"])).toBe("unknown");
  });
});

// ── emitCastStartStdout: default mode detection ─────────────────────────

describe("emitCastStartStdout (default mode detection)", () => {
  test("emits when process.argv carries `--mode rpc` and no explicit mode is given", async () => {
    const original = process.argv;
    process.argv = ["node", "pi", "--mode", "rpc"];
    try {
      const captured: StdoutLifecycleEvent[] = [];
      const ok = await emitCastStartStdout(
        { castId: "cast-detect", config: configWithPresets(["agent-controller"]), socketDetails: MULTI_SOCKET_DETAILS },
        { writer: capturingWriter(captured) },
      );
      expect(ok).toBe(true);
      expect(captured).toHaveLength(1);
    } finally {
      process.argv = original;
    }
  });

  test("stays silent by default in a non-rpc argv (e.g. the test runner)", async () => {
    const captured: StdoutLifecycleEvent[] = [];
    const ok = await emitCastStartStdout(
      { castId: "cast-detect", config: configWithPresets(["agent-controller"]), socketDetails: MULTI_SOCKET_DETAILS },
      { writer: capturingWriter(captured) },
    );
    expect(ok).toBe(false);
    expect(captured).toHaveLength(0);
  });
});

// ── resolveStdoutEventingPreset ─────────────────────────────────────────

describe("resolveStdoutEventingPreset", () => {
  test("prefers agent-controller when present", () => {
    expect(resolveStdoutEventingPreset(configWithPresets(["other", "agent-controller"]))).toBe("agent-controller");
  });

  test("returns the first configured preset when agent-controller is absent", () => {
    expect(resolveStdoutEventingPreset(configWithPresets(["custom-preset", "other"]))).toBe("custom-preset");
  });

  test("falls back to the default sentinel when no presets are configured", () => {
    expect(resolveStdoutEventingPreset(configWithPresets())).toBe(DEFAULT_STDOUT_EVENTING_PRESET);
    expect(resolveStdoutEventingPreset(configWithPresets([]))).toBe(DEFAULT_STDOUT_EVENTING_PRESET);
  });
});

// ── mapSocketDetailsToStdout ────────────────────────────────────────────

describe("mapSocketDetailsToStdout", () => {
  test("maps socketId→socketName, isAgent→type, and passes materiaName/multiTurn through", () => {
    expect(mapSocketDetailsToStdout(MULTI_SOCKET_DETAILS)).toEqual([
      { socketName: "Socket-1", type: "agent", materiaName: "Buildga", multiTurn: false },
      { socketName: "Socket-2", type: "agent", materiaName: "Reviewer", multiTurn: true },
      { socketName: "Socket-3", type: "materia", materiaName: "Catalog", multiTurn: false },
    ]);
  });

  test("returns an empty array for an empty pipeline", () => {
    expect(mapSocketDetailsToStdout([])).toEqual([]);
  });
});

// ── emitCastStartStdout: RPC mode payload ───────────────────────────────

describe("emitCastStartStdout (RPC mode)", () => {
  test("emits exactly one cast_start with the controller-compatible payload", async () => {
    const captured: StdoutLifecycleEvent[] = [];
    const ok = await emitCastStartStdout(baseInput(), { writer: capturingWriter(captured) });

    expect(ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      type: "cast_start",
      castId: "cast-2026",
      eventing: { preset: "agent-controller" },
      sockets: [
        { socketName: "Socket-1", type: "agent", materiaName: "Buildga", multiTurn: false },
        { socketName: "Socket-2", type: "agent", materiaName: "Reviewer", multiTurn: true },
        { socketName: "Socket-3", type: "materia", materiaName: "Catalog", multiTurn: false },
      ],
      loadout: "Elena",
      loadoutId: "elena-v1",
    });
  });

  test("serializes as strict LF-delimited JSONL (one line, trailing newline)", async () => {
    const lines: string[] = [];
    const writer: StdoutWriter = (chunk) => { lines.push(String(chunk)); };
    await emitCastStartStdout(baseInput(), { writer });

    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith("\n")).toBe(true);
    expect(lines[0].includes("\r")).toBe(false);
    const parsed = JSON.parse(lines[0]) as { type: string };
    expect(parsed.type).toBe("cast_start");
  });

  test("omits loadout/loadoutId when not provided", async () => {
    const captured: StdoutLifecycleEvent[] = [];
    await emitCastStartStdout(
      baseInput({ loadoutName: undefined, loadoutId: undefined }),
      { writer: capturingWriter(captured) },
    );

    const event = captured[0] as Record<string, unknown>;
    expect("loadout" in event).toBe(false);
    expect("loadoutId" in event).toBe(false);
  });

  test("reflects the resolved preset when agent-controller is not active", async () => {
    const captured: StdoutLifecycleEvent[] = [];
    await emitCastStartStdout(
      baseInput({ config: configWithPresets(["custom-preset"]) }),
      { writer: capturingWriter(captured) },
    );

    expect((captured[0] as { eventing: { preset: string } }).eventing.preset).toBe("custom-preset");
  });
});

// ── emitCastStartStdout: non-RPC gating ─────────────────────────────────

describe("emitCastStartStdout (non-RPC modes are silent)", () => {
  for (const mode of ["tui", "json", "print"] as const) {
    test(`writes nothing in ${mode} mode`, async () => {
      const captured: StdoutLifecycleEvent[] = [];
      const ok = await emitCastStartStdout(baseInput({ mode }), { writer: capturingWriter(captured) });

      expect(ok).toBe(false);
      expect(captured).toHaveLength(0);
    });
  }
});

// ── emitCastStartStdout: best-effort / non-throwing ─────────────────────

describe("emitCastStartStdout (best-effort)", () => {
  test("swallows a throwing writer and returns false without throwing", async () => {
    const explodingWriter: StdoutWriter = () => { throw new Error("broken pipe"); };
    const ok = await emitCastStartStdout(baseInput(), { writer: explodingWriter });

    expect(ok).toBe(false);
  });

  test("swallows an async-rejecting writer and returns false without throwing", async () => {
    const rejectingWriter: StdoutWriter = () => Promise.reject(new Error("async broken pipe"));
    const ok = await emitCastStartStdout(baseInput(), { writer: rejectingWriter });

    expect(ok).toBe(false);
  });
});
