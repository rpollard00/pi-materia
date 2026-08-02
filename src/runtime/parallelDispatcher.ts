import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collectAcceptedParallelBranches, type IntrinsicParallelFanInResult } from "../domain/parallelFanIn.js";
import { parallelBranchRegionForEntry } from "../graph/parallelRegions.js";
import type {
  ChildCastRunnerPort,
  ChildCastSnapshot,
  ChildCastStreamEvent,
  ChildCastTerminalResult,
  StartChildCastInput,
} from "../application/childCastRunner.js";
import type {
  ParallelFanInArtifactPort,
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
  ParallelFanInArtifactPort,
  ParallelLaneArtifactIdentity,
  ParallelLaneArtifactPaths,
  ParallelLaneArtifactPort,
  ParallelLaneDiagnosticArtifact,
  ParallelLaneEventArtifact,
  ParallelLaneRevisionArtifact,
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
    fanIn?: ParallelFanInArtifactPort;
  };
  runtimeEvents?: { emit(state: MateriaCastState, type: string, payload: Record<string, unknown>): Promise<void> };
  budget?: { assertBudget?(state: MateriaCastState, ctx: ExtensionContext): Promise<void> };
  onBudgetExceeded?(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, error: unknown, entryId: string): Promise<void>;
  now?: () => number;
}

interface PreparedLane {
  stream: NormalizedParallelStream;
  compiledLoadout: CompiledLoopChildLoadout;
  recoveryChildCastId?: string;
  recoveryAfterSequence?: number;
  resumeChild?: boolean;
}

