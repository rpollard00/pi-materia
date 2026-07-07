import { describe, expect, test } from "bun:test";
import {
  DEFAULT_STDOUT_EVENTING_PRESET,
  detectPiRunMode,
  emitCastStartStdout,
  emitCastEndStdout,
  emitMateriaStartStdout,
  emitMateriaEndStdout,
  mapSocketDetailsToStdout,
  resolveStdoutEventingPreset,
  type StdoutCastStartInput,
  type StdoutCastEndInput,
  type StdoutMateriaLifecycleInput,
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

// ── emitCastEndStdout ───────────────────────────────────────────────────

/** Build a cast_end input with sensible RPC defaults. */
function baseEndInput(overrides: Partial<StdoutCastEndInput> = {}): StdoutCastEndInput {
  return {
    mode: "rpc",
    castId: "cast-2026",
    ok: true,
    ...overrides,
  };
}

describe("emitCastEndStdout (RPC mode)", () => {
  test("emits exactly one cast_end with ok:true and the matching castId", async () => {
    const captured: StdoutLifecycleEvent[] = [];
    const ok = await emitCastEndStdout(baseEndInput(), { writer: capturingWriter(captured) });

    expect(ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      type: "cast_end",
      castId: "cast-2026",
      ok: true,
    });
    // No error field on the success path.
    expect("error" in (captured[0] as Record<string, unknown>)).toBe(false);
  });

  test("emits exactly one cast_end with ok:false and the error message on the failure path", async () => {
    const captured: StdoutLifecycleEvent[] = [];
    const ok = await emitCastEndStdout(
      baseEndInput({ ok: false, error: "multiTurn agent socket under agent-controller" }),
      { writer: capturingWriter(captured) },
    );

    expect(ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      type: "cast_end",
      castId: "cast-2026",
      ok: false,
      error: "multiTurn agent socket under agent-controller",
    });
  });

  test("omits the error field on the failure path when none is provided", async () => {
    const captured: StdoutLifecycleEvent[] = [];
    await emitCastEndStdout(baseEndInput({ ok: false }), { writer: capturingWriter(captured) });

    expect(captured[0]).toEqual({
      type: "cast_end",
      castId: "cast-2026",
      ok: false,
    });
    expect("error" in (captured[0] as Record<string, unknown>)).toBe(false);
  });

  test("serializes as strict LF-delimited JSONL (one line, trailing newline)", async () => {
    const lines: string[] = [];
    const writer: StdoutWriter = (chunk) => { lines.push(String(chunk)); };
    await emitCastEndStdout(baseEndInput(), { writer });

    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith("\n")).toBe(true);
    expect(lines[0].includes("\r")).toBe(false);
    const parsed = JSON.parse(lines[0]) as { type: string };
    expect(parsed.type).toBe("cast_end");
  });
});

describe("emitCastEndStdout (non-RPC modes are silent)", () => {
  for (const mode of ["tui", "json", "print"] as const) {
    test(`writes nothing in ${mode} mode`, async () => {
      const captured: StdoutLifecycleEvent[] = [];
      const ok = await emitCastEndStdout(baseEndInput({ mode }), { writer: capturingWriter(captured) });

      expect(ok).toBe(false);
      expect(captured).toHaveLength(0);
    });
  }
});

