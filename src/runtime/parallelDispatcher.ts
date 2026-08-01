import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  ChildCastRunnerPort,
  ChildCastSnapshot,
  ChildCastTerminalResult,
  StartChildCastInput,
} from "../application/childCastRunner.js";
import { compileLoopRegionToChildLoadout, type CompiledLoopChildLoadout } from "../graph/loopCompiler.js";
import {
  applyParallelTransitionToCastState,
  attachParallelRunToCastState,
  createParallelRunState,
} from "./parallelCoordinatorState.js";
import type { MateriaCastState, MateriaLoopParallelConfig, MateriaParallelRunState, ResolvedMateriaSocket } from "../types.js";
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

export interface ParallelLoopDispatcherDependencies {
  children: ChildCastRunnerPort;
  workspaces: ParallelWorkspacePort;
  state: {
    saveCastState(pi: ExtensionAPI, state: MateriaCastState): void;
  };
  artifacts?: {
    appendEvent(runState: MateriaCastState["runState"], type: string, data: unknown): Promise<void>;
  };
  /** Injectable clock keeps scheduler tests deterministic. */
  now?: () => number;
}

interface PreparedLane {
  stream: NormalizedParallelStream;
  compiledLoadout: CompiledLoopChildLoadout;
  workspace?: ParallelWorkspaceRecord;
}

interface ActiveLane {
  prepared: PreparedLane;
  workspace: ParallelWorkspaceRecord;
  childCastId: string;
}

