import { describe, expect, test } from "bun:test";
import {
  STDOUT_LIFECYCLE_EVENT_TYPES,
  StdoutLifecycleEmitter,
  createStdoutLifecycleEmitter,
  defaultStdoutWriter,
  isStdoutLifecycleType,
  serializeStdoutLifecycleLine,
  shouldEmitStdoutLifecycle,
  type StdoutLifecycleEvent,
  type StdoutWriter,
} from "../src/infrastructure/stdoutLifecycle.js";

// ── Capturing writer used across tests ───────────────────────────────────

function capturingWriter(sink: string[]): StdoutWriter {
  return (chunk) => {
    sink.push(chunk);
  };
}

const SAMPLE_CAST_START: StdoutLifecycleEvent = {
  type: "cast_start",
  castId: "cast-123",
  eventing: { preset: "agent-controller" },
  sockets: [
    { socketName: "Socket-1", type: "agent", materiaName: "Buildga", multiTurn: false },
    { socketName: "Socket-2", type: "agent", materiaName: "Reviewer", multiTurn: true },
  ],
  loadout: "Elena",
  loadoutId: "elena-v1",
};

const SAMPLE_CAST_END_OK: StdoutLifecycleEvent = {
  type: "cast_end",
  castId: "cast-123",
  ok: true,
};

const SAMPLE_CAST_END_FAIL: StdoutLifecycleEvent = {
  type: "cast_end",
  castId: "cast-123",
  ok: false,
  error: "boom",
};

// ── Curated type set ────────────────────────────────────────────────────

describe("STDOUT_LIFECYCLE_EVENT_TYPES / isStdoutLifecycleType", () => {
  test("the curated set contains exactly the controller-recognized lifecycle types", () => {
    expect([...STDOUT_LIFECYCLE_EVENT_TYPES].sort()).toEqual(
      ["cast_end", "cast_start", "materia_end", "materia_start"],
    );
  });

  test("accepts curated lifecycle types", () => {
    for (const type of STDOUT_LIFECYCLE_EVENT_TYPES) {
      expect(isStdoutLifecycleType(type)).toBe(true);
    }
  });

  test("rejects socket-level and diagnostic/internal types", () => {
    const rejected = [
      "socket_start",
      "socket_complete",
      "stale_agent_end_ignored",
      "same_socket_recovery_retry",
      "utility_command",
      "agent_end",
      "",
      undefined,
      null,
      123,
    ];
    for (const type of rejected) {
      expect(isStdoutLifecycleType(type)).toBe(false);
    }
  });
});

// ── Serialization ───────────────────────────────────────────────────────

describe("serializeStdoutLifecycleLine", () => {
  test("produces compact JSON terminated by exactly one LF", () => {
    const line = serializeStdoutLifecycleLine(SAMPLE_CAST_START);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.endsWith("\r\n")).toBe(false);
    expect(line.match(/\n/g)?.length).toBe(1);
    // The payload (minus the trailing LF) is valid compact JSON.
    const parsed = JSON.parse(line.slice(0, -1));
    expect(parsed.type).toBe("cast_start");
    expect(parsed.eventing.preset).toBe("agent-controller");
    expect(parsed.sockets).toHaveLength(2);
    expect(parsed.sockets[1]).toEqual({
      socketName: "Socket-2",
      type: "agent",
      materiaName: "Reviewer",
      multiTurn: true,
    });
  });

  test("preserves optional fields and omits undefined", () => {
    const line = serializeStdoutLifecycleLine({ type: "materia_end", materiaName: "Buildga", socketName: "Socket-1" });
    const parsed = JSON.parse(line.slice(0, -1));
    expect(parsed).toEqual({ type: "materia_end", materiaName: "Buildga", socketName: "Socket-1" });
    expect("error" in parsed).toBe(false);
  });
});

// ── Mode gating ─────────────────────────────────────────────────────────

describe("shouldEmitStdoutLifecycle", () => {
  test("only RPC mode emits", () => {
    expect(shouldEmitStdoutLifecycle("rpc")).toBe(true);
  });

  test("TUI, json, print, and unknown modes stay quiet", () => {
    for (const mode of ["tui", "json", "print", "interactive", "", "cli"]) {
      expect(shouldEmitStdoutLifecycle(mode)).toBe(false);
    }
  });
});

// ── Emitter behavior ────────────────────────────────────────────────────

