import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import path from "node:path";
import { collectAcceptedParallelBranches, type IntrinsicParallelFanInResult } from "../domain/parallelFanIn.js";
import { deriveNominalParallelLaneProgress } from "../domain/parallelProgress.js";
import { parallelBranchRegionForEntry } from "../graph/parallelRegions.js";
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
import { cloneExecutionScope, cloneParallelBranchExecutionScope, createBaseExecutionScope } from "../domain/executionScope.js";
import { compileLoopRegionToChildLoadout, type CompiledLoopChildLoadout } from "../graph/loopCompiler.js";
import {
  applyParallelRunPhaseTransition,
  applyParallelTransitionToCastState,
  attachParallelRunToCastState,
  createParallelRunState,
  restartParallelLaneAttempt,
} from "./parallelCoordinatorState.js";
import type {
  MateriaCastState,
  MateriaParallelLaneState,
  MateriaParallelRunState,
  MateriaParallelUsageTotals,
  ResolvedMateriaSocket,
} from "../types.js";
import {
  boundedParallelContext,
  childCastIdentity,
  isParallelUsage,
  lanePaths,
  parallelErrorMessage,
  readNormalizedParallelPlan,
  readParallelWorkItems,
  replaceParallelState,
  type NormalizedParallelPlan,
  type NormalizedParallelStream,
} from "./parallelDispatchSupport.js";

export type {
  ParallelLaneArtifactIdentity,
  ParallelLaneArtifactPaths,
  ParallelLaneArtifactPort,
  ParallelLaneDiagnosticArtifact,
  ParallelLaneEventArtifact,
} from "../application/parallelArtifacts.js";
export type { NormalizedParallelPlan, NormalizedParallelStream } from "./parallelDispatchSupport.js";

export interface ParallelFanInCompletionInput {
  loopId: string;
  runId: string;
  result: IntrinsicParallelFanInResult;
}

export interface ParallelRunFailureInput { loopId: string; runId: string; reason: string }
export interface EffectiveParallelConcurrencyConfig { maxConcurrency: number }

export interface ParallelLoopDispatchInput {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  state: MateriaCastState;
  socket: ResolvedMateriaSocket;
  loopId: string;
  config: EffectiveParallelConcurrencyConfig;
  onFanIn?: (input: ParallelFanInCompletionInput) => Promise<void>;
  onFailure?: (input: ParallelRunFailureInput) => Promise<void>;
}

export interface ParallelLoopCancellationInput {
  pi: ExtensionAPI;
  ctx?: ExtensionContext;
  state: MateriaCastState;
  loopId?: string;
  reason?: string;
}

export interface ParallelLoopReviveInput extends Omit<ParallelLoopDispatchInput, "socket"> {
  onPrepared?: () => Promise<void>;
}

export interface ParallelLoopReviveResult {
  ok: boolean;
  issues: readonly { code: string; path: string; message: string; laneId?: string }[];
}

export interface ParallelLoopDispatcherDependencies {
  children: ChildCastRunnerPort;
  state: { saveCastState(pi: ExtensionAPI, state: MateriaCastState): void };
  artifacts?: {
    appendEvent(runState: MateriaCastState["runState"], type: string, data: unknown): Promise<void>;
    writeUsage?(runState: MateriaCastState["runState"]): Promise<void>;
    lane?: ParallelLaneArtifactPort;
  };
  runtimeEvents?: { emit(state: MateriaCastState, type: string, payload: Record<string, unknown>): Promise<void> };
  budget?: { assertBudget?(state: MateriaCastState, ctx: ExtensionContext): Promise<void> };
  onBudgetExceeded?(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, error: unknown, entryId: string): Promise<void>;
  /** Mount presentation for a newly owned coordinator run. */
  onProgressStart?(ctx: ExtensionContext, run: MateriaParallelRunState): void;
  /** Best-effort redraw request after an observable lane progress/status change. */
  onProgressChange?(run: MateriaParallelRunState): void;
  now?: () => number;
}

interface PreparedLane {
  stream: NormalizedParallelStream;
  compiledLoadout: CompiledLoopChildLoadout;
  recoveryChildCastId?: string;
  recoveryAfterSequence?: number;
  recoveryScope?: MateriaParallelLaneState["executionScope"];
  resumeChild?: boolean;
}

interface ActiveLane {
  childCastId: string;
  attempt: number;
  /** Identifies the dispatcher run that installed this callback. */
  generation: number;
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

/** Workspace-neutral bounded fan-out coordinator. Repository behavior belongs in utilities. */
export class ParallelLoopDispatcher {
  readonly #deps: ParallelLoopDispatcherDependencies;
  readonly #now: () => number;
  #state?: MateriaCastState;
  #input?: ParallelLoopDispatchInput;
  #run?: MateriaParallelRunState;
  #prepared: PreparedLane[] = [];
  #nextQueueIndex = 0;
  #active = new Map<string, ActiveLane>();
  /** Queue entries reserved for launch setup but not yet counted as active lanes. */
  #reserved = new Set<string>();
  /** Children whose durable running transition is installed but whose start has not returned. */
  #starting = new Map<string, { childCastId: string; generation: number }>();
  /** Launch tasks remain tracked through lane-local lifecycle I/O without occupying a slot. */
  #launching = new Map<string, Promise<void>>();
  #slotWaiters = new Set<() => void>();
  #pumpTail: Promise<void> = Promise.resolve();
  #eventTails = new Map<string, Promise<void>>();
  #latestUsage = new Map<string, MateriaParallelUsageTotals>();
  #usageWriteTail: Promise<void> = Promise.resolve();
  #budgetFailure?: Error;
  #cancelRequested = false;
  #cancelPromise?: Promise<void>;
  #cancelCastId?: string;
  #initialization?: DispatchInitialization;
  #terminalPromise?: Promise<void>;
  #terminalTail: Promise<void> = Promise.resolve();
  #generation = 0;

  constructor(deps: ParallelLoopDispatcherDependencies) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
  }

