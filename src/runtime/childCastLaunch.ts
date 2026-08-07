import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  normalizeChildCastRecoveryOperation,
  type ChildCastLaunchSpec,
  type ChildCastOperation,
  type ChildCastIdentity,
} from "../application/childCastRunner.js";
import { cloneExecutionScope, type ExecutionScope } from "../domain/executionScope.js";
import type { NominalParallelLaneProgressDefinition } from "../domain/parallelProgress.js";
import type { MateriaCastState, ResolvedMateriaPipeline } from "../types.js";
import { currentSocketOrThrow, isAgentResolvedSocket } from "./sessionState.js";
import type { MateriaPluginAdapters } from "./pluginAdapters.js";
import { beginChildProgressCheckpointEmission } from "./childProgressCheckpoints.js";
import { beginChildUsageCheckpointEmission } from "./childUsageCheckpoints.js";

/**
 * Execute the fixed `/materia child <spec>` command used by the subprocess
 * adapter. The request, graph, and lane seed are read from the launch file;
 * none of them are placed in the Pi command line.
 */
export async function runChildCastLaunch(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  adapters: Pick<MateriaPluginAdapters, "configs" | "pipeline" | "states" | "lifecycle">,
  specPath: string,
): Promise<void> {
  const spec = await readChildLaunchSpec(specPath);
  const loaded = await adapters.configs.load(ctx.cwd, spec.configPath);
  const pipeline = isResolvedPipeline(spec.compiledLoadout.loadout)
    ? spec.compiledLoadout.loadout
    : adapters.pipeline.resolve(loaded.config);

  const stopUsageCheckpoints = beginChildUsageCheckpointEmission();
  const progressDefinition = validNominalProgress(spec.compiledLoadout.nominalProgress);
  const stopProgressCheckpoints = progressDefinition
    ? beginChildProgressCheckpointEmission(
        progressDefinition,
        childLoopCursor(pipeline, spec.compiledLoadout.loopId),
      )
    : () => undefined;
  try {
    const retained = spec.operation === "start"
      ? undefined
      : await locateRetainedChildCast(adapters.states, ctx, spec, pipeline);
    const passiveRevive = spec.operation === "revive" && retained?.recoveryExhaustion === undefined;

    // A parent can be interrupted after the child persisted its active state
    // but before the child process emitted a terminal marker. Recovery is the
    // parent's authorization to reconcile that orphaned state before native
    // revive/recast applies its normal active-cast checks.
    if (retained?.active) {
      const orphanReason = `parallel parent interrupted child lane ${spec.identity.laneId}`;
      await adapters.lifecycle.clear(pi, retained, orphanReason);
      // Keep recovery deterministic for compatibility lifecycle adapters that
      // report clear as fire-and-forget. The native adapter persists this
      // transition itself; this fallback preserves the same local invariant.
      if (retained.active) {
        retained.active = false;
        retained.awaitingResponse = false;
        retained.socketState = "failed";
        retained.phase = "failed";
        retained.failedReason = orphanReason;
        retained.runState.endedAt ??= Date.now();
      }
    }

    if (spec.operation === "start") {
      await adapters.lifecycle.start(
        pi,
        ctx,
        loaded,
        pipeline,
        spec.request,
        {
          initialData: { ...spec.compiledLoadout.initialData },
          initialExecutionScope: spec.executionScope,
          startEventDetails: {
            childCast: {
              childCastId: spec.identity.childCastId,
              parentCastId: spec.identity.parentCastId,
              loopId: spec.identity.loopId,
              laneId: spec.identity.laneId,
              attempt: spec.attempt,
              operation: spec.operation,
            },
          },
        },
      );
    } else if (spec.operation === "revive") {
      await adapters.lifecycle.revive(pi, ctx, retained!.castId);
    } else {
      // The native cast lifecycle calls this operation `resume`; the child
      // protocol deliberately exposes the clearer `recast` spelling.
      await adapters.lifecycle.resume(pi, ctx, retained!.castId);
    }

    if (passiveRevive) {
      await continuePassiveChildRevive(pi, ctx, adapters, retained!, pipeline, spec.identity);
    }

    // startSocket and agent-end advancement can queue the next prompt on a
    // zero-delay timer. A single waitForIdle() only waits for the turn that was
    // active when the command started; it can return in the small gap before a
    // deferred prompt is dispatched. Keep the child process alive until its
    // persisted cast is actually terminal so the parent never mistakes an
    // in-flight lane for a failed child.
    const state = await waitForChildCastTerminal(ctx, () => adapters.states.loadActive(ctx));
    const result = terminalResult(state);
    emitChildTerminal(result);
  } finally {
    stopProgressCheckpoints();
    stopUsageCheckpoints();
  }
}

