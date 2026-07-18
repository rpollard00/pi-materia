import { describe, expect, test, afterEach } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeTestInternals } from "../src/castRuntime.js";
import type { MateriaCastState } from "../src/domain/eventing.js";

const { initializeCastEventBus } = nativeTestInternals as unknown as {
  initializeCastEventBus: (
    config: { eventing?: { enabled?: boolean; presets?: string[]; sinks?: Record<string, unknown> } },
    state: MateriaCastState,
  ) => Promise<unknown>;
};

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "pi-materia-webhook-diag-"));
}

/**
 * Minimal cast state sufficient for initializeCastEventBus: it only reads
 * `state.runDir`, `state.castId`, and `state.runState.eventsFile`.
 */
function makeState(runDir: string, castId: string): MateriaCastState {
  return {
    version: 2,
    active: true,
    castId,
    request: "test",
    configSource: "test",
    configHash: "h",
    cwd: runDir,
    runDir,
    artifactRoot: runDir,
    phase: "Socket-1",
    currentSocketId: "Socket-1",
    currentMateria: "TestMateria",
    awaitingResponse: true,
    socketState: "awaiting_agent_response",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    data: {},
    cursors: {},
    visits: { "Socket-1": 1 },
    multiTurnRefinements: {},
    taskAttempts: {},
    edgeTraversals: {},
    runState: {
      castId,
      runDir,
      eventsFile: path.join(runDir, "events.jsonl"),
      model: "test-model",
      loadoutName: "test-loadout",
      currentSocketId: "Socket-1",
      currentMateria: "TestMateria",
      lastMessage: "Socket-1",
      attempt: 1,
      usage: { costKind: "tokens", tokenUsage: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 } },
    },
    pipeline: {
      pipeline: "test",
      loadoutName: "test",
      entry: { id: "Socket-1", materia: { materia: "TestMateria" as never, parse: "text" }, utility: false } as never,
      sockets: new Map(),
    },
  } as unknown as MateriaCastState;
}

/** Read events.jsonl and parse each line. Returns [] when the file is absent. */
async function readEvents(runDir: string): Promise<Array<{ type: string; data: any }>> {
  try {
    const content = await readFile(path.join(runDir, "events.jsonl"), "utf-8");
    return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** Poll events.jsonl until predicate matches or timeout (artifact writes are async). */
async function waitForDiagnostic(
  runDir: string,
  predicate: (events: Array<{ type: string; data: any }>) => boolean,
  timeoutMs = 1000,
): Promise<Array<{ type: string; data: any }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await readEvents(runDir);
    if (predicate(events)) return events;
    await new Promise((r) => setTimeout(r, 10));
  }
  return readEvents(runDir);
}

function diagnosticReasons(events: Array<{ type: string; data: any }>): string[] {
  return events
    .filter((e) => e.type === "eventing_webhook_diagnostic")
    .map((e) => e.data?.reason)
    .filter((r): r is string => typeof r === "string");
}

// ── Runtime artifact emission ───────────────────────────────────────────

