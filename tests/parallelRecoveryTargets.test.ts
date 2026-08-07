import { describe, expect, test } from "bun:test";
import {
  CastExecutionUseCases,
  ParallelRecoveryTargetError,
  parseParallelRecoveryTarget,
  resolveParallelRecoveryTarget,
  type CastLifecyclePort,
} from "../src/application/index.js";
import { createParallelRunState } from "../src/domain/parallelRun.js";
import type { MateriaCastState } from "../src/types.js";

function run(loopId = "build") {
  const result = createParallelRunState({
    parentCastId: "cast-new",
    loopId,
    runId: `${loopId}-run`,
    planIdentity: { version: 1, planId: `${loopId}-plan`, workItemCount: 3 },
    graphIdentity: { graphHash: `${loopId}-graph` },
    configIdentity: { configHash: `${loopId}-config`, loopId, maxConcurrency: 2 },
    queue: [
      { laneId: "lane-one", name: "one", streamIndex: 0, workItemIndexes: [0] },
      { laneId: "lane-two", name: "two", streamIndex: 1, workItemIndexes: [1] },
      { laneId: "lane-three", name: "three", streamIndex: 2, workItemIndexes: [2] },
    ],
    now: 1,
  });
  result.phase = "failed";
  result.fanInPhase = "skipped";
  result.lanes["lane-one"]!.status = "accepted";
  result.lanes["lane-two"]!.status = "failed";
  result.lanes["lane-three"]!.status = "interrupted";
  return result;
}

function state(castId: string, parallelRuns: MateriaCastState["parallelRuns"], updatedAt = 1, active = false): MateriaCastState {
  return { castId, active, updatedAt, startedAt: updatedAt, parallelRuns } as MateriaCastState;
}

