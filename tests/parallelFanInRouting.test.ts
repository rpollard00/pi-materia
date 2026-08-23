import { describe, expect, test } from "bun:test";
import { applyParallelFanIn } from "../src/application/parallelFanInRouting.js";
import {
  ParallelFanInValidationError,
  type IntrinsicParallelFanInResult,
} from "../src/domain/parallelFanIn.js";
import type {
  MateriaCastState,
  MateriaLoopConfig,
  ResolvedMateriaPipeline,
  ResolvedMateriaSocket,
} from "../src/types.js";

function makeSocket(id: string): ResolvedMateriaSocket {
  return { id, name: id } as ResolvedMateriaSocket;
}

function makeLoop(exits: MateriaLoopConfig["exits"]): MateriaLoopConfig {
  return { id: "build", exit: { from: "coordinator" }, exits } as MateriaLoopConfig;
}

function makePipeline(loop?: MateriaLoopConfig): ResolvedMateriaPipeline {
  const coordinator = makeSocket("coordinator");
  const next = makeSocket("next");
  const alt = makeSocket("alt");
  return {
    entry: coordinator,
    sockets: { coordinator, next, alt },
    loops: loop === undefined ? undefined : { build: loop },
  } as ResolvedMateriaPipeline;
}

function makeState(overrides: Partial<MateriaCastState> = {}): MateriaCastState {
  return {
    castId: "cast-1",
    active: false,
    phase: "coordinator",
    pipeline: makePipeline(makeLoop([
      { id: "build-satisfied", from: "coordinator", condition: "satisfied", targetSocketId: "next" },
    ])),
    data: {},
    ...overrides,
  } as MateriaCastState;
}

function makeFanInResult(overrides: Partial<IntrinsicParallelFanInResult> = {}): IntrinsicParallelFanInResult {
  return {
    version: 1,
    parentCastId: "cast-1",
    loopId: "build",
    runId: "build-run-1",
    satisfied: true,
    orderedBranches: [],
    ...overrides,
  };
}

function captureThrow(fn: () => void): ParallelFanInValidationError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ParallelFanInValidationError);
    return error as ParallelFanInValidationError;
  }
  throw new Error("expected applyParallelFanIn to throw");
}

describe("applyParallelFanIn", () => {
  test("resolves the satisfied exit route and applies the handoff to cast state", () => {
    const state = makeState({
      data: { item: "branch-item", currentWorkItem: { title: "w" }, workItem: "w", envelope: { legacy: true } },
      currentItemKey: "w:0",
      currentItemLabel: "item zero",
    });
    const result = makeFanInResult();

    const { targetSocketId } = applyParallelFanIn(state, "build", result);

    expect(targetSocketId).toBe("next");
    expect(state.data.envelope).toMatchObject({ legacy: true, satisfied: true });
    expect(typeof state.data.envelope?.context).toBe("string");
    expect(state.data.parallelFanIn).toEqual(result);
    expect(state.data.item).toBeUndefined();
    expect(state.data.currentWorkItem).toBeUndefined();
    expect(state.data.workItem).toBeUndefined();
    expect(state.currentItemKey).toBeUndefined();
    expect(state.currentItemLabel).toBeUndefined();
    expect(state.lastJson).toMatchObject({ satisfied: true, parallelFanIn: result });
    expect(state.lastOutput).toBe(JSON.stringify(state.lastJson));
    expect(state.lastAssistantText).toBe(state.lastOutput);
  });

  test("prefers the condition-specific route over the always route", () => {
    const state = makeState({
      pipeline: makePipeline(makeLoop([
        { id: "build-always", from: "coordinator", condition: "always", targetSocketId: "alt" },
        { id: "build-satisfied", from: "coordinator", condition: "satisfied", targetSocketId: "next" },
      ])),
    });

    expect(applyParallelFanIn(state, "build", makeFanInResult()).targetSocketId).toBe("next");
  });

  test("falls back to the always route when no condition-specific route exists", () => {
    const state = makeState({
      pipeline: makePipeline(makeLoop([
        { id: "build-always", from: "coordinator", condition: "always", targetSocketId: "alt" },
      ])),
    });

    expect(applyParallelFanIn(state, "build", makeFanInResult()).targetSocketId).toBe("alt");
  });

  test("resolves the exit source from the first route when loop.exit.from is unset", () => {
    const state = makeState({
      pipeline: makePipeline({
        id: "build",
        exits: [{ id: "build-satisfied", from: "coordinator", condition: "satisfied", targetSocketId: "next" }],
      } as MateriaLoopConfig),
    });

    expect(applyParallelFanIn(state, "build", makeFanInResult()).targetSocketId).toBe("next");
  });

  test("throws fan_in_route_missing without mutating state when no exit route matches", () => {
    const missingRoutes = makeState({ pipeline: makePipeline(makeLoop(undefined)) });
    const before = structuredClone(missingRoutes);
    const missingLoop = makeState();
    const missingLoopBefore = structuredClone(missingLoop);

    const noRoutes = captureThrow(() => applyParallelFanIn(missingRoutes, "build", makeFanInResult()));
    expect(noRoutes.code).toBe("fan_in_route_missing");
    expect(noRoutes.message).toBe(`Parallel loop "build" has no symbolic satisfied fan-in route.`);
    expect(missingRoutes).toEqual(before);

    const noLoop = captureThrow(() => applyParallelFanIn(missingLoop, "unknown", makeFanInResult()));
    expect(noLoop.code).toBe("fan_in_route_missing");
    expect(missingLoop).toEqual(missingLoopBefore);
  });

  test("throws fan_in_target_unknown without mutating state when the route targets an unknown socket", () => {
    const state = makeState({
      pipeline: makePipeline(makeLoop([
        { id: "build-satisfied", from: "coordinator", condition: "satisfied", targetSocketId: "ghost" },
      ])),
    });
    const before = structuredClone(state);

    const thrown = captureThrow(() => applyParallelFanIn(state, "build", makeFanInResult()));
    expect(thrown.code).toBe("fan_in_target_unknown");
    expect(thrown.message).toBe(`Parallel fan-in route targets unknown socket "ghost".`);
    expect(state).toEqual(before);
  });
});