describe("emitCastEndStdout (default mode detection)", () => {
  test("emits when process.argv carries `--mode rpc` and no explicit mode is given", async () => {
    const original = process.argv;
    process.argv = ["node", "pi", "--mode", "rpc"];
    try {
      const captured: StdoutLifecycleEvent[] = [];
      const ok = await emitCastEndStdout(
        { castId: "cast-detect", ok: true },
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
    const ok = await emitCastEndStdout(
      { castId: "cast-detect", ok: true },
      { writer: capturingWriter(captured) },
    );
    expect(ok).toBe(false);
    expect(captured).toHaveLength(0);
  });
});

describe("emitCastEndStdout (best-effort)", () => {
  test("swallows a throwing writer and returns false without throwing", async () => {
    const explodingWriter: StdoutWriter = () => { throw new Error("broken pipe"); };
    const ok = await emitCastEndStdout(baseEndInput(), { writer: explodingWriter });

    expect(ok).toBe(false);
  });

  test("swallows an async-rejecting writer and returns false without throwing", async () => {
    const rejectingWriter: StdoutWriter = () => Promise.reject(new Error("async broken pipe"));
    const ok = await emitCastEndStdout(baseEndInput(), { writer: rejectingWriter });

    expect(ok).toBe(false);
  });
});

// ── cast_start + cast_end pairing (single terminal cast_end per cast) ────

describe("cast lifecycle pairing (start + single terminal end)", () => {
  test("a cast emits exactly one cast_start then exactly one cast_end on the success path", async () => {
    const captured: StdoutLifecycleEvent[] = [];
    const writer = capturingWriter(captured);

    await emitCastStartStdout(baseInput(), { writer });
    // The three cast_end artifact paths are mutually exclusive; here the
    // success terminal (finishCast) fires exactly once after the pipeline.
    await emitCastEndStdout(baseEndInput({ castId: "cast-2026", ok: true }), { writer });

    expect(captured).toHaveLength(2);
    expect(captured[0].type).toBe("cast_start");
    expect(captured[1].type).toBe("cast_end");
    expect((captured[0] as { castId: string }).castId)
      .toBe((captured[1] as { castId: string }).castId);
    expect((captured[1] as { ok: boolean }).ok).toBe(true);
  });

  test("a multi-socket cast still emits exactly one cast_end after the last socket", async () => {
    // cast_start carries multiple agent sockets, but cast_end is cast-level
    // (finishCast/failCast/validation are mutually exclusive single terminals),
    // so exactly one cast_end is emitted regardless of socket count.
    const captured: StdoutLifecycleEvent[] = [];
    const writer = capturingWriter(captured);

    await emitCastStartStdout(baseInput(), { writer });
    await emitCastEndStdout(baseEndInput({ castId: "cast-2026", ok: true }), { writer });

    const castEnds = captured.filter((e) => e.type === "cast_end");
    expect(castEnds).toHaveLength(1);
    const castStarts = captured.filter((e) => e.type === "cast_start");
    expect(castStarts).toHaveLength(1);
    expect((castStarts[0] as { sockets: unknown[] }).sockets.length).toBeGreaterThan(1);
  });
});

// ── materia_start / materia_end ─────────────────────────────────────────

/** Build a materia lifecycle input with sensible RPC defaults. */
function baseMateriaInput(overrides: Partial<StdoutMateriaLifecycleInput> = {}): StdoutMateriaLifecycleInput {
  return {
    mode: "rpc",
    materiaName: "Buildga",
    socketName: "Socket-1",
    ...overrides,
  };
}

describe("emitMateriaStartStdout (RPC mode)", () => {
  test("emits exactly one materia_start with the controller-compatible payload", async () => {
    const captured: StdoutLifecycleEvent[] = [];
    const ok = await emitMateriaStartStdout(baseMateriaInput(), { writer: capturingWriter(captured) });

    expect(ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      type: "materia_start",
      materiaName: "Buildga",
      socketName: "Socket-1",
    });
    // No extra fields beyond the contract.
    expect(Object.keys(captured[0]).sort()).toEqual(["materiaName", "socketName", "type"]);
  });

  test("serializes as strict LF-delimited JSONL (one line, trailing newline)", async () => {
    const lines: string[] = [];
    const writer: StdoutWriter = (chunk) => { lines.push(String(chunk)); };
    await emitMateriaStartStdout(baseMateriaInput(), { writer });

    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith("\n")).toBe(true);
    expect(lines[0].includes("\r")).toBe(false);
    const parsed = JSON.parse(lines[0]) as { type: string };
    expect(parsed.type).toBe("materia_start");
  });
});

describe("emitMateriaEndStdout (RPC mode)", () => {
  test("emits exactly one materia_end with the controller-compatible payload", async () => {
    const captured: StdoutLifecycleEvent[] = [];
    const ok = await emitMateriaEndStdout(baseMateriaInput(), { writer: capturingWriter(captured) });

    expect(ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      type: "materia_end",
      materiaName: "Buildga",
      socketName: "Socket-1",
    });
    expect(Object.keys(captured[0]).sort()).toEqual(["materiaName", "socketName", "type"]);
  });

  test("serializes as strict LF-delimited JSONL (one line, trailing newline)", async () => {
    const lines: string[] = [];
    const writer: StdoutWriter = (chunk) => { lines.push(String(chunk)); };
    await emitMateriaEndStdout(baseMateriaInput(), { writer });

    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith("\n")).toBe(true);
    expect(lines[0].includes("\r")).toBe(false);
    const parsed = JSON.parse(lines[0]) as { type: string };
    expect(parsed.type).toBe("materia_end");
  });
});

// Non-RPC gating is shared (createMateriaStdoutEmitter), so asserting one
// event for each type is sufficient to cover the gating path for both.
describe("emitMateriaStartStdout / emitMateriaEndStdout (non-RPC modes are silent)", () => {
  for (const mode of ["tui", "json", "print"] as const) {
    test(`materia_start writes nothing in ${mode} mode`, async () => {
      const captured: StdoutLifecycleEvent[] = [];
      const ok = await emitMateriaStartStdout(baseMateriaInput({ mode }), { writer: capturingWriter(captured) });

      expect(ok).toBe(false);
      expect(captured).toHaveLength(0);
    });
    test(`materia_end writes nothing in ${mode} mode`, async () => {
      const captured: StdoutLifecycleEvent[] = [];
      const ok = await emitMateriaEndStdout(baseMateriaInput({ mode }), { writer: capturingWriter(captured) });

      expect(ok).toBe(false);
      expect(captured).toHaveLength(0);
    });
  }
});

