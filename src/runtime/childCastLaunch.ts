import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ChildCastLaunchSpec, ChildCastOperation } from "../application/childCastRunner.js";
import { cloneExecutionScope, type ExecutionScope } from "../domain/executionScope.js";
import type { NominalParallelLaneProgressDefinition } from "../domain/parallelProgress.js";
import type { MateriaCastState, ResolvedMateriaPipeline } from "../types.js";
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
  if (!isRecord(parsed) || parsed.version !== 1 || !validIdentity(parsed.identity) || typeof parsed.request !== "string" || typeof parsed.cwd !== "string" || !isRecord(parsed.compiledLoadout) || !validPaths(parsed.paths) || !validExecutionScope(parsed.executionScope) || typeof parsed.attempt !== "number" || !Number.isSafeInteger(parsed.attempt) || parsed.attempt < 1 || (parsed.configPath !== undefined && typeof parsed.configPath !== "string") || (parsed.operation !== undefined && !validChildCastOperation(parsed.operation))) {
    throw new Error(`Invalid child launch specification: ${file}`);
  }
  return { ...parsed, operation: parsed.operation ?? "start" } as unknown as ChildCastLaunchSpec;
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

function validChildCastOperation(value: unknown): value is ChildCastOperation {
  return value === "start" || value === "revive" || value === "recast";
}