/**
 * Runtime coordinator for the fan-out half of a parallel loop.
 *
 * This module deliberately stops at child terminal state. Fan-in, conflict
 * resolution, cancellation, and final evaluation are later coordinator
 * phases; this scheduler only guarantees that the parent never enters the
 * member sockets and that child launches respect maxConcurrency.
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
    const existing = input.state.parallelRuns?.[input.loopId];
    if (existing) {
      this.#state = input.state;
      this.#run = existing;
      return true;
    }

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

    this.#state = input.state;
    this.#input = input;
    this.#run = run;
    this.#repositoryRoot = baseline.repositoryRoot;
    this.#prepared = prepared;
    this.#nextQueueIndex = 0;
    this.#active.clear();
    replaceState(input.state, attachParallelRunToCastState(input.state, run));
    this.#deps.state.saveCastState(input.pi, input.state);
    await this.#appendEvent(input.state, "parallel_dispatch_started", {
      loopId: input.loopId,
      runId: run.runId,
      planId: plan.planId,
      baseline: baseline.baseline,
      queueOrder: run.queueOrder,
      maxConcurrency: run.maxConcurrency,
    });

    // Empty plans are already represented as a completed run. There is no
    // child to launch and, importantly, no workspace side effect.
    if (prepared.length === 0) return true;

    await this.#pump();
    return true;
  }

  /** Return the run currently owned by this dispatcher, if any. */
  get run(): MateriaParallelRunState | undefined {
    return this.#run;
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
      while (this.#active.size < input.config.maxConcurrency && this.#nextQueueIndex < this.#prepared.length) {
        const prepared = this.#prepared[this.#nextQueueIndex++];
        if (!prepared) break;
        await this.#launchLane(input, state, prepared);
      }
    } finally {
      this.#dispatching = false;
    }
  }

  async #launchLane(input: ParallelLoopDispatchInput, state: MateriaCastState, prepared: PreparedLane): Promise<void> {
    const lane = this.#run?.lanes[prepared.stream.laneId];
    if (!lane || lane.status !== "queued") return;

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
    } catch (error) {
      await this.#markLaneFailure(input, state, prepared.stream.laneId, `workspace creation failed: ${errorMessage(error)}`);
      return;
    }

    const attempt = lane.attempt;
    const childCastId = childCastIdentity(state.castId, input.loopId, prepared.stream.laneId, attempt);
    const childPaths = lanePaths(state, input.loopId, prepared.stream.laneId, attempt);
    const childSession = {
      childCastId,
      sessionPath: childPaths.sessionPath,
      artifactRoot: childPaths.artifactRoot,
      runDirectory: childPaths.runDirectory,
    };
    const ownership = workspaceOwnership(state, input.loopId, prepared.stream.laneId, workspace);

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

    const active: ActiveLane = { prepared, workspace, childCastId };
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
      this.#deps.children.subscribe({ childCastId }, {
        onEvent: (event) => this.#handleChildEvent(input, state, prepared.stream, event),
        onTerminal: (result) => this.#handleChildTerminal(input, state, prepared.stream, active, result),
      });
      await this.#appendEvent(state, "parallel_lane_started", {
        loopId: input.loopId,
        runId: this.#run?.runId,
        laneId: prepared.stream.laneId,
        childCastId,
        streamIndex: prepared.stream.streamIndex,
        workItemIndexes: [...prepared.stream.workItemIndexes],
        workspace: ownership,
      });
    } catch (error) {
      this.#active.delete(prepared.stream.laneId);
      await this.#markLaneFailure(input, state, prepared.stream.laneId, `child launch failed: ${errorMessage(error)}`, childCastId);
    }
  }

  async #handleChildEvent(
    input: ParallelLoopDispatchInput,
    state: MateriaCastState,
    stream: NormalizedParallelStream,
    event: { childCastId: string; sequence: number; type: string; occurredAt: number; usage?: unknown },
  ): Promise<void> {
    const usage = isUsage(event.usage) ? event.usage : undefined;
    this.#applyLaneTransition(input, state, {
      laneId: stream.laneId,
      attempt: this.#run?.lanes[stream.laneId]?.attempt ?? 1,
      childCastId: event.childCastId,
      lastEvent: { sequence: event.sequence, type: event.type, occurredAt: event.occurredAt },
      ...(usage ? { usage } : {}),
      timestamp: event.occurredAt,
    });
  }

  async #handleChildTerminal(
    input: ParallelLoopDispatchInput,
    state: MateriaCastState,
    stream: NormalizedParallelStream,
    active: ActiveLane,
    result: ChildCastTerminalResult,
  ): Promise<void> {
    // The terminal callback can be delivered more than once by an adapter. The
    // active-map deletion makes releasing the scheduler slot idempotent.
    if (!this.#active.delete(stream.laneId)) return;

    const currentLane = this.#run?.lanes[stream.laneId];
    const attempt = currentLane?.attempt ?? 1;
    const childSnapshot = await this.#deps.children.observe({ childCastId: active.childCastId }).catch(() => undefined);
    const usage = childSnapshot && isUsage(childSnapshot.snapshot.usage) ? childSnapshot.snapshot.usage : undefined;
    const head = result.status === "succeeded" && result.accepted
      ? await this.#acceptedHead(active.workspace, result, childSnapshot?.snapshot)
      : undefined;

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
      const reason = result.error
        ?? (result.status === "succeeded" ? "Child completed without a verifiable accepted lane head." : "Child lane did not complete successfully.");
      this.#applyLaneTransition(input, state, {
        laneId: stream.laneId,
        attempt,
        childCastId: active.childCastId,
        status,
        ...(usage ? { usage } : {}),
        failureReason: reason,
        timestamp: result.endedAt,
      });
    }

    await this.#appendEvent(state, "parallel_lane_terminal", {
      loopId: input.loopId,
      runId: this.#run?.runId,
      laneId: stream.laneId,
      childCastId: active.childCastId,
      status: result.status,
      accepted: result.accepted,
      ...(head ? { acceptedHead: head } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
    await this.#pump();
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
  ): Promise<void> {
    const lane = this.#run?.lanes[laneId];
    if (!lane) return;
    this.#applyLaneTransition(input, state, {
      laneId,
      attempt: lane.attempt,
      ...(childCastId !== undefined ? { childCastId } : lane.childCastId !== undefined ? { childCastId: lane.childCastId } : {}),
      status: lane.status === "queued" ? "failed" : lane.status === "running" ? "failed" : undefined,
      failureReason: reason,
      timestamp: this.#now(),
    });
    await this.#appendEvent(state, "parallel_lane_failed", {
      loopId: input.loopId,
      runId: this.#run?.runId,
      laneId,
      ...(childCastId !== undefined ? { childCastId } : {}),
      error: reason,
    });
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
    if (!this.#deps.artifacts) return;
    await this.#deps.artifacts.appendEvent(state.runState, type, data).catch(() => undefined);
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