describe("emitMateriaStartStdout / emitMateriaEndStdout (default mode detection)", () => {
  test("emit when process.argv carries `--mode rpc` and no explicit mode is given", async () => {
    const original = process.argv;
    process.argv = ["node", "pi", "--mode", "rpc"];
    try {
      const captured: StdoutLifecycleEvent[] = [];
      const ok = await emitMateriaStartStdout(
        { materiaName: "Buildga", socketName: "Socket-1" },
        { writer: capturingWriter(captured) },
      );
      expect(ok).toBe(true);
      expect(captured).toHaveLength(1);
    } finally {
      process.argv = original;
    }
  });

  test("stay silent by default in a non-rpc argv (e.g. the test runner)", async () => {
    const captured: StdoutLifecycleEvent[] = [];
    const ok = await emitMateriaEndStdout(
      { materiaName: "Buildga", socketName: "Socket-1" },
      { writer: capturingWriter(captured) },
    );
    expect(ok).toBe(false);
    expect(captured).toHaveLength(0);
  });
});

describe("emitMateriaStartStdout / emitMateriaEndStdout (best-effort)", () => {
  test("swallow a throwing writer and return false without throwing", async () => {
    const explodingWriter: StdoutWriter = () => { throw new Error("broken pipe"); };
    expect(await emitMateriaStartStdout(baseMateriaInput(), { writer: explodingWriter })).toBe(false);
    expect(await emitMateriaEndStdout(baseMateriaInput(), { writer: explodingWriter })).toBe(false);
  });

  test("swallow an async-rejecting writer and return false without throwing", async () => {
    const rejectingWriter: StdoutWriter = () => Promise.reject(new Error("async broken pipe"));
    expect(await emitMateriaStartStdout(baseMateriaInput(), { writer: rejectingWriter })).toBe(false);
    expect(await emitMateriaEndStdout(baseMateriaInput(), { writer: rejectingWriter })).toBe(false);
  });
});

describe("materia lifecycle emits only materia_* types (no socket_* noise)", () => {
  test("the materia emit functions never produce socket_start or socket_complete", async () => {
    const captured: StdoutLifecycleEvent[] = [];
    const writer = capturingWriter(captured);

    await emitMateriaStartStdout(baseMateriaInput(), { writer });
    await emitMateriaEndStdout(baseMateriaInput(), { writer });

    expect(captured.map((e) => e.type)).toEqual(["materia_start", "materia_end"]);
    expect(captured.filter((e) => e.type === "socket_start" || e.type === "socket_complete")).toHaveLength(0);
  });
});

describe("materia lifecycle pairing (start + end per socket)", () => {
  test("a socket emits exactly one materia_start then one materia_end with mirrored materiaName/socketName", async () => {
    const captured: StdoutLifecycleEvent[] = [];
    const writer = capturingWriter(captured);

    await emitMateriaStartStdout(baseMateriaInput({ materiaName: "Reviewer", socketName: "Socket-2" }), { writer });
    await emitMateriaEndStdout(baseMateriaInput({ materiaName: "Reviewer", socketName: "Socket-2" }), { writer });

    expect(captured).toHaveLength(2);
    expect(captured[0].type).toBe("materia_start");
    expect(captured[1].type).toBe("materia_end");
    // materiaName / socketName mirror the cast_start.sockets[] fields so the
    // controller can correlate materia lifecycle with the socket graph.
    for (const event of captured) {
      const e = event as { materiaName: string; socketName: string };
      expect(e.materiaName).toBe("Reviewer");
      expect(e.socketName).toBe("Socket-2");
    }
  });

  test("a multi-socket cast emits one materia_start/materia_end per socket (socket-scoped, not cast-scoped)", async () => {
    const captured: StdoutLifecycleEvent[] = [];
    const writer = capturingWriter(captured);

    // Simulate Socket-1 then Socket-2 each bracketing their materia execution.
    await emitMateriaStartStdout({ mode: "rpc", materiaName: "Buildga", socketName: "Socket-1" }, { writer });
    await emitMateriaEndStdout({ mode: "rpc", materiaName: "Buildga", socketName: "Socket-1" }, { writer });
    await emitMateriaStartStdout({ mode: "rpc", materiaName: "Reviewer", socketName: "Socket-2" }, { writer });
    await emitMateriaEndStdout({ mode: "rpc", materiaName: "Reviewer", socketName: "Socket-2" }, { writer });

    expect(captured.filter((e) => e.type === "materia_start")).toHaveLength(2);
    expect(captured.filter((e) => e.type === "materia_end")).toHaveLength(2);
  });
});