describe("numbered parallel recovery targets", () => {
  test("preserves bulk forms and parses implicit and explicit lane forms", () => {
    expect(parseParallelRecoveryTarget("")).toEqual({ ok: true, value: { kind: "bulk" } });
    expect(parseParallelRecoveryTarget("cast-1")).toEqual({ ok: true, value: { kind: "bulk", castId: "cast-1" } });
    expect(parseParallelRecoveryTarget("2026-08-07T16-10-26-817Z")).toEqual({ ok: true, value: { kind: "bulk", castId: "2026-08-07T16-10-26-817Z" } });
    expect(parseParallelRecoveryTarget("2")).toEqual({ ok: true, value: { kind: "lane", laneNumber: 2 } });
    expect(parseParallelRecoveryTarget("cast-1 3")).toEqual({ ok: true, value: { kind: "lane", castId: "cast-1", laneNumber: 3 } });
  });

  test("rejects zero, malformed, and over-arity lane targets", () => {
    expect(parseParallelRecoveryTarget("0")).toMatchObject({ ok: false, issues: [{ path: "laneNumber" }] });
    expect(parseParallelRecoveryTarget("1.5")).toMatchObject({ ok: false, issues: [{ path: "laneNumber" }] });
    expect(parseParallelRecoveryTarget("cast-1 nope")).toMatchObject({ ok: false, issues: [{ path: "laneNumber" }] });
    expect(parseParallelRecoveryTarget("cast-1 2 extra")).toMatchObject({ ok: false, issues: [{ path: "arguments" }] });
  });

  test("uses immutable queue order, including accepted lanes, across attempts", () => {
    const newer = run();
    newer.lanes["lane-two"]!.attempt = 4;
    newer.lanes["lane-three"]!.attempt = 5;
    const older = run("older");
    older.parentCastId = "cast-old";
    older.lanes["lane-two"]!.status = "accepted";
    older.lanes["lane-three"]!.status = "failed";

    const resolved = resolveParallelRecoveryTarget({
      target: { kind: "lane", laneNumber: 2 },
      states: [state("cast-old", { older }), state("cast-new", { build: newer }, 20)],
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.kind).toBe("lane");
      if (resolved.value.kind === "lane") {
        expect(resolved.value.castId).toBe("cast-new");
        expect(resolved.value.laneId).toBe("lane-two");
        expect(resolved.value.laneNumber).toBe(2);
      }
    }
  });

  test("rejects accepted, running, ambiguous-run, out-of-range, and non-parallel targets", () => {
    const accepted = run();
    accepted.lanes["lane-two"]!.status = "accepted";
    const acceptedResult = resolveParallelRecoveryTarget({ target: { kind: "lane", castId: "cast-accepted", laneNumber: 2 }, states: [state("cast-accepted", { build: accepted })] });
    expect(acceptedResult).toMatchObject({ ok: false, issues: [{ path: "laneNumber" }] });
    if (!acceptedResult.ok) expect(acceptedResult.issues[0]!.message).toContain("accepted");

    const running = run();
    running.phase = "awaiting_lanes";
    running.lanes["lane-two"]!.status = "running";
    const runningResult = resolveParallelRecoveryTarget({ target: { kind: "lane", castId: "cast-running", laneNumber: 2 }, states: [state("cast-running", { build: running })] });
    expect(runningResult).toMatchObject({ ok: false, issues: [{ path: "castId" }] });
    if (!runningResult.ok) expect(runningResult.issues[0]!.message).toContain("running");

    const secondRun = run("review");
    const ambiguousResult = resolveParallelRecoveryTarget({ target: { kind: "lane", castId: "cast-ambiguous", laneNumber: 1 }, states: [state("cast-ambiguous", { build: run(), review: secondRun })] });
    expect(ambiguousResult).toMatchObject({ ok: false, issues: [{ path: "parallelRun" }] });
    if (!ambiguousResult.ok) expect(ambiguousResult.issues[0]!.message).toContain("multiple");

    const rangeResult = resolveParallelRecoveryTarget({ target: { kind: "lane", castId: "cast-range", laneNumber: 4 }, states: [state("cast-range", { build: run() })] });
    expect(rangeResult).toMatchObject({ ok: false, issues: [{ path: "laneNumber" }] });
    if (!rangeResult.ok) expect(rangeResult.issues[0]!.message).toContain("out of range");

    const nonParallelResult = resolveParallelRecoveryTarget({ target: { kind: "lane", castId: "cast-ordinary", laneNumber: 1 }, states: [state("cast-ordinary", {})] });
    expect(nonParallelResult).toMatchObject({ ok: false, issues: [{ path: "castId" }] });
    if (!nonParallelResult.ok) expect(nonParallelResult.issues[0]!.message).toContain("not a parallel parent");
  });

  test("use case resolves a target without dispatching lifecycle work", () => {
    const calls: string[] = [];
    const lifecycle = {
      start: async () => undefined,
      continue: async () => undefined,
      resume: async () => undefined,
      revive: async () => undefined,
      reactivateQueuedCast: async () => state("queued", {}),
      clear: () => undefined,
    } satisfies CastLifecyclePort<string, string>;
    const useCases = new CastExecutionUseCases({
      states: { loadActive: () => undefined, listLatest: () => [state("cast-1", { build: run() })], listResumable: () => [], listRevivable: () => [] },
      context: { buildIsolatedContext: (messages) => messages },
      agentTurns: { prepareAgentStartSystemPrompt: async () => undefined, handleAgentEnd: async () => undefined },
      lifecycle,
      statusPresenter: { statusLabel: () => "" },
      loadouts: {} as any,
      configs: {} as any,
      pipeline: {} as any,
    });

    const resolved = useCases.resolveParallelRecoveryTarget("session", "revive", "2");
    expect(resolved).toMatchObject({ kind: "lane", castId: "cast-1", loopId: "build", laneId: "lane-two", laneNumber: 2 });
    expect(calls).toEqual([]);
    expect(() => useCases.resolveParallelRecoveryTarget("session", "revive", "cast-1 0")).toThrow(ParallelRecoveryTargetError);
  });
});
