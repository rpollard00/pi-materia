import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ChildCastLaunchSpec } from "../application/childCastRunner.js";
import type { MateriaCastState, ResolvedMateriaPipeline } from "../types.js";
import type { MateriaPluginAdapters } from "./pluginAdapters.js";

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
        },
      },
    },
  );

  // startSocket dispatches the first turn asynchronously. Keeping the child
  // command in the print-mode request until Pi is idle gives the subprocess a
  // real lifetime that covers the complete sequential child graph.
  await ctx.waitForIdle();
  const state = adapters.states.loadActive(ctx);
  const result = terminalResult(state);
  emitChildTerminal(result);
}

export async function readChildLaunchSpec(file: string): Promise<ChildCastLaunchSpec> {
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!isRecord(parsed) || parsed.version !== 1 || !validIdentity(parsed.identity) || typeof parsed.request !== "string" || typeof parsed.cwd !== "string" || !isRecord(parsed.compiledLoadout) || !validPaths(parsed.paths) || !validExecutionScope(parsed.executionScope) || typeof parsed.attempt !== "number" || !Number.isSafeInteger(parsed.attempt) || parsed.attempt < 1 || (parsed.configPath !== undefined && typeof parsed.configPath !== "string")) {
    throw new Error(`Invalid child launch specification: ${file}`);
  }
  return parsed as unknown as ChildCastLaunchSpec;
}

interface ChildTerminalPayload {
  status: "succeeded" | "failed" | "interrupted";
  accepted: boolean;
  endedAt: number;
  message?: string;
  error?: string;
  output?: unknown;
  usage?: unknown;
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
    };
  }
  return {
    status: "failed",
    accepted: false,
    endedAt: state.runState.endedAt ?? Date.now(),
    error: state.failedReason ?? "Child cast ended without an accepted terminal state.",
    ...(state.lastJson !== undefined ? { output: state.lastJson } : state.lastOutput !== undefined ? { output: state.lastOutput } : {}),
    usage: { tokens: usage.tokens, cost: usage.cost },
  };
}

function emitChildTerminal(result: ChildTerminalPayload): void {
  // JSON mode reserves stdout for JSONL. This marker is intentionally a
  // single JSON record so the parent can distinguish an accepted cast from a
  // clean but non-terminal Pi process exit.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

