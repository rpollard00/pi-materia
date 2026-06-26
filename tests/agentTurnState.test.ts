import { describe, expect, test } from "bun:test";
import type { MateriaCastState } from "../src/types.js";
import { describeStaleCompletion, recordActiveTurnProvenance } from "../src/runtime/agentTurnState.js";

/**
 * Minimal cast state for provenance helpers. These helpers only read
 * activeTurn / currentSocketId / currentMateria / lastProcessedEntryId / visits,
 * so a partial cast is sufficient (cast to satisfy the full interface).
 */
function makeState(overrides: Partial<Pick<MateriaCastState, "currentSocketId" | "currentMateria" | "lastProcessedEntryId" | "visits" | "activeTurn">> = {}): MateriaCastState {
  return {
    currentSocketId: "Socket-1",
    currentMateria: "Plan",
    visits: { "Socket-1": 2 },
    ...overrides,
  } as unknown as MateriaCastState;
}

describe("active-turn provenance", () => {
  describe("describeStaleCompletion", () => {
    test("returns undefined when no active turn is recorded (backward-compatible pass-through)", () => {
      const state = makeState({ activeTurn: undefined });
      expect(describeStaleCompletion(state, "entry-9")).toBeUndefined();
    });

    test("flags a stale completion when the active turn belongs to a different socket", () => {
      const state = makeState({
        currentSocketId: "Socket-2",
        activeTurn: { socketId: "Socket-1", visit: 2, materia: "Plan", boundaryEntryId: "entry-5" },
      });
      expect(describeStaleCompletion(state, "entry-9")).toEqual({
        reason: "active_turn_socket_mismatch",
        activeTurnSocketId: "Socket-1",
        activeTurnVisit: 2,
        activeTurnMateria: "Plan",
        activeTurnBoundaryEntryId: "entry-5",
        currentSocketId: "Socket-2",
        latestEntryId: "entry-9",
      });
    });

    test("allows a completion that belongs to the active turn", () => {
      const state = makeState({
        currentSocketId: "Socket-1",
        activeTurn: { socketId: "Socket-1", visit: 2, materia: "Plan", boundaryEntryId: "entry-5" },
      });
      expect(describeStaleCompletion(state, "entry-9")).toBeUndefined();
    });

    test("flags a latest entry pinned to the recorded boundary as a stale duplicate", () => {
      const state = makeState({
        currentSocketId: "Socket-1",
        activeTurn: { socketId: "Socket-1", visit: 2, materia: "Plan", boundaryEntryId: "entry-5" },
      });
      expect(describeStaleCompletion(state, "entry-5")?.reason).toBe("active_turn_boundary_duplicate");
    });

    test("omits optional materia/boundary fields when absent", () => {
      const state = makeState({
        currentSocketId: undefined,
        activeTurn: { socketId: "Socket-1", visit: 0 },
      });
      const reason = describeStaleCompletion(state, "entry-9");
      expect(reason).toBeDefined();
      expect(reason).not.toHaveProperty("activeTurnMateria");
      expect(reason).not.toHaveProperty("activeTurnBoundaryEntryId");
      expect(reason).not.toHaveProperty("currentSocketId");
    });
  });

  describe("recordActiveTurnProvenance", () => {
    test("captures socket id, visit, materia, and the entry boundary", () => {
      const state = makeState({ currentSocketId: "Socket-1", currentMateria: "Plan", visits: { "Socket-1": 3 }, lastProcessedEntryId: "entry-7" });
      recordActiveTurnProvenance(state);
      expect(state.activeTurn).toEqual({ socketId: "Socket-1", visit: 3, materia: "Plan", boundaryEntryId: "entry-7" });
    });

    test("defaults visit to 0 when no visit is recorded", () => {
      const state = makeState({ currentSocketId: "Socket-4", visits: {}, currentMateria: "Build" });
      recordActiveTurnProvenance(state);
      expect(state.activeTurn).toMatchObject({ socketId: "Socket-4", visit: 0 });
    });

    test("clears active turn when no current socket is set", () => {
      const state = makeState({ currentSocketId: undefined, activeTurn: { socketId: "Socket-1", visit: 1 } });
      recordActiveTurnProvenance(state);
      expect(state.activeTurn).toBeUndefined();
    });

    test("omits optional materia/boundary when unset", () => {
      const state = makeState({ currentSocketId: "Socket-1", visits: { "Socket-1": 1 }, currentMateria: undefined, lastProcessedEntryId: undefined });
      recordActiveTurnProvenance(state);
      expect(state.activeTurn).toEqual({ socketId: "Socket-1", visit: 1 });
    });
  });
});
