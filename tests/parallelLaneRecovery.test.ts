import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createParallelRunState } from "../src/domain/parallelRun.js";
import {
  ParallelRecoveryTargetError,
  type IntrinsicParallelFanInResult,
} from "../src/application/useCases.js";
import type { IntrinsicParallelFanInResult } from "../src/domain/parallelFanIn.js";
import {
  createParallelLaneRecovery,
  type ParallelLaneRecovery,
} from "../src/runtime/parallelLaneRecovery.js";
import type {
  MateriaCastState,
  MateriaLoopConfig,
  PiMateriaConfig,
  ResolvedMateriaPipeline,
  ResolvedMateriaSocket,
} from "../src/types.js";

const pi = {} as ExtensionAPI;

function makeSocket(id: string): ResolvedMateriaSocket {
  return { id, name: id } as ResolvedMateriaSocket;
}

function makePipeline(): ResolvedMateriaPipeline {
  const coordinator = makeSocket("coordinator");
  const next = makeSocket("next");
  const loop = {
    id: "build",
    exit: { from: "coordinator" },
    exits: [{ id: "build-satisfied", from: "coordinator", condition: "satisfied", targetSocketId: "next" }],
  } as MateriaLoopConfig;
  return { entry: coordinator, sockets: { coordinator, next }, loops: { build: loop } } as ResolvedMateriaPipeline;
}

function makeRun(loopId = "build") {
  const result = createParallelRunState({
    parentCastId: "cast-1",
    loopId,
    runId: `${loopId}-run-1`,
    planIdentity: { version: 1, planId: `${loopId}-plan`, workItemCount: 2 },
    graphIdentity: { graphHash: `${loopId}-graph` },
    configIdentity: { configHash: `${loopId}-config`, loopId, maxConcurrency: 2 },
    queue: [
      { laneId: "lane-a", name: "a", streamIndex: 0, workItemIndexes: [0] },
      { laneId: "lane-b", name: "b", streamIndex: 1, workItemIndexes: [1] },
    ],
    now: 1,
  });
  result.phase = "failed";
  result.fanInPhase = "skipped";
  result.lanes["lane-a"]!.status = "accepted";
  result.lanes["lane-b"]!.status = "failed";
  return result;
}

function makeCastState(overrides: Partial<MateriaCastState> = {}): MateriaCastState {
  return {
    castId: "cast-1",
    active: false,
    phase: "coordinator",
    currentSocketId: "coordinator",
    pipeline: makePipeline(),
    runState: {
      runId: "run-1",
      startedAt: 1,
      runDir: "/tmp/run",
      eventsFile: "/tmp/run/events.jsonl",
      usageFile: "/tmp/run/usage.json",
      usage: { totalTokens: 0 } as MateriaCastState["runState"]["usage"],
      budgetWarned: false,
    },
    parallelRuns: { build: makeRun() },
    data: {},
    ...overrides,
  } as MateriaCastState;
}

interface Harness {
  recovery: ParallelLaneRecovery;
  state: MateriaCastState;
  saved: MateriaCastState[];
  parallelInput: Record<string, any> | undefined;
  /** The fake dispatcher's behavior: the module's callbacks run through here. */
  parallelBehavior: (input: Record<string, any>) => Promise<void>;
  lifecycleEvents: { type: string; overrides: Record<string, any> | undefined }[];
  usageWrites: unknown[];
  widgetUpdates: number;
  statuses: string[];
  heartbeats: number;
  startedSockets: ResolvedMateriaSocket[];
  castFailures: { error: unknown; entryId?: string }[];
  notifies: { message: string; type: string }[];
  ctx: ExtensionContext;
  failConfigLoad: () => void;
}

