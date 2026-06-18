import { describe, expect, test } from "bun:test";
import { recoveryIdentityKey } from "../src/application/recoveryPolicy.js";
import {
  deriveRetryBudget,
  deriveReworkEdgeBudget,
  deriveSameSocketRecoveryBudget,
} from "../src/presentation/retryBudget.js";
import type {
  MateriaCastState,
  MateriaRunState,
  ResolvedMateriaAgentSocket,
  UsageReport,
} from "../src/types.js";

function emptyUsage(): UsageReport {
  return {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    byMateria: {},
    bySocket: {},
    byTask: {},
    byAttempt: {},
  } as UsageReport;
}

function agentSocket(id: string, edges: ResolvedMateriaAgentSocket["socket"]["edges"]): ResolvedMateriaAgentSocket {
  return {
    id,
    socket: { materia: id, ...(edges ? { edges } : {}) },
    materia: { type: "agent", tools: "coding", prompt: `${id} prompt` },
  };
}

function baseCastState(overrides: Partial<MateriaCastState> = {}): MateriaCastState {
  const runState: MateriaRunState = {
    runId: "cast-1",
    startedAt: 1_000,
    runDir: "/tmp/cast",
    eventsFile: "/tmp/cast/events.jsonl",
    usageFile: "/tmp/cast/usage.json",
    currentSocketId: "Build",
    currentMateria: "Build",
    usage: emptyUsage(),
    budgetWarned: false,
    ...(overrides.runState as MateriaRunState),
  };
  return {
    version: 2,
    active: true,
    castId: "cast-1",
    request: "retry budget",
    configSource: "test",
    configHash: "hash",
    cwd: "/tmp",
    runDir: "/tmp/cast",
    artifactRoot: "/tmp/cast",
    phase: "Build",
    currentSocketId: "Build",
    currentMateria: "Build",
    currentItemKey: "WI-1",
    awaitingResponse: true,
    startedAt: 1_000,
    updatedAt: 2_000,
    data: {},
    cursors: {},
    visits: { Build: 1 },
    taskAttempts: {},
    edgeTraversals: {},
    runState,
    pipeline: {
      entry: {} as never,
      sockets: { Build: agentSocket("Build") },
    },
    ...overrides,
  } as MateriaCastState;
}

interface RecoveryFixture {
  attempts: number;
  effectiveMax: number;
  originalMax?: number;
  reviveCount?: number;
}

function recoveryCastState(fixture: RecoveryFixture): MateriaCastState {
  const base = baseCastState({});
  const key = recoveryIdentityKey(base);
  return {
    ...base,
    recoveryAllowances: {
      [key]: {
        originalMaxAttempts: fixture.originalMax ?? fixture.effectiveMax,
        effectiveMaxAttempts: fixture.effectiveMax,
        reviveCount: fixture.reviveCount ?? 0,
      },
    },
    recoveryAttempts: { [key]: fixture.attempts },
  };
}

interface ReworkFixture {
  attempt: number;
  edgeMax: number;
  effectiveEdgeLimit?: number;
}

function reworkCastState(fixture: ReworkFixture): MateriaCastState {
  const base = baseCastState({
    currentSocketId: "Build",
    phase: "Build",
    runState: { attempt: fixture.attempt } as MateriaRunState,
    pipeline: {
      entry: {} as never,
      sockets: {
        Build: agentSocket("Build", [{ when: "always", to: "Eval" }]),
        Eval: agentSocket("Eval", [
          { when: "not_satisfied", to: "Build", maxTraversals: fixture.edgeMax },
          { when: "satisfied", to: "end" },
        ]),
      },
      loops: { work: { sockets: ["Build", "Eval"] } },
    },
  });
  if (fixture.effectiveEdgeLimit === undefined) {
    delete base.edgeAllowances;
    return base;
  }
  return {
    ...base,
    edgeAllowances: {
      "Eval->Build": {
        originalLimit: fixture.edgeMax,
        effectiveLimit: fixture.effectiveEdgeLimit,
        reviveCount: 1,
      },
    },
  };
}

