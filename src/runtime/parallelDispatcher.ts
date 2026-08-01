import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  ChildCastRunnerPort,
  ChildCastSnapshot,
  ChildCastStreamEvent,
  ChildCastTerminalResult,
  StartChildCastInput,
} from "../application/childCastRunner.js";
import { boundParallelFanInResult, type ParallelFanInResult } from "../domain/parallelFanIn.js";
import { isParallelLaneRevivalCandidate, validateParallelRecovery, type ParallelRecoveryPlan, type ParallelRecoveryValidationIssue } from "../domain/parallelRecovery.js";
import type {
  ParallelFanInArtifactPort,
  ParallelLaneArtifactIdentity,
  ParallelLaneArtifactPaths,
  ParallelLaneArtifactPort,
  ParallelLaneDiagnosticArtifact,
  ParallelLaneEventArtifact,
} from "../application/parallelArtifacts.js";
import { addUsage } from "../telemetry/usage.js";
import { compileLoopRegionToChildLoadout, type CompiledLoopChildLoadout } from "../graph/loopCompiler.js";
import {
  applyParallelFanInProvenanceToCastState,
  applyParallelFinalizationToCastState,
  applyParallelRunPhaseTransition,
  applyParallelTransitionToCastState,
  attachParallelRunToCastState,
  createParallelRunState,
  restartParallelLaneAttempt,
} from "./parallelCoordinatorState.js";
import type { MateriaCastState, MateriaLoopParallelConfig, MateriaParallelFinalizationProvenance, MateriaParallelRunState, MateriaParallelUsageTotals, ResolvedMateriaSocket } from "../types.js";
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
  type NormalizedParallelPlan,
  type NormalizedParallelStream,
  type ParallelWorkspacePort,
  type ParallelWorkspaceRecord,
  type ParallelWorkspaceRevision,
} from "./parallelDispatchSupport.js";