function makeHarness(options: { eventBus?: boolean; activeCast?: MateriaCastState } = {}): Harness {
  const saved: MateriaCastState[] = [];
  const lifecycleEvents: { type: string; overrides: Record<string, any> | undefined }[] = [];
  const usageWrites: unknown[] = [];
  const startedSockets: ResolvedMateriaSocket[] = [];
  const castFailures: { error: unknown; entryId?: string }[] = [];
  const notifies: { message: string; type: string }[] = [];
  const statuses: string[] = [];
  let widgetUpdates = 0;
  let heartbeats = 0;
  let configFails = false;

  const state = makeCastState();
  const harness: Harness = {
    recovery: undefined as unknown as ParallelLaneRecovery,
    state,
    saved,
    parallelInput: undefined,
    parallelBehavior: async (input) => { await input.onPrepared?.(); },
    lifecycleEvents,
    usageWrites,
    get widgetUpdates() { return widgetUpdates; },
    statuses,
    get heartbeats() { return heartbeats; },
    startedSockets,
    castFailures,
    notifies,
    ctx: {
      cwd: "/tmp",
      ui: {
        notify: (message: string, type: string) => { notifies.push({ message, type }); },
        setStatus: (_key: string, value: string) => { statuses.push(value); },
      },
    } as unknown as ExtensionContext,
    failConfigLoad: () => { configFails = true; },
  };

  harness.recovery = createParallelLaneRecovery({
    state: {
      listLatest: () => [state],
      loadActiveCastState: () => options.activeCast,
      loadCastStateById: (_ctx, castId) => (castId === state.castId ? state : undefined),
      saveCastState: (_pi, next) => { saved.push(next); },
      loadConfigFromState: async () => {
        if (configFails) throw new Error("config store unavailable");
        return {} as PiMateriaConfig;
      },
      resolvePersistedCastLoadoutIdentity: async () => ({ loadoutId: "loadout-1", loadoutName: "materia-x" } as never),
    },
    parallel: {
      recover: async (input: Record<string, any>) => {
        harness.parallelInput = input;
        await harness.parallelBehavior(input);
        return true;
      },
    },
    eventing: {
      initializeCastEventBus: async () => (options.eventBus ? ({ id: "bus-1" } as never) : undefined),
      startHeartbeat: () => { heartbeats += 1; },
      emitLifecycleEvent: async (_state, type, overrides) => { lifecycleEvents.push({ type, overrides }); },
    },
    artifacts: { writeUsage: async (runState) => { usageWrites.push(runState); } },
    ui: { updateWidget: () => { widgetUpdates += 1; } },
    execution: { startSocket: async (_pi, _ctx, _state, socket) => { startedSockets.push(socket); } },
    termination: { failCast: async (_pi, _ctx, _state, error, entryId) => { castFailures.push({ error, entryId }); } },
  });
  return harness;
}