  get run(): MateriaParallelRunState | undefined { return this.#run; }

  async dispatch(input: ParallelLoopDispatchInput): Promise<boolean> {
    validateDispatchConfig(input.config);
    this.#resetForDifferentCast(input.state.castId);
    this.#state = input.state;
    this.#input = input;
    const existing = input.state.parallelRuns?.[input.loopId];
    if (existing) { this.#run = existing; return true; }

    const pending = this.#initialization;
    if (pending?.castId === input.state.castId && pending.loopId === input.loopId) {
      await pending.promise;
      return true;
    }
    const initialization = this.#beginInitialization(input);
    let interrupted = false;
    try {
      await this.#deps.budget?.assertBudget?.(input.state, input.ctx);
      const plan = readNormalizedParallelPlan(input.state, "state.parallelPlan");
      const workItems = readParallelWorkItems(input.state);
      if (plan.workItemCount !== workItems.length) throw new Error(`Parallel loop ${JSON.stringify(input.loopId)} plan workItemCount ${plan.workItemCount} does not match state.workItems length ${workItems.length}.`);
      const prepared = compileStreams(input, plan, workItems);
      const run = createParallelRunState({
        parentCastId: input.state.castId,
        loopId: input.loopId,
        planIdentity: { version: plan.version, planId: plan.planId, workItemCount: plan.workItemCount },
        graphIdentity: { graphHash: parallelGraphHash(prepared) },
        configIdentity: { configHash: input.state.configHash, loopId: input.loopId, maxConcurrency: input.config.maxConcurrency },
        queue: plan.streams.map((stream) => {
          const compiled = prepared.find((candidate) => candidate.stream.laneId === stream.laneId)!;
          return {
            laneId: stream.laneId,
            name: stream.name,
            streamIndex: stream.streamIndex,
            workItemIndexes: [...stream.workItemIndexes],
            progressTotal: nominalProgressTotal(compiled.compiledLoadout),
          };
        }),
        now: this.#now(),
      });
      const baseScope = input.state.baseScope ?? createBaseExecutionScope(input.state.castId, input.state.cwd);
      for (const laneId of run.queueOrder) {
        const scope = cloneParallelBranchExecutionScope(baseScope, input.loopId, laneId);
        run.lanes[laneId]!.executionScope = scope;
        input.state.branchScopes = { ...(input.state.branchScopes ?? {}), [scope.id]: cloneExecutionScope(scope) };
      }
      this.#generation += 1;
      this.#run = run;
      this.#prepared = prepared;
      this.#nextQueueIndex = 0;
      this.#active.clear();
      this.#reserved.clear();
      this.#starting.clear();
      this.#launching.clear();
      this.#eventTails.clear();
      this.#latestUsage.clear();
      this.#budgetFailure = undefined;
      this.#terminalPromise = undefined;
      replaceParallelState(input.state, attachParallelRunToCastState(input.state, run));
      this.#deps.state.saveCastState(input.pi, input.state);
      try { this.#deps.onProgressStart?.(input.ctx, run); } catch { /* presentation is best effort */ }
      await this.#appendEvent(input.state, "parallel_dispatch_started", {
        parentCastId: input.state.castId,
        loopId: input.loopId,
        runId: run.runId,
        planId: plan.planId,
        baseScopeId: (input.state.baseScope ?? createBaseExecutionScope(input.state.castId, input.state.cwd)).id,
        queueOrder: run.queueOrder,
        maxConcurrency: run.maxConcurrency,
      });
      if (run.queueOrder.length > 0) {
        notifyParallelUser(input.ctx, `pi-materia parallel loop "${input.loopId}" started: ${run.queueOrder.length} lane${run.queueOrder.length === 1 ? "" : "s"} queued (up to ${run.maxConcurrency} concurrent). The parent will continue automatically at the barrier; no /materia continue is needed.`, "info");
      }
    } catch (error) {
      if (!this.#cancelRequested) throw error;
      interrupted = true;
    } finally {
      this.#finishInitialization(initialization);
    }
    if (interrupted || this.#cancelRequested || this.#prepared.length === 0) return true;
    await this.#pump();
    await this.#maybeAllTerminal(input, input.state);
    return true;
  }

  async validateRevival(input: ParallelLoopReviveInput): Promise<ParallelLoopReviveResult> {
    const issues: Array<{ code: string; path: string; message: string; laneId?: string }> = [];
    try { validateDispatchConfig(input.config); } catch (error) {
      issues.push({ code: "config_unsupported", path: `loops.${input.loopId}.parallel`, message: boundedFailureReason(parallelErrorMessage(error)) });
    }
    const run = input.state.parallelRuns?.[input.loopId];
    if (!run) return { ok: false, issues: [{ code: "run_missing", path: `parallelRuns.${input.loopId}`, message: "no persisted parallel run exists for this loop" }] };
    let plan: NormalizedParallelPlan | undefined;
    try { plan = readNormalizedParallelPlan(input.state, "state.parallelPlan"); }
    catch (error) { issues.push({ code: "plan_invalid", path: "state.parallelPlan", message: boundedFailureReason(parallelErrorMessage(error)) }); }
    if (run.parentCastId !== input.state.castId) issues.push({ code: "cast_mismatch", path: "run.parentCastId", message: "persisted run belongs to another cast" });
    if (run.loopId !== input.loopId || run.configIdentity.loopId !== input.loopId) issues.push({ code: "loop_mismatch", path: "run.loopId", message: "persisted run belongs to another loop" });
    if (run.phase !== "failed" || run.fanInPhase !== "skipped") issues.push({ code: "run_not_revivable", path: "run.phase", message: "only failed branch work whose barrier was skipped can be revived" });
    if (run.configIdentity.configHash !== input.state.configHash || run.maxConcurrency !== input.config.maxConcurrency) issues.push({ code: "config_mismatch", path: "run.configIdentity", message: "parallel configuration changed" });
    if (plan && (run.planIdentity.planId !== plan.planId || run.planIdentity.version !== plan.version || run.planIdentity.workItemCount !== plan.workItemCount)) issues.push({ code: "plan_mismatch", path: "run.planIdentity", message: "normalized parallel plan changed" });
    let prepared: PreparedLane[] | undefined;
    if (plan) {
      try {
        const workItems = readParallelWorkItems(input.state);
        if (workItems.length !== plan.workItemCount) throw new Error("work-item count differs from the immutable plan");
        prepared = compileStreams(input as ParallelLoopDispatchInput, plan, workItems);
        if (!run.graphIdentity?.graphHash || run.graphIdentity.graphHash !== parallelGraphHash(prepared)) issues.push({ code: "graph_drift", path: "run.graphIdentity", message: "compiled parallel branch graph changed" });
      } catch (error) {
        issues.push({ code: "graph_invalid", path: "state.pipeline", message: boundedFailureReason(parallelErrorMessage(error)) });
      }
    }
    const plannedLaneIds = plan?.streams.map((stream) => stream.laneId) ?? [];
    if (!sameStrings(run.queueOrder, plannedLaneIds)) issues.push({ code: "branch_order_drift", path: "run.queueOrder", message: "persisted branches no longer exactly match normalized stream order" });
    for (const [queueIndex, laneId] of run.queueOrder.entries()) {
      const lane = run.lanes[laneId];
      const stream = plan?.streams[queueIndex];
      if (!lane || !stream || lane.laneId !== laneId || lane.queueIndex !== queueIndex || lane.name !== stream.name || lane.streamIndex !== stream.streamIndex || !sameNumbers(lane.workItemIndexes, stream.workItemIndexes)) {
        issues.push({ code: "branch_drift", path: `lanes.${laneId}`, laneId, message: "persisted branch identity or stream membership changed" });
        continue;
      }
      const expectedBranchId = `${run.runId}:branch:${encodeURIComponent(laneId)}`;
      if (lane.branchId !== expectedBranchId) issues.push({ code: "branch_identity_drift", path: `lanes.${laneId}.branchId`, laneId, message: "persisted branch identity changed" });
      if (lane.status !== "accepted" && lane.status !== "failed" && lane.status !== "interrupted") issues.push({ code: "lane_not_terminal", path: `lanes.${laneId}.status`, laneId, message: "revival only restarts failed or interrupted terminal branches" });
      if (!lane.executionScope) issues.push({ code: "scope_missing", path: `lanes.${laneId}.executionScope`, laneId, message: "branch has no persisted execution scope" });
      else {
        const persistedScope = input.state.branchScopes?.[lane.executionScope.id];
        if (!persistedScope || !sameJson(persistedScope, lane.executionScope)) issues.push({ code: "scope_drift", path: `lanes.${laneId}.executionScope`, laneId, message: "persisted execution scope differs from the cast branch scope snapshot" });
      }
      const preparedLane = prepared?.find((candidate) => candidate.stream.laneId === laneId);
      if ((lane.status === "failed" || lane.status === "interrupted") && lane.childCastId && lane.childSession && preparedLane) {
        const observation = await this.#deps.children.observe({ childCastId: lane.childCastId }).catch(() => undefined);
        if (observation) {
          try { assertRecoverySnapshot(run, lane, preparedLane, observation.snapshot); }
          catch (error) { issues.push({ code: "child_session_drift", path: `lanes.${laneId}.childSession`, laneId, message: boundedFailureReason(parallelErrorMessage(error)) }); }
        }
      }
    }
    for (const laneId of Object.keys(run.lanes)) if (!run.queueOrder.includes(laneId)) issues.push({ code: "unexpected_branch", path: `lanes.${laneId}`, laneId, message: "persisted run contains a branch outside the immutable plan" });
    return { ok: issues.length === 0, issues };
  }

  async revive(input: ParallelLoopReviveInput): Promise<boolean> {
    const validation = await this.validateRevival(input);
    if (!validation.ok) throw new Error(`Parallel revival validation failed: ${validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
    const original = input.state.parallelRuns?.[input.loopId]!;
    const plan = readNormalizedParallelPlan(input.state, "state.parallelPlan");
    const workItems = readParallelWorkItems(input.state);
    const failed = plan.streams.filter((stream) => {
      const status = original.lanes[stream.laneId]?.status;
      return status === "failed" || status === "interrupted";
    });
    const allCompiled = compileStreams(input as ParallelLoopDispatchInput, { ...plan, streams: failed }, workItems);
    let next = original;
    for (const prepared of allCompiled) {
      const lane = next.lanes[prepared.stream.laneId]!;
      if (lane.childCastId && lane.childSession) {
        const observation = await this.#deps.children.observe({ childCastId: lane.childCastId }).catch(() => undefined);
        if (observation) {
          assertRecoverySnapshot(original, lane, prepared, observation.snapshot);
          prepared.recoveryChildCastId = lane.childCastId;
          prepared.recoveryScope = cloneExecutionScope(observation.snapshot.executionScope);
          prepared.resumeChild = true;
          // Resume from the last *durable* watermark. A newer observed tail may
          // have existed only in the crashed coordinator's memory and must not
          // cause retained usage checkpoints to be skipped.
          prepared.recoveryAfterSequence = lane.lastEvent?.sequence ?? 0;
          if (lane.usage) this.#latestUsage.set(lane.childCastId, lane.usage);
        }
      }
      const restarted = restartParallelLaneAttempt(next, {
        parentCastId: input.state.castId, loopId: input.loopId, runId: next.runId, laneId: lane.laneId, attempt: lane.attempt,
        ...(lane.childCastId ? { childCastId: lane.childCastId } : {}), preserveChildSession: prepared.resumeChild === true,
        timestamp: this.#now(),
      });
      if (!restarted.applied) throw new Error(`Unable to revive lane ${JSON.stringify(lane.laneId)}.`);
      next = restarted.state;
    }
    this.#state = input.state;
    this.#input = { ...input, socket: {} as ResolvedMateriaSocket };
    this.#generation += 1;
    this.#run = next;
    this.#prepared = allCompiled;
    this.#nextQueueIndex = 0;
    this.#active.clear();
    this.#reserved.clear();
    this.#starting.clear();
    this.#launching.clear();
    this.#cancelRequested = false;
    this.#cancelPromise = undefined;
    this.#terminalPromise = undefined;
    replaceParallelState(input.state, { ...input.state, active: true, awaitingResponse: false, socketState: "running_parallel", failedReason: undefined, parallelRuns: { ...(input.state.parallelRuns ?? {}), [input.loopId]: next } });
    this.#deps.state.saveCastState(input.pi, input.state);
    try { this.#deps.onProgressStart?.(input.ctx, next); } catch { /* presentation is best effort */ }
    await input.onPrepared?.();
    await this.#pump();
    await this.#maybeAllTerminal(this.#input, input.state);
    return true;
  }

  async cancel(input: ParallelLoopCancellationInput): Promise<void> {
    if (!this.#hasCancellationTarget(input)) return;
    if (this.#cancelPromise && this.#cancelCastId === input.state.castId) return this.#cancelPromise;
    const initialization = this.#initialization?.promise;
    this.#state = input.state;
    this.#cancelRequested = true;
    this.#cancelCastId = input.state.castId;
    this.#cancelPromise = (async () => {
      if (initialization) await initialization;
      await this.#cancelInternal(input);
    })();
    return this.#cancelPromise;
  }
  async abort(input: ParallelLoopCancellationInput): Promise<void> { return this.cancel(input); }
  async shutdown(input: ParallelLoopCancellationInput): Promise<void> { return this.cancel(input); }

  #resetForDifferentCast(castId: string): void {
    const previous = this.#input?.state.castId ?? this.#run?.parentCastId;
    if (previous === undefined || previous === castId || this.#initialization || this.#active.size > 0 || this.#reserved.size > 0 || this.#launching.size > 0) return;
    this.#generation += 1;
    this.#run = undefined; this.#prepared = []; this.#nextQueueIndex = 0;
    this.#reserved.clear(); this.#starting.clear(); this.#launching.clear();
    this.#eventTails.clear(); this.#latestUsage.clear();
    this.#budgetFailure = undefined; this.#cancelRequested = false; this.#cancelPromise = undefined; this.#cancelCastId = undefined; this.#terminalPromise = undefined;
  }

  #beginInitialization(input: ParallelLoopDispatchInput): DispatchInitialization {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return this.#initialization = { castId: input.state.castId, loopId: input.loopId, promise, resolve };
  }
  #finishInitialization(value: DispatchInitialization): void { if (this.#initialization === value) { this.#initialization = undefined; value.resolve(); } }
  #hasCancellationTarget(input: ParallelLoopCancellationInput): boolean {
    if (this.#initialization?.castId === input.state.castId && (!input.loopId || this.#initialization.loopId === input.loopId)) return true;
    return Object.entries(input.state.parallelRuns ?? {}).some(([loopId, run]) => run.parentCastId === input.state.castId && (!input.loopId || input.loopId === loopId));
  }

  async #pump(): Promise<void> {
    this.#pumpTail = this.#pumpTail.catch(() => undefined).then(async () => {
      const input = this.#input; const state = this.#state;
      if (!input || !state || !this.#run) return;

      // Reserve the deterministic queue prefix before doing any asynchronous
      // lane setup. A reservation counts against the bound until the child
      // start has returned, so concurrent pump calls cannot oversubscribe the
      // coordinator while a child runner is still starting.
      while (!this.#cancelRequested && !this.#budgetFailure) {
        while (this.#active.size + this.#reserved.size < input.config.maxConcurrency && this.#nextQueueIndex < this.#prepared.length) {
          const prepared = this.#prepared[this.#nextQueueIndex++];
          if (!prepared) continue;
          const laneId = prepared.stream.laneId;
          this.#reserved.add(laneId);
          const launch = this.#launchLane(input, state, prepared);
          this.#launching.set(laneId, launch);
          void launch.catch(() => undefined).finally(() => {
            if (this.#launching.get(laneId) === launch) this.#launching.delete(laneId);
          });
        }

        // Launches release their reservations as soon as their child start
        // returns or fails. Do not wait for lane artifact/runtime-event I/O; a
        // failed slot must be refillable while sibling lifecycle writes remain
        // pending.
        if (this.#reserved.size > 0) {
          await this.#waitForSlotAvailability();
          continue;
        }
        break;
      }

      // All available starts have now been entered (or failed), so preserve
      // dispatch's established completion boundary for their lifecycle records
      // without holding up the sibling slot-filling loop above.
      await Promise.all([...this.#launching.values()].map((launch) => launch.catch(() => undefined)));
    });
    await this.#pumpTail;
  }

  async #launchLane(input: ParallelLoopDispatchInput, state: MateriaCastState, prepared: PreparedLane): Promise<void> {
    const lane = this.#run?.lanes[prepared.stream.laneId];
    if (!lane || lane.status !== "queued") {
      this.#releaseLaneReservation(prepared.stream.laneId);
      return;
    }
    const launchGeneration = this.#generation;
    const launchRunId = this.#run?.runId;
    const ownsLaunch = () => this.#ownsLaunch(input, state, prepared.stream.laneId, launchGeneration, launchRunId);
    const attempt = lane.attempt;
    const childCastId = prepared.recoveryChildCastId ?? childCastIdentity(state.castId, input.loopId, lane.laneId, attempt);
    const coordinatorArtifactRoot = path.dirname(lanePaths(state, input.loopId, lane.laneId, attempt).runDirectory);
    let paths = lanePaths(state, input.loopId, lane.laneId, attempt);
    const baseScope = state.baseScope ?? createBaseExecutionScope(state.castId, state.cwd);
    const scope = cloneExecutionScope(prepared.recoveryScope ?? lane.executionScope ?? cloneParallelBranchExecutionScope(baseScope, input.loopId, lane.laneId));
    let identity: ParallelLaneArtifactIdentity | undefined;
    let active: ActiveLane | undefined;

    try {
      if (!ownsLaunch()) return;
      state.branchScopes = { ...(state.branchScopes ?? {}), [scope.id]: scope };
      identity = {
        parentCastId: state.castId,
        runId: launchRunId ?? this.#run!.runId,
        loopId: input.loopId,
        laneId: lane.laneId,
        childCastId,
        planId: this.#run!.planIdentity.planId,
        graphHash: this.#run!.graphIdentity.graphHash,
        branchId: lane.branchId,
        executionScopeId: scope.id,
        attempt,
        streamIndex: lane.streamIndex,
        workItemIndexes: [...lane.workItemIndexes],
        coordinatorArtifactRoot,
        paths,
      };
      if (prepared.resumeChild) {
        const resumed = await this.#deps.children.resume({ childCastId, mode: "resume" });
        if (!ownsLaunch()) {
          await this.#abortChild(childCastId, "parallel launch superseded");
          return;
        }
        assertResumedSnapshot(this.#run!, lane, prepared, childCastId, attempt, scope, resumed.snapshot);
        // Resume is owned by the child runner and may intentionally retain its
        // original session. Persist those actual paths instead of speculative
        // paths for the parent's new lane attempt.
        paths = { ...resumed.snapshot.paths };
        identity = { ...identity, paths };
      }
      if (!ownsLaunch()) {
        await this.#abortChild(childCastId, "parallel launch superseded");
        return;
      }
      const artifactPaths = await this.#initializeLaneArtifacts(identity, state);
      if (!ownsLaunch()) {
        await this.#abortChild(childCastId, "parallel launch superseded");
        return;
      }
      const childSession = { childCastId, sessionPath: paths.sessionPath, artifactRoot: paths.artifactRoot, runDirectory: paths.runDirectory };
      if (!this.#applyLaneTransition(input, state, { laneId: lane.laneId, attempt, childCastId, status: "running", executionScope: scope, childSession, timestamp: this.#now() })) {
        await this.#abortChild(childCastId, "parallel launch superseded");
        return;
      }
      // Keep the reservation until start returns. The durable lane transition
      // is already running, while the reservation represents the still-pending
      // child start and prevents a third lane from oversubscribing the bound.
      this.#starting.set(lane.laneId, { childCastId, generation: launchGeneration });

      const startInput: StartChildCastInput = {
        identity: { childCastId, parentCastId: state.castId, loopId: input.loopId, laneId: lane.laneId },
        request: state.request,
        cwd: scope.cwd,
        executionScope: scope,
        compiledLoadout: {
          childLoadoutId: prepared.compiledLoadout.childLoadoutId,
          loadout: prepared.compiledLoadout.loadout,
          initialData: { ...prepared.compiledLoadout.initialData, ...boundedParallelChildData(this.#run!, prepared.stream) },
          nominalProgress: prepared.compiledLoadout.nominalProgress,
          loopId: input.loopId,
          laneId: lane.laneId,
        },
        paths,
        attempt,
      };
      if (!prepared.resumeChild) await this.#deps.children.start(startInput);
      if (!ownsLaunch()) {
        const reason = this.#budgetFailure
          ? "parallel parent budget exhausted"
          : this.#cancelRequested
            ? "parallel execution cancelled"
            : "parallel launch superseded";
        await this.#abortChild(childCastId, reason);
        this.#starting.delete(lane.laneId);
        return;
      }
      active = { childCastId, attempt, generation: launchGeneration, artifactIdentity: identity, artifactPaths };
      this.#active.set(lane.laneId, active);
      this.#starting.delete(lane.laneId);
      this.#releaseLaneReservation(lane.laneId);
      active.subscription = this.#deps.children.subscribe({ childCastId, afterSequence: prepared.recoveryAfterSequence }, {
        onEvent: (event) => this.#handleChildEvent(input, state, prepared.stream, active!, event),
        onTerminal: (result) => {
          const work = this.#terminalTail.catch(() => undefined).then(() => this.#handleChildTerminal(input, state, prepared.stream, active!, result));
          this.#terminalTail = work;
          return work;
        },
      });
      const lifecycleType = prepared.resumeChild ? "parallel_lane_resumed" : "parallel_lane_started";
      // Lifecycle writes are intentionally outside slot acquisition. They are
      // guarded between awaits so a retired generation cannot write into a
      // replacement run.
      if (!this.#ownsActiveLane(input, state, prepared.stream, active)) return;
      await this.#appendLaneLifecycle(active, state, input.loopId, prepared.stream, lifecycleType, this.#now(), { status: "running" });
      if (!this.#ownsActiveLane(input, state, prepared.stream, active)) return;
      await this.#appendEvent(state, lifecycleType, { ...this.#eventProvenance(state, input.loopId, prepared.stream, active), status: "running" });
      if (this.#ownsActiveLane(input, state, prepared.stream, active)) notifyParallelUser(input.ctx, `pi-materia spawned parallel lane "${prepared.stream.name}" for loop "${input.loopId}".`, "info");
    } catch (error) {
      if (active && this.#active.get(lane.laneId) === active) {
        this.#active.delete(lane.laneId);
        active.subscription?.unsubscribe();
      }
      this.#starting.delete(lane.laneId);
      // Release before failure artifacts so the queue can refill immediately.
      this.#releaseLaneReservation(lane.laneId);
      if (!identity) return;
      await this.#deps.children.abort({ childCastId, reason: `child launch failed: ${parallelErrorMessage(error)}` }).catch(() => undefined);
      if (!ownsLaunch()) return;
      await this.#failLane(input, state, prepared.stream, identity, `child launch failed: ${parallelErrorMessage(error)}`);
      // The failure transition may make the final barrier terminal after the
      // current pump has already moved on to a replacement queue entry.
      void this.#pump().then(() => this.#maybeAllTerminal(input, state)).catch(() => undefined);
    } finally {
      this.#releaseLaneReservation(lane.laneId);
    }
  }

  async #handleChildEvent(input: ParallelLoopDispatchInput, state: MateriaCastState, stream: NormalizedParallelStream, active: ActiveLane, event: ChildCastStreamEvent): Promise<void> {
    if (this.#run?.runId !== active.artifactIdentity.runId || this.#active.get(stream.laneId) !== active) return;
    // Usage already delivered by the child runner remains authoritative during
    // cancellation. Other late callbacks must not mutate a terminal lane.
    const checkpoint = event.type === "usage_checkpoint" && isParallelUsage(event.usage)
      ? compactParallelUsage(event.usage)
      : undefined;
    if (this.#cancelRequested && !checkpoint) return;
    const previous = this.#eventTails.get(active.childCastId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      // The callback may have been queued before its run settled. Do not let an
      // old run mutate a later run that reuses this dispatcher and lane id.
      if (this.#run?.runId !== active.artifactIdentity.runId || this.#active.get(stream.laneId) !== active) return;
      // Child stream events are observational. Keep their watermark in the
      // live coordinator so the next durable transition can checkpoint it,
      // but do not amplify token/message traffic into parent persistence or
      // monitoring artifacts. Child-owned session/stdout artifacts retain the
      // detailed evidence. Merge checkpoints only after entering this serialized
      // tail so a queued stale callback cannot regress the lane baseline.
      const usage = checkpoint ? cumulativeUsage([this.#latestUsage.get(active.childCastId), checkpoint]) : undefined;
      const progress = event.type === "progress_checkpoint" && event.position !== undefined && event.total !== undefined
        ? { position: event.position, total: event.total }
        : undefined;
      const applied = this.#applyLaneTransition(input, state, { laneId: stream.laneId, attempt: active.attempt, childCastId: event.childCastId, lastEvent: { sequence: event.sequence, type: event.type, occurredAt: event.occurredAt }, ...(usage ? { usage } : {}), ...(progress ? { progress } : {}), timestamp: event.occurredAt }, false);
      // A real cumulative usage delta is itself a durable boundary. The usage
      // checkpoint saves both accounting and the latest replay watermark.
      if (usage && applied) await this.#aggregateUsage(state, input, stream, active, usage);
    });
    this.#eventTails.set(active.childCastId, next);
    try { await next; } finally { if (this.#eventTails.get(active.childCastId) === next) this.#eventTails.delete(active.childCastId); }
  }

  async #handleChildTerminal(input: ParallelLoopDispatchInput, state: MateriaCastState, stream: NormalizedParallelStream, active: ActiveLane, result: ChildCastTerminalResult): Promise<void> {
    if (!this.#ownsActiveLane(input, state, stream, active)) return;
    await this.#eventTails.get(active.childCastId)?.catch(() => undefined);
    if (!this.#ownsActiveLane(input, state, stream, active) || this.#budgetFailure || !this.#active.delete(stream.laneId)) return;
    active.subscription?.unsubscribe();
    const observation = await this.#deps.children.observe({ childCastId: active.childCastId }).catch(() => undefined);
    // Observation can wait on process close. Cancellation or a later dispatch
    // may take ownership while it is pending, so never continue using global
    // coordinator fields until ownership has been revalidated.
    if (!this.#ownsClaimedLane(input, state, active)) return;
    const usage = cumulativeUsage([
      observation && isParallelUsage(observation.snapshot.usage) ? observation.snapshot.usage : undefined,
      isParallelUsage(result.usage) ? result.usage : undefined,
      this.#latestUsage.get(active.childCastId),
    ]);
    if (usage) await this.#aggregateUsage(state, input, stream, active, usage);
    // Budget enforcement retires the run and deliberately clears its failure
    // sentinel. Generation ownership is therefore the durable stop condition.
    if (!this.#ownsClaimedLane(input, state, active) || this.#budgetFailure) return;
    const accepted = result.status === "succeeded" && result.accepted;
    const reason = result.error ?? (accepted ? undefined : "Child lane did not complete with an accepted result.");
    const lane = this.#run?.lanes[stream.laneId];
    if (!lane?.executionScope) return;
    const terminalScope = cloneExecutionScope(observation?.snapshot.executionScope ?? lane.executionScope);
    if (terminalScope) state.branchScopes = { ...(state.branchScopes ?? {}), [terminalScope.id]: terminalScope };
    this.#applyLaneTransition(input, state, {
      laneId: stream.laneId, attempt: active.attempt, childCastId: active.childCastId,
      status: accepted ? "accepted" : result.status === "interrupted" ? "interrupted" : "failed",
      accepted,
      executionScope: terminalScope,
      ...(accepted && result.output !== undefined ? { terminalOutput: result.output } : {}),
      ...(usage ? { usage } : {}),
      ...(reason ? { failureReason: boundedFailureReason(reason), diagnostic: { code: "parallel_lane_terminal", message: boundedFailureReason(reason), severity: "error", occurredAt: result.endedAt } } : { failureReason: undefined }),
      timestamp: result.endedAt,
    });
    const diagnostics = observation?.snapshot.diagnostics.map(toParallelDiagnostic) ?? [];
    await this.#writeTerminal(active, result, usage, diagnostics);
    if (!this.#ownsClaimedLane(input, state, active)) return;
    await this.#appendLaneLifecycle(active, state, input.loopId, stream, "parallel_lane_terminal", result.endedAt, {
      status: accepted ? "accepted" : result.status,
      ...(usage ? { usage } : {}),
      ...(reason ? { error: boundedFailureReason(reason) } : {}),
    });
    if (!this.#ownsClaimedLane(input, state, active)) return;
    const terminalRun = this.#run!;
    const reached = Object.values(terminalRun.lanes).filter((lane) => isTerminalLaneStatus(lane.status)).length;
    await this.#appendEvent(state, "parallel_lane_terminal", {
      ...this.#eventProvenance(state, input.loopId, stream, active),
      status: accepted ? "accepted" : result.status === "interrupted" ? "interrupted" : "failed",
      barrier: { reached, total: terminalRun.queueOrder.length },
      ...(reason ? { error: boundedFailureReason(reason) } : {}),
      ...(usage ? { usage: compactParallelUsage(usage) } : {}),
    });
    if (!this.#ownsClaimedLane(input, state, active)) return;
    // Failed/interrupted attempts must remain resumable, but their process,
    // parser, captures, observers, and replay tails are no longer live.
    if (!accepted) await this.#retireChild(active.childCastId, true);
    if (!this.#ownsClaimedLane(input, state, active)) return;
    await this.#pump();
    if (!this.#ownsClaimedLane(input, state, active)) return;
    await this.#maybeAllTerminal(input, state);
  }

  async #maybeAllTerminal(input: ParallelLoopDispatchInput, state: MateriaCastState): Promise<void> {
    const run = this.#run;
    if (!run || this.#active.size || this.#nextQueueIndex < this.#prepared.length || !Object.values(run.lanes).every((lane) => isTerminalLaneStatus(lane.status))) return;
    if (this.#terminalPromise) return this.#terminalPromise;
    const terminalPromise = this.#settleAllTerminal(input, state, run);
    this.#terminalPromise = terminalPromise;
    try { await terminalPromise; } finally { if (this.#terminalPromise === terminalPromise) this.#terminalPromise = undefined; }
  }

  async #settleAllTerminal(input: ParallelLoopDispatchInput, state: MateriaCastState, run: MateriaParallelRunState): Promise<void> {
    const rejected = Object.values(run.lanes).filter((lane) => lane.status !== "accepted");
    if (rejected.length) {
      const reason = aggregateParallelLaneFailureReason(run);
      this.#transitionRun(input, state, "failed", "skipped");
      await this.#appendEvent(state, "parallel_branches_failed", {
        parentCastId: state.castId,
        loopId: input.loopId,
        runId: run.runId,
        status: "failed",
        error: boundedFailureReason(reason),
        barrier: barrierSummary(run, "failed"),
      });
      await this.#retireRunChildren(run);
      this.#releaseTerminalCoordinatorState();
      await this.#notifyRunFailure(input, state, run.runId, reason);
      return;
    }
    const result = collectAcceptedParallelBranches(run);
    // Persist the accepted barrier before invoking parent advancement. This is
    // the exactly-once guard against duplicate terminal callbacks.
    this.#transitionRun(input, state, "completed", "accepted");
    await this.#appendEvent(state, "parallel_branches_terminal", {
      parentCastId: state.castId,
      loopId: input.loopId,
      runId: run.runId,
      status: "accepted",
      barrier: barrierSummary(run, "accepted"),
    });
    // Release this run before advancing the parent. Parent advancement may
    // synchronously dispatch another parallel run through this same global
    // dispatcher, which must not be cleared by the settled run afterward.
    await this.#retireRunChildren(run);
    this.#releaseTerminalCoordinatorState();
    if (input.onFanIn) {
      try {
        await input.onFanIn({ loopId: input.loopId, runId: run.runId, result });
      } catch (error) {
        const reason = boundedFailureReason(`Parallel barrier advancement failed: ${parallelErrorMessage(error)}`);
        await this.#notifyRunFailure(input, state, run.runId, reason);
      }
    }
  }

  async #cancelInternal(input: ParallelLoopCancellationInput): Promise<void> {
    const state = this.#state;
    if (!state) return;
    const runs = cancellableParallelRuns(input, this.#run);
    if (runs.length === 0) return;
    const reason = boundedFailureReason(input.reason?.trim() || "parallel execution cancelled");
    this.#nextQueueIndex = this.#prepared.length;
    await this.#pumpTail.catch(() => undefined);
    await Promise.all([...this.#eventTails.values()].map((tail) => tail.catch(() => undefined)));

    for (const run of runs) {
      this.#run = run;
      const dispatchInput = this.#input?.loopId === run.loopId ? this.#input : cancellationDispatchInput(input, run);
      const runChildIds = new Set(Object.values(run.lanes).flatMap((lane) => lane.childCastId ? [lane.childCastId] : []));
      const active = [...this.#active.values()].filter((lane) => runChildIds.has(lane.childCastId));
      const childIds = new Set(active.map((lane) => lane.childCastId));
      for (const lane of Object.values(run.lanes)) {
        if (!isTerminalLaneStatus(lane.status) && lane.childCastId) childIds.add(lane.childCastId);
      }
      // A dispatcher may be recreated while runs are persisted. Observe child
      // snapshots before aborting so cumulative telemetry survives both process
      // revival and delayed observer callbacks.
      for (const childCastId of childIds) {
        const lane = Object.values(run.lanes).find((candidate) => candidate.childCastId === childCastId);
        if (lane) await this.#reconcileCancellationUsage(state, dispatchInput, run, lane);
      }

      await Promise.all([...childIds].map((childCastId) => this.#abortChild(childCastId, reason)));
      // Process shutdown can flush a final canonical checkpoint. Live callbacks
      // deliberately cannot aggregate while cancellation owns the run, so drain
      // them and reconcile the runner snapshot once more before terminalizing.
      await Promise.all([...this.#eventTails.values()].map((tail) => tail.catch(() => undefined)));
      for (const childCastId of childIds) {
        const lane = Object.values(this.#run?.lanes ?? run.lanes).find((candidate) => candidate.childCastId === childCastId);
        if (lane) await this.#reconcileCancellationUsage(state, dispatchInput, this.#run ?? run, lane);
      }
      const timestamp = this.#now();
      for (const laneId of run.queueOrder) {
        const lane = this.#run?.lanes[laneId];
        if (!lane || isTerminalLaneStatus(lane.status)) continue;
        const activeLane = active.find((candidate) => candidate.childCastId === lane.childCastId);
        this.#applyLaneTransition(dispatchInput, state, { laneId, attempt: lane.attempt, ...(lane.childCastId ? { childCastId: lane.childCastId } : {}), status: "interrupted", failureReason: reason, diagnostic: { code: "parallel_cancelled", message: reason, severity: "warning", occurredAt: timestamp }, timestamp });
        if (lane.childCastId) await this.#appendLaneLifecycle(activeLane ?? activeForPersistedLane(state, run, lane), state, run.loopId, streamForPersistedLane(lane), "parallel_lane_cancelled", timestamp, { status: "interrupted", error: reason });
      }
      for (const lane of active) lane.subscription?.unsubscribe();
      this.#transitionRun(dispatchInput, state, "failed", "skipped");
      await this.#appendEvent(state, "parallel_cancelled", {
        parentCastId: state.castId,
        loopId: run.loopId,
        runId: run.runId,
        status: "failed",
        error: reason,
        barrier: barrierSummary(this.#run ?? run, "failed"),
      });
      await this.#retireRunChildren(this.#run ?? run);
    }
    this.#active.clear();
    this.#releaseTerminalCoordinatorState();
  }

  async #reconcileCancellationUsage(state: MateriaCastState, input: ParallelLoopDispatchInput, run: MateriaParallelRunState, lane: MateriaParallelLaneState): Promise<void> {
    const childCastId = lane.childCastId;
    if (!childCastId) return;
    const observation = await this.#deps.children.observe({ childCastId }).catch(() => undefined);
    if (!observation || !isParallelUsage(observation.snapshot.usage)) return;
    const observedUsage = cumulativeUsage([
      observation.snapshot.usage,
      this.#latestUsage.get(childCastId),
      lane.usage && isParallelUsage(lane.usage) ? lane.usage : undefined,
    ])!;
    if (!this.#latestUsage.has(childCastId) && lane.usage) this.#latestUsage.set(childCastId, compactParallelUsage(lane.usage));
    const latestEvent = [...observation.snapshot.events, ...observation.events]
      .reduce<ChildCastStreamEvent | undefined>((latest, event) => !latest || event.sequence > latest.sequence ? event : latest, undefined);
    // Persist baseline and replay watermark together. Repeating this settlement
    // after abort is monotonic and #aggregateUsage deltas it exactly once.
    this.#applyLaneTransition(input, state, {
      laneId: lane.laneId,
      attempt: lane.attempt,
      childCastId,
      usage: observedUsage,
      ...(latestEvent ? { lastEvent: { sequence: latestEvent.sequence, type: latestEvent.type, occurredAt: latestEvent.occurredAt } } : {}),
      timestamp: observation.snapshot.updatedAt,
    }, false);
    await this.#aggregateUsage(state, input, streamForPersistedLane(lane), activeForPersistedLane(state, run, lane), observedUsage, false);
  }

  async #abortChild(childCastId: string, reason: string): Promise<void> { await this.#deps.children.abort({ childCastId, reason }).catch(() => undefined); }

  async #retireChild(childCastId: string, retainForResume: boolean): Promise<void> {
    await this.#deps.children.retire?.({ childCastId, retainForResume }).catch(() => undefined);
  }

  async #retireRunChildren(run: MateriaParallelRunState): Promise<void> {
    await Promise.all(Object.values(run.lanes).flatMap((lane) => lane.childCastId
      ? [this.#retireChild(lane.childCastId, lane.status !== "accepted")]
      : []));
  }

  #releaseTerminalCoordinatorState(): void {
    // Invalidate callbacks before clearing references. A callback may currently
    // be suspended in child observation or artifact I/O.
    this.#generation += 1;
    for (const lane of this.#active.values()) lane.subscription?.unsubscribe();
    this.#active.clear();
    this.#reserved.clear();
    this.#starting.clear();
    this.#launching.clear();
    const slotWaiters = [...this.#slotWaiters];
    this.#slotWaiters.clear();
    for (const resolve of slotWaiters) resolve();
    this.#eventTails.clear();
    this.#latestUsage.clear();
    this.#prepared = [];
    this.#nextQueueIndex = 0;
    this.#state = undefined;
    this.#input = undefined;
    this.#run = undefined;
    this.#terminalPromise = undefined;
    this.#budgetFailure = undefined;
    this.#cancelRequested = false;
    this.#cancelPromise = undefined;
    this.#cancelCastId = undefined;
    this.#usageWriteTail = Promise.resolve();
    this.#pumpTail = Promise.resolve();
    this.#terminalTail = Promise.resolve();
  }

  #waitForSlotAvailability(): Promise<void> {
    return new Promise((resolve) => this.#slotWaiters.add(resolve));
  }

  #releaseLaneReservation(laneId: string): void {
    if (!this.#reserved.delete(laneId)) return;
    const waiters = [...this.#slotWaiters];
    this.#slotWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  #ownsLaunch(input: ParallelLoopDispatchInput, state: MateriaCastState, laneId: string, generation: number, runId: string | undefined): boolean {
    return !this.#cancelRequested
      && generation === this.#generation
      && this.#input === input
      && this.#state === state
      && this.#run?.runId === runId
      && (this.#run?.lanes[laneId]?.status === "queued" || this.#run?.lanes[laneId]?.status === "running");
  }

  #ownsActiveLane(input: ParallelLoopDispatchInput, state: MateriaCastState, stream: NormalizedParallelStream, active: ActiveLane): boolean {
    return this.#ownsClaimedLane(input, state, active) && this.#active.get(stream.laneId) === active;
  }

  #ownsClaimedLane(input: ParallelLoopDispatchInput, state: MateriaCastState, active: ActiveLane): boolean {
    return !this.#cancelRequested
      && active.generation === this.#generation
      && this.#input === input
      && this.#state === state
      && this.#run?.runId === active.artifactIdentity.runId;
  }

  async #aggregateUsage(state: MateriaCastState, input: ParallelLoopDispatchInput, stream: NormalizedParallelStream, active: ActiveLane, usage: MateriaParallelUsageTotals, enforceBudget = true): Promise<void> {
    // Cancellation performs its own durable aggregation with synthetic lane
    // records. Live callback aggregation, however, must remain generation-owned
    // across every artifact write before it can touch coordinator state again.
    if (enforceBudget && !this.#ownsClaimedLane(input, state, active)) return;
    const cumulative = cumulativeUsage([this.#latestUsage.get(active.childCastId), usage])!;
    const delta = usageDelta(this.#latestUsage.get(active.childCastId), cumulative);
    this.#latestUsage.set(active.childCastId, cumulative);
    if (!hasUsage(delta)) return;
    const report = state.runState.usage;
    report.byMateria ??= {}; report.bySocket ??= {}; report.byTask ??= {}; report.byAttempt ??= {};
    addUsage(report, delta, { socket: `parallel/${input.loopId}/${stream.laneId}`, materia: "parallel-child", taskId: stream.laneId, attempt: active.attempt });
    this.#deps.state.saveCastState(input.pi, state);
    const write = this.#deps.artifacts?.writeUsage;
    if (write) { this.#usageWriteTail = this.#usageWriteTail.catch(() => undefined).then(() => write(state.runState)); await this.#usageWriteTail.catch(() => undefined); }
    if (enforceBudget && !this.#ownsClaimedLane(input, state, active)) return;
    await this.#deps.artifacts?.lane?.writeUsage({ ...active.artifactIdentity, usage: cumulative }).catch(() => undefined);
    if (enforceBudget && !this.#ownsClaimedLane(input, state, active)) return;
    await this.#appendLaneLifecycle(active, state, input.loopId, stream, "usage_checkpoint", this.#now(), { usage: cumulative });
    if (enforceBudget && !this.#ownsClaimedLane(input, state, active)) return;
    try { await this.#deps.budget?.assertBudget?.(state, input.ctx); }
    catch (error) {
      if (this.#ownsClaimedLane(input, state, active)) await this.#enforceBudget(input, state, active, error);
    }
  }

  async #enforceBudget(input: ParallelLoopDispatchInput, state: MateriaCastState, owner: ActiveLane, error: unknown): Promise<void> {
    if (this.#budgetFailure || !this.#ownsClaimedLane(input, state, owner)) return;
    const run = this.#run!;
    this.#budgetFailure = error instanceof Error ? error : new Error(String(error));
    const reason = boundedFailureReason(`Parallel parent budget exhausted: ${parallelErrorMessage(error)}`);
    const active = [...this.#active.values()];
    const starting = [...this.#starting.values()];
    this.#active.clear();
    this.#nextQueueIndex = this.#prepared.length;
    for (const lane of Object.values(run.lanes)) {
      if (!this.#ownsClaimedLane(input, state, owner)) return;
      if (isTerminalLaneStatus(lane.status)) continue;
      const timestamp = this.#now();
      const status = lane.status === "running" ? "interrupted" : "failed";
      this.#applyLaneTransition(input, state, { laneId: lane.laneId, attempt: lane.attempt, ...(lane.childCastId ? { childCastId: lane.childCastId } : {}), status, failureReason: reason, diagnostic: { code: "parallel_budget_exceeded", message: reason, severity: "error", occurredAt: timestamp }, timestamp });
      const activeLane = active.find((candidate) => candidate.childCastId === lane.childCastId);
      if (lane.childCastId) await this.#appendLaneLifecycle(activeLane ?? activeForPersistedLane(state, run, lane), state, input.loopId, streamForPersistedLane(lane), "parallel_lane_budget_exceeded", timestamp, { status, error: reason });
    }
    if (!this.#ownsClaimedLane(input, state, owner)) return;
    this.#transitionRun(input, state, "failed", "failed");
    await this.#appendEvent(state, "parallel_budget_exceeded", { parentCastId: state.castId, loopId: input.loopId, runId: run.runId, reason });
    if (!this.#ownsClaimedLane(input, state, owner)) return;
    for (const lane of active) lane.subscription?.unsubscribe();
    await Promise.all([
      ...active.map((lane) => this.#abortChild(lane.childCastId, reason)),
      ...starting.map((lane) => this.#abortChild(lane.childCastId, reason)),
    ]);
    if (!this.#ownsClaimedLane(input, state, owner)) return;
    await this.#deps.onBudgetExceeded?.(input.pi, input.ctx, state, this.#budgetFailure, `parallel:${input.loopId}`).catch(() => undefined);
    if (!this.#ownsClaimedLane(input, state, owner)) return;
    await this.#retireRunChildren(run);
    if (this.#ownsClaimedLane(input, state, owner)) this.#releaseTerminalCoordinatorState();
  }

  async #failLane(input: ParallelLoopDispatchInput, state: MateriaCastState, stream: NormalizedParallelStream, identity: ParallelLaneArtifactIdentity, reason: string): Promise<void> {
    const message = boundedFailureReason(reason); const endedAt = this.#now();
    this.#applyLaneTransition(input, state, { laneId: stream.laneId, attempt: identity.attempt, childCastId: identity.childCastId, status: "failed", failureReason: message, diagnostic: { code: "parallel_lane_failure", message, severity: "error", occurredAt: endedAt }, timestamp: endedAt });
    const active: ActiveLane = { childCastId: identity.childCastId, attempt: identity.attempt, generation: this.#generation, artifactIdentity: identity };
    await this.#writeTerminal(active, { status: "failed", accepted: false, endedAt, error: message }, undefined, []);
    await this.#appendLaneLifecycle(active, state, input.loopId, stream, "parallel_lane_terminal", endedAt, { status: "failed", error: message });
    await this.#retireChild(identity.childCastId, true);
  }

  #transitionRun(input: ParallelLoopDispatchInput, state: MateriaCastState, phase: Parameters<typeof applyParallelRunPhaseTransition>[1]["phase"], fanInPhase: Parameters<typeof applyParallelRunPhaseTransition>[1]["fanInPhase"]): void {
    if (!this.#run) return;
    const changed = applyParallelRunPhaseTransition(this.#run, { parentCastId: state.castId, loopId: input.loopId, runId: this.#run.runId, phase, fanInPhase, timestamp: this.#now() });
    if (!changed.applied) return;
    replaceParallelState(state, { ...state, parallelRuns: { ...(state.parallelRuns ?? {}), [input.loopId]: changed.state } });
    this.#run = changed.state; this.#deps.state.saveCastState(input.pi, state);
    this.#requestProgressRefresh();
  }

  #applyLaneTransition(input: ParallelLoopDispatchInput, state: MateriaCastState, transition: Omit<Parameters<typeof applyParallelTransitionToCastState>[1], "parentCastId" | "castId" | "loopId" | "runId">, persist = true): boolean {
    if (!this.#run) return false;
    const result = applyParallelTransitionToCastState(state, { parentCastId: state.castId, loopId: input.loopId, runId: this.#run.runId, ...transition });
    if (!result.applied) return false;
    replaceParallelState(state, result.state);
    this.#run = state.parallelRuns?.[input.loopId];
    if (persist) this.#deps.state.saveCastState(input.pi, state);
    if (transition.progress !== undefined || transition.status !== undefined) this.#requestProgressRefresh();
    return true;
  }

  #requestProgressRefresh(): void {
    if (!this.#run) return;
    try { this.#deps.onProgressChange?.(this.#run); } catch { /* presentation is best effort */ }
  }

  async #notifyRunFailure(input: ParallelLoopDispatchInput, state: MateriaCastState, runId: string, reason: string): Promise<void> {
    if (input.onFailure) { await input.onFailure({ loopId: input.loopId, runId, reason }).catch(() => undefined); return; }
    state.active = false; state.awaitingResponse = false; state.socketState = "failed"; state.phase = "failed"; state.failedReason = reason; state.runState.lastMessage = reason; state.runState.endedAt ??= this.#now(); this.#deps.state.saveCastState(input.pi, state);
  }

  async #initializeLaneArtifacts(identity: ParallelLaneArtifactIdentity, state: MateriaCastState): Promise<ParallelLaneArtifactPaths | undefined> {
    try { return await this.#deps.artifacts?.lane?.initialize(identity); }
    catch (error) { await this.#appendEvent(state, "parallel_artifact_failure", { laneId: identity.laneId, operation: "initialize", error: boundedFailureReason(parallelErrorMessage(error)) }); return undefined; }
  }
  async #appendLaneLifecycle(active: ActiveLane, state: MateriaCastState, loopId: string, stream: NormalizedParallelStream, type: ParallelLaneEventArtifact["event"]["type"], occurredAt: number, details: Omit<ParallelLaneEventArtifact["event"], "type" | "occurredAt"> = {}): Promise<void> {
    const event: ParallelLaneEventArtifact = {
      provenance: this.#eventProvenance(state, loopId, stream, active),
      event: {
        type,
        occurredAt,
        ...(details.status ? { status: details.status } : {}),
        ...(details.usage && isParallelUsage(details.usage) ? { usage: compactParallelUsage(details.usage) } : {}),
        ...(details.error ? { error: boundedFailureReason(details.error) } : {}),
      },
    };
    await this.#deps.artifacts?.lane?.appendEvent({ ...active.artifactIdentity, event }).catch(() => undefined);
  }
  async #writeTerminal(active: ActiveLane, result: ChildCastTerminalResult, usage: MateriaParallelUsageTotals | undefined, diagnostics: readonly ParallelLaneDiagnosticArtifact[]): Promise<void> {
    const lane = this.#deps.artifacts?.lane; if (!lane) return;
    await lane.writeTerminalResult({ ...active.artifactIdentity, result, ...(usage ? { usage } : {}) }).catch(() => undefined);
    await lane.writeDiagnostics({ ...active.artifactIdentity, diagnostics }).catch(() => undefined);
    if (usage) await lane.writeUsage({ ...active.artifactIdentity, usage }).catch(() => undefined);
  }
  #eventProvenance(state: MateriaCastState, loopId: string, stream: NormalizedParallelStream, active: ActiveLane, sequence?: number, workItemId?: string): Record<string, unknown> {
    return { parentCastId: state.castId, loopId, runId: this.#run?.runId, laneId: stream.laneId, childCastId: active.childCastId, attempt: active.attempt, streamIndex: stream.streamIndex, workItemIndexes: [...stream.workItemIndexes], ...(workItemId ? { workItemId } : {}), ...(sequence !== undefined ? { childSequence: sequence } : {}) };
  }
  async #appendEvent(state: MateriaCastState, type: string, data: unknown): Promise<void> {
    await this.#deps.artifacts?.appendEvent(state.runState, type, data).catch(() => undefined);
    await this.#deps.runtimeEvents?.emit(state, type, isRecord(data) ? data : { value: data }).catch(() => undefined);
  }
}

export function parallelLoopForSocket(state: MateriaCastState, socketId: string): {
  loopId: string;
  config?: NonNullable<MateriaCastState["pipeline"]["loops"]>[string]["parallel"];
} | undefined {
  const region = parallelBranchRegionForEntry(state.pipeline, socketId);
  if (!region) return undefined;
  const config = state.pipeline.loops?.[region.loopId]?.parallel;
  return { loopId: region.loopId, ...(config ? { config } : {}) };
}

export function createParallelLoopDispatcher(deps: ParallelLoopDispatcherDependencies): ParallelLoopDispatcher { return new ParallelLoopDispatcher(deps); }
export const createParallelLaneScheduler = createParallelLoopDispatcher;
export const ParallelLaneScheduler = ParallelLoopDispatcher;

function cancellableParallelRuns(input: ParallelLoopCancellationInput, activeRun: MateriaParallelRunState | undefined): MateriaParallelRunState[] {
  const persisted = Object.entries(input.state.parallelRuns ?? {})
    .filter(([loopId, run]) => (!input.loopId || loopId === input.loopId) && run.parentCastId === input.state.castId)
    .map(([, run]) => run)
    .filter((run) => Object.values(run.lanes).some((lane) => !isTerminalLaneStatus(lane.status)));
  if (persisted.length > 0 || !activeRun || (input.loopId && activeRun.loopId !== input.loopId)) return persisted;
  return activeRun.parentCastId === input.state.castId && Object.values(activeRun.lanes).some((lane) => !isTerminalLaneStatus(lane.status)) ? [activeRun] : [];
}
function cancellationDispatchInput(input: ParallelLoopCancellationInput, run: MateriaParallelRunState): ParallelLoopDispatchInput {
  return {
    pi: input.pi,
    ctx: input.ctx ?? ({} as ExtensionContext),
    state: input.state,
    socket: {} as ResolvedMateriaSocket,
    loopId: run.loopId,
    config: { maxConcurrency: run.maxConcurrency },
  };
}
function streamForPersistedLane(lane: MateriaParallelLaneState): NormalizedParallelStream {
  return { laneId: lane.laneId, name: lane.name, streamIndex: lane.streamIndex, workItemIndexes: [...lane.workItemIndexes] };
}
function activeForPersistedLane(state: MateriaCastState, run: MateriaParallelRunState, lane: MateriaParallelLaneState): ActiveLane {
  const childCastId = lane.childCastId!;
  const paths = lane.childSession
    ? { sessionPath: lane.childSession.sessionPath, artifactRoot: lane.childSession.artifactRoot, runDirectory: lane.childSession.runDirectory }
    : lanePaths(state, run.loopId, lane.laneId, lane.attempt);
  return {
    childCastId,
    attempt: lane.attempt,
    // Synthetic records are used only for durable artifact writes and never
    // install asynchronous callbacks.
    generation: 0,
    artifactIdentity: {
      parentCastId: state.castId,
      runId: run.runId,
      loopId: run.loopId,
      laneId: lane.laneId,
      childCastId,
      planId: run.planIdentity.planId,
      graphHash: run.graphIdentity.graphHash,
      branchId: lane.branchId,
      executionScopeId: lane.executionScope?.id ?? "missing-scope",
      attempt: lane.attempt,
      streamIndex: lane.streamIndex,
      workItemIndexes: [...lane.workItemIndexes],
      coordinatorArtifactRoot: path.dirname(lanePaths(state, run.loopId, lane.laneId, lane.attempt).runDirectory),
      paths,
    },
  };
}
function compileStreams(input: ParallelLoopDispatchInput, plan: NormalizedParallelPlan, workItems: ReturnType<typeof readParallelWorkItems>): PreparedLane[] {
  return plan.streams.map((stream) => {
    const compiled = compileLoopRegionToChildLoadout({ pipeline: input.state.pipeline, loopId: input.loopId, workItems, workItemIndexes: stream.workItemIndexes, laneId: stream.laneId });
    if (!compiled.ok) throw new Error(`Unable to compile parallel lane ${JSON.stringify(stream.laneId)}: ${compiled.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
    return { stream, compiledLoadout: compiled.value };
  });
}
function nominalProgressTotal(compiled: CompiledLoopChildLoadout): number {
  return deriveNominalParallelLaneProgress({
    definition: compiled.nominalProgress,
    workItemCursor: Number.POSITIVE_INFINITY,
  }).total;
}

function boundedParallelChildData(run: MateriaParallelRunState, stream: NormalizedParallelStream): Record<string, unknown> {
  return { parallelContext: boundedParallelContext(run, stream), parallelRun: { runId: run.runId, planId: run.planIdentity.planId, loopId: run.loopId, laneId: stream.laneId }, parallelLane: { laneId: stream.laneId, name: stream.name, streamIndex: stream.streamIndex, workItemIndexes: [...stream.workItemIndexes] } };
}
function parallelGraphHash(prepared: readonly PreparedLane[]): string {
  const graph = prepared.map(({ stream, compiledLoadout }) => ({
    laneId: stream.laneId,
    childLoadoutId: compiledLoadout.childLoadoutId,
    loadout: compiledLoadout.loadout,
    initialData: compiledLoadout.initialData,
  }));
  return createHash("sha256").update(JSON.stringify(graph)).digest("hex");
}
function assertRecoverySnapshot(run: MateriaParallelRunState, lane: MateriaParallelLaneState, prepared: PreparedLane, snapshot: ChildCastSnapshot): void {
  if (snapshot.identity.childCastId !== lane.childCastId || snapshot.identity.parentCastId !== run.parentCastId || snapshot.identity.loopId !== run.loopId || snapshot.identity.laneId !== lane.laneId) {
    throw new Error(`Parallel revival child identity drift for lane ${JSON.stringify(lane.laneId)}.`);
  }
  if (snapshot.attempt !== lane.attempt) throw new Error(`Parallel revival child attempt drift for lane ${JSON.stringify(lane.laneId)}.`);
  if (!lane.childSession || lane.childSession.childCastId !== snapshot.identity.childCastId || !sameJson(childSessionPaths(lane.childSession), snapshot.paths)) {
    throw new Error(`Parallel revival child session path drift for lane ${JSON.stringify(lane.laneId)}.`);
  }
  if (!sameJson(snapshot.compiledLoadout, expectedChildCompiledLoadout(run, prepared))) {
    throw new Error(`Parallel revival graph or initial-data drift for child ${JSON.stringify(snapshot.identity.childCastId)}.`);
  }
  if (!lane.executionScope || !sameJson(snapshot.executionScope, lane.executionScope)) {
    throw new Error(`Parallel revival execution scope drift for lane ${JSON.stringify(lane.laneId)}.`);
  }
  if (snapshot.cwd !== lane.executionScope.cwd) throw new Error(`Parallel revival child cwd drift for lane ${JSON.stringify(lane.laneId)}.`);
}
function assertResumedSnapshot(run: MateriaParallelRunState, lane: MateriaParallelLaneState, prepared: PreparedLane, childCastId: string, attempt: number, scope: NonNullable<MateriaParallelLaneState["executionScope"]>, snapshot: ChildCastSnapshot): void {
  if (snapshot.identity.childCastId !== childCastId || snapshot.identity.parentCastId !== run.parentCastId || snapshot.identity.loopId !== run.loopId || snapshot.identity.laneId !== lane.laneId || snapshot.attempt !== attempt) {
    throw new Error(`Parallel resumed child identity or attempt drift for lane ${JSON.stringify(lane.laneId)}.`);
  }
  if (!lane.childSession || !sameJson(childSessionPaths(lane.childSession), snapshot.paths)) {
    throw new Error(`Parallel resumed child session path drift for lane ${JSON.stringify(lane.laneId)}.`);
  }
  if (!sameJson(snapshot.compiledLoadout, expectedChildCompiledLoadout(run, prepared))) {
    throw new Error(`Parallel resumed child graph or initial-data drift for lane ${JSON.stringify(lane.laneId)}.`);
  }
  if (!sameJson(snapshot.executionScope, scope)) throw new Error(`Parallel resumed child execution scope drift for lane ${JSON.stringify(lane.laneId)}.`);
  if (snapshot.cwd !== scope.cwd) throw new Error(`Parallel resumed child cwd drift for lane ${JSON.stringify(lane.laneId)}.`);
}
function expectedChildCompiledLoadout(run: MateriaParallelRunState, prepared: PreparedLane): ChildCastSnapshot["compiledLoadout"] {
  return {
    childLoadoutId: prepared.compiledLoadout.childLoadoutId,
    loadout: prepared.compiledLoadout.loadout,
    initialData: { ...prepared.compiledLoadout.initialData, ...boundedParallelChildData(run, prepared.stream) },
    nominalProgress: prepared.compiledLoadout.nominalProgress,
    loopId: run.loopId,
    laneId: prepared.stream.laneId,
  };
}
function childSessionPaths(session: NonNullable<MateriaParallelLaneState["childSession"]>): ChildCastSnapshot["paths"] {
  return { sessionPath: session.sessionPath, artifactRoot: session.artifactRoot, runDirectory: session.runDirectory };
}
function sameStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function sameNumbers(left: readonly number[], right: readonly number[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function sameJson(left: unknown, right: unknown): boolean { try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; } }
function validateDispatchConfig(config: EffectiveParallelConcurrencyConfig): void { if (!Number.isSafeInteger(config.maxConcurrency) || config.maxConcurrency < 1) throw new Error("parallel maxConcurrency must be a positive safe integer"); }
function isTerminalLaneStatus(status: string): boolean { return status === "accepted" || status === "failed" || status === "interrupted"; }

/** User-facing progress is best effort so the coordinator remains testable with a minimal context. */
function notifyParallelUser(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  const ui = (ctx as unknown as { ui?: { notify?: (text: string, severity: "info" | "warning" | "error") => void } }).ui;
  try {
    ui?.notify?.(message, level);
  } catch {
    // Progress notification must never turn a completed child launch into a
    // coordinator failure when the host session is being replaced.
  }
}
function aggregateParallelLaneFailureReason(run: MateriaParallelRunState): string { return boundedFailureReason(`Parallel fan-in skipped because not all branches were accepted: ${run.queueOrder.filter((id) => run.lanes[id]?.status !== "accepted").map((id) => `${id} (${run.lanes[id]?.status ?? "missing"}${run.lanes[id]?.failureReason ? `: ${run.lanes[id]!.failureReason}` : ""})`).join("; ")}.`); }
function compactParallelUsage(usage: MateriaParallelUsageTotals): MateriaParallelUsageTotals {
  return {
    tokens: { input: usage.tokens.input, output: usage.tokens.output, cacheRead: usage.tokens.cacheRead, cacheWrite: usage.tokens.cacheWrite, total: usage.tokens.total },
    cost: { input: usage.cost.input, output: usage.cost.output, cacheRead: usage.cost.cacheRead, cacheWrite: usage.cost.cacheWrite, total: usage.cost.total },
  };
}
function barrierSummary(run: MateriaParallelRunState, phase: "accepted" | "failed"): Record<string, unknown> {
  const statuses: Record<string, number> = {};
  for (const laneId of run.queueOrder) {
    const status = run.lanes[laneId]?.status ?? "interrupted";
    statuses[status] = (statuses[status] ?? 0) + 1;
  }
  return { reached: run.queueOrder.length, total: run.queueOrder.length, phase, statuses };
}
function boundedFailureReason(value: string, max = 1_000): string { const text = value.trim() || "parallel execution failed"; return text.length <= max ? text : `${text.slice(0, max - 1)}…`; }
function toParallelDiagnostic(value: unknown): ParallelLaneDiagnosticArtifact { const record = isRecord(value) ? value : {}; return { code: boundedFailureReason(typeof record.code === "string" ? record.code : "child_diagnostic", 120), message: boundedFailureReason(typeof record.message === "string" ? record.message : "Child emitted a diagnostic."), severity: record.severity === "info" || record.severity === "error" ? record.severity : "warning", occurredAt: typeof record.occurredAt === "number" ? record.occurredAt : Date.now() }; }
function cumulativeUsage(values: readonly (MateriaParallelUsageTotals | undefined)[]): MateriaParallelUsageTotals | undefined {
  const available = values.filter((value): value is MateriaParallelUsageTotals => value !== undefined);
  if (available.length === 0) return undefined;
  const maximum = (select: (value: MateriaParallelUsageTotals) => number) => Math.max(...available.map(select));
  return {
    tokens: { input: maximum((value) => value.tokens.input), output: maximum((value) => value.tokens.output), cacheRead: maximum((value) => value.tokens.cacheRead), cacheWrite: maximum((value) => value.tokens.cacheWrite), total: maximum((value) => value.tokens.total) },
    cost: { input: maximum((value) => value.cost.input), output: maximum((value) => value.cost.output), cacheRead: maximum((value) => value.cost.cacheRead), cacheWrite: maximum((value) => value.cost.cacheWrite), total: maximum((value) => value.cost.total) },
  };
}
function usageDelta(previous: MateriaParallelUsageTotals | undefined, current: MateriaParallelUsageTotals): MateriaParallelUsageTotals { const p = previous ?? { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; const delta = (a: number, b: number) => Math.max(0, a - b); return { tokens: { input: delta(current.tokens.input, p.tokens.input), output: delta(current.tokens.output, p.tokens.output), cacheRead: delta(current.tokens.cacheRead, p.tokens.cacheRead), cacheWrite: delta(current.tokens.cacheWrite, p.tokens.cacheWrite), total: delta(current.tokens.total, p.tokens.total) }, cost: { input: delta(current.cost.input, p.cost.input), output: delta(current.cost.output, p.cost.output), cacheRead: delta(current.cost.cacheRead, p.cost.cacheRead), cacheWrite: delta(current.cost.cacheWrite, p.cost.cacheWrite), total: delta(current.cost.total, p.cost.total) } }; }
function hasUsage(value: MateriaParallelUsageTotals): boolean { return Object.values(value.tokens).some((amount) => amount > 0) || Object.values(value.cost).some((amount) => amount > 0); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
