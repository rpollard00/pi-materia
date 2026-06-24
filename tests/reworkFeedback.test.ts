import { describe, expect, test } from "bun:test";
import { captureReworkFeedbackForRoute, renderReworkFeedbackPromptContext } from "../src/application/reworkFeedback.js";
import type { MateriaCastState, ResolvedMateriaAgentSocket } from "../src/types.js";

function socket(id = "Socket-5"): ResolvedMateriaAgentSocket {
  return {
    id,
    socket: { materia: "Auto-Eval", parse: "json" },
    materia: { tools: "readOnly", prompt: "Evaluate.", label: "Auto-Eval" },
    edges: [],
  } as ResolvedMateriaAgentSocket;
}

function state(overrides: Partial<MateriaCastState> = {}): MateriaCastState {
  return {
    version: 2,
    active: true,
    castId: "cast-1",
    request: "request",
    configSource: "test",
    configHash: "hash",
    cwd: "/repo",
    runDir: "/repo/.pi/pi-materia/cast-1",
    artifactRoot: "/repo/.pi/pi-materia",
    phase: "Socket-5",
    currentSocketId: "Socket-5",
    currentMateria: "Auto-Eval",
    currentItemKey: "WI-1",
    currentItemLabel: "Validate behavior",
    awaitingResponse: true,
    socketState: "awaiting_agent_response",
    startedAt: 1,
    updatedAt: 1,
    data: {},
    cursors: {},
    visits: {},
    taskAttempts: {},
    edgeTraversals: {},
    runState: { runId: "run-1", runDir: "/repo/.pi/pi-materia/cast-1", eventsFile: "events.jsonl", usageFile: "usage.json", startedAt: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, byMateria: {}, bySocket: {}, byTask: {}, byAttempt: {} }, budgetWarned: false },
    pipeline: { entry: socket(), sockets: {} },
    ...overrides,
  } as MateriaCastState;
}

describe("runtime rework feedback", () => {
  test("captures top-level context for not_satisfied routes without writing state.data", () => {
    const cast = state();
    captureReworkFeedbackForRoute(cast, {
      sourceSocket: socket(),
      targetSocketId: "Socket-4",
      edge: { when: "not_satisfied", to: "Socket-4" },
      parsed: { satisfied: false, context: "Failing tests identify missing provenance." },
      rawOutput: JSON.stringify({ satisfied: false, context: "Failing tests identify missing provenance." }),
    });

    expect(cast.reworkFeedback).toHaveLength(1);
    expect(cast.reworkFeedback?.[0]).toMatchObject({ sourceSocketId: "Socket-5", sourceMateria: "Auto-Eval", targetSocketId: "Socket-4", condition: "not_satisfied", itemKey: "WI-1" });
    expect(cast.reworkFeedback?.[0]?.reason).toBe("Failing tests identify missing provenance.");
    expect(cast.data).toEqual({});
  });

  test("ignores satisfied routes", () => {
    const cast = state();
    captureReworkFeedbackForRoute(cast, {
      sourceSocket: socket(),
      targetSocketId: "Socket-7",
      edge: { when: "satisfied", to: "Socket-7" },
      parsed: { satisfied: true, context: "Looks good." },
      rawOutput: JSON.stringify({ satisfied: true, context: "Looks good." }),
    });

    expect(cast.reworkFeedback).toBeUndefined();
    expect(renderReworkFeedbackPromptContext(cast, "Socket-7")).toBeUndefined();
  });

  test("falls back to bounded sanitized JSON excerpt when context is missing from a JSON handoff", () => {
    const cast = state();
    captureReworkFeedbackForRoute(cast, {
      sourceSocket: socket(),
      targetSocketId: "Socket-4",
      edge: { when: "not_satisfied", to: "Socket-4" },
      parsed: { satisfied: false, workItems: [{ title: "x".repeat(2_000), context: "y" }] },
      rawOutput: JSON.stringify({ satisfied: false, workItems: [{ title: "x".repeat(2_000), context: "y" }] }),
    });

    const rendered = renderReworkFeedbackPromptContext(cast, "Socket-4") ?? "";
    expect(rendered).toContain("No top-level context was provided");
    expect(rendered).toContain("bounded previous output excerpt");
    expect(rendered.length).toBeLessThan(2_400);
  });

  test("strips renderable text from JSON handoff rework excerpt when context is missing", () => {
    const cast = state();
    const prose = "Sensitive narration prose that must not leak as default context.";
    captureReworkFeedbackForRoute(cast, {
      sourceSocket: socket(),
      targetSocketId: "Socket-4",
      edge: { when: "not_satisfied", to: "Socket-4" },
      parsed: { satisfied: false, text: prose },
      rawOutput: JSON.stringify({ satisfied: false, text: prose }),
    });

    const rendered = renderReworkFeedbackPromptContext(cast, "Socket-4") ?? "";
    expect(rendered).toContain("No top-level context was provided");
    expect(rendered).not.toContain(prose);
    expect(rendered).toContain("satisfied");
  });

  test("does not leak renderable text when JSON handoff carried only text", () => {
    const cast = state();
    const prose = "Narration-only payload prose.";
    captureReworkFeedbackForRoute(cast, {
      sourceSocket: socket(),
      targetSocketId: "Socket-4",
      edge: { when: "not_satisfied", to: "Socket-4" },
      parsed: { text: prose },
      rawOutput: JSON.stringify({ text: prose }),
    });

    const rendered = renderReworkFeedbackPromptContext(cast, "Socket-4") ?? "";
    expect(rendered).toContain("only renderable text");
    expect(rendered).not.toContain(prose);
  });

  test("passes free-text output through as the bounded excerpt when context is missing", () => {
    const cast = state();
    captureReworkFeedbackForRoute(cast, {
      sourceSocket: socket(),
      targetSocketId: "Socket-4",
      edge: { when: "not_satisfied", to: "Socket-4" },
      parsed: "x".repeat(2_000),
      rawOutput: "x".repeat(2_000),
    });

    const rendered = renderReworkFeedbackPromptContext(cast, "Socket-4") ?? "";
    expect(rendered).toContain("No top-level context was provided");
    expect(rendered).toContain("bounded previous output excerpt");
    expect(rendered.length).toBeLessThan(2_400);
  });
});