describe("lane recovery module", () => {
  test("resolves lane, bulk, and malformed targets against the state list", () => {
    const { recovery, ctx } = makeHarness();
    expect(recovery.resolveTarget({ session: ctx, operation: "revive", argumentsText: "2" })).toMatchObject({
      kind: "lane",
      castId: "cast-1",
      loopId: "build",
      laneId: "lane-b",
      laneNumber: 2,
    });
    expect(recovery.resolveTarget({ session: ctx, operation: "recast", argumentsText: "" })).toEqual({ kind: "bulk" });
    expect(recovery.resolveTarget({ session: ctx, operation: "recast", argumentsText: "cast-1" })).toMatchObject({ kind: "bulk", castId: "cast-1" });
    expect(() => recovery.resolveTarget({ session: ctx, operation: "revive", argumentsText: "0" })).toThrow(ParallelRecoveryTargetError);
    expect(() => recovery.resolveTarget({ session: ctx, operation: "revive", argumentsText: "cast-1 0" })).toThrow(ParallelRecoveryTargetError);
  });

  test("recovers a numbered lane and restores coordinator services", async () => {
    const harness = makeHarness({ eventBus: true });
    const { recovery, state, ctx, saved, lifecycleEvents, usageWrites, statuses, notifies } = harness;
    const result = await recovery.recover({ pi, ctx, operation: "revive", castId: "cast-1", loopId: "build", laneIds: ["lane-b"], laneNumber: 2 });

    expect(result).toBe(state);
    expect(harness.parallelInput).toMatchObject({
      state,
      loopId: "build",
      operation: "revive",
      laneIds: ["lane-b"],
      laneNumber: 2,
      config: { maxConcurrency: 2 },
    });
    // Coordinator services restored in onPrepared.
    expect(state.runState.loadoutId).toBe("loadout-1");
    expect(state.runState.loadoutName).toBe("materia-x");
    expect(state.runState.currentSocketId).toBe("coordinator");
    expect(state.runState.lastMessage).toContain("Revived parallel lanes for cast cast-1");
    expect(usageWrites).toHaveLength(1);
    expect(saved).toHaveLength(1);
    expect(statuses).toHaveLength(1);
    expect(harness.heartbeats).toBe(1);
    expect(harness.widgetUpdates).toBe(1);
    const [event] = lifecycleEvents;
    expect(event?.type).toBe("lifecycle.cast.revived");
    expect(event?.overrides?.payload).toMatchObject({
      kind: "parallel_lanes",
      operation: "revive",
      castId: "cast-1",
      loopId: "build",
      laneIds: ["lane-b"],
      laneNumber: 2,
      preservedLaneIds: ["lane-a"],
    });
    expect(notifies[0]?.message).toContain("revived failed parallel lanes (lane-b)");
  });

  test("bulk recovery omits lane selection", async () => {
    const harness = makeHarness();
    const { recovery, ctx, lifecycleEvents, notifies } = harness;
    await recovery.recover({ pi, ctx, operation: "revive", castId: "cast-1", loopId: "build" });
    expect(harness.parallelInput?.laneIds).toBeUndefined();
    expect(harness.parallelInput?.laneNumber).toBeUndefined();
    expect(lifecycleEvents[0]?.overrides?.payload).not.toHaveProperty("laneIds");
    expect(notifies[0]?.message).toBe("pi-materia cast cast-1 revived failed parallel lanes without rerunning accepted lanes.");
  });

  test("reports recast past tense for the recast operation", async () => {
    const { recovery, ctx, notifies } = makeHarness();
    await recovery.recover({ pi, ctx, operation: "recast", castId: "cast-1", loopId: "build", laneIds: ["lane-b"], laneNumber: 2 });
    expect(notifies[0]?.message).toContain("recast failed parallel lanes (lane-b)");
  });

  test("keeps recovery durable when event-bus restoration fails", async () => {
    const harness = makeHarness();
    harness.failConfigLoad();
    const { recovery, ctx, usageWrites, lifecycleEvents } = harness;
    const state = await recovery.recover({ pi, ctx, operation: "revive", castId: "cast-1", loopId: "build", laneIds: ["lane-b"] });
    // Event-bus restore is best effort; the rest of onPrepared still ran.
    expect(harness.heartbeats).toBe(0);
    expect(usageWrites).toHaveLength(1);
    expect(lifecycleEvents[0]?.type).toBe("lifecycle.cast.revived");
    expect(state.runState.lastMessage).toContain("Revived parallel lanes");
  });

  test("rejects recovery while another cast is active", async () => {
    const { recovery, ctx } = makeHarness({ activeCast: makeCastState({ castId: "cast-active", active: true }) });
    await expect(recovery.recover({ pi, ctx, operation: "revive", castId: "cast-1", loopId: "build" }))
      .rejects.toThrow("A pi-materia cast is already active (cast-active)");
  });

  test("rejects recovery of the cast that is itself active", async () => {
    const { recovery, ctx } = makeHarness({ activeCast: makeCastState({ active: true }) });
    await expect(recovery.recover({ pi, ctx, operation: "recast", castId: "cast-1", loopId: "build" }))
      .rejects.toThrow("pi-materia cast cast-1 is already running.");
  });

  test("rejects unknown cast ids and missing parallel runs", async () => {
    const { recovery, ctx } = makeHarness();
    await expect(recovery.recover({ pi, ctx, operation: "revive", castId: "nope", loopId: "build" }))
      .rejects.toThrow('Unknown pi-materia cast id "nope"');
    await expect(recovery.recover({ pi, ctx, operation: "revive", castId: "cast-1", loopId: "missing" }))
      .rejects.toThrow('has no persisted parallel run for loop "missing"');
  });

  test("routes the parent socket onward when the run reaches its fan-in barrier", async () => {
    const harness = makeHarness();
    const { recovery, state, ctx, startedSockets, saved } = harness;
    state.data = { item: "done-item", envelope: { legacy: true } };
    state.currentItemKey = "w:0";
    state.currentItemLabel = "item zero";
    const fanInResult: IntrinsicParallelFanInResult = {
      version: 1,
      parentCastId: "cast-1",
      loopId: "build",
      runId: "build-run-1",
      satisfied: true,
      orderedBranches: [],
    };
    // The dispatcher drives fan-in when the recovered run reaches the barrier.
    harness.parallelBehavior = async (input) => {
      await input.onPrepared?.();
      await input.onFanIn({ loopId: "build", result: fanInResult });
    };
    await recovery.recover({ pi, ctx, operation: "revive", castId: "cast-1", loopId: "build" });

    expect(startedSockets).toHaveLength(1);
    expect(startedSockets[0]?.id).toBe("next");
    expect(saved.length).toBeGreaterThanOrEqual(1);
    expect(state.data.envelope).toMatchObject({ legacy: true, satisfied: true });
    expect(state.data.parallelFanIn).toEqual(fanInResult);
    expect(state.lastJson).toMatchObject({ satisfied: true });
    expect(state.data.item).toBeUndefined();
    expect(state.data.currentWorkItem).toBeUndefined();
    expect(state.data.workItem).toBeUndefined();
    expect(state.currentItemKey).toBeUndefined();
    expect(state.currentItemLabel).toBeUndefined();
  });

  test("fails the cast through termination when the run fails", async () => {
    const harness = makeHarness();
    const { recovery, ctx, castFailures } = harness;
    // The dispatcher reports the run failure; the module maps it to cast termination.
    harness.parallelBehavior = async (input) => {
      await input.onFailure({ loopId: "build", reason: "lane blew up" });
    };
    await recovery.recover({ pi, ctx, operation: "revive", castId: "cast-1", loopId: "build" });
    expect(castFailures).toHaveLength(1);
    expect(castFailures[0]?.entryId).toBe("parallel:build");
    expect((castFailures[0]?.error as Error).message).toBe("lane blew up");
  });
});
