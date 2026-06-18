import { describe, expect, test } from "bun:test";
import type { MateriaMonitorEventEntry } from "../src/webui/server/session.js";
import { webUiLauncherTestInternals } from "../src/webui/launcher.js";

const { normalizeArtifactEvents, deriveEventMessage } = webUiLauncherTestInternals;

function entry(type: string, data: Record<string, unknown>, ts = 1_700_000_000_000): MateriaMonitorEventEntry {
  return { ts, type, data };
}

describe("normalizeArtifactEvents provenance", () => {
  test("advancement_lifecycle derives materia from materiaName and socket from currentSocketId", () => {
    // Mirrors the payload shape written by appendAdvancementDiagnostic.
    const normalized = normalizeArtifactEvents(
      [entry("advancement_lifecycle", {
        diagnostic: true,
        stage: "dispatch",
        castId: "cast-1",
        currentSocketId: "Socket-4",
        sourceSocketId: "Socket-3",
        materiaName: "Build",
        sourceMateriaName: "Auto-Plan",
        phase: "Build",
        socketState: "awaiting_agent_response",
      })],
      "cast-1",
    );

    expect(normalized).toHaveLength(1);
    const [event] = normalized;
    expect(event.materia).toBe("Build");
    expect(event.socketId).toBe("Socket-4");
    // Expanded-metadata payload is preserved verbatim so the alternate fields
    // remain inspectable in the monitor's raw JSON view.
    expect(event.payload).toMatchObject({ materiaName: "Build", sourceMateriaName: "Auto-Plan", currentSocketId: "Socket-4", sourceSocketId: "Socket-3" });
    expect(event.castId).toBe("cast-1");
    expect(event.sequence).toBe(1);
  });

  test("falls back to sourceMateriaName/sourceSocketId when primary materia/socket are absent", () => {
    const normalized = normalizeArtifactEvents(
      [entry("deferred_dispatch_duplicate_skipped", {
        socket: "",
        sourceSocketId: "Socket-2",
        sourceMateriaName: "Narrate",
        idempotencyKey: "abc",
      })],
    );

    expect(normalized[0].materia).toBe("Narrate");
    expect(normalized[0].socketId).toBe("Socket-2");
  });

  test("prefers canonical materia/socket fields over alternate fields when both are present", () => {
    const normalized = normalizeArtifactEvents(
      [entry("socket_start", {
        socket: "Socket-4",
        materia: "Build",
        materiaLabel: "Build (Rude)",
        materiaName: "ignored-name",
        currentSocketId: "ignored-socket",
      })],
    );

    expect(normalized[0].materia).toBe("Build");
    expect(normalized[0].materiaLabel).toBe("Build (Rude)");
    expect(normalized[0].socketId).toBe("Socket-4");
  });

  test("true cast-level events without materia context still fall back to cast provenance", () => {
    const normalized = normalizeArtifactEvents(
      [entry("cast_start", { request: "do the thing", nativeSession: true })],
    );

    expect(normalized[0].materia).toBe("cast");
    expect(normalized[0].socketId).toBe("");
  });

  test("targetMateriaName/targetSocketId are honored for handoff-style payloads", () => {
    const normalized = normalizeArtifactEvents(
      [entry("handoff_dispatched", { targetMateriaName: "Blackbelt-PR", targetSocketId: "Socket-5" })],
    );

    expect(normalized[0].materia).toBe("Blackbelt-PR");
    expect(normalized[0].socketId).toBe("Socket-5");
  });

  test("empty-string identity values are skipped so they do not shadow later candidates", () => {
    const normalized = normalizeArtifactEvents(
      [entry("edge_event", { socket: "", materia: "", materiaName: "Auto-Plan", currentSocketId: "Socket-1" })],
    );

    expect(normalized[0].materia).toBe("Auto-Plan");
    expect(normalized[0].socketId).toBe("Socket-1");
  });

  test("renders newest-first and reindexes sequences", () => {
    const normalized = normalizeArtifactEvents(
      [
        entry("cast_start", {}, 1),
        entry("socket_start", { socket: "Socket-1", materia: "Build" }, 2),
        entry("socket_complete", { socket: "Socket-1", materia: "Build" }, 3),
      ],
    );

    expect(normalized.map((event) => event.type)).toEqual(["socket_complete", "socket_start", "cast_start"]);
    expect(normalized.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });
});

describe("normalizeArtifactEvents compact message", () => {
  test("advancement_lifecycle surfaces the stage instead of echoing the type as the body", () => {
    // The compact pretty row already shows `type` as its bold title, so the
    // body must not repeat it. Diagnostics carry a concise `stage` label.
    const normalized = normalizeArtifactEvents(
      [entry("advancement_lifecycle", {
        diagnostic: true,
        stage: "dispatch",
        castId: "cast-1",
        currentSocketId: "Socket-4",
        materiaName: "Build",
      })],
      "cast-1",
    );

    expect(normalized[0].message).toBe("dispatch");
    expect(normalized[0].message).not.toBe("advancement_lifecycle");
  });

  test("omits the message entirely when no distinct body text exists", () => {
    // socket_start has no message/stage/request; the body should be absent so
    // the row does not show `socket_start` as both title and body. The full
    // payload remains available in the expanded/raw JSON view.
    const normalized = normalizeArtifactEvents(
      [entry("socket_start", { socket: "Socket-1", materia: "Build" })],
    );

    expect(normalized[0].message).toBeUndefined();
  });

  test("prefers an explicit data.message over stage and request", () => {
    const normalized = normalizeArtifactEvents(
      [entry("tool_scope_warning", {
        warning: true,
        message: "Tool 'gh' is unavailable",
        stage: "ignored-stage",
        request: "ignored-request",
        socket: "Socket-2",
        materia: "Build",
      })],
    );

    expect(normalized[0].message).toBe("Tool 'gh' is unavailable");
  });

  test("still surfaces the originating request for lifecycle events like cast_start", () => {
    const normalized = normalizeArtifactEvents(
      [entry("cast_start", { request: "do the thing", nativeSession: true })],
    );

    expect(normalized[0].message).toBe("do the thing");
  });

  test("a data.message equal to the type is skipped so the body never duplicates the title", () => {
    const normalized = normalizeArtifactEvents(
      [entry("weird_event", { message: "weird_event", request: "do the thing" })],
    );

    expect(normalized[0].message).toBe("do the thing");
  });
});

describe("deriveEventMessage", () => {
  test("returns the first distinct candidate among message, stage, request", () => {
    expect(deriveEventMessage("cast_start", { request: "hi" })).toBe("hi");
    expect(deriveEventMessage("advancement_lifecycle", { stage: "agent_end" })).toBe("agent_end");
    expect(deriveEventMessage("tool_scope_warning", { message: "warn" })).toBe("warn");
  });

  test("returns undefined when every candidate is missing or equal to the type", () => {
    expect(deriveEventMessage("socket_start", { socket: "Socket-1" })).toBeUndefined();
    expect(deriveEventMessage("echo", { message: "echo", stage: "echo" })).toBeUndefined();
  });
});
