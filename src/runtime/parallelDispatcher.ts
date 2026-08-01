import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  ChildCastRunnerPort,
  ChildCastSnapshot,
  ChildCastStreamEvent,
  ChildCastTerminalResult,
  StartChildCastInput,
} from "../application/childCastRunner.js";
import type {
  ParallelLaneArtifactIdentity,
  ParallelLaneArtifactPaths,
  ParallelLaneArtifactPort,
  ParallelLaneDiagnosticArtifact,
  ParallelLaneEventArtifact,
} from "../application/parallelArtifacts.js";
import { addUsage } from "../telemetry/usage.js";
import { compileLoopRegionToChildLoadout, type CompiledLoopChildLoadout } from "../graph/loopCompiler.js";
import {
  applyParallelRunPhaseTransition,
  applyParallelTransitionToCastState,
  attachParallelRunToCastState,
  createParallelRunState,
} from "./parallelCoordinatorState.js";
import type { MateriaCastState, MateriaLoopParallelConfig, MateriaParallelRunState, MateriaParallelUsageTotals, ResolvedMateriaSocket } from "../types.js";
import {
  boundedParallelContext,
  childCastIdentity,
  isParallelUsage as isUsage,
  lanePaths,
  parallelErrorMessage as errorMessage,
  readNormalizedParallelPlan as readNormalizedPlan,
  readParallelWorkItems as readWorkItems,
  replaceParallelState as replaceState,
  revisionInValue,
  workspaceOwnership,
  type NormalizedParallelStream,
  type ParallelWorkspacePort,
  type ParallelWorkspaceRecord,
  type ParallelWorkspaceRevision,
} from "./parallelDispatchSupport.js";

export type {
  ParallelLaneArtifactIdentity,
  ParallelLaneArtifactPaths,
  ParallelLaneArtifactPort,
  ParallelLaneDiagnosticArtifact,
  ParallelLaneEventArtifact,
  ParallelLaneRevisionArtifact,
} from "../application/parallelArtifacts.js";
export type {
  NormalizedParallelPlan,
  NormalizedParallelStream,
  ParallelWorkspaceInspection,
  ParallelWorkspacePort,
  ParallelWorkspaceRecord,
  ParallelWorkspaceRevision,
} from "./parallelDispatchSupport.js";

export interface ParallelLoopDispatchInput {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  state: MateriaCastState;
  socket: ResolvedMateriaSocket;
  loopId: string;
  config: MateriaLoopParallelConfig;
}

export interface ParallelLoopCancellationInput {
  pi: ExtensionAPI;
  /** Cancellation does not need a live Pi context; it is retained when supplied. */
  ctx?: ExtensionContext;
  state: MateriaCastState;
  /** Optional when the dispatcher already owns exactly one active run. */
  loopId?: string;
  reason?: string;
}

export interface ParallelLoopDispatcherDependencies {
  children: ChildCastRunnerPort;
  workspaces: ParallelWorkspacePort;
  state: {
    saveCastState(pi: ExtensionAPI, state: MateriaCastState): void;
  };
  artifacts?: {
    appendEvent(runState: MateriaCastState["runState"], type: string, data: unknown): Promise<void>;
    writeUsage?(runState: MateriaCastState["runState"]): Promise<void>;
    lane?: ParallelLaneArtifactPort;
  };
  budget?: {
    /** Check the parent budget after a child usage delta is recorded. */
    assertBudget?(state: MateriaCastState, ctx: ExtensionContext): Promise<void>;
  };
  /**
   * Hard-stop the parent cast after a child usage update exhausts its budget.
   * The callback is optional for embedders that only need coordinator state;
   * native runtime wiring uses it to terminate the parent cast as well.
   */
  onBudgetExceeded?(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: MateriaCastState,
    error: unknown,
    entryId: string,
  ): Promise<void>;
  /** Injectable clock keeps scheduler tests deterministic. */
  now?: () => number;
}

interface PreparedLane {
  stream: NormalizedParallelStream;
  compiledLoadout: CompiledLoopChildLoadout;
  workspace?: ParallelWorkspaceRecord;
}

interface ActiveLane {
  workspace: ParallelWorkspaceRecord;
  childCastId: string;
  attempt: number;
  artifactIdentity: ParallelLaneArtifactIdentity;
  artifactPaths?: ParallelLaneArtifactPaths;
}

interface DispatchInitialization {
  castId: string;
  loopId: string;
  promise: Promise<void>;
  resolve: () => void;
}

/**
 * Runtime coordinator for the fan-out half of a parallel loop.
 *
 * This module owns bounded fan-out, child telemetry, and safe cancellation.
 * Fan-in, conflict resolution, and final evaluation remain later coordinator
 * phases; the parent still never enters the member sockets and child launches
 * respect maxConcurrency.
 */
export class ParallelLoopDispatcher {
  readonly #deps: ParallelLoopDispatcherDependencies;
  readonly #now: () => number;
  #state?: MateriaCastState;
  #input?: ParallelLoopDispatchInput;
  #run?: MateriaParallelRunState;
  #repositoryRoot?: string;
  #prepared: PreparedLane[] = [];
  #nextQueueIndex = 0;
  #active = new Map<string, ActiveLane>();
  #pumpTail: Promise<void> = Promise.resolve();
  #dispatching = false;
  #eventTails = new Map<string, Promise<void>>();
  #usageWriteTail: Promise<void> = Promise.resolve();
  #latestUsage = new Map<string, MateriaParallelUsageTotals>();
  #budgetFailure?: Error;
  #cancelRequested = false;
  #cancelPromise?: Promise<void>;
  #cancelCastId?: string;
  #initialization?: DispatchInitialization;