interface ActiveLane {
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
        configIdentity: { configHash: input.state.configHash, loopId: input.loopId, maxConcurrency: input.config.maxConcurrency },
        queue: plan.streams.map((stream) => ({ laneId: stream.laneId, name: stream.name, streamIndex: stream.streamIndex, workItemIndexes: [...stream.workItemIndexes] })),
        now: this.#now(),
      });
      this.#run = run;
      this.#prepared = prepared;
      this.#nextQueueIndex = 0;
      this.#active.clear();
      this.#eventTails.clear();
      this.#latestUsage.clear();
      this.#budgetFailure = undefined;
      this.#terminalPromise = undefined;
      replaceParallelState(input.state, attachParallelRunToCastState(input.state, run));
      this.#deps.state.saveCastState(input.pi, input.state);
      await this.#appendEvent(input.state, "parallel_dispatch_started", {
        parentCastId: input.state.castId,
        loopId: input.loopId,
        runId: run.runId,
        planId: plan.planId,
        baseScopeId: (input.state.baseScope ?? createBaseExecutionScope(input.state.castId, input.state.cwd)).id,
        queueOrder: run.queueOrder,
        maxConcurrency: run.maxConcurrency,
      });
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
    if (run.configIdentity.configHash !== input.state.configHash || run.maxConcurrency !== input.config.maxConcurrency) issues.push({ code: "config_mismatch", path: "run.configIdentity", message: "parallel configuration changed" });
    if (plan && (run.planIdentity.planId !== plan.planId || run.planIdentity.version !== plan.version || run.planIdentity.workItemCount !== plan.workItemCount)) issues.push({ code: "plan_mismatch", path: "run.planIdentity", message: "normalized parallel plan changed" });
    for (const lane of Object.values(run.lanes)) {
      if (lane.status === "accepted" && !lane.executionScope) issues.push({ code: "scope_missing", path: `lanes.${lane.laneId}.executionScope`, laneId: lane.laneId, message: "accepted branch has no persisted execution scope" });
      if (lane.executionScope && input.state.branchScopes?.[lane.executionScope.id]?.id !== lane.executionScope.id) issues.push({ code: "scope_drift", path: `lanes.${lane.laneId}.executionScope`, laneId: lane.laneId, message: "persisted branch scope differs from cast branch scopes" });
    }
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
          prepared.recoveryChildCastId = lane.childCastId;
          prepared.resumeChild = true;
          prepared.recoveryAfterSequence = lane.lastEvent?.sequence ?? observation.events.at(-1)?.sequence ?? 0;
          this.#latestUsage.set(lane.childCastId, observation.snapshot.usage);
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
    this.#run = next;
    this.#prepared = allCompiled;
    this.#nextQueueIndex = 0;
    this.#active.clear();
    this.#cancelRequested = false;
    this.#cancelPromise = undefined;
    this.#terminalPromise = undefined;
    replaceParallelState(input.state, { ...input.state, active: true, awaitingResponse: false, socketState: "running_parallel", failedReason: undefined, parallelRuns: { ...(input.state.parallelRuns ?? {}), [input.loopId]: next } });
    this.#deps.state.saveCastState(input.pi, input.state);
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
    if (previous === undefined || previous === castId || this.#initialization || this.#active.size > 0) return;
    this.#run = undefined; this.#prepared = []; this.#nextQueueIndex = 0; this.#eventTails.clear(); this.#latestUsage.clear();
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
      while (!this.#cancelRequested && !this.#budgetFailure && this.#active.size < input.config.maxConcurrency && this.#nextQueueIndex < this.#prepared.length) {
        const prepared = this.#prepared[this.#nextQueueIndex++];
        if (prepared) await this.#launchLane(input, state, prepared);
      }
    });
    await this.#pumpTail;
  }

  async #launchLane(input: ParallelLoopDispatchInput, state: MateriaCastState, prepared: PreparedLane): Promise<void> {
    const lane = this.#run?.lanes[prepared.stream.laneId];
    if (!lane || lane.status !== "queued") return;
    const attempt = lane.attempt;
    const childCastId = prepared.recoveryChildCastId ?? childCastIdentity(state.castId, input.loopId, lane.laneId, attempt);
    const paths = lanePaths(state, input.loopId, lane.laneId, attempt);
    const baseScope = state.baseScope ?? createBaseExecutionScope(state.castId, state.cwd);
    const scope = cloneParallelBranchExecutionScope(baseScope, input.loopId, lane.laneId);
    state.branchScopes = { ...(state.branchScopes ?? {}), [scope.id]: scope };
    const identity: ParallelLaneArtifactIdentity = { parentCastId: state.castId, runId: this.#run!.runId, loopId: input.loopId, laneId: lane.laneId, childCastId, attempt, streamIndex: lane.streamIndex, workItemIndexes: [...lane.workItemIndexes], paths };
    const artifactPaths = await this.#initializeLaneArtifacts(identity, state);
    const childSession = { childCastId, sessionPath: paths.sessionPath, artifactRoot: paths.artifactRoot, runDirectory: paths.runDirectory };
    if (!this.#applyLaneTransition(input, state, { laneId: lane.laneId, attempt, childCastId, status: "running", executionScope: scope, childSession, timestamp: this.#now() })) return;
    const active: ActiveLane = { childCastId, attempt, artifactIdentity: identity, artifactPaths };
    this.#active.set(lane.laneId, active);
    const startInput: StartChildCastInput = {
      identity: { childCastId, parentCastId: state.castId, loopId: input.loopId, laneId: lane.laneId },
      request: state.request,
      cwd: scope.cwd,
      executionScope: scope,
      compiledLoadout: {
        childLoadoutId: prepared.compiledLoadout.childLoadoutId,
        loadout: prepared.compiledLoadout.loadout,
        initialData: { ...prepared.compiledLoadout.initialData, ...boundedParallelChildData(this.#run!, prepared.stream) },
        loopId: input.loopId,
        laneId: lane.laneId,
      },
      paths,
      attempt,
    };
    try {
      if (prepared.resumeChild) await this.#deps.children.resume({ childCastId, mode: "resume" });
      else await this.#deps.children.start(startInput);
      if (this.#cancelRequested) { await this.#abortChild(childCastId, "parallel execution cancelled"); return; }
      active.subscription = this.#deps.children.subscribe({ childCastId, afterSequence: prepared.recoveryAfterSequence }, {
        onEvent: (event) => this.#handleChildEvent(input, state, prepared.stream, active, event),
        onTerminal: (result) => this.#handleChildTerminal(input, state, prepared.stream, active, result),
      });
      await this.#appendEvent(state, "parallel_lane_started", { parentCastId: state.castId, loopId: input.loopId, runId: this.#run?.runId, laneId: lane.laneId, childCastId, executionScope: { id: scope.id, cwd: scope.cwd }, ...(artifactPaths ? { artifactPaths } : {}) });
    } catch (error) {
      this.#active.delete(lane.laneId);
      await this.#deps.children.abort({ childCastId, reason: `child launch failed: ${parallelErrorMessage(error)}` }).catch(() => undefined);
      if (this.#cancelRequested) return;
      await this.#failLane(input, state, prepared.stream, identity, `child launch failed: ${parallelErrorMessage(error)}`);
    }
  }

  async #handleChildEvent(input: ParallelLoopDispatchInput, state: MateriaCastState, stream: NormalizedParallelStream, active: ActiveLane, event: ChildCastStreamEvent): Promise<void> {
    // Usage already delivered by the child runner remains authoritative during
    // cancellation. Other late callbacks must not mutate a terminal lane.
    const usage = isParallelUsage(event.usage) ? event.usage : undefined;
    if (this.#cancelRequested && !usage) return;
    const previous = this.#eventTails.get(active.childCastId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const provenance = this.#eventProvenance(state, input.loopId, stream, active, event.sequence, event.workItemId);
      await this.#appendLaneArtifact(active.artifactIdentity, { provenance, event });
      await this.#appendEvent(state, "parallel_child_event", { provenance, event });
      const applied = this.#applyLaneTransition(input, state, { laneId: stream.laneId, attempt: active.attempt, childCastId: event.childCastId, lastEvent: { sequence: event.sequence, type: event.type, occurredAt: event.occurredAt }, ...(usage ? { usage } : {}), timestamp: event.occurredAt });
      if (usage && applied) await this.#aggregateUsage(state, input, stream, active, usage);
    });
    this.#eventTails.set(active.childCastId, next);
    try { await next; } finally { if (this.#eventTails.get(active.childCastId) === next) this.#eventTails.delete(active.childCastId); }
  }

  async #handleChildTerminal(input: ParallelLoopDispatchInput, state: MateriaCastState, stream: NormalizedParallelStream, active: ActiveLane, result: ChildCastTerminalResult): Promise<void> {
    if (this.#cancelRequested) return;
    await this.#eventTails.get(active.childCastId)?.catch(() => undefined);
    if (this.#cancelRequested || this.#budgetFailure || !this.#active.delete(stream.laneId)) return;
    active.subscription?.unsubscribe();
    const observation = await this.#deps.children.observe({ childCastId: active.childCastId }).catch(() => undefined);
    const usage = highestUsage([observation && isParallelUsage(observation.snapshot.usage) ? observation.snapshot.usage : undefined, isParallelUsage(result.usage) ? result.usage : undefined, this.#latestUsage.get(active.childCastId)]);
    if (usage) await this.#aggregateUsage(state, input, stream, active, usage);
    if (this.#budgetFailure) return;
    const accepted = result.status === "succeeded" && result.accepted;
    const reason = result.error ?? (accepted ? undefined : "Child lane did not complete with an accepted result.");
    const terminalScope = accepted
      ? cloneExecutionScope(observation?.snapshot.executionScope ?? this.#run!.lanes[stream.laneId]!.executionScope!)
      : undefined;
    if (terminalScope) state.branchScopes = { ...(state.branchScopes ?? {}), [terminalScope.id]: terminalScope };
    this.#applyLaneTransition(input, state, {
      laneId: stream.laneId, attempt: active.attempt, childCastId: active.childCastId,
      status: accepted ? "accepted" : result.status === "interrupted" ? "interrupted" : "failed",
      accepted,
      ...(terminalScope ? { executionScope: terminalScope } : {}),
      ...(accepted && result.output !== undefined ? { terminalOutput: result.output } : {}),
      ...(usage ? { usage } : {}),
      ...(reason ? { failureReason: boundedFailureReason(reason), diagnostic: { code: "parallel_lane_terminal", message: boundedFailureReason(reason), severity: "error", occurredAt: result.endedAt } } : { failureReason: undefined }),
      timestamp: result.endedAt,
    });
    const diagnostics = observation?.snapshot.diagnostics.map(toParallelDiagnostic) ?? [];
    await this.#writeTerminal(active, result, usage, diagnostics);
    await this.#appendEvent(state, "parallel_lane_terminal", { ...this.#eventProvenance(state, input.loopId, stream, active), status: result.status, accepted, ...(result.output !== undefined ? { output: result.output } : {}), ...(reason ? { error: boundedFailureReason(reason) } : {}), ...(usage ? { usage } : {}) });
    await this.#pump();
    await this.#maybeAllTerminal(input, state);
  }

  async #maybeAllTerminal(input: ParallelLoopDispatchInput, state: MateriaCastState): Promise<void> {
    const run = this.#run;
    if (!run || this.#active.size || this.#nextQueueIndex < this.#prepared.length || !Object.values(run.lanes).every((lane) => isTerminalLaneStatus(lane.status))) return;
    if (this.#terminalPromise) return this.#terminalPromise;
    this.#terminalPromise = this.#settleAllTerminal(input, state, run);
    try { await this.#terminalPromise; } finally { this.#terminalPromise = undefined; }
  }

  async #settleAllTerminal(input: ParallelLoopDispatchInput, state: MateriaCastState, run: MateriaParallelRunState): Promise<void> {
    const rejected = Object.values(run.lanes).filter((lane) => lane.status !== "accepted");
    if (rejected.length) {
      const reason = aggregateParallelLaneFailureReason(run);
      this.#transitionRun(input, state, "failed", "skipped");
      await this.#appendEvent(state, "parallel_branches_failed", { loopId: input.loopId, runId: run.runId, reason, laneStatuses: Object.fromEntries(Object.entries(run.lanes).map(([id, lane]) => [id, lane.status])) });
      await this.#notifyRunFailure(input, state, run.runId, reason);
      return;
    }
    const result = collectAcceptedParallelBranches(run);
    // Persist the accepted barrier before invoking parent advancement. This is
    // the exactly-once guard against duplicate terminal callbacks.
    this.#transitionRun(input, state, "completed", "accepted");
    await this.#appendEvent(state, "parallel_branches_terminal", {
      loopId: input.loopId,
      runId: run.runId,
      orderedBranches: result.orderedBranches,
    });
    if (!input.onFanIn) return;
    try {
      await input.onFanIn({ loopId: input.loopId, runId: run.runId, result });
    } catch (error) {
      const reason = boundedFailureReason(`Parallel barrier advancement failed: ${parallelErrorMessage(error)}`);
      await this.#notifyRunFailure(input, state, run.runId, reason);
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
        if (!lane) continue;
        const observation = await this.#deps.children.observe({ childCastId }).catch(() => undefined);
        if (!observation || !isParallelUsage(observation.snapshot.usage)) continue;
        if (!this.#latestUsage.has(childCastId) && lane.usage) this.#latestUsage.set(childCastId, lane.usage);
        await this.#aggregateUsage(state, dispatchInput, streamForPersistedLane(lane), activeForPersistedLane(state, run, lane), observation.snapshot.usage, false);
      }

      await Promise.all([...childIds].map((childCastId) => this.#abortChild(childCastId, reason)));
      const timestamp = this.#now();
      for (const laneId of run.queueOrder) {
        const lane = this.#run?.lanes[laneId];
        if (!lane || isTerminalLaneStatus(lane.status)) continue;
        this.#applyLaneTransition(dispatchInput, state, { laneId, attempt: lane.attempt, ...(lane.childCastId ? { childCastId: lane.childCastId } : {}), status: "interrupted", failureReason: reason, diagnostic: { code: "parallel_cancelled", message: reason, severity: "warning", occurredAt: timestamp }, timestamp });
      }
      for (const lane of active) lane.subscription?.unsubscribe();
      this.#transitionRun(dispatchInput, state, "failed", "skipped");
      await this.#appendEvent(state, "parallel_cancelled", { loopId: run.loopId, runId: run.runId, reason });
    }
    this.#active.clear();
  }

  async #abortChild(childCastId: string, reason: string): Promise<void> { await this.#deps.children.abort({ childCastId, reason }).catch(() => undefined); }

  async #aggregateUsage(state: MateriaCastState, input: ParallelLoopDispatchInput, stream: NormalizedParallelStream, active: ActiveLane, usage: MateriaParallelUsageTotals, enforceBudget = true): Promise<void> {
    const delta = usageDelta(this.#latestUsage.get(active.childCastId), usage);
    this.#latestUsage.set(active.childCastId, usage);
    if (!hasUsage(delta)) return;
    const report = state.runState.usage;
    report.byMateria ??= {}; report.bySocket ??= {}; report.byTask ??= {}; report.byAttempt ??= {};
    addUsage(report, delta, { socket: `parallel/${input.loopId}/${stream.laneId}`, materia: "parallel-child", taskId: stream.laneId, attempt: active.attempt });
    this.#deps.state.saveCastState(input.pi, state);
    const write = this.#deps.artifacts?.writeUsage;
    if (write) { this.#usageWriteTail = this.#usageWriteTail.catch(() => undefined).then(() => write(state.runState)); await this.#usageWriteTail.catch(() => undefined); }
    await this.#deps.artifacts?.lane?.writeUsage({ ...active.artifactIdentity, usage }).catch(() => undefined);
    if (enforceBudget) {
      try { await this.#deps.budget?.assertBudget?.(state, input.ctx); }
      catch (error) { await this.#enforceBudget(input, state, error); }
    }
  }

  async #enforceBudget(input: ParallelLoopDispatchInput, state: MateriaCastState, error: unknown): Promise<void> {
    if (this.#budgetFailure) return;
    this.#budgetFailure = error instanceof Error ? error : new Error(String(error));
    const reason = boundedFailureReason(`Parallel parent budget exhausted: ${parallelErrorMessage(error)}`);
    const active = [...this.#active.values()]; this.#active.clear(); this.#nextQueueIndex = this.#prepared.length;
    for (const lane of Object.values(this.#run?.lanes ?? {})) {
      if (isTerminalLaneStatus(lane.status)) continue;
      this.#applyLaneTransition(input, state, { laneId: lane.laneId, attempt: lane.attempt, ...(lane.childCastId ? { childCastId: lane.childCastId } : {}), status: lane.status === "running" ? "interrupted" : "failed", failureReason: reason, diagnostic: { code: "parallel_budget_exceeded", message: reason, severity: "error", occurredAt: this.#now() }, timestamp: this.#now() });
    }
    this.#transitionRun(input, state, "failed", "failed");
    await Promise.all(active.map((lane) => this.#abortChild(lane.childCastId, reason)));
    await this.#deps.onBudgetExceeded?.(input.pi, input.ctx, state, this.#budgetFailure, `parallel:${input.loopId}`).catch(() => undefined);
  }

  async #failLane(input: ParallelLoopDispatchInput, state: MateriaCastState, stream: NormalizedParallelStream, identity: ParallelLaneArtifactIdentity, reason: string): Promise<void> {
    const message = boundedFailureReason(reason); const endedAt = this.#now();
    this.#applyLaneTransition(input, state, { laneId: stream.laneId, attempt: identity.attempt, childCastId: identity.childCastId, status: "failed", failureReason: message, diagnostic: { code: "parallel_lane_failure", message, severity: "error", occurredAt: endedAt }, timestamp: endedAt });
    await this.#writeTerminal({ childCastId: identity.childCastId, attempt: identity.attempt, artifactIdentity: identity }, { status: "failed", accepted: false, endedAt, error: message }, undefined, []);
  }

  #transitionRun(input: ParallelLoopDispatchInput, state: MateriaCastState, phase: Parameters<typeof applyParallelRunPhaseTransition>[1]["phase"], fanInPhase: Parameters<typeof applyParallelRunPhaseTransition>[1]["fanInPhase"]): void {
    if (!this.#run) return;
    const changed = applyParallelRunPhaseTransition(this.#run, { parentCastId: state.castId, loopId: input.loopId, runId: this.#run.runId, phase, fanInPhase, timestamp: this.#now() });
    if (!changed.applied) return;
    replaceParallelState(state, { ...state, parallelRuns: { ...(state.parallelRuns ?? {}), [input.loopId]: changed.state } });
    this.#run = changed.state; this.#deps.state.saveCastState(input.pi, state);
  }

  #applyLaneTransition(input: ParallelLoopDispatchInput, state: MateriaCastState, transition: Omit<Parameters<typeof applyParallelTransitionToCastState>[1], "parentCastId" | "castId" | "loopId" | "runId">): boolean {
    if (!this.#run) return false;
    const result = applyParallelTransitionToCastState(state, { parentCastId: state.castId, loopId: input.loopId, runId: this.#run.runId, ...transition });
    if (!result.applied) return false;
    replaceParallelState(state, result.state); this.#run = state.parallelRuns?.[input.loopId]; this.#deps.state.saveCastState(input.pi, state); return true;
  }

  async #notifyRunFailure(input: ParallelLoopDispatchInput, state: MateriaCastState, runId: string, reason: string): Promise<void> {
    if (input.onFailure) { await input.onFailure({ loopId: input.loopId, runId, reason }).catch(() => undefined); return; }
    state.active = false; state.awaitingResponse = false; state.socketState = "failed"; state.phase = "failed"; state.failedReason = reason; state.runState.lastMessage = reason; state.runState.endedAt ??= this.#now(); this.#deps.state.saveCastState(input.pi, state);
  }

  async #initializeLaneArtifacts(identity: ParallelLaneArtifactIdentity, state: MateriaCastState): Promise<ParallelLaneArtifactPaths | undefined> {
    try { return await this.#deps.artifacts?.lane?.initialize(identity); }
    catch (error) { await this.#appendEvent(state, "parallel_artifact_failure", { laneId: identity.laneId, operation: "initialize", error: boundedFailureReason(parallelErrorMessage(error)) }); return undefined; }
  }
  async #appendLaneArtifact(identity: ParallelLaneArtifactIdentity, event: ParallelLaneEventArtifact): Promise<void> { await this.#deps.artifacts?.lane?.appendEvent({ ...identity, event }).catch(() => undefined); }
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

export function parallelLoopForSocket(state: MateriaCastState, socketId: string): { loopId: string; config: NonNullable<MateriaCastState["pipeline"]["loops"]>[string]["parallel"] } | undefined {
  const region = parallelBranchRegionForEntry(state.pipeline, socketId);
  if (!region) return undefined;
  const config = state.pipeline.loops?.[region.loopId]?.parallel;
  return config ? { loopId: region.loopId, config } : undefined;
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
    artifactIdentity: {
      parentCastId: state.castId,
      runId: run.runId,
      loopId: run.loopId,
      laneId: lane.laneId,
      childCastId,
      attempt: lane.attempt,
      streamIndex: lane.streamIndex,
      workItemIndexes: [...lane.workItemIndexes],
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
function boundedParallelChildData(run: MateriaParallelRunState, stream: NormalizedParallelStream): Record<string, unknown> {
  return { parallelContext: boundedParallelContext(run, stream), parallelRun: { runId: run.runId, planId: run.planIdentity.planId, loopId: run.loopId, laneId: stream.laneId }, parallelLane: { laneId: stream.laneId, name: stream.name, streamIndex: stream.streamIndex, workItemIndexes: [...stream.workItemIndexes] } };
}
function validateDispatchConfig(config: EffectiveParallelConcurrencyConfig): void { if (!Number.isSafeInteger(config.maxConcurrency) || config.maxConcurrency < 1) throw new Error("parallel maxConcurrency must be a positive safe integer"); }
function isTerminalLaneStatus(status: string): boolean { return status === "accepted" || status === "failed" || status === "interrupted"; }
function aggregateParallelLaneFailureReason(run: MateriaParallelRunState): string { return boundedFailureReason(`Parallel fan-in skipped because not all branches were accepted: ${run.queueOrder.filter((id) => run.lanes[id]?.status !== "accepted").map((id) => `${id} (${run.lanes[id]?.status ?? "missing"}${run.lanes[id]?.failureReason ? `: ${run.lanes[id]!.failureReason}` : ""})`).join("; ")}.`); }
function boundedFailureReason(value: string, max = 1_000): string { const text = value.trim() || "parallel execution failed"; return text.length <= max ? text : `${text.slice(0, max - 1)}…`; }
function toParallelDiagnostic(value: unknown): ParallelLaneDiagnosticArtifact { const record = isRecord(value) ? value : {}; return { code: boundedFailureReason(typeof record.code === "string" ? record.code : "child_diagnostic", 120), message: boundedFailureReason(typeof record.message === "string" ? record.message : "Child emitted a diagnostic."), severity: record.severity === "info" || record.severity === "error" ? record.severity : "warning", occurredAt: typeof record.occurredAt === "number" ? record.occurredAt : Date.now() }; }
function highestUsage(values: readonly (MateriaParallelUsageTotals | undefined)[]): MateriaParallelUsageTotals | undefined { return values.filter((value): value is MateriaParallelUsageTotals => value !== undefined).sort((a, b) => b.tokens.total - a.tokens.total)[0]; }
function usageDelta(previous: MateriaParallelUsageTotals | undefined, current: MateriaParallelUsageTotals): MateriaParallelUsageTotals { const p = previous ?? { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; const delta = (a: number, b: number) => Math.max(0, a - b); return { tokens: { input: delta(current.tokens.input, p.tokens.input), output: delta(current.tokens.output, p.tokens.output), cacheRead: delta(current.tokens.cacheRead, p.tokens.cacheRead), cacheWrite: delta(current.tokens.cacheWrite, p.tokens.cacheWrite), total: delta(current.tokens.total, p.tokens.total) }, cost: { input: delta(current.cost.input, p.cost.input), output: delta(current.cost.output, p.cost.output), cacheRead: delta(current.cost.cacheRead, p.cost.cacheRead), cacheWrite: delta(current.cost.cacheWrite, p.cost.cacheWrite), total: delta(current.cost.total, p.cost.total) } }; }
function hasUsage(value: MateriaParallelUsageTotals): boolean { return value.tokens.total > 0 || value.cost.total > 0; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
