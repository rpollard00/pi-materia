import { describe, expect, test } from "bun:test";
import {
  createPromptIntent,
  parseCanonicalSocketId,
  parseHandoffWorkItem,
  recordSocketVisit,
  validateLoadout,
  validateReservedHandoffFields,
  chooseRoutingOutcome,
  type CastStateCore,
  type Loadout,
} from "../src/domain/index.js";

describe("pure materia/loadout domain", () => {
  test("parses canonical socket ids only", () => {
    expect(parseCanonicalSocketId("Socket-12")).toEqual({ id: "Socket-12", ordinal: 12 });
    expect(parseCanonicalSocketId("Socket-0")).toBeUndefined();
    expect(parseCanonicalSocketId("node-1")).toBeUndefined();
  });

  test("validates loadout socket references and routing conditions", () => {
    const loadout: Loadout = {
      entry: "Socket-1",
      sockets: {
        "Socket-1": { type: "agent", materia: "Build", edges: [{ when: "satisfied", to: "Socket-2" }] },
        "Socket-2": { type: "utility", utility: "checkpoint" },
      },
      loops: {
        LoopA: {
          sockets: ["Socket-1"],
          consumes: { from: "Socket-1", output: "workItems" },
          exits: [{ id: "done", from: "Socket-1", condition: "always", targetSocketId: "Socket-2" }],
        },
      },
    };

    expect(validateLoadout(loadout).ok).toBe(true);

    const invalid = validateLoadout({
      entry: "Node-1",
      sockets: {
        "Node-1": { type: "agent", materia: "", edges: [{ when: "passed" as never, to: "Socket-9" }] },
      },
    });

    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(["loadout.entry", "loadout.sockets.Node-1", "loadout.sockets.Node-1.materia", "loadout.sockets.Node-1.edges.0.when", "loadout.sockets.Node-1.edges.0.to"]));
  });

  test("chooses deterministic routing outcomes from reserved satisfied control state", () => {
    const socket = {
      edges: [
        { when: "satisfied" as const, to: "Socket-2" },
        { when: "not_satisfied" as const, to: "Socket-3" },
      ],
    };

    expect(chooseRoutingOutcome(socket, { satisfied: true })).toEqual({ kind: "next", to: "Socket-2", condition: "satisfied" });
    expect(chooseRoutingOutcome(socket, { satisfied: false })).toEqual({ kind: "next", to: "Socket-3", condition: "not_satisfied" });
    expect(chooseRoutingOutcome(socket, {})).toEqual({ kind: "complete" });
  });

  test("validates work item and reserved handoff control field invariants", () => {
    expect(parseHandoffWorkItem({ id: "core-1", title: "Extract", description: "Do it", acceptance: ["tested"], context: { constraints: [], dependencies: [], risks: [] } }).ok).toBe(true);

    const invalidWorkItem = parseHandoffWorkItem({ id: "", title: "", description: "", acceptance: "nope", context: { constraints: [], dependencies: [], risks: "bad" } });
    expect(invalidWorkItem.ok).toBe(false);
    if (!invalidWorkItem.ok) expect(invalidWorkItem.issues.map((issue) => issue.path)).toContain("workItems[].id");

    expect(validateReservedHandoffFields({ satisfied: true, feedback: "", missing: [] }, "$", { requiresSatisfied: true }).ok).toBe(true);
    const invalidReserved = validateReservedHandoffFields({ satisfied: "yes", feedback: [], missing: "none" }, "$", { requiresSatisfied: true });
    expect(invalidReserved.ok).toBe(false);
    if (!invalidReserved.ok) expect(invalidReserved.issues.map((issue) => issue.path)).toEqual(["$.satisfied", "$.feedback", "$.missing"]);
  });

  test("creates prompt intent and cast updates without mutating inputs", () => {
    expect(createPromptIntent({ socketId: "Socket-1", materiaId: "Build", parse: "json", includeHandoffContract: true }).ok).toBe(true);
    expect(createPromptIntent({ socketId: "node", materiaId: "", parse: "json", includeHandoffContract: true }).ok).toBe(false);

    const state: CastStateCore = {
      active: true,
      castId: "cast-1",
      request: "request",
      phase: "Build",
      data: {},
      cursors: {},
      visits: { "Socket-1": 1 },
      edgeTraversals: {},
    };
    const next = recordSocketVisit(state, "Socket-1");
    expect(next.visits["Socket-1"]).toBe(2);
    expect(state.visits["Socket-1"]).toBe(1);
  });
});
