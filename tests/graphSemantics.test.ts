import { describe, expect, test } from "bun:test";
import {
  buildLoopExitIndex,
  classifyGraphTarget,
  remapGraphTargetPreservingTerminal,
  resolveCanonicalLoopExhaustionTarget,
  resolveIndexedLoopExhaustionTarget,
  resolveIndexedLoopExhaustionTargetWithLegacyAdvanceDoneFallback,
  resolveIndexedLoopExitRouteTarget,
  resolveLoopExhaustionTargetWithLegacyAdvanceDoneFallback,
  TERMINAL_GRAPH_TARGET,
} from "../src/graph/graphSemantics.js";
import type { MateriaLoopConfig } from "../src/types.js";

describe("graph semantics helpers", () => {
  test("classifies socket targets, the terminal sentinel, and unknown targets", () => {
    const sockets = new Set(["Socket-1", "Socket-2"]);

    expect(classifyGraphTarget("Socket-1", sockets)).toEqual({ kind: "socket", target: "Socket-1" });
    expect(classifyGraphTarget("end", sockets)).toEqual({ kind: "terminal", target: TERMINAL_GRAPH_TARGET });
    expect(classifyGraphTarget("Socket-9", sockets)).toEqual({ kind: "unknown", target: "Socket-9" });
    expect(classifyGraphTarget("anything", { "Socket-1": {} })).toEqual({ kind: "unknown", target: "anything" });
  });

  test("remaps socket ids while preserving terminal end", () => {
    const map = new Map([["Socket-1", "Socket-10"]]);

    expect(remapGraphTargetPreservingTerminal("Socket-1", map)).toBe("Socket-10");
    expect(remapGraphTargetPreservingTerminal("end", map)).toBe("end");
    expect(remapGraphTargetPreservingTerminal("Socket-9", map)).toBe("Socket-9");
    expect(remapGraphTargetPreservingTerminal("Socket-2", { "Socket-2": "Socket-20" })).toBe("Socket-20");
  });

  test("resolves canonical loop exhaustion to a loop exit route or terminal fallback", () => {
    const loop: MateriaLoopConfig = {
      sockets: ["Socket-2", "Socket-3"],
      exit: { from: "Socket-3", when: "satisfied", to: "end" },
      exits: [
        { id: "retry-summary", from: "Socket-3", condition: "not_satisfied", targetSocketId: "Socket-2" },
        { id: "summary", from: "Socket-3", condition: "satisfied", targetSocketId: "Socket-4" },
      ],
    };

    expect(resolveCanonicalLoopExhaustionTarget(loop, { reason: "post-final-item", from: "Socket-3", satisfied: true })).toBe("Socket-4");
    expect(resolveCanonicalLoopExhaustionTarget(loop, { reason: "post-final-item", from: "Socket-3", satisfied: false })).toBe("Socket-2");
    expect(resolveCanonicalLoopExhaustionTarget(loop, { reason: "empty-loop", from: "Socket-9", satisfied: true })).toBe("end");
    expect(resolveCanonicalLoopExhaustionTarget(undefined, { reason: "empty-loop", satisfied: true })).toBe("end");
  });

  test("uses a precomputed loop-exit index for runtime-style route lookups", () => {
    const index = buildLoopExitIndex({
      workItems: {
        sockets: ["Socket-2", "Socket-3"],
        exits: [{ id: "summary", from: "Socket-3", condition: "always", targetSocketId: "Socket-4" }],
      },
    });

    expect(resolveIndexedLoopExitRouteTarget(index, "Socket-3", { reason: "post-final-item" })).toBe("Socket-4");
    expect(resolveIndexedLoopExitRouteTarget(index, "Socket-2", { reason: "post-final-item" })).toBeUndefined();
    expect(resolveIndexedLoopExhaustionTarget(index, "Socket-2", { reason: "empty-loop" })).toBe("end");
    expect(resolveIndexedLoopExhaustionTargetWithLegacyAdvanceDoneFallback(index, "Socket-3", "Socket-9", { reason: "post-final-item" })).toBe("Socket-4");
    expect(resolveIndexedLoopExhaustionTargetWithLegacyAdvanceDoneFallback(index, "Socket-2", "Socket-9", { reason: "post-final-item" })).toBe("Socket-9");
  });

  test("isolates legacy advance.done compatibility fallback behind a named helper", () => {
    const loop: MateriaLoopConfig = {
      sockets: ["Socket-2"],
      exits: [{ id: "canonical", from: "Socket-2", condition: "always", targetSocketId: "Socket-4" }],
    };

    expect(resolveLoopExhaustionTargetWithLegacyAdvanceDoneFallback(loop, "Socket-9", { reason: "post-final-item", from: "Socket-2" })).toBe("Socket-4");
    expect(resolveLoopExhaustionTargetWithLegacyAdvanceDoneFallback(undefined, "Socket-9", { reason: "post-final-item" })).toBe("Socket-9");
    expect(resolveLoopExhaustionTargetWithLegacyAdvanceDoneFallback(undefined, undefined, { reason: "post-final-item" })).toBe("end");
  });
});