describe("initializeCastEventBus webhook diagnostics", () => {
  test("emits run_id_unresolved diagnostic when controller launch lacks a runId", async () => {
    const runDir = await tempDir();
    const state = makeState(runDir, "cast-no-runid");
    // Controller launch detected via CONTROLLER_EVENT_URL, but no runId source.
    process.env.CONTROLLER_EVENT_URL = "https://controller.example.com/runs/x/events";
    delete process.env.CONTROLLER_RUN_ID;
    delete process.env.CONTROLLER_CONTEXT_DIR;

    await initializeCastEventBus(
      { eventing: { enabled: true, presets: ["agent-controller"] } },
      state,
    );

    const events = await waitForDiagnostic(runDir, (ev) =>
      diagnosticReasons(ev).includes("run_id_unresolved"),
    );
    expect(diagnosticReasons(events)).toContain("run_id_unresolved");
  });

  test("emits active info diagnostic when controller launch resolves a runId", async () => {
    const runDir = await tempDir();
    const state = makeState(runDir, "cast-active");
    process.env.CONTROLLER_RUN_ID = "run-42";
    process.env.CONTROLLER_EVENT_URL = "https://controller.example.com/runs/run-42/events";
    delete process.env.CONTROLLER_CONTEXT_DIR;

    await initializeCastEventBus(
      { eventing: { enabled: true, presets: ["agent-controller"] } },
      state,
    );

    const events = await waitForDiagnostic(runDir, (ev) =>
      diagnosticReasons(ev).includes("active"),
    );
    const reasons = diagnosticReasons(events);
    expect(reasons).toContain("active");
    // Active case must not also emit gap warnings.
    expect(reasons).not.toContain("eventing_disabled");
    expect(reasons).not.toContain("run_id_unresolved");
    // Target URL is recorded (redacted: origin + pathname only).
    const activeEvent = events.find(
      (e) => e.type === "eventing_webhook_diagnostic" && e.data?.reason === "active",
    );
    expect(activeEvent?.data?.targetUrl).toBe("https://controller.example.com/runs/run-42/events");
    expect(activeEvent?.data?.active).toBe(true);
  });

  test("emits eventing_disabled diagnostic even when the bus is not created", async () => {
    const runDir = await tempDir();
    const state = makeState(runDir, "cast-disabled");
    // Controller launch present (so delivery is expected) but eventing disabled.
    process.env.CONTROLLER_RUN_ID = "run-1";
    delete process.env.CONTROLLER_EVENT_URL;
    delete process.env.CONTROLLER_CONTEXT_DIR;

    const bus = await initializeCastEventBus(
      { eventing: { enabled: false, presets: ["agent-controller"] } },
      state,
    );
    // No bus is created when eventing is disabled...
    expect(bus).toBeUndefined();

    // ...but the diagnostic still surfaces in the artifact.
    const events = await waitForDiagnostic(runDir, (ev) =>
      diagnosticReasons(ev).includes("eventing_disabled"),
    );
    expect(diagnosticReasons(events)).toContain("eventing_disabled");
  });

  test("stays silent on unrelated local runs (no controller, no preset, no sink)", async () => {
    const runDir = await tempDir();
    const state = makeState(runDir, "cast-unrelated");
    delete process.env.CONTROLLER_RUN_ID;
    delete process.env.CONTROLLER_EVENT_URL;
    delete process.env.CONTROLLER_CONTEXT_DIR;

    await initializeCastEventBus({ eventing: { enabled: false } }, state);

    // Give async artifact writes a chance to flush, then assert silence.
    await new Promise((r) => setTimeout(r, 30));
    const events = await readEvents(runDir);
    expect(events.filter((e) => e.type === "eventing_webhook_diagnostic")).toEqual([]);
  });

  test("emits controller_environment_missing when preset is referenced but no CONTROLLER_* env", async () => {
    const runDir = await tempDir();
    const state = makeState(runDir, "cast-no-controller-env");
    // Eventing enabled + agent-controller preset referenced, but running outside
    // a controller launch (manual config). No CONTROLLER_* env is set at all.
    delete process.env.CONTROLLER_RUN_ID;
    delete process.env.CONTROLLER_EVENT_URL;
    delete process.env.CONTROLLER_CONTEXT_DIR;

    const bus = await initializeCastEventBus(
      { eventing: { enabled: true, presets: ["agent-controller"] } },
      state,
    );
    // A bus is created (eventing is enabled) even though the controller env is absent.
    expect(bus).toBeDefined();

    const events = await waitForDiagnostic(runDir, (ev) =>
      diagnosticReasons(ev).includes("controller_environment_missing"),
    );
    const reasons = diagnosticReasons(events);
    expect(reasons).toContain("controller_environment_missing");
    // Must NOT be reported as active — the controller target cannot be resolved.
    expect(reasons).not.toContain("active");
  });
});