describe("deriveRetryBudget same-socket recovery", () => {
  test("renders 1/3, 2/3, and 3/3 for the same current item as attempts advance", () => {
    const first = deriveRetryBudget(recoveryCastState({ attempts: 0, effectiveMax: 3 }));
    const second = deriveRetryBudget(recoveryCastState({ attempts: 1, effectiveMax: 3 }));
    const third = deriveRetryBudget(recoveryCastState({ attempts: 2, effectiveMax: 3 }));

    expect(first).toEqual({ current: 1, max: 3 });
    expect(second).toEqual({ current: 2, max: 3 });
    expect(third).toEqual({ current: 3, max: 3 });
  });

  test("current is 1-based so the first attempt for a step is 1/max", () => {
    const budget = deriveSameSocketRecoveryBudget(recoveryCastState({ attempts: 0, effectiveMax: 3 }));
    expect(budget).toEqual({ current: 1, max: 3 });
  });

  test("a revived allowance changes the denominator", () => {
    // Exhausted the original 3-attempt budget, then /materia revive raised the
    // effective max to 6. The next in-flight attempt is 4/6.
    const revived = deriveRetryBudget(
      recoveryCastState({
        attempts: 3,
        effectiveMax: 6,
        originalMax: 3,
        reviveCount: 1,
      }),
    );
    expect(revived).toEqual({ current: 4, max: 6 });
  });

  test("returns undefined when no same-socket recovery allowance exists", () => {
    expect(deriveSameSocketRecoveryBudget(baseCastState({}))).toBeUndefined();
  });

  test("ignores invalid allowance metadata instead of guessing a max", () => {
    const base = baseCastState({});
    const key = recoveryIdentityKey(base);
    const state: MateriaCastState = {
      ...base,
      recoveryAllowances: { [key]: { originalMaxAttempts: 0, effectiveMaxAttempts: 0, reviveCount: 0 } },
      recoveryAttempts: { [key]: 1 },
    };
    expect(deriveSameSocketRecoveryBudget(state)).toBeUndefined();
  });
});

describe("deriveRetryBudget graph rework retries", () => {
  test("uses the current socket/item attempt against the configured rework edge max", () => {
    expect(deriveReworkEdgeBudget(reworkCastState({ attempt: 1, edgeMax: 3 }))).toEqual({ current: 1, max: 3 });
    expect(deriveReworkEdgeBudget(reworkCastState({ attempt: 2, edgeMax: 3 }))).toEqual({ current: 2, max: 3 });
    expect(deriveReworkEdgeBudget(reworkCastState({ attempt: 3, edgeMax: 3 }))).toEqual({ current: 3, max: 3 });
  });

  test("a revived edge allowance changes the denominator", () => {
    const revived = deriveReworkEdgeBudget(
      reworkCastState({ attempt: 4, edgeMax: 3, effectiveEdgeLimit: 6 }),
    );
    expect(revived).toEqual({ current: 4, max: 6 });
  });

  test("returns undefined when the current socket has no bounded rework edge", () => {
    const base = baseCastState({});
    expect(deriveReworkEdgeBudget(base)).toBeUndefined();
  });

  test("does not invent a max when the rework edge has no configured or revived cap", () => {
    const state = baseCastState({
      currentSocketId: "Build",
      phase: "Build",
      pipeline: {
        entry: {} as never,
        sockets: {
          Build: agentSocket("Build", [{ when: "always", to: "Eval" }]),
          Eval: agentSocket("Eval", [
            { when: "not_satisfied", to: "Build" },
            { when: "satisfied", to: "end" },
          ]),
        },
        loops: { work: { sockets: ["Build", "Eval"] } },
      },
    });
    expect(deriveReworkEdgeBudget(state)).toBeUndefined();
  });
});

describe("deriveRetryBudget resolution priority", () => {
  test("same-socket recovery takes precedence over graph rework when both apply", () => {
    // Recovery allowance present (effective max 3) AND a bounded rework edge (max 5).
    // The active in-flight retry is the more specific signal, so 2/3 wins over the
    // rework edge budget.
    const rework = reworkCastState({ attempt: 2, edgeMax: 5 });
    const key = recoveryIdentityKey(rework);
    const state: MateriaCastState = {
      ...rework,
      recoveryAllowances: {
        [key]: { originalMaxAttempts: 3, effectiveMaxAttempts: 3, reviveCount: 0 },
      },
      recoveryAttempts: { [key]: 1 },
    };

    expect(deriveRetryBudget(state)).toEqual({ current: 2, max: 3 });
  });

  test("falls back to graph rework when no same-socket recovery is active", () => {
    expect(deriveRetryBudget(reworkCastState({ attempt: 2, edgeMax: 3 }))).toEqual({ current: 2, max: 3 });
  });

  test("returns undefined when neither recovery nor a bounded rework edge is available", () => {
    expect(deriveRetryBudget(baseCastState({}))).toBeUndefined();
  });
});
