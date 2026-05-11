import { describe, expect, test } from "bun:test";
import { resolveLoopExitRoute } from "../src/graph/loopExitRoutes.js";
import type { MateriaLoopConfig } from "../src/types.js";

const loop = (): MateriaLoopConfig => ({
  sockets: ["Socket-2", "Socket-3"],
  exit: { from: "Socket-3", when: "satisfied", to: "end" },
  exits: [
    { id: "always-summary", from: "Socket-3", condition: "always", targetSocketId: "Socket-4" },
    { id: "satisfied-report", from: "Socket-3", condition: "satisfied", targetSocketId: "Socket-5" },
    { id: "retry-summary", from: "Socket-3", condition: "not_satisfied", targetSocketId: "Socket-6" },
  ],
});

describe("loop-exit route resolution", () => {
  test("selects satisfied routes before always fallback when satisfied is true", () => {
    expect(resolveLoopExitRoute(loop(), { from: "Socket-3", satisfied: true })?.targetSocketId).toBe("Socket-5");

    const onlyAlways = loop();
    onlyAlways.exits = onlyAlways.exits?.filter((route) => route.condition !== "satisfied");

    expect(resolveLoopExitRoute(onlyAlways, { from: "Socket-3", satisfied: true })?.targetSocketId).toBe("Socket-4");
  });

  test("selects not_satisfied routes before always fallback when satisfied is false", () => {
    expect(resolveLoopExitRoute(loop(), { from: "Socket-3", satisfied: false })?.targetSocketId).toBe("Socket-6");

    const onlyAlways = loop();
    onlyAlways.exits = onlyAlways.exits?.filter((route) => route.condition !== "not_satisfied");

    expect(resolveLoopExitRoute(onlyAlways, { from: "Socket-3", satisfied: false })?.targetSocketId).toBe("Socket-4");
  });

  test("selects only always routes when satisfied is unavailable", () => {
    expect(resolveLoopExitRoute(loop(), { from: "Socket-3" })?.targetSocketId).toBe("Socket-4");

    const conditionalOnly = loop();
    conditionalOnly.exits = conditionalOnly.exits?.filter((route) => route.condition !== "always");

    expect(resolveLoopExitRoute(conditionalOnly, { from: "Socket-3" })).toBeUndefined();
  });

  test("uses loop.exit.from as the default source and ignores other sources", () => {
    const withOtherSource = loop();
    withOtherSource.exits = [
      { id: "other-satisfied", from: "Socket-2", condition: "satisfied", targetSocketId: "Socket-7" },
      ...(withOtherSource.exits ?? []),
    ];

    expect(resolveLoopExitRoute(withOtherSource, { satisfied: true })?.targetSocketId).toBe("Socket-5");
    expect(resolveLoopExitRoute(withOtherSource, { from: "Socket-2", satisfied: true })?.targetSocketId).toBe("Socket-7");
  });

  test("is deterministic and only uses the supplied canonical satisfied boolean", () => {
    const malformedDuplicateRoutes = loop();
    malformedDuplicateRoutes.exits = [
      { id: "first", from: "Socket-3", condition: "satisfied", targetSocketId: "Socket-5" },
      { id: "second", from: "Socket-3", condition: "satisfied", targetSocketId: "Socket-6" },
      { id: "fallback", from: "Socket-3", condition: "always", targetSocketId: "Socket-4" },
    ];

    expect(resolveLoopExitRoute(malformedDuplicateRoutes, { from: "Socket-3", satisfied: true })?.id).toBe("first");
    expect(resolveLoopExitRoute(malformedDuplicateRoutes, { from: "Socket-3", satisfied: undefined })?.id).toBe("fallback");
    expect(resolveLoopExitRoute(malformedDuplicateRoutes as MateriaLoopConfig & { passed: true }, { from: "Socket-3" })?.id).toBe("fallback");
  });

  test("returns no route when no route matches the selected source or condition", () => {
    expect(resolveLoopExitRoute(undefined, { from: "Socket-3", satisfied: true })).toBeUndefined();
    expect(resolveLoopExitRoute({ sockets: ["Socket-3"] }, { from: "Socket-3", satisfied: true })).toBeUndefined();
    expect(resolveLoopExitRoute(loop(), { from: "Socket-9", satisfied: true })).toBeUndefined();
  });
});