describe("StdoutLifecycleEmitter", () => {
  test("writes exactly one JSONL line for each curated lifecycle event", async () => {
    const sink: string[] = [];
    const emitter = new StdoutLifecycleEmitter({ writer: capturingWriter(sink), enabled: true });

    await emitter.emit(SAMPLE_CAST_START);
    await emitter.emit({ type: "materia_start", materiaName: "Buildga", socketName: "Socket-1" });
    await emitter.emit({ type: "materia_end", materiaName: "Buildga", socketName: "Socket-1" });
    await emitter.emit(SAMPLE_CAST_END_OK);

    expect(sink).toHaveLength(4);
    expect(sink.every((line) => line.endsWith("\n") && !line.endsWith("\r\n"))).toBe(true);
    expect(JSON.parse(sink[0].slice(0, -1)).type).toBe("cast_start");
    expect(JSON.parse(sink[1].slice(0, -1)).type).toBe("materia_start");
    expect(JSON.parse(sink[2].slice(0, -1)).type).toBe("materia_end");
    expect(JSON.parse(sink[3].slice(0, -1)).type).toBe("cast_end");
  });

  test("cast_end carries ok:false on failure paths and ok:true on success", async () => {
    const sink: string[] = [];
    const emitter = new StdoutLifecycleEmitter({ writer: capturingWriter(sink), enabled: true });

    await emitter.emit(SAMPLE_CAST_END_FAIL);
    await emitter.emit(SAMPLE_CAST_END_OK);

    const fail = JSON.parse(sink[0].slice(0, -1));
    const ok = JSON.parse(sink[1].slice(0, -1));
    expect(fail.ok).toBe(false);
    expect(fail.error).toBe("boom");
    expect(ok.ok).toBe(true);
    expect("error" in ok).toBe(false);
  });

  test("is a silent no-op when disabled", async () => {
    const sink: string[] = [];
    const emitter = new StdoutLifecycleEmitter({ writer: capturingWriter(sink), enabled: false });

    expect(emitter.enabled).toBe(false);
    const result = await emitter.emit(SAMPLE_CAST_START);
    expect(result).toBe(false);
    expect(sink).toHaveLength(0);
  });

  test("rejects non-curated types (socket/diagnostic) without writing", async () => {
    const sink: string[] = [];
    const emitter = new StdoutLifecycleEmitter({ writer: capturingWriter(sink), enabled: true });

    // These mimic the shapes that would be passed if the wiring accidentally
    // forwarded socket/diagnostic events — they must never reach stdout.
    const nonCurated = [
      { type: "socket_start", socketName: "Socket-1" },
      { type: "socket_complete", socketName: "Socket-1" },
      { type: "stale_agent_end_ignored" },
      { type: "agent_end" },
      { type: "cast_begin" /* typo, not curated */ },
    ];
    for (const event of nonCurated) {
      // The emitter is typed to StdoutLifecycleEvent; cast for the negative test.
      const wrote = await emitter.emit(event as unknown as StdoutLifecycleEvent);
      expect(wrote).toBe(false);
    }
    expect(sink).toHaveLength(0);
  });

  test("never throws when the writer throws (best-effort)", async () => {
    const throwingWriter: StdoutWriter = () => {
      throw new Error("EPIPE");
    };
    const emitter = new StdoutLifecycleEmitter({ writer: throwingWriter, enabled: true });

    await expect(emitter.emit(SAMPLE_CAST_START)).resolves.toBe(false);
  });

  test("never throws when the async writer rejects (best-effort)", async () => {
    const rejectingWriter: StdoutWriter = () => Promise.reject(new Error("broken pipe"));
    const emitter = new StdoutLifecycleEmitter({ writer: rejectingWriter, enabled: true });

    await expect(emitter.emit(SAMPLE_CAST_START)).resolves.toBe(false);
  });

  test("never throws on an unserializable (circular) payload", async () => {
    const sink: string[] = [];
    const emitter = new StdoutLifecycleEmitter({ writer: capturingWriter(sink), enabled: true });

    const circular: Record<string, unknown> = { type: "cast_start", castId: "x" };
    circular.self = circular;
    await expect(emitter.emit(circular as unknown as StdoutLifecycleEvent)).resolves.toBe(false);
    expect(sink).toHaveLength(0);
  });

  test("awaits an async writer before resolving", async () => {
    let observed: string | null = null;
    let resolveWriter: (() => void) | null = null;
    const asyncWriter: StdoutWriter = (chunk) =>
      new Promise<void>((resolve) => {
        observed = chunk;
        resolveWriter = resolve;
      });
    const emitter = new StdoutLifecycleEmitter({ writer: asyncWriter, enabled: true });

    const pending = emitter.emit(SAMPLE_CAST_END_OK);
    // Writer has captured the chunk synchronously but not resolved.
    expect(observed).not.toBeNull();
    resolveWriter?.();
    await expect(pending).resolves.toBe(true);
  });

  test("default factory constructs an enabled emitter bound to fd 1", () => {
    const emitter = createStdoutLifecycleEmitter({ enabled: true });
    expect(emitter).toBeInstanceOf(StdoutLifecycleEmitter);
    expect(emitter.enabled).toBe(true);
    // defaultStdoutWriter is exported and callable (no-assert; just ensure it's a function).
    expect(typeof defaultStdoutWriter).toBe("function");
  });
});