/**
 * Wait for the whole sequential child cast, not merely the current Pi turn.
 *
 * `waitForIdle()` is intentionally turn-scoped in Pi. Between automatic
 * socket turns pi-materia may have an active persisted cast while Pi is
 * briefly idle, so yield once after each idle observation to let deferred
 * advancement dispatch its next turn.
 */
export async function waitForChildCastTerminal(
  ctx: Pick<ExtensionCommandContext, "waitForIdle">,
  loadState: () => MateriaCastState | undefined,
): Promise<MateriaCastState | undefined> {
  while (true) {
    await ctx.waitForIdle();
    const state = loadState();
    if (!state || !state.active) return state;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

export async function readChildLaunchSpec(file: string): Promise<ChildCastLaunchSpec> {
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!isRecord(parsed) || parsed.version !== 1 || !validIdentity(parsed.identity) || typeof parsed.request !== "string" || typeof parsed.cwd !== "string" || !isRecord(parsed.compiledLoadout) || !validPaths(parsed.paths) || !validExecutionScope(parsed.executionScope) || typeof parsed.attempt !== "number" || !Number.isSafeInteger(parsed.attempt) || parsed.attempt < 1 || (parsed.configPath !== undefined && typeof parsed.configPath !== "string") || (parsed.operation !== undefined && !validChildCastLaunchOperation(parsed.operation))) {
    throw new Error(`Invalid child launch specification: ${file}`);
  }
  return { ...parsed, operation: normalizeChildCastLaunchOperation(parsed.operation) } as unknown as ChildCastLaunchSpec;
}

interface ChildTerminalPayload {
  status: "succeeded" | "failed" | "interrupted";
  accepted: boolean;
  endedAt: number;
  message?: string;
  error?: string;
  output?: unknown;
  usage?: unknown;
  executionScope?: ExecutionScope;
}

function terminalResult(state: MateriaCastState | undefined): ChildTerminalPayload {
  if (!state) {
    return { status: "failed", accepted: false, endedAt: Date.now(), error: "Child cast did not persist a terminal state." };
  }
  const usage = state.runState.usage;
  if (state.active) {
    return {
      status: "interrupted",
      accepted: false,
      endedAt: Date.now(),
      error: "Child cast remained active after Pi became idle.",
      usage: { tokens: usage.tokens, cost: usage.cost },
      executionScope: cloneExecutionScope(state.activeScope),
    };
  }
  if (state.phase === "complete" && state.socketState === "complete" && !state.failedReason) {
    return {
      status: "succeeded",
      accepted: true,
      endedAt: state.runState.endedAt ?? Date.now(),
      message: state.runState.lastMessage,
      ...(state.lastJson !== undefined ? { output: state.lastJson } : state.lastOutput !== undefined ? { output: state.lastOutput } : {}),
      usage: { tokens: usage.tokens, cost: usage.cost },
      executionScope: cloneExecutionScope(state.activeScope),
    };
  }
  return {
    status: "failed",
    accepted: false,
    endedAt: state.runState.endedAt ?? Date.now(),
    error: state.failedReason ?? "Child cast ended without an accepted terminal state.",
    ...(state.lastJson !== undefined ? { output: state.lastJson } : state.lastOutput !== undefined ? { output: state.lastOutput } : {}),
    usage: { tokens: usage.tokens, cost: usage.cost },
    executionScope: cloneExecutionScope(state.activeScope),
  };
}

function emitChildTerminal(result: ChildTerminalPayload): void {
  // JSON mode reserves stdout for JSONL. The host's stdout guard may redirect
  // this direct extension write to stderr, so the parent accepts the marker on
  // either channel. It remains a single JSON record so the parent can
  // distinguish an accepted cast from a clean but non-terminal process exit.
  process.stdout.write(`${JSON.stringify({ type: "pi_materia_child_terminal", result, ...(result.usage !== undefined ? { usage: result.usage } : {}) })}\n`);
}

function validIdentity(value: unknown): boolean {
  return isRecord(value) && ["childCastId", "parentCastId", "loopId", "laneId"].every((key) => typeof value[key] === "string" && value[key].trim().length > 0);
}

function validPaths(value: unknown): boolean {
  return isRecord(value) && ["sessionPath", "artifactRoot", "runDirectory"].every((key) => typeof value[key] === "string" && value[key].trim().length > 0);
}

function validExecutionScope(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === "string"
    && value.id.trim().length > 0
    && typeof value.cwd === "string"
    && value.cwd.trim().length > 0
    && isRecord(value.state)
    && isRecord(value.exports);
}

function isResolvedPipeline(value: unknown): value is ResolvedMateriaPipeline {
  return isRecord(value) && isRecord(value.entry) && isRecord(value.entry.socket) && isRecord(value.entry.materia);
}

function validNominalProgress(value: unknown): NominalParallelLaneProgressDefinition | undefined {
  if (!isRecord(value) || !Array.isArray(value.orderedLoopSocketIds)) return undefined;
  if (!value.orderedLoopSocketIds.every((id) => typeof id === "string" && id.length > 0)) return undefined;
  if (typeof value.workItemCount !== "number" || !Number.isSafeInteger(value.workItemCount) || value.workItemCount < 0) return undefined;
  return {
    orderedLoopSocketIds: [...value.orderedLoopSocketIds] as string[],
    workItemCount: value.workItemCount,
  };
}

function childLoopCursor(pipeline: ResolvedMateriaPipeline, loopId: string | undefined): string {
  const selected = loopId !== undefined ? pipeline.loops?.[loopId] : undefined;
  const loop = selected ?? Object.values(pipeline.loops ?? {}).find((candidate) => candidate?.iterator);
  return loop?.iterator?.cursor ?? "workItemIndex";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validChildCastLaunchOperation(value: unknown): value is ChildCastOperation | "resume" | "restart" {
  return value === "start" || value === "revive" || value === "recast" || value === "resume" || value === "restart";
}

function normalizeChildCastLaunchOperation(value: unknown): ChildCastOperation {
  if (value === undefined || value === "start") return "start";
  if (value === "revive" || value === "recast") return value;
  return normalizeChildCastRecoveryOperation(value as "resume" | "restart");
}

async function locateRetainedChildCast(
  states: Pick<MateriaPluginAdapters["states"], "listLatest">,
  ctx: ExtensionCommandContext,
  spec: ChildCastLaunchSpec,
  pipeline: ResolvedMateriaPipeline,
): Promise<MateriaCastState> {
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  if (typeof sessionFile === "string" && sessionFile !== spec.paths.sessionPath) {
    throw new Error(`Child cast recovery session drifted: expected ${JSON.stringify(spec.paths.sessionPath)}, got ${JSON.stringify(sessionFile)}.`);
  }
  const candidates = states.listLatest(ctx).filter((state) =>
    state.request === spec.request
    && state.cwd === spec.cwd
    && state.artifactRoot === spec.paths.artifactRoot,
  );
  if (candidates.length === 0) {
    throw new Error(`Unable to recover child lane ${JSON.stringify(spec.identity.laneId)}: retained child cast state was not found.`);
  }

  const matches: MateriaCastState[] = [];
  const identityDrift: string[] = [];
  for (const candidate of candidates) {
    validateRetainedChildCast(candidate, spec, pipeline);
    const recordedIdentity = await childStartIdentity(candidate);
    if (recordedIdentity) {
      if (sameChildCastIdentity(recordedIdentity, spec.identity)) matches.push(candidate);
      else identityDrift.push(`cast ${candidate.castId} recorded ${JSON.stringify(recordedIdentity)}`);
      continue;
    }

    // Older dedicated child sessions did not persist child identity in the
    // cast_start artifact. Accept their sole path/request/scope match, or an
    // exact cast-id match, but never guess between multiple retained casts.
    if (candidate.castId === spec.identity.childCastId || candidates.length === 1) matches.push(candidate);
  }

  if (matches.length !== 1) {
    if (identityDrift.length > 0) {
      throw new Error(`Child cast recovery identity drifted for ${JSON.stringify(spec.identity.childCastId)}: ${identityDrift.join("; ")}.`);
    }
    throw new Error(`Unable to recover child lane ${JSON.stringify(spec.identity.laneId)}: retained child cast state is ambiguous.`);
  }
  return matches[0]!;
}

function validateRetainedChildCast(
  state: MateriaCastState,
  spec: ChildCastLaunchSpec,
  pipeline: ResolvedMateriaPipeline,
): void {
  if (!state.active && (state.phase === "complete" || state.socketState === "complete")) {
    throw new Error(`Child cast ${JSON.stringify(spec.identity.childCastId)} was accepted and cannot be recovered.`);
  }
  if (state.active && state.currentSocketId === undefined) {
    throw new Error(`Child cast ${JSON.stringify(state.castId)} is active without a retained current socket.`);
  }
  if (!sameJson(state.activeScope, spec.executionScope)) {
    throw new Error(`Child cast recovery scope drifted for ${JSON.stringify(spec.identity.childCastId)}.`);
  }
  if (!sameJson(state.pipeline, pipeline)) {
    throw new Error(`Child cast recovery loadout drifted for ${JSON.stringify(spec.identity.childCastId)}.`);
  }

  const lane = recordAt(state.data, "parallelLane");
  if (lane && lane.laneId !== spec.identity.laneId) {
    throw new Error(`Child cast recovery lane identity drifted for ${JSON.stringify(spec.identity.childCastId)}.`);
  }
  const run = recordAt(state.data, "parallelRun");
  if (run && (run.loopId !== spec.identity.loopId || run.laneId !== spec.identity.laneId)) {
    throw new Error(`Child cast recovery parallel identity drifted for ${JSON.stringify(spec.identity.childCastId)}.`);
  }
}

async function childStartIdentity(state: MateriaCastState): Promise<ChildCastIdentity | undefined> {
  const eventsFile = state.runState?.eventsFile;
  if (typeof eventsFile !== "string" || eventsFile.length === 0) return undefined;
  try {
    const contents = await readFile(eventsFile, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as { type?: unknown; data?: unknown };
        if (parsed.type !== "cast_start" || !isRecord(parsed.data) || !isRecord(parsed.data.childCast)) continue;
        const child = parsed.data.childCast;
        if (validIdentity(child)) return child as unknown as ChildCastIdentity;
      } catch {
        // A truncated final artifact line must not make an otherwise retained
        // legacy child unrecoverable.
      }
    }
  } catch {
    // Legacy sessions may not retain an events artifact. Path and scope
    // validation still protects the recovery fallback below.
  }
  return undefined;
}

async function continuePassiveChildRevive(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  adapters: Pick<MateriaPluginAdapters, "states" | "lifecycle">,
  retained: MateriaCastState,
  pipeline: ResolvedMateriaPipeline,
  identity: ChildCastIdentity,
): Promise<void> {
  const state = adapters.states.listLatest(ctx).find((candidate) => candidate.castId === retained.castId) ?? retained;
  if (!state.active) return;
  const socket = currentSocketOrThrow(state);
  if (isAgentResolvedSocket(socket)) {
    // A detached child has no human to type the nudge requested by passive
    // revive. Keep it out of the visible transcript while still triggering a
    // normal Pi turn against the retained materia prompt.
    pi.sendMessage({
      customType: "pi-materia-child-continuation",
      content: "Continue the retained pi-materia child lane now. Do not wait for user input or ask for a continuation command.",
      display: false,
      details: {
        childCastId: identity.childCastId,
        parentCastId: identity.parentCastId,
        loopId: identity.loopId,
        laneId: identity.laneId,
        socketId: socket.id,
      },
    }, { triggerTurn: true });
    return;
  }

  // Utility sockets do not have an agent turn to nudge; continue their native
  // socket execution directly after passive revival.
  if (pipeline.sockets[socket.id]) await adapters.lifecycle.continue(pi, ctx, state);
}

function sameChildCastIdentity(left: ChildCastIdentity, right: ChildCastIdentity): boolean {
  return left.childCastId === right.childCastId
    && left.parentCastId === right.parentCastId
    && left.loopId === right.loopId
    && left.laneId === right.laneId;
}

function recordAt(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