export type {
  ParallelFanInArtifactPort,
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

export interface ParallelFanInCompletionInput {
  loopId: string;
  runId: string;
  result: ParallelFanInResult;
}

export interface ParallelRunFailureInput {
  loopId: string;
  runId: string;
  reason: string;
}

export interface ParallelLoopDispatchInput {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  state: MateriaCastState;
  socket: ResolvedMateriaSocket;
  loopId: string;
  config: MateriaLoopParallelConfig;
  /** Parent-session continuation at the symbolic fan-in barrier. */
  onFanIn?: (input: ParallelFanInCompletionInput) => Promise<void>;
  /** Turn an all-terminal coordinator failure into a parent cast failure. */
  onFailure?: (input: ParallelRunFailureInput) => Promise<void>;
}

export interface ParallelLoopFinalizationInput {
  pi: ExtensionAPI;
  state: MateriaCastState;
  loopId: string;
  evaluationAccepted: boolean;
  bookmarkName: string;
  description?: string;
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

export interface ParallelLoopReviveInput {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  state: MateriaCastState;
  loopId: string;
  config: MateriaLoopParallelConfig;
  /** Reinstall parent eventing/UI services before child callbacks can route. */
  onPrepared?: () => Promise<void>;
  /** Continue at the symbolic fan-in barrier after all revived lanes succeed. */
  onFanIn?: (input: ParallelFanInCompletionInput) => Promise<void>;
  /** Hard-fail the parent if a revived attempt remains unaccepted. */
  onFailure?: (input: ParallelRunFailureInput) => Promise<void>;
}

export interface ParallelLoopReviveResult {
  ok: boolean;
  issues: readonly ParallelRecoveryValidationIssue[];
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
    fanIn?: ParallelFanInArtifactPort;
  };
  /** Optional enriched runtime-event bridge used by the monitor feed. */
  runtimeEvents?: {
    emit(state: MateriaCastState, type: string, payload: Record<string, unknown>): Promise<void>;
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
  /** Existing failed or unaccepted child that can be resumed without changing lane identity. */
  recoveryChildCastId?: string;
  /** Last event already retained by the failed attempt; old events must not replay. */
  recoveryAfterSequence?: number;
  resumeChild?: boolean;
}

interface ActiveLane {
  workspace: ParallelWorkspaceRecord;
  childCastId: string;
  attempt: number;
  artifactIdentity: ParallelLaneArtifactIdentity;
  artifactPaths?: ParallelLaneArtifactPaths;
  subscription?: { unsubscribe(): void };
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
  #fanInPromise?: Promise<void>;
  #fanInRunId?: string;

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
      this.#fanInPromise = undefined;
      this.#fanInRunId = undefined;
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
      // A process/session restart can occur after jj materializes fan-in but
      // before the parent continuation starts. Rehydrate that barrier from
      // durable provenance rather than leaving the parent in running_parallel.
      if (existing.fanInProvenance && input.onFanIn && isFanInContinuationPhase(existing.phase) && isParallelLoopMember(input.state, input.loopId, input.socket.id)) {
        const result = boundParallelFanInResult({
          ...existing.fanInProvenance,
          satisfied: existing.fanInProvenance.outcome === "clean",
        });
        const continuation = applyParallelRunPhaseTransition(existing, {
          parentCastId: input.state.castId,
          loopId: input.loopId,
          runId: existing.runId,
          phase: result.satisfied ? "evaluating" : "resolving",
          fanInPhase: result.satisfied ? "accepted" : "conflict",
          timestamp: this.#now(),
        });
        if (continuation.applied) {
          replaceState(input.state, {
            ...input.state,
            parallelRuns: { ...(input.state.parallelRuns ?? {}), [input.loopId]: continuation.state },
          });
          this.#run = input.state.parallelRuns?.[input.loopId];
          this.#deps.state.saveCastState(input.pi, input.state);
        }
        await input.onFanIn({ loopId: input.loopId, runId: existing.runId, result });
        await this.#appendEvent(input.state, "parallel_fan_in_routed", {
          parentCastId: input.state.castId,
          loopId: input.loopId,
          runId: existing.runId,
          condition: result.satisfied ? "satisfied" : "not_satisfied",
          integrationRevision: result.integrationRevision,
          retainedLaneArtifacts: true,
          rehydrated: true,
        });
      }
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
      this.#fanInPromise = undefined;
      this.#fanInRunId = undefined;
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
    // Workspace and child-start failures terminalize lanes synchronously and
    // therefore do not produce a child terminal callback. Reconcile the
    // scheduler barrier after the initial pump so an all-failed fan-out skips
    // fan-in and fails the parent just like callback-driven completion does.
    await this.#maybeFanIn(input, input.state);
    return true;
  }

  /**
   * Validate a failed lane run without changing durable state. Revival is
   * intentionally strict: the normalized plan, loop config, baseline, lane
   * ownership, and accepted heads are all immutable recovery inputs.
   */
  async validateRevival(input: ParallelLoopReviveInput): Promise<ParallelLoopReviveResult> {
    const issues: ParallelRecoveryValidationIssue[] = [];
    try {
      validateDispatchConfig(input.config);
    } catch (error) {
      issues.push({ code: "config_unsupported", path: `loops.${input.loopId}.parallel`, message: boundedFailureReason(errorMessage(error)) });
    }
    const run = input.state.parallelRuns?.[input.loopId];
    if (!run) return { ok: false, issues: [{ code: "run_missing", path: `parallelRuns.${input.loopId}`, message: "no persisted parallel run exists for this loop" }] };
    if (!isParallelLaneRevivalCandidate(run)) {
      issues.push({ code: "not_lane_revivable", path: `parallelRuns.${input.loopId}`, message: "the run is not a failed all-terminal lane run with fan-in skipped" });
    }

    let plan: NormalizedParallelPlan | undefined;
    try {
      plan = readNormalizedPlan(input.state, input.config.planInput);
    } catch (error) {
      issues.push({ code: "plan_invalid", path: input.config.planInput, message: boundedFailureReason(errorMessage(error)) });
    }

    let baseline: ParallelWorkspaceRevision | undefined;
    try {
      baseline = (await this.#deps.workspaces.pinBaseline(input.state.cwd)).baseline;
    } catch (error) {
      issues.push({ code: "baseline_unavailable", path: "baseline", message: boundedFailureReason(errorMessage(error)) });
    }

    if (plan && baseline) {
      const result = validateParallelRecovery({
        parentCastId: input.state.castId,
        loopId: input.loopId,
        configHash: input.state.configHash,
        config: input.config,
        plan: plan as ParallelRecoveryPlan,
        baseline,
        run,
      });
      issues.push(...result.issues);
    }

    if (run && baseline) {
      await this.#validateRevivalReferences(input, run, issues);
    }
    return { ok: issues.length === 0, issues };
  }

  /**
   * Revive only failed/interrupted lanes of a terminal run. Accepted lanes
   * remain untouched, retain their heads/workspaces, and never consume a new
   * scheduler slot. Failed or unaccepted children are resumed when their
   * process/session is still observable; otherwise a fresh child attempt is
   * launched in the same owned workspace.
   */
  async revive(input: ParallelLoopReviveInput): Promise<boolean> {
    validateDispatchConfig(input.config);
    const validation = await this.validateRevival(input);
    if (!validation.ok) {
      throw new Error(`Parallel revival validation failed: ${validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
    }

    const originalRun = input.state.parallelRuns?.[input.loopId];
    if (!originalRun) throw new Error(`No parallel run exists for loop ${JSON.stringify(input.loopId)}.`);
    const plan = readNormalizedPlan(input.state, input.config.planInput);
    const baseline = await this.#deps.workspaces.pinBaseline(input.state.cwd);
    const workItems = readWorkItems(input.state);
    if (plan.workItemCount !== workItems.length) {
      throw new Error(`Parallel revival plan workItemCount ${plan.workItemCount} does not match state.workItems length ${workItems.length}.`);
    }

    const failedStreams = plan.streams.filter((stream) => {
      const lane = originalRun.lanes[stream.laneId];
      return lane?.status === "failed" || lane?.status === "interrupted";
    });
    // Compile only the streams being revived. Accepted lanes remain entirely
    // outside the child launch path, while the plan/config validation above
    // prevents a changed graph from being treated as the original run.
    const prepared: PreparedLane[] = [];
    for (const stream of failedStreams) {
      const compiled = compileLoopRegionToChildLoadout({
        pipeline: input.state.pipeline,
        loopId: input.loopId,
        workItems,
        workItemIndexes: stream.workItemIndexes,
        laneId: stream.laneId,
      });
      if (!compiled.ok) {
        throw new Error(`Unable to compile revived parallel lane ${JSON.stringify(stream.laneId)}: ${compiled.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
      }
      const lane = originalRun.lanes[stream.laneId]!;
      let resumeChild = false;
      let recoveryAfterSequence: number | undefined;
      if (lane.childCastId && lane.childSession) {
        const observation = await this.#deps.children.observe({ childCastId: lane.childCastId }).catch(() => undefined);
        if (observation) {
          resumeChild = true;
          recoveryAfterSequence = lane.lastEvent?.sequence ?? observation.events.at(-1)?.sequence ?? 0;
          this.#latestUsage.set(lane.childCastId, observation.snapshot.usage);
        }
      }
      prepared.push({
        stream,
        compiledLoadout: compiled.value,
        ...(resumeChild && lane.childCastId ? { recoveryChildCastId: lane.childCastId, resumeChild: true } : {}),
        ...(recoveryAfterSequence !== undefined ? { recoveryAfterSequence } : {}),
      });
    }

    let nextRun = originalRun;
    for (const preparedLane of prepared) {
      const lane = nextRun.lanes[preparedLane.stream.laneId]!;
      const restarted = restartParallelLaneAttempt(nextRun, {
        parentCastId: input.state.castId,
        loopId: input.loopId,
        runId: nextRun.runId,
        laneId: lane.laneId,
        attempt: lane.attempt,
        ...(lane.childCastId ? { childCastId: lane.childCastId } : {}),
        preserveChildSession: preparedLane.resumeChild === true,
        diagnostic: {
          code: "parallel_lane_revived",
          message: `Reviving lane ${lane.laneId} without rerunning accepted lanes or changing stream assignment.`,
          severity: "info",
          occurredAt: this.#now(),
        },
        timestamp: this.#now(),
      });
      if (!restarted.applied) throw new Error(`Unable to revive lane ${JSON.stringify(lane.laneId)}: ${restarted.reason ?? "invalid lane state"}.`);
      nextRun = restarted.state;
    }

    const state = input.state;
    this.#state = state;
    this.#input = {
      pi: input.pi,
      ctx: input.ctx,
      state,
      socket: {} as ResolvedMateriaSocket,
      loopId: input.loopId,
      config: input.config,
      ...(input.onFanIn ? { onFanIn: input.onFanIn } : {}),
      ...(input.onFailure ? { onFailure: input.onFailure } : {}),
    };
    this.#run = nextRun;
    this.#repositoryRoot = baseline.repositoryRoot;
    this.#prepared = prepared;
    this.#nextQueueIndex = 0;
    this.#active.clear();
    this.#eventTails.clear();
    this.#usageWriteTail = Promise.resolve();
    this.#budgetFailure = undefined;
    this.#fanInPromise = undefined;
    this.#fanInRunId = undefined;
    this.#cancelRequested = false;
    this.#cancelPromise = undefined;
    this.#cancelCastId = undefined;

    replaceState(state, {
      ...state,
      active: true,
      phase: state.currentSocketId ?? state.phase,
      awaitingResponse: false,
      socketState: "running_parallel",
      failedReason: undefined,
      recoveryExhaustion: undefined,
      runState: { ...state.runState, endedAt: undefined, currentSocketId: state.currentSocketId ?? state.runState.currentSocketId, lastMessage: `Reviving parallel lanes for ${input.loopId}.` },
      parallelRuns: { ...(state.parallelRuns ?? {}), [input.loopId]: nextRun },
    });
    this.#deps.state.saveCastState(input.pi, state);
    await this.#appendEvent(state, "parallel_revive_started", {
      parentCastId: state.castId,
      loopId: input.loopId,
      runId: nextRun.runId,
      planId: nextRun.planIdentity.planId,
      revivedLaneIds: prepared.map((lane) => lane.stream.laneId),
      preservedLaneIds: nextRun.queueOrder.filter((laneId) => nextRun.lanes[laneId]?.status === "accepted"),
      baseline: nextRun.baseline,
    });
    await input.onPrepared?.();
    await this.#pump();
    // A revived lane can fail while its workspace is being recreated or its
    // child is being started. Those terminal failures have no child callback
    // to release the final scheduling barrier, so reconcile it explicitly.
    await this.#maybeFanIn(this.#input, state);
    return true;
  }

  /** Return the run currently owned by this dispatcher, if any. */
  get run(): MateriaParallelRunState | undefined {
    return this.#run;
  }

  /**
   * Apply the explicit post-integration evaluation/VCS boundary.
   *
   * The workspace adapter owns jj mutation and cleanup; this method only
   * supplies durable provenance and records the guarded result in cast state.
   * A rejected evaluation is retained as a retryable preserved result.
   */
  async finalize(input: ParallelLoopFinalizationInput): Promise<boolean> {
    const run = input.state.parallelRuns?.[input.loopId] ?? (this.#run?.loopId === input.loopId ? this.#run : undefined);
    if (!run) throw new Error(`No parallel run exists for loop ${JSON.stringify(input.loopId)}.`);
    if (!run.fanInProvenance) throw new Error(`Parallel run ${JSON.stringify(run.runId)} has no fan-in provenance to finalize.`);
    const finalize = this.#deps.workspaces.finalize;
    if (!finalize) throw new Error("No jj parallel finalization backend is configured.");
    const result = await finalize({
      parentCastId: input.state.castId,
      loopId: input.loopId,
      runId: run.runId,
      cwd: input.state.cwd,
      repositoryRoot: this.#repositoryRoot ?? input.state.cwd,
      fanIn: run.fanInProvenance,
      evaluationAccepted: input.evaluationAccepted,
      bookmarkName: input.bookmarkName,
      ...(input.description !== undefined ? { description: input.description } : {}),
    });
    const { satisfied: _satisfied, ...resultProvenance } = result;
    const provenance: MateriaParallelFinalizationProvenance = resultProvenance;
    const applied = applyParallelFinalizationToCastState(input.state, {
      parentCastId: input.state.castId,
      loopId: input.loopId,
      runId: run.runId,
      provenance,
      timestamp: result.finalizedAt,
    });
    if (applied.applied) {
      replaceState(input.state, applied.state);
      this.#run = input.state.parallelRuns?.[input.loopId];
      this.#deps.state.saveCastState(input.pi, input.state);
    }
    await this.#appendEvent(input.state, result.satisfied ? "parallel_finalized" : "parallel_finalization_preserved", {
      parentCastId: input.state.castId,
      loopId: input.loopId,
      runId: run.runId,
      satisfied: result.satisfied,
      integrationRevision: result.integrationRevision,
      bookmarkName: result.bookmarkName,
      parentWorkingRevision: result.parentWorkingRevision,
      cleanedLaneIds: result.cleanedLaneIds,
      reason: result.reason,
    });
    return result.satisfied;
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

  async #validateRevivalReferences(
    input: ParallelLoopReviveInput,
    run: MateriaParallelRunState,
    issues: ParallelRecoveryValidationIssue[],
  ): Promise<void> {
    if (!run.lanes || typeof run.lanes !== "object" || Array.isArray(run.lanes)) {
      issues.push({ code: "lanes_invalid", path: "lanes", message: "the persisted parallel lanes record is invalid" });
      return;
    }
    for (const lane of Object.values(run.lanes)) {
      if (lane.workspace && this.#deps.workspaces.inspect) {
        const inspected = await this.#deps.workspaces.inspect({
          workspacePath: lane.workspace.workspacePath,
          workspaceRoot: lane.workspace.workspaceRoot,
          workspaceName: lane.workspace.workspaceName,
        }).catch((error) => {
          issues.push({ code: "workspace_inspection_failed", path: `lanes.${lane.laneId}.workspace`, laneId: lane.laneId, message: boundedFailureReason(errorMessage(error)) });
          return undefined;
        });
        if (!inspected) {
          issues.push({ code: "workspace_missing", path: `lanes.${lane.laneId}.workspace`, laneId: lane.laneId, message: "owned lane workspace could not be inspected" });
        } else {
          const workspacePath = `lanes.${lane.laneId}.workspace`;
          if (inspected.exists === false) {
            issues.push({ code: "workspace_missing", path: workspacePath, laneId: lane.laneId, message: "owned lane workspace directory no longer exists" });
          }
          if (inspected.tracked === false) {
            issues.push({ code: "workspace_untracked", path: workspacePath, laneId: lane.laneId, message: "owned lane workspace is no longer tracked by jj" });
          }
          // Accepted lanes are preserved inputs to the next fan-in. Their
          // recorded head is only trustworthy when the owned workspace still
          // points at that exact revision; an altered or missing current head
          // must stop revival before any failed lane is relaunched.
          if (lane.status === "accepted" && lane.acceptedHead) {
            if (!inspected.currentRevision) {
              issues.push({ code: "accepted_head_unverified", path: `${workspacePath}.currentRevision`, laneId: lane.laneId, message: "accepted lane workspace has no verifiable current revision" });
            } else if (!sameRevisionIdentity(inspected.currentRevision, lane.acceptedHead)) {
              issues.push({ code: "accepted_head_drift", path: `${workspacePath}.currentRevision`, laneId: lane.laneId, message: `accepted lane workspace revision ${formatRevision(inspected.currentRevision)} differs from recorded accepted head ${formatRevision(lane.acceptedHead)}` });
            }
          }
        }
      }

      if (!lane.childCastId) continue;
      const observation = await this.#deps.children.observe({ childCastId: lane.childCastId }).catch(() => undefined);
      // A failed child may be restarted from its durable launch/session paths
      // after a parent process restart. Accepted lanes still retain their
      // identity structurally and are never relaunched here.
      if (!observation) continue;
      const identity = observation.snapshot.identity;
      if (identity.childCastId !== lane.childCastId || identity.parentCastId !== input.state.castId || identity.loopId !== input.loopId || identity.laneId !== lane.laneId) {
        issues.push({ code: "child_identity_mismatch", path: `lanes.${lane.laneId}.childSession`, laneId: lane.laneId, message: "observed child session identity does not match the persisted lane" });
      }
      if (lane.status === "accepted" && (!observation.snapshot.terminalResult || !observation.snapshot.accepted)) {
        issues.push({ code: "accepted_child_unverified", path: `lanes.${lane.laneId}.childSession`, laneId: lane.laneId, message: "accepted lane child session is not terminal and accepted" });
      }
      if ((lane.status === "failed" || lane.status === "interrupted") && (observation.snapshot.status === "running" || observation.snapshot.status === "starting" || observation.snapshot.status === "queued")) {
        issues.push({ code: "child_not_terminal", path: `lanes.${lane.laneId}.childSession`, laneId: lane.laneId, message: "failed/interrupted lane child session is still active" });
      }
      // A clean child exit without an explicit accepted terminal result is
      // represented as succeeded/accepted=false by the runner. The parent
      // already records that lane as failed, so this is a recoverable attempt,
      // not an accepted head. Only an actually accepted child is unsafe to
      // revive here.
      if ((lane.status === "failed" || lane.status === "interrupted") && observation.snapshot.status === "succeeded" && observation.snapshot.accepted) {
        issues.push({ code: "child_terminal_mismatch", path: `lanes.${lane.laneId}.childSession`, laneId: lane.laneId, message: "failed/interrupted lane child session is already succeeded and accepted and cannot be safely revived" });
      }
    }
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
    for (const active of initiallyActive) active.subscription?.unsubscribe();
    for (const active of remainingActive) active.subscription?.unsubscribe();
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
    const childCastId = prepared.recoveryChildCastId ?? childCastIdentity(state.castId, input.loopId, prepared.stream.laneId, attempt);
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
      if (prepared.resumeChild) {
        await this.#deps.children.resume({ childCastId, mode: "resume" });
      } else {
        await this.#deps.children.start(startInput);
      }
      if (this.#cancelRequested) {
        // Cancellation may have raced with start(). Keep the active record so
        // the coordinator can observe telemetry and persist its workspace.
        await this.#abortChild(childCastId, "parallel execution cancelled");
        return;
      }
      active.subscription = this.#deps.children.subscribe({ childCastId, afterSequence: prepared.recoveryAfterSequence }, {
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
    active.subscription?.unsubscribe();

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
    await this.#maybeFanIn(input, state);
  }

  async #maybeFanIn(input: ParallelLoopDispatchInput, state: MateriaCastState): Promise<void> {
    const run = this.#run;
    if (!run || this.#active.size > 0 || this.#nextQueueIndex < this.#prepared.length) return;
    if (this.#fanInPromise && this.#fanInRunId === run.runId) return this.#fanInPromise;
    if (!Object.values(run.lanes).every((lane) => isTerminalLaneStatus(lane.status))) return;

    const task = this.#performFanIn(input, state, run);
    this.#fanInPromise = task;
    this.#fanInRunId = run.runId;
    try {
      await task;
    } finally {
      if (this.#fanInPromise === task) this.#fanInPromise = undefined;
    }
  }

  async #performFanIn(input: ParallelLoopDispatchInput, state: MateriaCastState, run: MateriaParallelRunState): Promise<void> {
    const nonAccepted = Object.values(run.lanes).filter((lane) => lane.status !== "accepted");
    if (nonAccepted.length > 0) {
      const occurredAt = this.#now();
      const phase = applyParallelRunPhaseTransition(run, {
        parentCastId: state.castId,
        loopId: input.loopId,
        runId: run.runId,
        phase: "failed",
        fanInPhase: "skipped",
        timestamp: occurredAt,
      });
      const aggregate = aggregateParallelLaneFailureReason(run);
      const diagnostic = {
        code: "parallel_lanes_unaccepted",
        message: aggregate,
        severity: "error" as const,
        occurredAt,
        details: {
          failedLaneIds: nonAccepted.filter((lane) => lane.status === "failed").map((lane) => lane.laneId),
          interruptedLaneIds: nonAccepted.filter((lane) => lane.status === "interrupted").map((lane) => lane.laneId),
          preservedAcceptedLaneIds: Object.values(run.lanes).filter((lane) => lane.status === "accepted").map((lane) => lane.laneId),
        },
      };
      if (phase.applied) {
        const next = { ...phase.state, diagnostics: [...phase.state.diagnostics, diagnostic].slice(-64) };
        replaceState(state, { ...state, parallelRuns: { ...(state.parallelRuns ?? {}), [input.loopId]: next } });
        this.#run = state.parallelRuns?.[input.loopId];
        this.#deps.state.saveCastState(input.pi, state);
      }
      await this.#appendEvent(state, "parallel_fan_in_skipped", {
        parentCastId: state.castId,
        loopId: input.loopId,
        runId: run.runId,
        reason: "not_all_lanes_accepted",
        aggregateFailure: aggregate,
        laneStatuses: Object.fromEntries(Object.entries(run.lanes).map(([laneId, lane]) => [laneId, lane.status])),
      });
      await this.#notifyRunFailure(input, state, run.runId, aggregate);
      return;
    }

    const fanIn = this.#deps.workspaces.fanIn;
    if (!fanIn) {
      const diagnostic = {
        code: "parallel_fan_in_unavailable",
        message: "No jj fan-in backend is configured for this parallel run.",
        severity: "error" as const,
        occurredAt: this.#now(),
      };
      const phase = applyParallelRunPhaseTransition(run, {
        parentCastId: state.castId,
        loopId: input.loopId,
        runId: run.runId,
        phase: "failed",
        fanInPhase: "failed",
        timestamp: diagnostic.occurredAt,
      });
      if (phase.applied) {
        const next = { ...phase.state, diagnostics: [...phase.state.diagnostics, diagnostic].slice(-64) };
        replaceState(state, { ...state, parallelRuns: { ...(state.parallelRuns ?? {}), [input.loopId]: next } });
        this.#run = state.parallelRuns?.[input.loopId];
        this.#deps.state.saveCastState(input.pi, state);
      }
      await this.#appendEvent(state, "parallel_fan_in_failed", { parentCastId: state.castId, loopId: input.loopId, runId: run.runId, error: diagnostic.message });
      await this.#notifyRunFailure(input, state, run.runId, diagnostic.message);
      return;
    }

    const ready = applyParallelRunPhaseTransition(run, {
      parentCastId: state.castId,
      loopId: input.loopId,
      runId: run.runId,
      phase: "fan_in",
      fanInPhase: "running",
      timestamp: this.#now(),
    });
    if (ready.applied) {
      replaceState(state, { ...state, parallelRuns: { ...(state.parallelRuns ?? {}), [input.loopId]: ready.state } });
      this.#run = state.parallelRuns?.[input.loopId];
      this.#deps.state.saveCastState(input.pi, state);
    }

    try {
      const rawResult = await fanIn({
        parentCastId: state.castId,
        loopId: input.loopId,
        runId: run.runId,
        cwd: state.cwd,
        repositoryRoot: this.#repositoryRoot ?? state.cwd,
        baseline: run.baseline,
        queueOrder: run.queueOrder,
        lanes: run.queueOrder.map((laneId, queueIndex) => {
          const lane = run.lanes[laneId]!;
          return {
            laneId,
            streamIndex: lane.streamIndex,
            queueIndex,
            workItemIndexes: [...lane.workItemIndexes],
            status: lane.status,
            acceptedHead: lane.acceptedHead,
            workspace: lane.workspace,
          };
        }),
      });
      const result = boundParallelFanInResult(rawResult);
      const finalPhase = applyParallelRunPhaseTransition(this.#run ?? run, {
        parentCastId: state.castId,
        loopId: input.loopId,
        runId: run.runId,
        // A conflict is still in the coordinator's conflict phase until the
        // parent continuation is handed to the configured resolver. Keeping
        // the intermediate phase durable makes a crash at the barrier
        // distinguishable from a resolver attempt.
        phase: result.outcome === "conflict"
          ? (input.onFanIn ? "resolving" : "conflict")
          : "evaluating",
        fanInPhase: result.outcome === "conflict" ? "conflict" : "accepted",
        timestamp: result.completedAt,
      });
      if (finalPhase.applied) {
        replaceState(state, { ...state, parallelRuns: { ...(state.parallelRuns ?? {}), [input.loopId]: finalPhase.state } });
        this.#run = state.parallelRuns?.[input.loopId];
      }
      const provenance = applyParallelFanInProvenanceToCastState(state, {
        parentCastId: state.castId,
        loopId: input.loopId,
        runId: run.runId,
        provenance: result,
        timestamp: result.completedAt,
      });
      if (provenance.applied) replaceState(state, provenance.state);
      this.#run = state.parallelRuns?.[input.loopId];
      this.#deps.state.saveCastState(input.pi, state);
      try {
        await this.#deps.artifacts?.fanIn?.write({ artifactRoot: state.artifactRoot, provenance: result, satisfied: result.satisfied });
      } catch {
        // Fan-in state is durable even when the optional convenience artifact fails.
      }
      await this.#appendEvent(state, result.outcome === "conflict" ? "parallel_fan_in_conflict" : "parallel_fan_in_clean", {
        parentCastId: state.castId,
        loopId: input.loopId,
        runId: run.runId,
        orderedHeads: result.orderedHeads,
        integrationRevision: result.integrationRevision,
        conflictedPaths: result.conflictedPaths,
        conflictDetails: result.conflictDetails,
        operationId: result.operationId,
      });
      if (input.onFanIn) {
        await input.onFanIn({ loopId: input.loopId, runId: run.runId, result });
        await this.#appendEvent(state, "parallel_fan_in_routed", {
          parentCastId: state.castId,
          loopId: input.loopId,
          runId: run.runId,
          condition: result.satisfied ? "satisfied" : "not_satisfied",
          integrationRevision: result.integrationRevision,
          retainedLaneArtifacts: true,
        });
      }
    } catch (error) {
      const message = boundedFailureReason(errorMessage(error));
      const failed = applyParallelRunPhaseTransition(this.#run ?? run, {
        parentCastId: state.castId,
        loopId: input.loopId,
        runId: run.runId,
        phase: "failed",
        fanInPhase: "failed",
        timestamp: this.#now(),
      });
      if (failed.applied) {
        const next = { ...failed.state, diagnostics: [...failed.state.diagnostics, { code: "parallel_fan_in_failed", message, severity: "error" as const, occurredAt: this.#now() }].slice(-64) };
        replaceState(state, { ...state, parallelRuns: { ...(state.parallelRuns ?? {}), [input.loopId]: next } });
        this.#run = state.parallelRuns?.[input.loopId];
        this.#deps.state.saveCastState(input.pi, state);
      }
      await this.#appendEvent(state, "parallel_fan_in_failed", { parentCastId: state.castId, loopId: input.loopId, runId: run.runId, error: message });
      await this.#notifyRunFailure(input, state, run.runId, message);
    }
  }

  async #notifyRunFailure(input: ParallelLoopDispatchInput, state: MateriaCastState, runId: string, reason: string): Promise<void> {
    const boundedReason = boundedFailureReason(reason);
    if (!input.onFailure) {
      // Embedders may omit the lifecycle callback, but a terminal lane run
      // must still leave the parent durably failed rather than appearing live.
      state.active = false;
      state.awaitingResponse = false;
      state.socketState = "failed";
      state.phase = "failed";
      state.failedReason = boundedReason;
      state.runState.lastMessage = boundedReason;
      state.runState.endedAt ??= this.#now();
      this.#deps.state.saveCastState(input.pi, state);
      return;
    }
    try {
      await input.onFailure({ loopId: input.loopId, runId, reason: boundedReason });
    } catch (error) {
      await this.#appendEvent(state, "parallel_parent_failure_callback_failed", {
        parentCastId: state.castId,
        loopId: input.loopId,
        runId,
        error: boundedFailureReason(errorMessage(error)),
      });
    }
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
    if (append && state.runState) {
      try {
        await append(state.runState, type, data);
      } catch {
        // Parent artifact failures must not stop a child lane or corrupt state.
      }
    }
    const emit = this.#deps.runtimeEvents?.emit;
    if (!emit) return;
    try {
      await emit(state, type, isRecord(data) ? data : { value: data });
    } catch {
      // Runtime monitor delivery is best effort; durable state and artifacts
      // remain authoritative when eventing is disabled or unavailable.
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

function sameRevisionIdentity(
  left: ParallelWorkspaceRevision | undefined,
  right: ParallelWorkspaceRevision | undefined,
): boolean {
  return Boolean(left && right && left.commitId === right.commitId && left.changeId === right.changeId);
}

function formatRevision(revision: ParallelWorkspaceRevision): string {
  return `${revision.commitId}/${revision.changeId}`;
}

function aggregateParallelLaneFailureReason(run: MateriaParallelRunState): string {
  const failures = Object.values(run.lanes)
    .filter((lane) => lane.status === "failed" || lane.status === "interrupted")
    .sort((left, right) => left.queueIndex - right.queueIndex)
    .map((lane) => `${lane.laneId} (${lane.status}: ${lane.failureReason ?? lane.diagnostics.at(-1)?.message ?? "no diagnostic"})`);
  const accepted = Object.values(run.lanes)
    .filter((lane) => lane.status === "accepted")
    .sort((left, right) => left.queueIndex - right.queueIndex)
    .map((lane) => lane.laneId);
  const suffix = failures.length > 0 ? ` Lane diagnostics: ${failures.join("; ")}.` : "";
  const preserved = accepted.length > 0 ? ` Preserved accepted lane heads: ${accepted.join(", ")}.` : "";
  return boundedFailureReason(`Parallel run ${run.runId} hard-failed: fan-in skipped because not every lane was accepted.${suffix}${preserved}`);
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

function isFanInContinuationPhase(phase: MateriaParallelRunState["phase"]): boolean {
  return phase === "conflict" || phase === "resolving" || phase === "evaluating";
}

function isParallelLoopMember(state: MateriaCastState, loopId: string, socketId: string): boolean {
  const members = state.pipeline.loops?.[loopId]?.sockets;
  return Array.isArray(members) && members.includes(socketId);
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