  constructor(deps: ParallelLoopDispatcherDependencies) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
  }

  /**
   * Dispatch an opted-in region. The first call initializes durable state and
   * starts up to maxConcurrency children. Repeated calls for the same region
   * are intentionally no-ops so parent retries cannot create duplicate lanes.
   */
  async dispatch(input: ParallelLoopDispatchInput): Promise<boolean> {
    validateDispatchConfig(input.config);

    // A dispatcher is shared by the native runtime. Once the prior cast has no
    // live lanes, a fresh cast must not inherit its terminal cancellation
    // promise or request.
    const previousCastId = this.#input?.state.castId ?? this.#run?.parentCastId;
    if (previousCastId !== undefined && previousCastId !== input.state.castId && !this.#initialization && this.#active.size === 0) {
      this.#run = undefined;
      this.#prepared = [];
      this.#nextQueueIndex = 0;
      this.#eventTails.clear();
      this.#latestUsage.clear();
      this.#budgetFailure = undefined;
      this.#cancelRequested = false;
      this.#cancelPromise = undefined;
      this.#cancelCastId = undefined;
    }

    // Bind the input before the first await. Parent cancellation can therefore
    // find this in-flight initialization even though no durable coordinator
    // exists yet (budget checks, compilation, and baseline pinning all await or
    // yield before lanes are launched).
    this.#state = input.state;
    this.#input = input;
    const existing = input.state.parallelRuns?.[input.loopId];
    if (existing) {
      this.#run = existing;
      return true;
    }

    const pending = this.#initialization;
    if (pending && pending.castId === input.state.castId && pending.loopId === input.loopId) {
      await pending.promise;
      return true;
    }
    const initialization = this.#beginInitialization(input);
    let initializationInterrupted = false;
    try {
      // Do not fan out work when the parent is already over its hard limit. The
      // ordinary socket path performs the same check at its output boundary;
      // parallel entry must preserve that invariant before creating workspaces.
      await this.#deps.budget?.assertBudget?.(input.state, input.ctx);

      const plan = readNormalizedPlan(input.state, input.config.planInput);
      const workItems = readWorkItems(input.state);
      if (plan.workItemCount !== workItems.length) {
        throw new Error(`Parallel loop ${JSON.stringify(input.loopId)} plan workItemCount ${plan.workItemCount} does not match state.workItems length ${workItems.length}.`);
      }

      // Compile every child before pinning or creating a workspace. A malformed
      // member graph therefore cannot leave a partially fanned-out run behind.
      const prepared = plan.streams.map((stream) => {
        const compiled = compileLoopRegionToChildLoadout({
          pipeline: input.state.pipeline,
          loopId: input.loopId,
          workItems,
          workItemIndexes: stream.workItemIndexes,
          laneId: stream.laneId,
        });
        if (!compiled.ok) {
          throw new Error(`Unable to compile parallel lane ${JSON.stringify(stream.laneId)}: ${compiled.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
        }
        return { stream, compiledLoadout: compiled.value };
      });

      const baseline = await this.#deps.workspaces.pinBaseline(input.state.cwd);
      const queue = plan.streams.map((stream) => ({
        laneId: stream.laneId,
        name: stream.name,
        streamIndex: stream.streamIndex,
        workItemIndexes: [...stream.workItemIndexes],
      }));
      const run = createParallelRunState({
        parentCastId: input.state.castId,
        loopId: input.loopId,
        planIdentity: {
          version: plan.version,
          planId: plan.planId,
          workItemCount: plan.workItemCount,
        },
        configIdentity: {
          configHash: input.state.configHash,
          loopId: input.loopId,
          planInput: input.config.planInput,
          maxConcurrency: input.config.maxConcurrency,
          workspaceMode: input.config.workspaceMode,
          failurePolicy: input.config.failurePolicy,
          fanIn: input.config.fanIn,
        },
        baseline: baseline.baseline,
        queue,
        now: this.#now(),
      });

      this.#run = run;
      this.#repositoryRoot = baseline.repositoryRoot;
      this.#prepared = prepared;
      this.#nextQueueIndex = 0;
      this.#active.clear();
      this.#eventTails.clear();
      this.#usageWriteTail = Promise.resolve();
      this.#latestUsage.clear();
      this.#budgetFailure = undefined;
      // Do not reset #cancelRequested here. A cancellation may have arrived
      // while initialization was in flight; clearing it would resurrect the
      // dispatch after cancel() had already returned.
      replaceState(input.state, attachParallelRunToCastState(input.state, run));
      this.#deps.state.saveCastState(input.pi, input.state);
      await this.#appendEvent(input.state, "parallel_dispatch_started", {
        parentCastId: input.state.castId,
        loopId: input.loopId,
        runId: run.runId,
        planId: plan.planId,
        baseline: baseline.baseline,
        queueOrder: run.queueOrder,
        maxConcurrency: run.maxConcurrency,
      });
    } catch (error) {
      // Once cancellation owns the initialization handshake, let the parent
      // cancellation win over an initialization failure. Otherwise preserve
      // the normal dispatch error and let socket execution fail the cast.
      if (!this.#cancelRequested) throw error;
      initializationInterrupted = true;
    } finally {
      this.#finishInitialization(initialization);
    }

    // Empty plans are already represented as a completed run. There is no
    // child to launch and, importantly, no workspace side effect.
    if (initializationInterrupted || this.#cancelRequested || this.#prepared.length === 0) return true;

    await this.#pump();
    return true;
  }

  /** Return the run currently owned by this dispatcher, if any. */
  get run(): MateriaParallelRunState | undefined {
    return this.#run;
  }

  /**
   * Stop this coordinator without deleting any lane workspace or revision.
   *
   * Cancellation is intentionally a durable coordinator transition rather than
   * a process-only operation: queued lanes become interrupted, active child
   * sessions are aborted through the application port, and late callbacks are
   * ignored after the final telemetry observation. The promise is memoized so
   * parent abort, session shutdown, and repeated callers share one operation.
   */
  async cancel(input: ParallelLoopCancellationInput): Promise<void> {
    // The native termination path calls this hook for ordinary casts too. Do
    // not poison this singleton dispatcher unless the request addresses a
    // persisted run or an initialization currently owned by this cast.
    if (!this.#hasCancellationTarget(input)) return;
    if (this.#cancelPromise && this.#cancelCastId === input.state.castId) return this.#cancelPromise;
    const initialization = this.#initialization?.promise;
    this.#bindCancellationInput(input);
    this.#cancelRequested = true;
    this.#cancelCastId = input.state.castId;
    this.#cancelPromise = (async () => {
      // A run is created only after compilation and baseline pinning. Waiting
      // here closes the pre-run race: cancel cannot return before dispatch has
      // either published that run or completed initialization without one.
      if (initialization) await initialization;
      await this.#cancelInternal(input);
    })().catch(async (error) => {
      const state = this.#state;
      if (state) {
        await this.#appendEvent(state, "parallel_cancellation_failure", {
          parentCastId: state.castId,
          error: boundedFailureReason(errorMessage(error)),
        });
        this.#deps.state.saveCastState(input.pi, state);
      }
    });
    return this.#cancelPromise;
  }

  /** Alias used by shutdown adapters that call the operation an abort. */
  async abort(input: ParallelLoopCancellationInput): Promise<void> {
    return this.cancel(input);
  }

  /** Alias for session lifecycle adapters. */
  async shutdown(input: ParallelLoopCancellationInput): Promise<void> {
    return this.cancel(input);
  }

  #beginInitialization(input: ParallelLoopDispatchInput): DispatchInitialization {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => { resolve = complete; });
    const initialization = { castId: input.state.castId, loopId: input.loopId, promise, resolve };
    this.#initialization = initialization;
    return initialization;
  }

  #finishInitialization(initialization: DispatchInitialization): void {
    if (this.#initialization !== initialization) return;
    this.#initialization = undefined;
    initialization.resolve();
  }

  #hasCancellationTarget(input: ParallelLoopCancellationInput): boolean {
    const initialization = this.#initialization;
    if (initialization && initialization.castId === input.state.castId && (!input.loopId || initialization.loopId === input.loopId)) return true;

    const persistedRuns = input.state.parallelRuns ?? {};
    if (Object.entries(persistedRuns).some(([loopId, run]) =>
      run.parentCastId === input.state.castId && (input.loopId === undefined || loopId === input.loopId),
    )) return true;

    return Boolean(
      this.#run &&
      this.#run.parentCastId === input.state.castId &&
      (input.loopId === undefined || this.#run.loopId === input.loopId),
    );
  }

  async #pump(): Promise<void> {
    this.#pumpTail = this.#pumpTail.then(() => this.#pumpInternal());
    await this.#pumpTail;
  }

  async #pumpInternal(): Promise<void> {
    if (this.#dispatching) return;
    this.#dispatching = true;
    try {
      const input = this.#input;
      const state = this.#state;
      if (!input || !state || !this.#run) return;
      while (!this.#cancelRequested && !this.#budgetFailure && this.#active.size < input.config.maxConcurrency && this.#nextQueueIndex < this.#prepared.length) {
        const prepared = this.#prepared[this.#nextQueueIndex++];
        if (!prepared) break;
        await this.#launchLane(input, state, prepared);
      }
    } finally {
      this.#dispatching = false;
    }
  }

  #bindCancellationInput(input: ParallelLoopCancellationInput): void {
    this.#state = input.state;
    const availableRuns = input.state.parallelRuns ?? {};
    const sameCastInput = this.#input?.state.castId === input.state.castId ? this.#input : undefined;
    const sameCastRun = this.#run?.parentCastId === input.state.castId ? this.#run : undefined;
    const loopId = input.loopId
      ?? Object.keys(availableRuns)[0]
      ?? sameCastInput?.loopId
      ?? sameCastRun?.loopId;
    if (!loopId) return;

    const persistedRun = availableRuns[loopId];
    if (persistedRun && (!this.#run || this.#run.runId !== persistedRun.runId || this.#run.parentCastId !== input.state.castId)) {
      this.#run = persistedRun;
    }
    if (!this.#input || this.#input.state.castId !== input.state.castId || this.#input.loopId !== loopId) {
      const run = this.#run;
      const config: MateriaLoopParallelConfig = run
        ? {
            planInput: run.configIdentity.planInput,
            maxConcurrency: run.configIdentity.maxConcurrency,
            workspaceMode: run.configIdentity.workspaceMode,
            failurePolicy: run.configIdentity.failurePolicy,
            fanIn: run.configIdentity.fanIn,
          }
        : {
            planInput: "state.parallelPlan",
            maxConcurrency: 1,
            workspaceMode: "jj",
            failurePolicy: "all_terminal",
            fanIn: "ordered",
          };
      this.#input = {
        pi: input.pi,
        ctx: input.ctx ?? this.#input?.ctx ?? {} as ExtensionContext,
        state: input.state,
        socket: {} as ResolvedMateriaSocket,
        loopId,
        config,
      };
    } else {
      this.#input = { ...this.#input, pi: input.pi, ...(input.ctx ? { ctx: input.ctx } : {}), state: input.state };
    }
  }

  async #cancelInternal(input: ParallelLoopCancellationInput): Promise<void> {
    const state = this.#state;
    const coordinator = this.#run;
    const dispatchInput = this.#input;
    if (!state || !coordinator || !dispatchInput) return;

    const reason = boundedFailureReason(input.reason?.trim() || "parallel execution cancelled");
    const occurredAt = this.#now();
    await this.#appendEvent(state, "parallel_cancellation_requested", {
      parentCastId: state.castId,
      loopId: coordinator.loopId,
      runId: coordinator.runId,
      reason,
      activeLaneIds: [...this.#active.keys()],
      queuedLaneIds: coordinator.queueOrder.filter((laneId) => coordinator.lanes[laneId]?.status === "queued"),
    });

    // Prevent the current pump from taking another queue entry. The lane that
    // is already preparing a workspace is allowed to finish so its ownership
    // can be retained in the cancellation record.
    this.#nextQueueIndex = this.#prepared.length;
    const initiallyActive = [...this.#active.values()];
    await Promise.all(initiallyActive.map((active) => this.#abortChild(active.childCastId, reason)));
    await this.#pumpTail.catch(() => undefined);

    // A child may be registered while a start() call was in flight when the
    // first abort pass ran. Repeat the pass after the pump quiesces.
    const remainingActive = [...this.#active.values()];
    await Promise.all(remainingActive.map((active) => this.#abortChild(active.childCastId, reason)));

    const snapshots = new Map<string, ChildCastSnapshot | undefined>();
    for (const active of [...this.#active.values()]) {
      snapshots.set(active.childCastId, await this.#flushChildTelemetry(dispatchInput, state, active));
    }

    const diagnostic: ParallelLaneDiagnosticArtifact = {
      code: "parallel_cancelled",
      message: reason,
      severity: "warning",
      occurredAt,
    };
    for (const laneId of coordinator.queueOrder) {
      const lane = this.#run?.lanes[laneId];
      if (!lane || isTerminalLaneStatus(lane.status)) continue;
      const active = this.#active.get(laneId);
      const prepared = this.#prepared.find((candidate) => candidate.stream.laneId === laneId);
      const stream = prepared?.stream ?? streamFromLane(lane);
      if (!stream) continue;
      let workspace = lane.workspace
        ?? (active?.artifactIdentity.workspace as MateriaParallelRunState["lanes"][string]["workspace"] | undefined)
        ?? (prepared?.workspace ? workspaceOwnership(state, dispatchInput.loopId, laneId, prepared.workspace) : undefined);
      if (workspace && this.#deps.workspaces.inspect) {
        const inspected = await this.#deps.workspaces.inspect({
          workspacePath: workspace.workspacePath,
          workspaceRoot: workspace.workspaceRoot,
          workspaceName: workspace.workspaceName,
        }).catch(() => undefined);
        if (inspected?.currentRevision) workspace = { ...workspace, revision: inspected.currentRevision };
      }
      const childCastId = lane.childCastId ?? active?.childCastId ?? childCastIdentity(state.castId, dispatchInput.loopId, laneId, lane.attempt);
      this.#applyLaneTransition(dispatchInput, state, {
        laneId,
        attempt: lane.attempt,
        childCastId,
        ...(workspace ? { workspace } : {}),
        status: "interrupted",
        failureReason: reason,
        diagnostic,
        timestamp: occurredAt,
      });

      const latestLane = this.#run?.lanes[laneId];
      const childSnapshot = active ? snapshots.get(active.childCastId) : undefined;
      const usage = active ? this.#latestUsage.get(active.childCastId) : undefined;
      const identity = active?.artifactIdentity ?? this.#cancellationArtifactIdentity(state, dispatchInput, stream, childCastId, lane.attempt, workspace);
      await this.#initializeLaneArtifacts(identity, state);
      const result: ChildCastTerminalResult = {
        status: "interrupted",
        accepted: false,
        endedAt: occurredAt,
        error: reason,
        abortReason: reason,
        ...(childSnapshot?.terminalResult?.message ? { message: childSnapshot.terminalResult.message } : {}),
        ...(usage ? { usage } : {}),
      };
      const diagnostics = latestLane?.diagnostics ?? [diagnostic];
      await this.#writeLaneFailureArtifacts(identity, {
        status: result.status,
        accepted: false,
        endedAt: result.endedAt,
        error: result.error,
        abortReason: result.abortReason,
      }, {
        baseline: latestLane?.workspace?.baseline ?? this.#run!.baseline,
        ...(latestLane?.workspace?.revision ? { workspace: latestLane.workspace.revision } : {}),
      }, diagnostics, usage);
      await this.#appendEvent(state, "parallel_lane_interrupted", {
        parentCastId: state.castId,
        loopId: dispatchInput.loopId,
        runId: this.#run?.runId,
        laneId,
        childCastId,
        reason,
      });
    }

    const run = this.#run;
    if (run) {
      const phase = applyParallelRunPhaseTransition(run, {
        parentCastId: state.castId,
        loopId: dispatchInput.loopId,
        runId: run.runId,
        phase: "failed",
        fanInPhase: "skipped",
        timestamp: this.#now(),
      });
      if (phase.applied) {
        replaceState(state, {
          ...state,
          parallelRuns: { ...(state.parallelRuns ?? {}), [dispatchInput.loopId]: phase.state },
        });
        this.#run = state.parallelRuns?.[dispatchInput.loopId];
      }
    }
    this.#active.clear();
    this.#deps.state.saveCastState(input.pi, state);
    await this.#appendEvent(state, "parallel_cancelled", {
      parentCastId: state.castId,
      loopId: dispatchInput.loopId,
      runId: this.#run?.runId,
      reason,
      laneStatuses: Object.fromEntries(Object.entries(this.#run?.lanes ?? {}).map(([laneId, lane]) => [laneId, lane.status])),
      workspacesPreserved: true,
    });
  }

  async #abortChild(childCastId: string, reason: string): Promise<void> {
    await this.#deps.children.abort({ childCastId, reason }).catch(() => undefined);
  }

  async #flushChildTelemetry(
    input: ParallelLoopDispatchInput,
    state: MateriaCastState,
    active: ActiveLane,
  ): Promise<ChildCastSnapshot | undefined> {
    await this.#eventTails.get(active.childCastId)?.catch(() => undefined);
    const observation = await this.#deps.children.observe({ childCastId: active.childCastId }).catch(() => undefined);
    if (!observation) return undefined;
    const lastSequence = this.#run?.lanes[active.artifactIdentity.laneId]?.lastEvent?.sequence ?? 0;
    for (const event of observation.events) {
      if (event.sequence <= lastSequence) continue;
      await this.#processChildEvent(input, state, streamForActive(this.#run, active), active, event);
    }
    const usage = isUsage(observation.snapshot.usage) ? observation.snapshot.usage : undefined;
    if (usage) await this.#aggregateUsage(state, input, streamForActive(this.#run, active), active, usage);
    for (const childDiagnostic of observation.snapshot.diagnostics) {
      await this.#appendLaneDiagnostic(input, state, streamForActive(this.#run, active), active, toParallelDiagnostic(childDiagnostic));
    }
    return observation.snapshot;
  }

  #cancellationArtifactIdentity(
    state: MateriaCastState,
    input: ParallelLoopDispatchInput,
    stream: NormalizedParallelStream,
    childCastId: string,
    attempt: number,
    workspace: MateriaParallelRunState["lanes"][string]["workspace"] | undefined,
  ): ParallelLaneArtifactIdentity {
    return {
      parentCastId: state.castId,
      runId: this.#run?.runId ?? state.runState.runId,
      loopId: input.loopId,
      laneId: stream.laneId,
      childCastId,
      attempt,
      streamIndex: stream.streamIndex,
      workItemIndexes: [...stream.workItemIndexes],
      paths: lanePaths(state, input.loopId, stream.laneId, attempt),
      ...(workspace ? { workspace } : {}),
    };
  }

  async #launchLane(input: ParallelLoopDispatchInput, state: MateriaCastState, prepared: PreparedLane): Promise<void> {
    const lane = this.#run?.lanes[prepared.stream.laneId];
    if (!lane || lane.status !== "queued") return;

    const attempt = lane.attempt;
    const childCastId = childCastIdentity(state.castId, input.loopId, prepared.stream.laneId, attempt);
    const childPaths = lanePaths(state, input.loopId, prepared.stream.laneId, attempt);
    // Initialize the lane record before workspace creation. A workspace failure
    // is still a terminal lane attempt and must have a durable artifact trail.
    const baseArtifactIdentity: ParallelLaneArtifactIdentity = {
      parentCastId: state.castId,
      runId: this.#run!.runId,
      loopId: input.loopId,
      laneId: prepared.stream.laneId,
      childCastId,
      attempt,
      streamIndex: prepared.stream.streamIndex,
      workItemIndexes: [...prepared.stream.workItemIndexes],
      paths: childPaths,
    };
    let artifactPaths = await this.#initializeLaneArtifacts(baseArtifactIdentity, state);

    let workspace: ParallelWorkspaceRecord;
    try {
      workspace = await this.#deps.workspaces.create({
        parentCastId: state.castId,
        loopId: input.loopId,
        laneId: prepared.stream.laneId,
        cwd: state.cwd,
        repositoryRoot: this.#repositoryRoot ?? state.cwd,
        baseline: this.#run!.baseline,
      });
      prepared.workspace = workspace;
      if (this.#cancelRequested) return;
    } catch (error) {
      const reason = `workspace creation failed: ${errorMessage(error)}`;
      const diagnostic = await this.#markLaneFailure(input, state, prepared.stream.laneId, reason, childCastId);
      await this.#writeLaneFailureArtifacts(baseArtifactIdentity, {
        status: "failed",
        accepted: false,
        endedAt: diagnostic.occurredAt,
        error: boundedFailureReason(reason),
      }, { baseline: this.#run!.baseline }, [diagnostic]);
      return;
    }

    const childSession = {
      childCastId,
      sessionPath: childPaths.sessionPath,
      artifactRoot: childPaths.artifactRoot,
      runDirectory: childPaths.runDirectory,
    };
    const ownership = workspaceOwnership(state, input.loopId, prepared.stream.laneId, workspace);
    const artifactIdentity: ParallelLaneArtifactIdentity = { ...baseArtifactIdentity, workspace: ownership };
    // Refresh the manifest with workspace ownership after the workspace exists.
    artifactPaths = await this.#initializeLaneArtifacts(artifactIdentity, state) ?? artifactPaths;

    const transitioned = this.#applyLaneTransition(input, state, {
      laneId: prepared.stream.laneId,
      attempt,
      childCastId,
      status: "running",
      workspace: ownership,
      childSession,
      timestamp: this.#now(),
    });
    if (!transitioned) return;

    const active: ActiveLane = { workspace, childCastId, attempt, artifactIdentity, artifactPaths };
    this.#active.set(prepared.stream.laneId, active);
    const startInput: StartChildCastInput = {
      identity: {
        childCastId,
        parentCastId: state.castId,
        loopId: input.loopId,
        laneId: prepared.stream.laneId,
      },
      request: state.request,
      cwd: workspace.workspacePath,
      compiledLoadout: {
        childLoadoutId: prepared.compiledLoadout.childLoadoutId,
        loadout: prepared.compiledLoadout.loadout,
        initialData: {
          ...prepared.compiledLoadout.initialData,
          ...boundedParallelChildData(this.#run!, prepared.stream),
        },
        loopId: input.loopId,
        laneId: prepared.stream.laneId,
      },
      paths: childPaths,
      attempt,
    };

    try {
      await this.#deps.children.start(startInput);
      if (this.#cancelRequested) {
        // Cancellation may have raced with start(). Keep the active record so
        // the coordinator can observe telemetry and persist its workspace.
        await this.#abortChild(childCastId, "parallel execution cancelled");
        return;
      }
      this.#deps.children.subscribe({ childCastId }, {
        onEvent: (event) => this.#handleChildEvent(input, state, prepared.stream, active, event),
        onTerminal: (result) => this.#handleChildTerminal(input, state, prepared.stream, active, result),
      });
      await this.#appendEvent(state, "parallel_lane_started", {
        parentCastId: state.castId,
        loopId: input.loopId,
        runId: this.#run?.runId,
        laneId: prepared.stream.laneId,
        childCastId,
        streamIndex: prepared.stream.streamIndex,
        workItemIndexes: [...prepared.stream.workItemIndexes],
        workspace: ownership,
        ...(artifactPaths ? { artifactPaths } : {}),
      });
    } catch (error) {
      this.#active.delete(prepared.stream.laneId);
      await this.#deps.children.abort({ childCastId, reason: `child launch failed: ${errorMessage(error)}` }).catch(() => undefined);
      if (this.#cancelRequested) return;
      const reason = `child launch failed: ${errorMessage(error)}`;
      const diagnostic = await this.#markLaneFailure(input, state, prepared.stream.laneId, reason, childCastId);
      await this.#writeLaneFailureArtifacts(artifactIdentity, {
        status: "failed",
        accepted: false,
        endedAt: diagnostic.occurredAt,
        error: boundedFailureReason(reason),
      }, {
        baseline: workspace.baseline,
        workspace: workspace.revision,
      }, [diagnostic]);
    }
  }

  async #handleChildEvent(
    input: ParallelLoopDispatchInput,
    state: MateriaCastState,
    stream: NormalizedParallelStream,
    active: ActiveLane,
    event: ChildCastStreamEvent,
  ): Promise<void> {
    if (this.#cancelRequested) return;
    const previous = this.#eventTails.get(active.childCastId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.#processChildEvent(input, state, stream, active, event));
    this.#eventTails.set(active.childCastId, next);
    try {
      await next;
    } finally {
      if (this.#eventTails.get(active.childCastId) === next) this.#eventTails.delete(active.childCastId);
    }
  }

  async #processChildEvent(
    input: ParallelLoopDispatchInput,
    state: MateriaCastState,
    stream: NormalizedParallelStream,
    active: ActiveLane,
    event: ChildCastStreamEvent,
  ): Promise<void> {
    const usage = isUsage(event.usage) ? event.usage : undefined;
    const provenance = this.#eventProvenance(state, input.loopId, this.#run?.runId, stream, active, event.sequence, event.workItemId);
    const eventArtifact = { provenance, event };
    await this.#appendLaneArtifact(active.artifactIdentity, eventArtifact);
    await this.#appendEvent(state, "parallel_child_event", eventArtifact);

    const applied = this.#applyLaneTransition(input, state, {
      laneId: stream.laneId,
      attempt: active.attempt,
      childCastId: event.childCastId,
      lastEvent: { sequence: event.sequence, type: event.type, occurredAt: event.occurredAt },
      ...(usage ? { usage } : {}),
      timestamp: event.occurredAt,
    });
    if (usage && applied) await this.#aggregateUsage(state, input, stream, active, usage);

    const diagnostic = childDiagnosticFromEvent(event);
    if (diagnostic) await this.#appendLaneDiagnostic(input, state, stream, active, diagnostic);
  }

  async #handleChildTerminal(
    input: ParallelLoopDispatchInput,
    state: MateriaCastState,
    stream: NormalizedParallelStream,
    active: ActiveLane,
    result: ChildCastTerminalResult,
  ): Promise<void> {
    if (this.#cancelRequested) return;
    // Drain child events first so the lane event stream remains ordered before
    // the normalized terminal record is written.
    await this.#eventTails.get(active.childCastId)?.catch(() => undefined);
    if (this.#cancelRequested) return;
    // The terminal callback can be delivered more than once by an adapter. The
    // active-map deletion makes releasing the scheduler slot idempotent. A
    // budget stop may have already removed and finalized this lane.
    if (this.#budgetFailure) return;
    if (!this.#active.delete(stream.laneId)) return;

    const currentLane = this.#run?.lanes[stream.laneId];
    const attempt = currentLane?.attempt ?? active.attempt;
    const childSnapshot = await this.#deps.children.observe({ childCastId: active.childCastId }).catch(() => undefined);
    const usage = highestUsage([
      childSnapshot && isUsage(childSnapshot.snapshot.usage) ? childSnapshot.snapshot.usage : undefined,
      isUsage(result.usage) ? result.usage : undefined,
      this.#latestUsage.get(active.childCastId),
    ]);
    if (usage) await this.#aggregateUsage(state, input, stream, active, usage);
    if (this.#budgetFailure) return;
    const head = result.status === "succeeded" && result.accepted
      ? await this.#acceptedHead(active.workspace, result, childSnapshot?.snapshot)
      : undefined;

    const reason = result.error
      ?? (result.status === "succeeded" ? "Child completed without a verifiable accepted lane head." : "Child lane did not complete successfully.");
    if (result.status === "succeeded" && result.accepted && head) {
      this.#applyLaneTransition(input, state, {
        laneId: stream.laneId,
        attempt,
        childCastId: active.childCastId,
        status: "accepted",
        accepted: true,
        acceptedHead: head,
        ...(usage ? { usage } : {}),
        failureReason: undefined,
        timestamp: result.endedAt,
      });
    } else {
      const status = result.status === "interrupted" ? "interrupted" : "failed";
      this.#applyLaneTransition(input, state, {
        laneId: stream.laneId,
        attempt,
        childCastId: active.childCastId,
        status,
        ...(usage ? { usage } : {}),
        failureReason: boundedFailureReason(reason),
        diagnostic: {
          code: "parallel_lane_terminal",
          message: boundedFailureReason(reason),
          severity: "error",
          occurredAt: result.endedAt,
        },
        timestamp: result.endedAt,
      });
    }

    const childDiagnostics = childSnapshot?.snapshot.diagnostics.map(toParallelDiagnostic) ?? [];
    const terminalDiagnostic = result.status === "succeeded" && result.accepted && head ? undefined : {
      code: "parallel_lane_terminal",
      message: boundedFailureReason(reason),
      severity: "error" as const,
      occurredAt: result.endedAt,
    };
    const allDiagnostics = terminalDiagnostic ? [...childDiagnostics, terminalDiagnostic] : childDiagnostics;
    for (const diagnostic of childDiagnostics) {
      await this.#appendLaneDiagnostic(input, state, stream, active, diagnostic);
    }
    await this.#writeLaneTerminalArtifacts(active, result, usage, head, allDiagnostics);
    await this.#appendEvent(state, "parallel_lane_terminal", {
      ...this.#eventProvenance(state, input.loopId, this.#run?.runId, stream, active),
      status: result.status,
      accepted: result.accepted,
      ...(head ? { acceptedHead: head } : {}),
      ...(result.error ? { error: boundedFailureReason(result.error) } : {}),
      ...(usage ? { usage } : {}),
    });
    await this.#pump();
  }

  async #initializeLaneArtifacts(identity: ParallelLaneArtifactIdentity, state: MateriaCastState): Promise<ParallelLaneArtifactPaths | undefined> {
    const lane = this.#deps.artifacts?.lane;
    if (!lane) return undefined;
    try {
      return await lane.initialize(identity);
    } catch (error) {
      await this.#appendEvent(state, "parallel_artifact_failure", {
        laneId: identity.laneId,
        childCastId: identity.childCastId,
        operation: "initialize",
        error: boundedFailureReason(errorMessage(error)),
      });
      return undefined;
    }
  }

  async #appendLaneArtifact(identity: ParallelLaneArtifactIdentity, event: ParallelLaneEventArtifact): Promise<void> {
    const lane = this.#deps.artifacts?.lane;
    if (!lane) return;
    try {
      await lane.appendEvent({ ...identity, event });
    } catch {
      // Artifact telemetry must not stop a child lane. The child runner keeps
      // its own stdout/stderr and session files as the recovery source.
    }
  }

  async #aggregateUsage(
    state: MateriaCastState,
    input: ParallelLoopDispatchInput,
    stream: NormalizedParallelStream,
    active: ActiveLane,
    usage: MateriaParallelUsageTotals,
  ): Promise<void> {
    const previous = this.#latestUsage.get(active.childCastId);
    const delta = usageDelta(previous, usage);
    this.#latestUsage.set(active.childCastId, usage);
    if (!hasUsage(delta)) return;

    const report = state.runState.usage;
    report.byMateria ??= {};
    report.bySocket ??= {};
    report.byTask ??= {};
    report.byAttempt ??= {};
    addUsage(report, delta, {
      socket: `parallel/${input.loopId}/${stream.laneId}`,
      materia: "parallel-child",
      taskId: stream.laneId,
      attempt: active.attempt,
    });
    this.#deps.state.saveCastState(input.pi, state);
    await this.#writeParentUsage(state);
    await this.#appendLaneUsage(active, usage);
    if (this.#cancelRequested) return;
    try {
      await this.#deps.budget?.assertBudget?.(state, input.ctx);
    } catch (error) {
      await this.#enforceBudget(input, state, stream, active, error);
    }
  }

  async #writeParentUsage(state: MateriaCastState): Promise<void> {
    const writeUsage = this.#deps.artifacts?.writeUsage;
    if (!writeUsage) return;
    this.#usageWriteTail = this.#usageWriteTail.catch(() => undefined).then(() => writeUsage(state.runState));
    try {
      await this.#usageWriteTail;
    } catch {
      // Parent usage artifacts are best effort; in-memory state remains current.
    }
  }

  async #appendLaneUsage(active: ActiveLane, usage: MateriaParallelUsageTotals): Promise<void> {
    const lane = this.#deps.artifacts?.lane;
    if (!lane) return;
    try {
      await lane.writeUsage({ ...active.artifactIdentity, usage });
    } catch {
      // See #appendLaneArtifact: telemetry is best effort and child files are
      // still available for recovery.
    }
  }

  async #appendLaneDiagnostic(
    input: ParallelLoopDispatchInput,
    state: MateriaCastState,
    stream: NormalizedParallelStream,
    active: ActiveLane,
    diagnostic: ParallelLaneDiagnosticArtifact,
  ): Promise<void> {
    const existingDiagnostics = this.#run?.lanes[stream.laneId]?.diagnostics ?? [];
    if (existingDiagnostics.some((entry) => entry.code === diagnostic.code && entry.message === diagnostic.message && entry.occurredAt === diagnostic.occurredAt)) return;
    const applied = this.#applyLaneTransition(input, state, {
      laneId: stream.laneId,
      attempt: active.attempt,
      childCastId: active.childCastId,
      diagnostic,
      timestamp: diagnostic.occurredAt,
    });
    if (!applied) return;
    const lane = this.#deps.artifacts?.lane;
    if (!lane) return;
    try {
      const diagnostics = this.#run?.lanes[stream.laneId]?.diagnostics ?? [diagnostic];
      await lane.writeDiagnostics({ ...active.artifactIdentity, diagnostics });
    } catch {
      // Best effort; state already retains a bounded copy.
    }
  }

  async #writeLaneTerminalArtifacts(
    active: ActiveLane,
    result: ChildCastTerminalResult,
    usage: MateriaParallelUsageTotals | undefined,
    head: ParallelWorkspaceRevision | undefined,
    diagnostics: readonly ParallelLaneDiagnosticArtifact[],
  ): Promise<void> {
    const lane = this.#deps.artifacts?.lane;
    if (!lane) return;
    await this.#safeLaneWrite(() => lane.writeTerminalResult({ ...active.artifactIdentity, result, ...(usage ? { usage } : {}) }));
    await this.#safeLaneWrite(() => lane.writeRevision({
      ...active.artifactIdentity,
      revision: {
        baseline: active.workspace.baseline,
        workspace: active.workspace.revision,
        ...(head ? { acceptedHead: head } : {}),
      },
    }));
    await this.#safeLaneWrite(() => lane.writeDiagnostics({ ...active.artifactIdentity, diagnostics }));
    if (usage) await this.#safeLaneWrite(() => lane.writeUsage({ ...active.artifactIdentity, usage }));
  }

  async #writeLaneFailureArtifacts(
    identity: ParallelLaneArtifactIdentity,
    result: ChildCastTerminalResult,
    revision: { baseline?: unknown; workspace?: unknown },
    diagnostics: readonly ParallelLaneDiagnosticArtifact[],
    usage?: MateriaParallelUsageTotals,
  ): Promise<void> {
    const lane = this.#deps.artifacts?.lane;
    if (!lane) return;
    await this.#safeLaneWrite(() => lane.writeTerminalResult({ ...identity, result, ...(usage ? { usage } : {}) }));
    await this.#safeLaneWrite(() => lane.writeRevision({ ...identity, revision }));
    await this.#safeLaneWrite(() => lane.writeDiagnostics({ ...identity, diagnostics: diagnostics.slice(-24) }));
    if (usage) await this.#safeLaneWrite(() => lane.writeUsage({ ...identity, usage }));
  }

  async #enforceBudget(
    input: ParallelLoopDispatchInput,
    state: MateriaCastState,
    stream: NormalizedParallelStream,
    triggeringLane: ActiveLane,
    error: unknown,
  ): Promise<void> {
    if (this.#budgetFailure) return;
    const budgetError = error instanceof Error ? error : new Error(String(error));
    this.#budgetFailure = budgetError;
    const occurredAt = this.#now();
    const reason = boundedFailureReason(`Parallel parent budget exhausted: ${errorMessage(error)}`);
    const diagnostic: ParallelLaneDiagnosticArtifact = {
      code: "parallel_budget_exceeded",
      message: reason,
      severity: "error",
      occurredAt,
    };
    await this.#appendEvent(state, "parallel_budget_exceeded", {
      ...this.#eventProvenance(state, input.loopId, this.#run?.runId, stream, triggeringLane),
      error: boundedFailureReason(errorMessage(error)),
      consumedTokens: state.runState.usage.tokens.total,
    });

    // Remove every live lane before aborting. Adapters are allowed to invoke
    // terminal callbacks synchronously from abort(), and those callbacks must
    // not reopen or overwrite the budget-stop artifacts.
    const lanesToStop = new Map<string, ActiveLane>(this.#active);
    lanesToStop.set(stream.laneId, triggeringLane);
    this.#active.clear();
    for (const [laneId, active] of lanesToStop) {
      const lane = this.#run?.lanes[laneId];
      if (!lane || lane.status !== "running") continue;
      this.#applyLaneTransition(input, state, {
        laneId,
        attempt: active.attempt,
        childCastId: active.childCastId,
        status: "interrupted",
        failureReason: reason,
        diagnostic,
        timestamp: occurredAt,
      });
      const diagnostics = this.#run?.lanes[laneId]?.diagnostics ?? [diagnostic];
      await this.#writeLaneFailureArtifacts(active.artifactIdentity, {
        status: "interrupted",
        accepted: false,
        endedAt: occurredAt,
        error: reason,
        abortReason: "parallel parent budget exhausted",
      }, {
        baseline: active.workspace.baseline,
        workspace: active.workspace.revision,
      }, diagnostics);
    }

    const queued = this.#prepared.slice(this.#nextQueueIndex);
    this.#nextQueueIndex = this.#prepared.length;
    for (const prepared of queued) {
      const lane = this.#run?.lanes[prepared.stream.laneId];
      if (!lane || lane.status !== "queued") continue;
      const childCastId = childCastIdentity(state.castId, input.loopId, prepared.stream.laneId, lane.attempt);
      const identity: ParallelLaneArtifactIdentity = {
        parentCastId: state.castId,
        runId: this.#run!.runId,
        loopId: input.loopId,
        laneId: prepared.stream.laneId,
        childCastId,
        attempt: lane.attempt,
        streamIndex: prepared.stream.streamIndex,
        workItemIndexes: [...prepared.stream.workItemIndexes],
        paths: lanePaths(state, input.loopId, prepared.stream.laneId, lane.attempt),
      };
      const artifactReason = "parallel parent budget exhausted before child launch";
      const laneDiagnostic = await this.#markLaneFailure(input, state, prepared.stream.laneId, artifactReason, childCastId);
      await this.#initializeLaneArtifacts(identity, state);
      await this.#writeLaneFailureArtifacts(identity, {
        status: "failed",
        accepted: false,
        endedAt: laneDiagnostic?.occurredAt ?? occurredAt,
        error: artifactReason,
      }, { baseline: this.#run!.baseline }, laneDiagnostic ? [laneDiagnostic] : [diagnostic]);
    }

    const run = this.#run;
    if (run) {
      const phase = applyParallelRunPhaseTransition(run, {
        parentCastId: state.castId,
        loopId: input.loopId,
        runId: run.runId,
        phase: "failed",
        fanInPhase: "failed",
        timestamp: occurredAt,
      });
      if (phase.applied) {
        replaceState(state, {
          ...state,
          parallelRuns: { ...(state.parallelRuns ?? {}), [input.loopId]: phase.state },
        });
        this.#run = state.parallelRuns?.[input.loopId];
      }
    }
    this.#deps.state.saveCastState(input.pi, state);

    for (const active of lanesToStop.values()) {
      await this.#deps.children.abort({ childCastId: active.childCastId, reason }).catch(() => undefined);
    }
    try {
      await this.#deps.onBudgetExceeded?.(input.pi, input.ctx, state, budgetError, `parallel:${input.loopId}`);
    } catch (callbackError) {
      await this.#appendEvent(state, "parallel_budget_callback_failure", {
        parentCastId: state.castId,
        loopId: input.loopId,
        error: boundedFailureReason(errorMessage(callbackError)),
      });
    }
  }

  async #safeLaneWrite(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch {
      // A failed artifact write must not change an already terminal lane or
      // release a scheduler slot twice.
    }
  }

  #eventProvenance(
    state: MateriaCastState,
    loopId: string,
    runId: string | undefined,
    stream: NormalizedParallelStream,
    active: ActiveLane,
    sequence?: number,
    workItemId?: string,
  ): Record<string, unknown> {
    return {
      parentCastId: state.castId,
      loopId,
      runId,
      laneId: stream.laneId,
      childCastId: active.childCastId,
      attempt: active.attempt,
      streamIndex: stream.streamIndex,
      workItemIndexes: [...stream.workItemIndexes],
      ...(workItemId !== undefined ? { workItemId } : {}),
      ...(sequence !== undefined ? { childSequence: sequence } : {}),
    };
  }

  async #acceptedHead(
    workspace: ParallelWorkspaceRecord,
    result: ChildCastTerminalResult,
    snapshot: ChildCastSnapshot | undefined,
  ): Promise<ParallelWorkspaceRevision | undefined> {
    const fromOutput = revisionInValue(result.output) ?? revisionInValue(snapshot?.terminalResult?.output);
    if (fromOutput) return fromOutput;
    if (this.#deps.workspaces.inspect) {
      const inspected = await this.#deps.workspaces.inspect({
        workspacePath: workspace.workspacePath,
        workspaceRoot: workspace.workspaceRoot,
        workspaceName: workspace.workspaceName,
      }).catch(() => undefined);
      if (inspected?.currentRevision) return inspected.currentRevision;
    }
    // A successful no-op child still has a verifiable jj revision. The
    // workspace record's revision is the immutable baseline when no item made
    // a change; it is preferable to inventing a synthetic head.
    return workspace.revision ?? workspace.baseline;
  }

  async #markLaneFailure(
    input: ParallelLoopDispatchInput,
    state: MateriaCastState,
    laneId: string,
    reason: string,
    childCastId?: string,
  ): Promise<ParallelLaneDiagnosticArtifact> {
    const lane = this.#run?.lanes[laneId];
    const occurredAt = this.#now();
    const boundedReason = boundedFailureReason(reason);
    const diagnostic: ParallelLaneDiagnosticArtifact = {
      code: "parallel_lane_failure",
      message: boundedReason,
      severity: "error",
      occurredAt,
    };
    if (!lane) return diagnostic;
    this.#applyLaneTransition(input, state, {
      laneId,
      attempt: lane.attempt,
      ...(childCastId !== undefined ? { childCastId } : lane.childCastId !== undefined ? { childCastId: lane.childCastId } : {}),
      status: lane.status === "queued" ? "failed" : lane.status === "running" ? "failed" : undefined,
      failureReason: boundedReason,
      diagnostic,
      timestamp: occurredAt,
    });
    await this.#appendEvent(state, "parallel_lane_failed", {
      parentCastId: state.castId,
      loopId: input.loopId,
      runId: this.#run?.runId,
      laneId,
      ...(childCastId !== undefined ? { childCastId } : {}),
      error: boundedReason,
    });
    return diagnostic;
  }

  #applyLaneTransition(
    input: ParallelLoopDispatchInput,
    state: MateriaCastState,
    transition: Omit<Parameters<typeof applyParallelTransitionToCastState>[1], "parentCastId" | "castId" | "loopId" | "runId">,
  ): boolean {
    const run = this.#run;
    if (!run) return false;
    const result = applyParallelTransitionToCastState(state, {
      parentCastId: state.castId,
      loopId: input.loopId,
      runId: run.runId,
      ...transition,
    });
    if (!result.applied) return false;
    replaceState(state, result.state);
    this.#run = state.parallelRuns?.[input.loopId];
    this.#deps.state.saveCastState(input.pi, state);
    return true;
  }

  async #appendEvent(state: MateriaCastState, type: string, data: unknown): Promise<void> {
    const append = this.#deps.artifacts?.appendEvent;
    if (!append || !state.runState) return;
    try {
      await append(state.runState, type, data);
    } catch {
      // Parent artifact failures must not stop a child lane or corrupt state.
    }
  }
}

export function createParallelLoopDispatcher(deps: ParallelLoopDispatcherDependencies): ParallelLoopDispatcher {
  return new ParallelLoopDispatcher(deps);
}

/** Compatibility alias for callers that name the component a scheduler. */
export const createParallelLaneScheduler = createParallelLoopDispatcher;
export const ParallelLaneScheduler = ParallelLoopDispatcher;

function boundedParallelChildData(run: MateriaParallelRunState, stream: NormalizedParallelStream): Record<string, unknown> {
  const context = boundedParallelContext(run, stream);
  return {
    parallelContext: context,
    // These two narrow records are also the stable input contract consumed by
    // lane-local checkpoint utilities. They contain no parent mutable state.
    parallelRun: { runId: run.runId, planId: run.planIdentity.planId, loopId: run.loopId, laneId: stream.laneId },
    parallelLane: {
      laneId: stream.laneId,
      name: stream.name,
      streamIndex: stream.streamIndex,
      workItemIndexes: [...stream.workItemIndexes],
    },
  };
}

function childDiagnosticFromEvent(event: ChildCastStreamEvent): ParallelLaneDiagnosticArtifact | undefined {
  if (event.type !== "diagnostic" || !isRecord(event.payload)) return undefined;
  return toParallelDiagnostic(event.payload);
}

function toParallelDiagnostic(value: unknown): ParallelLaneDiagnosticArtifact {
  const record = isRecord(value) ? value : {};
  const severity = record.severity === "info" || record.severity === "warning" || record.severity === "error" ? record.severity : "warning";
  const details = isRecord(record.details) ? boundDiagnosticDetails(record.details) : undefined;
  return {
    code: boundedFailureReason(typeof record.code === "string" ? record.code : "child_diagnostic", 120),
    message: boundedFailureReason(typeof record.message === "string" ? record.message : "Child emitted a diagnostic."),
    severity,
    occurredAt: typeof record.occurredAt === "number" && Number.isFinite(record.occurredAt) ? record.occurredAt : Date.now(),
    ...(details ? { details } : {}),
  };
}

function highestUsage(values: readonly (MateriaParallelUsageTotals | undefined)[]): MateriaParallelUsageTotals | undefined {
  return values.filter((value): value is MateriaParallelUsageTotals => value !== undefined)
    .sort((left, right) => usageMagnitude(right) - usageMagnitude(left))[0];
}

function usageMagnitude(usage: MateriaParallelUsageTotals): number {
  return usage.tokens.total + usage.cost.total;
}

function usageDelta(previous: MateriaParallelUsageTotals | undefined, next: MateriaParallelUsageTotals): MateriaParallelUsageTotals {
  return {
    tokens: {
      input: usageComponentDelta(previous?.tokens.input, next.tokens.input),
      output: usageComponentDelta(previous?.tokens.output, next.tokens.output),
      cacheRead: usageComponentDelta(previous?.tokens.cacheRead, next.tokens.cacheRead),
      cacheWrite: usageComponentDelta(previous?.tokens.cacheWrite, next.tokens.cacheWrite),
      total: usageComponentDelta(previous?.tokens.total, next.tokens.total),
    },
    cost: {
      input: usageComponentDelta(previous?.cost.input, next.cost.input),
      output: usageComponentDelta(previous?.cost.output, next.cost.output),
      cacheRead: usageComponentDelta(previous?.cost.cacheRead, next.cost.cacheRead),
      cacheWrite: usageComponentDelta(previous?.cost.cacheWrite, next.cost.cacheWrite),
      total: usageComponentDelta(previous?.cost.total, next.cost.total),
    },
  };
}

function usageComponentDelta(previous: number | undefined, next: number): number {
  if (previous === undefined) return next;
  return next >= previous ? next - previous : next;
}

function hasUsage(usage: MateriaParallelUsageTotals): boolean {
  return Object.values(usage.tokens).some((value) => value > 0) || Object.values(usage.cost).some((value) => value > 0);
}

function boundDiagnosticDetails(details: Record<string, unknown>): Record<string, unknown> {
  try {
    const serialized = JSON.stringify(details);
    if (Buffer.byteLength(serialized, "utf8") <= 4_096) return details;
    return { excerpt: serialized.slice(0, 4_000) };
  } catch {
    return { note: "child diagnostic details were not JSON serializable" };
  }
}

function boundedFailureReason(value: string, max = 1_000): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ParallelLaneState = MateriaParallelRunState["lanes"][string];

function streamFromLane(lane: ParallelLaneState): NormalizedParallelStream {
  return {
    laneId: lane.laneId,
    name: lane.name,
    streamIndex: lane.streamIndex,
    workItemIndexes: [...lane.workItemIndexes],
  };
}

function streamForActive(run: MateriaParallelRunState | undefined, active: ActiveLane): NormalizedParallelStream {
  const lane = run?.lanes[active.artifactIdentity.laneId];
  if (lane) return streamFromLane(lane);
  return {
    laneId: active.artifactIdentity.laneId,
    name: active.artifactIdentity.laneId,
    streamIndex: active.artifactIdentity.streamIndex,
    workItemIndexes: [...active.artifactIdentity.workItemIndexes],
  };
}

function isTerminalLaneStatus(status: ParallelLaneState["status"]): boolean {
  return status === "accepted" || status === "failed" || status === "interrupted";
}

function validateDispatchConfig(config: MateriaLoopParallelConfig): void {
  if (!Number.isSafeInteger(config.maxConcurrency) || config.maxConcurrency < 1) {
    throw new Error("Parallel loop maxConcurrency must be a positive safe integer.");
  }
  if (config.workspaceMode !== "jj") throw new Error(`Unsupported parallel workspace mode ${JSON.stringify(config.workspaceMode)}; only jj is available.`);
  if (config.failurePolicy !== "all_terminal") throw new Error(`Unsupported parallel failure policy ${JSON.stringify(config.failurePolicy)}; only all_terminal is available.`);
  if (config.fanIn !== "ordered") throw new Error(`Unsupported parallel fan-in behavior ${JSON.stringify(config.fanIn)}; only ordered is available.`);
}

/** Find the opt-in loop owning a socket, without inferring graph routes. */
export function parallelLoopForSocket(
  state: MateriaCastState,
  socketId: string,
): { loopId: string; config: MateriaLoopParallelConfig } | undefined {
  for (const [loopId, loop] of Object.entries(state.pipeline.loops ?? {})) {
    if (loop.parallel && Array.isArray(loop.sockets) && loop.sockets.includes(socketId)) {
      return { loopId, config: loop.parallel };
    }
  }
  return undefined;
}

